import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { PG_POOL } from "../db/db.module";
import { CacheService } from "../cache/cache.service";
import { decodeCursor, encodeCursor, MAX_PAGE_LIMIT } from "../common/pagination";
import {
  Decision,
  FEED_KEYS,
  FeedDetailResponse,
  FeedHistoryResponse,
  FeedListResponse,
  FeedSummary,
  ORACLE_STATUS_API_VERSION,
  SourceStatus,
  feedDetailResponseSchema,
  feedHistoryResponseSchema,
  feedKeySchema,
  feedListResponseSchema,
} from "../common/oracle-status.schemas";

/** Responses are cached briefly; new decisions invalidate immediately. */
export const ORACLE_STATUS_CACHE_TTL_SECONDS = 15;
const VERSION_KEY = "oracle:status:version";

/** Sources whose readings fall inside this window corroborate one another. */
const QUORUM_WINDOW_SECONDS = 120;
const QUORUM_REQUIRED = 2;
/** Newer than this → live. Between this and PAUSE → degraded (still settled). Older → paused. */
const FRESH_SECONDS = 120;
const PAUSE_AFTER_SECONDS = 900;
const DEFAULT_HISTORY_LIMIT = 20;
/** A reputation of 0 corresponds to a 5% mean deviation from the per-minute median. */
const REPUTATION_ZERO_DEVIATION = 0.05;

interface DecisionRow {
  coverage_type: string;
  id: string;
  value: string;
  severity: string;
  recorded_at: Date;
  source_count: string;
  min_value: string;
  max_value: string;
}

interface SourceRow {
  coverage_type: string;
  source: string;
  last_seen: Date;
  readings_24h: string;
  mean_dev: string | null;
}

/** A decision is one stored reading plus how many sources corroborated it in the quorum window. */
const DECISION_SELECT = `
  SELECT e.coverage_type::text AS coverage_type, e.id::text AS id, e.value::text AS value,
         e.severity, e.recorded_at,
         w.source_count::text AS source_count, w.min_value::text AS min_value, w.max_value::text AS max_value
    FROM oracle_events e
    CROSS JOIN LATERAL (
      SELECT count(DISTINCT s.source) AS source_count, min(s.value) AS min_value, max(s.value) AS max_value
        FROM oracle_events s
       WHERE s.coverage_type = e.coverage_type
         AND s.recorded_at <= e.recorded_at
         AND s.recorded_at > e.recorded_at - make_interval(secs => ${QUORUM_WINDOW_SECONDS})
    ) w`;

/**
 * Read-only query layer behind the public trust-status endpoints. Never computes
 * consensus: it only describes decisions already persisted in `oracle_events`
 * and the per-source health snapshot derived from them.
 */
@Injectable()
export class OracleStatusService {
  private readonly logger = new Logger(OracleStatusService.name);

  constructor(
    @Inject(PG_POOL) private readonly db: Pool,
    private readonly cache: CacheService,
  ) {}

