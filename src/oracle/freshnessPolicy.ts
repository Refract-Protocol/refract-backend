import { Logger } from "@nestjs/common";
import { FRESHNESS_POLICY, FreshnessPolicy } from "../common/coverage-catalog";

/**
 * Ingestion-side freshness guard (issue #186).
 *
 * Every adapter funnels readings through `evaluate()` before they reach
 * corroboration. A reading is usable only if it passes, in order:
 *
 *   1. missing_timestamp — source sent no observed time. The ingestion time is
 *      used as a stand-in for diagnostics, but the reading is unusable: an
 *      ingestion-time stamp always looks fresh, which would hide outages.
 *   2. future_dated      — observedAt is more than maxClockSkewSeconds ahead of
 *      ingestion time. Timestamps up to the skew allowance are accepted and
 *      treated as "now" (age 0), so skew handling is deterministic.
 *   3. too_old           — ingestion time minus observedAt exceeds
 *      freshnessWindowSeconds. Replayed backlogs after an outage are rejected
 *      here, so recovery never produces a burst of "fresh" readings.
 *   4. heartbeat_gap     — this source was silent for longer than
 *      heartbeatIntervalSeconds. The first reading after the silence is
 *      quarantined; the feed recovers only once the source resumes a
 *      contiguous heartbeat.
 *
 * Liveness is tracked by arrival time per source and feed; freshness is
 * judged by the source-observed timestamp. Rejected readings are still
 * persisted with `usable: false` and a reason so they can be audited.
 *
 * State is in-memory and bounded by feeds × sources, so no per-poll query is
 * issued. `sweep()` detects stalls that produce no readings at all.
 */

export type FreshnessRejectionReason =
  | "missing_timestamp"
  | "future_dated"
  | "too_old"
  | "heartbeat_gap";

export interface FreshnessInput {
  /** PascalCase coverage type, matching OracleReading.coverageType. */
  coverageType: string;
  /** Source tag, e.g. "CoinGecko". */
  source: string;
  /** Source-reported observation time; undefined when the source sends none. */
  observedAt?: Date;
  ingestedAt: Date;
}

export interface FreshnessVerdict {
  usable: boolean;
  reason?: FreshnessRejectionReason;
  /** Timestamp used for age checks; equals ingestedAt when the source sent none. */
  observedAt: Date;
}

const ENV_PREFIX = "ORACLE_FRESHNESS_";

/**
 * Builds the effective per-feed policy: code defaults from the coverage
 * catalog, overridable per environment with
 * ORACLE_FRESHNESS_<FEED>_WINDOW_SECONDS | _MAX_CLOCK_SKEW_SECONDS |
 * _HEARTBEAT_INTERVAL_SECONDS, where <FEED> is the snake_case coverage type
 * (e.g. ORACLE_FRESHNESS_STABLECOIN_DEPEG_WINDOW_SECONDS). Invalid values fail
 * startup rather than silently falling back.
 */
