import { Inject, Injectable, Logger } from "@nestjs/common";
import { Pool } from "pg";
import { PG_POOL } from "../db/db.module";
import { OracleReading } from "./oracle-reading";
import { ReferenceDataRejection } from "./reference-data.types";

/**
 * Persists oracle readings to the `oracle_events` table defined in
 * src/db/schema.sql. Writes are fire-and-forget via a micro-task queue so
 * they never block the caller (OracleScheduler's broadcast loop or
 * ClaimService's evaluation path).
 *
 * The coverage_type column is an enum in Postgres, matching the five
 * values in schema.sql. We map OracleReading.coverageType (PascalCase) to
 * the snake_case enum values the DB expects.
 */
@Injectable()
export class OracleEventRepository {
  private readonly logger = new Logger(OracleEventRepository.name);

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
   *
   * Readings rejected by reference-data validation are never written to
   * `oracle_events` (which feeds quorum counting); they are diverted to
   * the dead-letter path instead.
   */
  async record(reading: OracleReading, rejection?: ReferenceDataRejection): Promise<void> {
    if (rejection) {
      await this.recordDeadLetter(reading, rejection);
      return;
    }

    const coverageType = OracleEventRepository.COVERAGE_TYPE_MAP[reading.coverageType];
    if (!coverageType) {
      this.logger.warn(`Unknown coverageType "${reading.coverageType}" — skipping oracle_events insert`);
      return;
    }

    try {
      await this.db.query(
        `INSERT INTO oracle_events (coverage_type, value, source, severity)
         VALUES ($1, $2, $3, $4)`,
        [coverageType, reading.value, this.extractSource(reading.message), reading.severity]
      );
    } catch (err) {
      this.logger.error(
        `Failed to persist oracle event for ${reading.coverageType}`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /**
   * Batch-records multiple readings in a single transaction.
   * Also fire-and-forget.
   *
   * Readings rejected by reference-data validation are diverted to the
   * dead-letter table within the same transaction and never inserted into
   * `oracle_events`, so they cannot count toward quorum.
   */
  async recordBatch(
    readings: OracleReading[],
    rejections?: Map<OracleReading, ReferenceDataRejection>
  ): Promise<void> {
    if (readings.length === 0) return;
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      for (const reading of readings) {
        const rejection = rejections?.get(reading);
        if (rejection) {
          await this.insertDeadLetter(client, reading, rejection);
          continue;
        }
        const coverageType = OracleEventRepository.COVERAGE_TYPE_MAP[reading.coverageType];
        if (!coverageType) {
          this.logger.warn(`Unknown coverageType "${reading.coverageType}" — skipping oracle_events insert`);
          continue;
        }
        await client.query(
          `INSERT INTO oracle_events (coverage_type, value, source, severity)
           VALUES ($1, $2, $3, $4)`,
          [coverageType, reading.value, this.extractSource(reading.message), reading.severity]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      this.logger.error(
        "Failed to persist oracle event batch",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      client.release();
    }
  }

  /**
   * Persists a reading rejected by reference-data validation into the
   * dead-letter table, preserving the raw payload and the rejection
   * reason for later inspection. Fire-and-forget: errors are logged but
   * never re-thrown.
   */
  async recordDeadLetter(reading: OracleReading, rejection: ReferenceDataRejection): Promise<void> {
    try {
      await this.insertDeadLetter(this.db, reading, rejection);
    } catch (err) {
      this.logger.error(
        `Failed to persist dead-letter reading for ${reading.coverageType}`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /**
   * Returns the dataset version pinned for a given feed, or null when no
   * pin is configured. Feeds pin a dataset version so a later reference
   * data refresh cannot retroactively change how a past reading was
   * interpreted.
   */
  async getPinnedDatasetVersion(feedId: string): Promise<string | null> {
    try {
      const result = await this.db.query(
        `SELECT dataset_version FROM feed_dataset_pins WHERE feed_id = $1`,
        [feedId]
      );
      return result.rows.length > 0 ? (result.rows[0].dataset_version as string) : null;
    } catch (err) {
      this.logger.error(
        `Failed to fetch pinned dataset version for feed ${feedId}`,
        err instanceof Error ? err.message : String(err)
      );
      return null;
    }
  }

  private async insertDeadLetter(
    db: Pick<Pool, "query">,
    reading: OracleReading,
    rejection: ReferenceDataRejection
  ): Promise<void> {
    await db.query(
      `INSERT INTO dead_letter_readings
         (coverage_type, feed_id, reason, detail, dataset_version, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        reading.coverageType,
        rejection.feedId ?? null,
        rejection.reason,
        rejection.detail ?? null,
        rejection.datasetVersion ?? null,
        JSON.stringify(reading),
      ]
    );
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
