import { Pool } from "pg";

export const FEED_TYPES = [
  "stablecoin_depeg",
  "market_crash",
  "liquidation_shield",
  "smart_contract_risk",
  "flight_delay",
] as const;
export type FeedType = (typeof FEED_TYPES)[number];

export type MutationAction = "pause_feed" | "resume_feed" | "quarantine_source" | "unquarantine_source";

export interface MutationRequest {
  action: MutationAction;
  target: string;
  operator: string;
  reason: string;
  dryRun?: boolean;
}

export interface MutationResult {
  action: MutationAction;
  target: string;
  dryRun: boolean;
  changed: boolean;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface FeedStatus {
  coverageType: string;
  paused: boolean;
  pauseReason: string | null;
  lastReadingAt: Date | null;
  lastSource: string | null;
  readings1h: number;
  health: "paused" | "ok" | "stale" | "no-data";
}

const STALE_AFTER_MS = 15 * 60 * 1000;

export function isFeedType(v: string): v is FeedType {
  return (FEED_TYPES as readonly string[]).includes(v);
}

/** Validates a mutation request; throws on anything an operator must fix before retrying. */
export function validateMutation(req: MutationRequest): void {
  if (!req.operator.trim()) throw new Error("operator identity is required (--operator or OPERATOR_ID)");
  if (!req.reason.trim()) throw new Error("--reason is required for mutating commands");
  if (req.action === "pause_feed" || req.action === "resume_feed") {
    if (!isFeedType(req.target)) {
      throw new Error(`unknown feed "${req.target}" (expected one of ${FEED_TYPES.join(", ")})`);
    }
  } else if (!req.target.trim() || req.target.length > 40) {
    throw new Error("source must be a non-empty name of at most 40 characters");
  }
}

/**
 * Operator-facing service layer. Reads are plain SELECTs; mutations run in one
 * transaction together with their audit record so they either fully apply or not at all.
 */
export class OperatorControls {
  constructor(private readonly db: Pool) {}

  async listFeeds(): Promise<FeedStatus[]> {
    const { rows } = await this.db.query(
      `SELECT t.coverage_type AS coverage_type,
              COALESCE(c.paused, false) AS paused,
              c.reason AS pause_reason,
              e.recorded_at AS last_reading_at,
              e.source AS last_source,
              (SELECT COUNT(*) FROM oracle_events x
                WHERE x.coverage_type::text = t.coverage_type
                  AND x.recorded_at > NOW() - INTERVAL '1 hour')::int AS readings_1h
         FROM unnest($1::text[]) AS t(coverage_type)
         LEFT JOIN oracle_feed_controls c ON c.coverage_type::text = t.coverage_type
         LEFT JOIN LATERAL (
           SELECT recorded_at, source FROM oracle_events
            WHERE coverage_type::text = t.coverage_type
            ORDER BY recorded_at DESC LIMIT 1
         ) e ON true
        ORDER BY t.coverage_type`,
      [FEED_TYPES]
    );
    const now = Date.now();
    return rows.map((r) => {
      const last: Date | null = r.last_reading_at;
      let health: FeedStatus["health"] = "ok";
      if (r.paused) health = "paused";
      else if (!last) health = "no-data";
      else if (now - last.getTime() > STALE_AFTER_MS) health = "stale";
      return {
        coverageType: r.coverage_type,
        paused: r.paused,
        pauseReason: r.pause_reason,
        lastReadingAt: last,
        lastSource: r.last_source,
        readings1h: r.readings_1h,
        health,
      };
    });
  }

  /** Recent readings for one feed, grouped by source (newest first within each). */
  async recentReadings(feed: string, limit = 20) {
    if (!isFeedType(feed)) throw new Error(`unknown feed "${feed}"`);
    const { rows } = await this.db.query(
      `SELECT e.source, e.value, e.severity, e.recorded_at,
              COALESCE(q.quarantined, false) AS quarantined
         FROM oracle_events e
         LEFT JOIN oracle_source_quarantine q ON q.source = e.source
        WHERE e.coverage_type::text = $1
        ORDER BY e.recorded_at DESC
        LIMIT $2`,
      [feed, limit]
    );
    const grouped = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = grouped.get(r.source) ?? [];
      list.push(r);
      grouped.set(r.source, list);
    }
    return grouped;
  }

  /** Recent claim decisions with the on-chain evidence (tx hash) behind them. */
  async recentDecisions(limit = 20, explorerBase = "https://stellar.expert/explorer/testnet/tx") {
    const { rows } = await this.db.query(
      `SELECT id, coverage_type::text AS coverage_type, trigger_value, trigger_source,
              payout, tx_hash, processed_at
         FROM claims
        ORDER BY processed_at DESC
        LIMIT $1`,
      [limit]
    );
    return rows.map((r) => ({
      ...r,
      evidence: r.tx_hash ? `${explorerBase}/${r.tx_hash}` : null,
    }));
  }

  async recentAudit(limit = 20) {
    const { rows } = await this.db.query(
      `SELECT id, operator, action, target, reason, created_at
         FROM operator_audit_log ORDER BY id DESC LIMIT $1`,
      [limit]
    );
    return rows;
  }

  async mutate(req: MutationRequest): Promise<MutationResult> {
    validateMutation(req);
    const dryRun = !!req.dryRun;
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const isFeed = req.action === "pause_feed" || req.action === "resume_feed";
      const flag = req.action === "pause_feed" || req.action === "quarantine_source";
      const [table, key, col] = isFeed
        ? ["oracle_feed_controls", "coverage_type", "paused"]
        : ["oracle_source_quarantine", "source", "quarantined"];

      const cur = await client.query(
        `SELECT ${col} AS flag, reason FROM ${table} WHERE ${key}::text = $1 FOR UPDATE`,
        [req.target]
      );
      const before = { [col]: cur.rows[0]?.flag ?? false, reason: cur.rows[0]?.reason ?? null };
      const after = { [col]: flag, reason: req.reason };
      const changed = before[col] !== flag;

      if (!dryRun) {
        await client.query(
          `INSERT INTO ${table} (${key}, ${col}, reason, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (${key}) DO UPDATE
             SET ${col} = EXCLUDED.${col}, reason = EXCLUDED.reason,
                 updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
          [req.target, flag, req.reason, req.operator]
        );
        await client.query(
          `INSERT INTO operator_audit_log (operator, action, target, reason, before, after)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [req.operator, req.action, req.target, req.reason, JSON.stringify(before), JSON.stringify(after)]
        );
      }
      await client.query(dryRun ? "ROLLBACK" : "COMMIT");
      return { action: req.action, target: req.target, dryRun, changed, before, after };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