  /** Call after writing a new decision; every cached response is rotated out. */
  static async invalidate(cache: CacheService): Promise<void> {
    try {
      await cache.set(VERSION_KEY, Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    } catch {
      // cache is best-effort; entries expire on their own within the TTL
    }
  }

  async listFeeds(): Promise<FeedListResponse> {
    return this.cached("list", async () => {
      const [decisions, sources] = await Promise.all([this.latestDecisions(), this.sourceSnapshot()]);
      const feeds = FEED_KEYS.map((key) => this.summarize(key, decisions.get(key) ?? null, sources.get(key) ?? []));
      return feedListResponseSchema.parse({ apiVersion: ORACLE_STATUS_API_VERSION, feeds });
    });
  }

  async getFeed(rawKey: string): Promise<FeedDetailResponse> {
    const feedKey = this.parseKey(rawKey);
    return this.cached(`feed:${feedKey}`, async () => {
      const [decisions, sources] = await Promise.all([this.latestDecisions(feedKey), this.sourceSnapshot(feedKey)]);
      const sourceList = sources.get(feedKey) ?? [];
      const summary = this.summarize(feedKey, decisions.get(feedKey) ?? null, sourceList);
      const value = summary.lastDecision?.value ?? null;
      return feedDetailResponseSchema.parse({
        apiVersion: ORACLE_STATUS_API_VERSION,
        feed: {
          ...summary,
          latestValue: summary.authoritative ? value : null,
          lastKnownValue: summary.authoritative ? null : value,
          sources: sourceList,
          evidenceUrl: summary.lastDecision ? `/api/v1/oracle/feeds/${feedKey}/history` : null,
        },
      });
    });
  }

  async getHistory(rawKey: string, limit?: number, cursor?: string): Promise<FeedHistoryResponse> {
    const feedKey = this.parseKey(rawKey);
    const pageSize = Math.min(Math.max(limit ?? DEFAULT_HISTORY_LIMIT, 1), MAX_PAGE_LIMIT);
    const after = cursor !== undefined ? decodeCursor(cursor) : null;
    if (after && !/^\d+$/.test(after.id)) decodeCursor("!"); // same 400 as any malformed cursor
    return this.cached(`history:${feedKey}:${pageSize}:${cursor ?? ""}`, async () => {
      const params: unknown[] = [feedKey, pageSize + 1];
      let keyset = "";
      if (after) {
        params.push(after.at, after.id);
        keyset = `AND (date_trunc('milliseconds', e.recorded_at), e.id) < (to_timestamp($3::double precision / 1000.0), $4::bigint)`;
      }
      const { rows } = await this.db.query<DecisionRow>(
        `${DECISION_SELECT}
          WHERE e.coverage_type::text = $1 ${keyset}
          ORDER BY e.recorded_at DESC, e.id DESC
          LIMIT $2`,
        params,
      );
      const page = rows.slice(0, pageSize);
      const last = page[page.length - 1];
      return feedHistoryResponseSchema.parse({
        apiVersion: ORACLE_STATUS_API_VERSION,
        feedKey,
        items: page.map((r) => this.toDecision(r)),
        nextCursor:
          rows.length > pageSize && last ? encodeCursor({ at: last.recorded_at.getTime(), id: last.id }) : null,
      });
    });
  }

  private parseKey(raw: string): (typeof FEED_KEYS)[number] {
    const parsed = feedKeySchema.safeParse(raw);
    if (!parsed.success) throw new NotFoundException({ error: "Unknown feed" });
    return parsed.data;
  }

  private summarize(feedKey: FeedSummary["feedKey"], decision: Decision | null, sources: SourceStatus[]): FeedSummary {
    if (!decision) {
      return { feedKey, state: "unknown", authoritative: false, trustMode: "none", health: null, lastDecision: null };
    }
    const ageSeconds = (Date.now() - Date.parse(decision.decidedAt)) / 1000;
    const state =
      ageSeconds > PAUSE_AFTER_SECONDS
        ? "paused"
        : ageSeconds <= FRESH_SECONDS && decision.quorum.met
          ? "live"
          : "degraded";
    const healthy = sources.filter((s) => s.health === "healthy").length;
    return {
      feedKey,
      state,
      authoritative: state !== "paused",
      trustMode:
        state === "paused" ? "none" : decision.quorum.achieved >= QUORUM_REQUIRED ? "multi_source" : "single_source",
      health: healthy === 0 ? "down" : healthy === sources.length ? "healthy" : "stale",
      lastDecision: decision,
    };
  }

  private toDecision(r: DecisionRow): Decision {
    const achieved = Number(r.source_count);
    const min = Number(r.min_value);
    const max = Number(r.max_value);
    const mid = (min + max) / 2;
    return {
      evidenceRef: `oracle_events:${r.id}`,
      value: Number(r.value),
      severity: r.severity,
      method: achieved >= QUORUM_REQUIRED ? "multi_source_median" : "single_source",
      quorum: {
        required: QUORUM_REQUIRED,
        achieved,
        met: achieved >= QUORUM_REQUIRED,
        windowSeconds: QUORUM_WINDOW_SECONDS,
      },
      divergenceBps: mid > 0 ? Math.round(((max - min) / mid) * 10_000) : 0,
      decidedAt: r.recorded_at.toISOString(),
    };
  }

  private async latestDecisions(feedKey?: string): Promise<Map<string, Decision>> {
    const { rows } = await this.db.query<DecisionRow>(
      `SELECT d.* FROM unnest($1::text[]) AS k(key)
        CROSS JOIN LATERAL (
          ${DECISION_SELECT}
           WHERE e.coverage_type::text = k.key
           ORDER BY e.recorded_at DESC, e.id DESC
           LIMIT 1
        ) d`,
      [feedKey ? [feedKey] : [...FEED_KEYS]],
    );
    return new Map(rows.map((r) => [r.coverage_type, this.toDecision(r)]));
  }

  /** Per-source health/reputation from stored readings; never polls providers. */
  private async sourceSnapshot(feedKey?: string): Promise<Map<string, SourceStatus[]>> {
    const { rows } = await this.db.query<SourceRow>(
      `WITH r AS (
         SELECT coverage_type::text AS coverage_type, source, value, recorded_at,
                date_trunc('minute', recorded_at) AS b
           FROM oracle_events
          WHERE recorded_at > now() - interval '24 hours'
            AND ($1::text IS NULL OR coverage_type::text = $1)
       ), m AS (
         SELECT coverage_type, b, percentile_cont(0.5) WITHIN GROUP (ORDER BY value) AS med
           FROM r GROUP BY coverage_type, b
       )
       SELECT r.coverage_type, r.source, max(r.recorded_at) AS last_seen, count(*)::text AS readings_24h,
              avg(CASE WHEN m.med = 0 THEN 0 ELSE abs(r.value - m.med) / m.med END)::text AS mean_dev
         FROM r JOIN m USING (coverage_type, b)
        GROUP BY r.coverage_type, r.source
        ORDER BY r.source`,
      [feedKey ?? null],
    );
    const out = new Map<string, SourceStatus[]>();
    for (const r of rows) {
      const age = (Date.now() - r.last_seen.getTime()) / 1000;
      const dev = Number(r.mean_dev ?? 0);
      const list = out.get(r.coverage_type) ?? [];
      list.push({
        name: r.source,
        health: age <= FRESH_SECONDS ? "healthy" : age <= PAUSE_AFTER_SECONDS ? "stale" : "down",
        lastSeenAt: r.last_seen.toISOString(),
        readings24h: Number(r.readings_24h),
        reputation: Math.round(Math.min(Math.max(1 - dev / REPUTATION_ZERO_DEVIATION, 0), 1) * 10_000) / 10_000,
      });
      out.set(r.coverage_type, list);
    }
    return out;
  }

  private async cached<T>(suffix: string, load: () => Promise<T>): Promise<T> {
    let key: string | null = null;
    try {
      const version = (await this.cache.get<string>(VERSION_KEY)) ?? "0";
      key = `oracle:status:${version}:${suffix}`;
      const hit = await this.cache.get<T>(key);
      if (hit) return hit;
    } catch (err) {
      this.logger.warn(`Oracle status cache read failed: ${(err as Error).message}`);
      key = null;
    }
    const fresh = await load();
    if (key) {
      await this.cache.set(key, fresh, ORACLE_STATUS_CACHE_TTL_SECONDS).catch((err: Error) => {
        this.logger.warn(`Oracle status cache write failed: ${err.message}`);
      });
    }
    return fresh;
  }
}
