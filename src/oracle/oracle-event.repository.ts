import { Inject, Injectable, Logger } from "@nestjs/common";
import { Pool } from "pg";
import { PG_POOL } from "../db/db.module";
import { OracleReading } from "./oracle-reading";

/**
 * Persists oracle readings to the partitioned `oracle_readings` table and
 * the append-only, partitioned `oracle_evidence` ledger defined in
 * src/db/schema.sql.
 *
 * Writes are fire-and-forget via a micro-task queue so they never block the
 * caller (OracleScheduler's broadcast loop or ClaimService's evaluation
 * path).
 *
 * Partitioning / query-budget policy (issue #295):
 *  - Both tables are RANGE partitioned by their observation timestamp
 *    (`observed_at`). Every INSERT therefore carries an explicit
 *    `observed_at`, and every SELECT must bound it, otherwise Postgres would
 *    scan every partition. `assertBoundedRange` enforces that rule and throws
 *    loudly when a query omits the timestamp predicate.
 *  - Each evidence record references the immutable methodology version(s)
 *    used to derive the reading (issue #294) via `methodology_version_ids`,
 *    so point-in-time reconstruction resolves the exact semantics.
 *
 * The coverage_type column is an enum in Postgres, matching the five
 * values in schema.sql. We map OracleReading.coverageType (PascalCase) to
 * the snake_case enum values the DB expects.
 */
@Injectable()
export class OracleEventRepository {
  private readonly logger = new Logger(OracleEventRepository.name);

  /**
   * Maximum width of a single bounded-range query. Anything wider is almost
   * certainly a missing/incorrect predicate and would scan too many
   * partitions, so we reject it rather than let it hit the hot write path.
   */
  static readonly MAX_QUERY_RANGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

  // Normalise OracleService's PascalCase coverageType names to the
  // schema's snake_case coverage_type enum values.
  private static readonly COVERAGE_TYPE_MAP: Record<string, string> = {
    StablecoinDepeg: "stablecoin_depeg",
    MarketCrash: "market_crash",
    LiquidationShield: "liquidation_shield",
    SmartContractRisk: "smart_contract_risk",
    FlightDelay: "flight_delay",
  };

  constructor(@Inject(PG_POOL) private readonly db: Pool) {}