export function resolveFreshnessPolicies(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, FreshnessPolicy> {
  const resolved: Record<string, FreshnessPolicy> = {};
  for (const [feed, defaults] of Object.entries(FRESHNESS_POLICY)) {
    const prefix = `${ENV_PREFIX}${toSnakeCase(feed)}_`;
    resolved[feed] = {
      freshnessWindowSeconds: readSeconds(env, `${prefix}WINDOW_SECONDS`, defaults.freshnessWindowSeconds),
      maxClockSkewSeconds: readSeconds(env, `${prefix}MAX_CLOCK_SKEW_SECONDS`, defaults.maxClockSkewSeconds),
      heartbeatIntervalSeconds: readSeconds(
        env,
        `${prefix}HEARTBEAT_INTERVAL_SECONDS`,
        defaults.heartbeatIntervalSeconds,
      ),
    };
  }
  return resolved;
}

function toSnakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

function readSeconds(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer number of seconds, got "${raw}"`);
  }
  return value;
}

export class FreshnessGuard {
  private readonly logger = new Logger(FreshnessGuard.name);

  /** Last arrival time (ms) per "feed|source", used for heartbeat liveness. */
  private readonly lastArrivalBySource = new Map<string, number>();
  /** Last usable source-observed time (ms) per feed. */
  private readonly lastUsableObservedByFeed = new Map<string, number>();
  /** Feeds currently in the stale state. */
  private readonly staleFeeds = new Set<string>();

  constructor(
    private readonly policies: Record<string, FreshnessPolicy> = resolveFreshnessPolicies(),
  ) {}

  /** Validates one reading against its feed's policy and updates liveness state. */
  evaluate(input: FreshnessInput): FreshnessVerdict {
    const policy = this.policyFor(input.coverageType);
    const ingestedMs = input.ingestedAt.getTime();
    const seriesKey = `${input.coverageType}|${input.source}`;

    const previousArrival = this.lastArrivalBySource.get(seriesKey);
    const heartbeatGap =
      previousArrival !== undefined &&
      ingestedMs - previousArrival > policy.heartbeatIntervalSeconds * 1000;
    this.lastArrivalBySource.set(seriesKey, ingestedMs);

    if (input.observedAt === undefined) {
      return this.reject("missing_timestamp", input, input.ingestedAt);
    }

    const observedMs = input.observedAt.getTime();
    if (observedMs - ingestedMs > policy.maxClockSkewSeconds * 1000) {
      return this.reject("future_dated", input, input.observedAt);
    }

    const ageMs = Math.max(0, ingestedMs - observedMs);
    if (ageMs > policy.freshnessWindowSeconds * 1000) {
      return this.reject("too_old", input, input.observedAt);
    }

    if (heartbeatGap) {
      return this.reject("heartbeat_gap", input, input.observedAt);
    }

    const previousUsable = this.lastUsableObservedByFeed.get(input.coverageType);
    if (previousUsable === undefined || observedMs > previousUsable) {
      this.lastUsableObservedByFeed.set(input.coverageType, observedMs);
    }
    this.clearStale(input.coverageType);
    return { usable: true, observedAt: input.observedAt };
  }

  /**
   * Re-evaluates every known feed against the clock. Call on each poll cycle
   * so a source that stops reporting still flips its feed to `stale`.
   */
  sweep(now: Date = new Date()): void {
    const nowMs = now.getTime();
    for (const feed of Object.keys(this.policies)) {
      const policy = this.policies[feed];
      const lastUsable = this.lastUsableObservedByFeed.get(feed);
      const lastArrival = this.latestArrival(feed);

      const windowExpired =
        lastUsable === undefined || nowMs - lastUsable > policy.freshnessWindowSeconds * 1000;
      const heartbeatMissed =
        lastArrival !== undefined &&
        nowMs - lastArrival > policy.heartbeatIntervalSeconds * 1000;

      if (windowExpired || heartbeatMissed) {
        this.markStale(feed, {
          lastUsableObservedAt: lastUsable === undefined ? null : new Date(lastUsable).toISOString(),
          lastArrivalAt: lastArrival === undefined ? null : new Date(lastArrival).toISOString(),
          reason: heartbeatMissed ? "heartbeat_missed" : "freshness_window_expired",
        });
      }
    }
  }

  /** Health-surface view: true while the feed has no usable, fresh reading. */
  isStale(coverageType: string): boolean {
    return this.staleFeeds.has(coverageType);
  }

  private reject(
    reason: FreshnessRejectionReason,
    input: FreshnessInput,
    observedAt: Date,
  ): FreshnessVerdict {
    this.logger.warn(
      JSON.stringify({
        event: "oracle_reading_rejected",
        coverageType: input.coverageType,
        source: input.source,
        reason,
        observedAt: observedAt.toISOString(),
        ingestedAt: input.ingestedAt.toISOString(),
      }),
    );
    return { usable: false, reason, observedAt };
  }

  private markStale(feed: string, details: Record<string, unknown>): void {
    if (this.staleFeeds.has(feed)) return;
    this.staleFeeds.add(feed);
    this.logger.warn(JSON.stringify({ event: "oracle_feed_stale", coverageType: feed, ...details }));
  }

  private clearStale(feed: string): void {
    if (!this.staleFeeds.delete(feed)) return;
    this.logger.log(JSON.stringify({ event: "oracle_feed_recovered", coverageType: feed }));
  }

  private latestArrival(feed: string): number | undefined {
    let latest: number | undefined;
    for (const [key, arrival] of this.lastArrivalBySource) {
      if (!key.startsWith(`${feed}|`)) continue;
      if (latest === undefined || arrival > latest) latest = arrival;
    }
    return latest;
  }

  private policyFor(coverageType: string): FreshnessPolicy {
    const policy = this.policies[coverageType];
    if (!policy) {
      throw new Error(`No freshness policy declared for coverageType: ${coverageType}`);
    }
    return policy;
  }
}
