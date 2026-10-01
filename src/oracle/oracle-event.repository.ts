import { Inject, Injectable, Logger } from "@nestjs/common";
import { Pool } from "pg";
import { PG_POOL } from "../db/db.module";
import { OracleReading } from "./oracle-reading";

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
   */
  async record(reading: OracleReading): Promise<void> {
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
   */
  async recordBatch(readings: OracleReading[]): Promise<void> {
    if (readings.length === 0) return;
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      for (const reading of readings) {
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