  /**
   * Persists one oracle reading. The call is fire-and-forget: errors are
   * logged but never re-thrown so a DB hiccup can never disrupt the
   * oracle broadcast or claim-evaluation paths that call this.
   */
  async record(reading: OracleReading): Promise<void> {
    const coverageType = OracleEventRepository.COVERAGE_TYPE_MAP[reading.coverageType];
    if (!coverageType) {
      this.logger.warn(`Unknown coverageType "${reading.coverageType}" — skipping oracle_readings insert`);
      return;
    }

    const observedAt = this.resolveObservedAt(reading);

    try {
      await this.db.query(
        `INSERT INTO oracle_readings (coverage_type, value, source, severity, observed_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [coverageType, reading.value, this.extractSource(reading.message), reading.severity, observedAt]
      );
    } catch (err) {
      this.logger.error(
        `Failed to persist oracle reading for ${reading.coverageType}`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /**
   * Batch-records multiple readings in a single transaction.
   * Also fire-and-forget.
   */
  async recordBatch(readings: OracleReading[]): Promise<void> {
    if (readings.length === 0) return;
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      for (const reading of readings) {
        const coverageType = OracleEventRepository.COVERAGE_TYPE_MAP[reading.coverageType];
        if (!coverageType) {
          this.logger.warn(`Unknown coverageType "${reading.coverageType}" — skipping oracle_readings insert`);
          continue;
        }
        await client.query(
          `INSERT INTO oracle_readings (coverage_type, value, source, severity, observed_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            coverageType,
            reading.value,
            this.extractSource(reading.message),
            reading.severity,
            this.resolveObservedAt(reading),
          ]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      this.logger.error(
        "Failed to persist oracle reading batch",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      client.release();
    }
  }

  /**
   * Appends an evidence record for a consensus decision / published reading.
   * The record references the exact methodology version(s) used (issue #294)
   * and carries the observation timestamp so it lands in the correct
   * `oracle_evidence` partition (issue #295).
   *
   * Fire-and-forget like the reading writers.
   */
  async recordEvidence(evidence: OracleEvidenceInput): Promise<void> {
    if (!evidence.methodologyVersionIds || evidence.methodologyVersionIds.length === 0) {
      this.logger.warn(
        `Evidence for decision ${evidence.decisionId} has no methodology version — refusing to write`
      );
      return;
    }

    const observedAt = this.resolveObservedAt(evidence);

    try {
      await this.db.query(
        `INSERT INTO oracle_evidence
           (decision_id, payout_id, feed_id, source, value, observed_at, methodology_version_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          evidence.decisionId,
          evidence.payoutId ?? null,
          evidence.feedId,
          evidence.source,
          evidence.value,
          observedAt,
          evidence.methodologyVersionIds,
        ]
      );
    } catch (err) {
      this.logger.error(
        `Failed to persist oracle evidence for decision ${evidence.decisionId}`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /**
   * Bounded-range lookup of evidence by decision id. The caller MUST supply
   * the observation window so the planner prunes to the relevant partitions.
   */
  async findEvidenceByDecision(
    decisionId: string,
    from: Date,
    to: Date
  ): Promise<OracleEvidenceRow[]> {
    this.assertBoundedRange(from, to, "findEvidenceByDecision");
    const { rows } = await this.db.query(
      `SELECT decision_id, payout_id, feed_id, source, value, observed_at, methodology_version_ids
         FROM oracle_evidence
        WHERE decision_id = $1
          AND observed_at >= $2
          AND observed_at < $3
        ORDER BY observed_at DESC`,
      [decisionId, from, to]
    );
    return rows as OracleEvidenceRow[];
  }

  /**
   * Bounded-range lookup of evidence by payout id (dispute review path).
   */
  async findEvidenceByPayout(
    payoutId: string,
    from: Date,
    to: Date
  ): Promise<OracleEvidenceRow[]> {
    this.assertBoundedRange(from, to, "findEvidenceByPayout");
    const { rows } = await this.db.query(
      `SELECT decision_id, payout_id, feed_id, source, value, observed_at, methodology_version_ids
         FROM oracle_evidence
        WHERE payout_id = $1
          AND observed_at >= $2
          AND observed_at < $3
        ORDER BY observed_at DESC`,
      [payoutId, from, to]
    );
    return rows as OracleEvidenceRow[];
  }

  /**
   * Bounded-range consensus-window read: readings for a (feed, source) pair
   * within the consensus window. Hits the covering index
   * (feed_id, source, observed_at) and prunes to the expected partitions.
   */
  async findReadingsInWindow(
    feedId: string,
    source: string,
    from: Date,
    to: Date
  ): Promise<OracleReadingRow[]> {
    this.assertBoundedRange(from, to, "findReadingsInWindow");
    const { rows } = await this.db.query(
      `SELECT feed_id, source, value, observed_at
         FROM oracle_readings
        WHERE feed_id = $1
          AND source = $2
          AND observed_at >= $3
          AND observed_at < $4
        ORDER BY observed_at ASC`,
      [feedId, source, from, to]
    );
    return rows as OracleReadingRow[];
  }

  /**
   * Query-budget guard (issue #295): every repository query against the
   * partitioned readings/evidence tables must bound the timestamp range.
   * Throws loudly rather than silently scanning all partitions.
   */
  assertBoundedRange(from: Date, to: Date, queryName: string): void {
    if (!(from instanceof Date) || Number.isNaN(from.getTime())) {
      throw new Error(
        `Query budget violation in ${queryName}: missing or invalid lower timestamp bound`
      );
    }
    if (!(to instanceof Date) || Number.isNaN(to.getTime())) {
      throw new Error(
        `Query budget violation in ${queryName}: missing or invalid upper timestamp bound`
      );
    }
    if (to.getTime() <= from.getTime()) {
      throw new Error(
        `Query budget violation in ${queryName}: upper bound must be after lower bound`
      );
    }
    if (to.getTime() - from.getTime() > OracleEventRepository.MAX_QUERY_RANGE_MS) {
      throw new Error(
        `Query budget violation in ${queryName}: range exceeds ${OracleEventRepository.MAX_QUERY_RANGE_MS}ms`
      );
    }
  }

  /**
   * Resolves the observation timestamp for a reading/evidence record. Falls
   * back to "now" so a partition key is always present.
   */
  private resolveObservedAt(input: { observedAt?: Date }): Date {
    const observedAt = input.observedAt ?? new Date();
    return observedAt instanceof Date && !Number.isNaN(observedAt.getTime())
      ? observedAt
      : new Date();
  }

  /**
   * Extracts a short source tag from the oracle message suffix, e.g.
   * "[CoinGecko]" → "CoinGecko", "[DeFiLlama]" → "DeFiLlama".
   * Falls back to "unknown" so the NOT NULL column is always populated.
   */
  private extractSource(message: string): string {
    const match = /\[([^\]]+)\]/.exec(message);
    if (!match) return "unknown";
    // Strip extra context from compound tags like
    // "[CoinGecko; Horizon testnet ledger #123 @ ...]"
    return match[1].split(";")[0].trim().substring(0, 40);
  }
}

/** Input for appending an evidence record to the partitioned ledger. */
export interface OracleEvidenceInput {
  decisionId: string;
  payoutId?: string | null;
  feedId: string;
  source: string;
  value: number;
  observedAt?: Date;
  /** Immutable methodology version ids used to derive the reading (issue #294). */
  methodologyVersionIds: string[];
}

/** Row shape returned by evidence lookups. */
export interface OracleEvidenceRow {
  decision_id: string;
  payout_id: string | null;
  feed_id: string;
  source: string;
  value: number;
  observed_at: Date;
  methodology_version_ids: string[];
}

/** Row shape returned by consensus-window reading lookups. */
export interface OracleReadingRow {
  feed_id: string;
  source: string;
  value: number;
  observed_at: Date;
}
