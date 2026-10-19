import { Inject, Injectable, Logger } from "@nestjs/common";
import { Pool } from "pg";
import { PG_POOL } from "../db/db.module";
import { OracleReading } from "./oracle-reading";
import { ReadingAdmissionGate, SourceClockOffset, readingDigest } from "./oracle-timestamp";

type InsertParams = [string, number, string, string, Date, string];

/**
 * Persists oracle readings to the `oracle_events` table defined in
 * src/db/schema.sql. Writes are fire-and-forget via a micro-task queue so
 * they never block the caller (OracleScheduler's broadcast loop or
 * ClaimService's evaluation path).
 *
 * The coverage_type column is an enum in Postgres, matching the five
 * values in schema.sql. We map OracleReading.coverageType (PascalCase) to
 * the snake_case enum values the DB expects.
 *
 * Every reading passes through ReadingAdmissionGate before it is written.
 * Rejected readings are logged with a reason code and never persisted.
 * Replays (same source + observation time + payload digest) are dropped by
 * the oracle_reading_receipts primary key in the same statement as the insert.
 */
@Injectable()
export class OracleEventRepository {
  private readonly logger = new Logger(OracleEventRepository.name);
  private readonly admission = new ReadingAdmissionGate();

  // Normalise OracleService's PascalCase coverageType names to the
  // schema's snake_case coverage_type enum values.
  private static readonly COVERAGE_TYPE_MAP: Record<string, string> = {
    StablecoinDepeg: "stablecoin_depeg",
    MarketCrash: "market_crash",
    LiquidationShield: "liquidation_shield",
    SmartContractRisk: "smart_contract_risk",
    FlightDelay: "flight_delay",
  };

  // Receipt insert and event insert are one statement, so a replay can never
  // leave an event row without its receipt (or vice versa). The event row is
  // written only when the receipt insert actually inserted.
  private static readonly INSERT_SQL = `
    WITH receipt AS (
      INSERT INTO oracle_reading_receipts (source, observed_at, payload_digest)
      VALUES ($3::varchar, $5::timestamptz, $6::char(64))
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    INSERT INTO oracle_events (coverage_type, value, source, severity, observed_at, payload_digest)
    SELECT $1::coverage_type, $2::numeric, $3::varchar, $4::varchar, $5::timestamptz, $6::char(64) FROM receipt`;

  constructor(@Inject(PG_POOL) private readonly db: Pool) {}

  /**
   * Persists one oracle reading. The call is fire-and-forget: errors are
   * logged but never re-thrown so a DB hiccup can never disrupt the
   * oracle broadcast or claim-evaluation paths that call this.
   */
  async record(reading: OracleReading): Promise<void> {
    const params = this.admitForInsert(reading);
    if (!params) return;

    try {
      const result = await this.db.query(OracleEventRepository.INSERT_SQL, params);
      if (result.rowCount === 0) {
        this.logger.debug(`Discarded replayed oracle reading from ${params[2]} for ${reading.coverageType}`);
      }
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
   */
  async recordBatch(readings: OracleReading[]): Promise<void> {
    if (readings.length === 0) return;
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      for (const reading of readings) {
        const params = this.admitForInsert(reading);
        if (!params) continue;
        await client.query(OracleEventRepository.INSERT_SQL, params);
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

  /** Per-source clock offset (receipt − observation), for operators to spot skewed providers. */
  getClockOffsets(): SourceClockOffset[] {
    return this.admission.clockOffsets();
  }

  /**
   * Maps and admits a reading. Returns the insert parameters, or undefined when
   * the reading must not be persisted (unknown coverage type or rejected timestamp).
   */
  private admitForInsert(reading: OracleReading): InsertParams | undefined {
    const coverageType = OracleEventRepository.COVERAGE_TYPE_MAP[reading.coverageType];
    if (!coverageType) {
      this.logger.warn(`Unknown coverageType "${reading.coverageType}" — skipping oracle_events insert`);
      return undefined;
    }

    const source = this.extractSource(reading.message);
    const admission = this.admission.admit(source, reading.observedAt);
    if (!admission.accepted) {
      this.logger.warn(`Rejected oracle reading ${reading.coverageType} from ${source}: ${admission.reason}`);
      return undefined;
    }

    return [coverageType, reading.value, source, reading.severity, admission.observedAt, readingDigest(reading)];
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
