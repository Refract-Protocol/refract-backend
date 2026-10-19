import { Inject, Injectable, Logger } from "@nestjs/common";
import { Pool } from "pg";
import { PG_POOL } from "../db/db.module";
import { OracleDeadLetterRepository } from "./oracle-dead-letter.repository";
import { OracleReading } from "./oracle-reading";

/**
 * Persists oracle readings to the `oracle_events` table defined in
 * src/db/schema.sql. Writes are fire-and-forget via a micro-task queue so
 * they never block the caller (OracleScheduler's broadcast loop or
 * ClaimService's evaluation path).
 *
 * Every reading either lands in oracle_events or in oracle_dead_letters
 * (src/db/migrations/004_oracle_dead_letter_queue.sql). Nothing is dropped.
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
  static readonly COVERAGE_TYPE_MAP: Record<string, string> = {
    StablecoinDepeg: "stablecoin_depeg",
    MarketCrash: "market_crash",
    LiquidationShield: "liquidation_shield",
    SmartContractRisk: "smart_contract_risk",
    FlightDelay: "flight_delay",
  };

  constructor(
    @Inject(PG_POOL) private readonly db: Pool,
    private readonly deadLetters: OracleDeadLetterRepository,
  ) {}

  /**
   * Persists one oracle reading. The call is fire-and-forget: errors are
   * logged but never re-thrown so a DB hiccup can never disrupt the
   * oracle broadcast or claim-evaluation paths that call this.
   * Failed readings are written to the dead-letter queue.
   */
  async record(reading: OracleReading): Promise<void> {
    const coverageType = OracleEventRepository.COVERAGE_TYPE_MAP[reading.coverageType];
    if (!coverageType) {
      this.logger.warn(`Unknown coverageType "${reading.coverageType}" — dead-lettering oracle reading`);
      await this.deadLetters.enqueue([reading], "UnknownCoverageType", new Error(`Unknown coverageType "${reading.coverageType}"`));
      return;
    }

    try {
      await this.db.query(
        `INSERT INTO oracle_events (coverage_type, value, source, severity)
         VALUES ($1, $2, $3, $4)`,
        [coverageType, reading.value, OracleEventRepository.extractSource(reading.message), reading.severity]
      );
    } catch (err) {
      this.logger.error(
        `Failed to persist oracle event for ${reading.coverageType}`,
        err instanceof Error ? err.message : String(err)
      );
      await this.deadLetters.enqueue([reading], err instanceof Error ? err.constructor.name : "UnknownError", err);
    }
  }

  /**
   * Batch-records multiple readings in a single transaction.
   * Also fire-and-forget. If the transaction rolls back, every reading in
   * the batch that passed validation is dead-lettered.
   */
  async recordBatch(readings: OracleReading[]): Promise<void> {
    if (readings.length === 0) return;
    const client = await this.db.connect();
    const valid: OracleReading[] = [];
    try {
      await client.query("BEGIN");
      for (const reading of readings) {
        const coverageType = OracleEventRepository.COVERAGE_TYPE_MAP[reading.coverageType];
        if (!coverageType) {
          this.logger.warn(`Unknown coverageType "${reading.coverageType}" — dead-lettering oracle reading`);
          await this.deadLetters.enqueue([reading], "UnknownCoverageType", new Error(`Unknown coverageType "${reading.coverageType}"`));
          continue;
        }
        valid.push(reading);
        await client.query(
          `INSERT INTO oracle_events (coverage_type, value, source, severity)
           VALUES ($1, $2, $3, $4)`,
          [coverageType, reading.value, OracleEventRepository.extractSource(reading.message), reading.severity]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      this.logger.error(
        "Failed to persist oracle event batch",
        err instanceof Error ? err.message : String(err)
      );
      await this.deadLetters.enqueue(valid, err instanceof Error ? err.constructor.name : "UnknownError", err);
    } finally {
      client.release();
    }
  }

  /**
   * Extracts a short source tag from the oracle message suffix, e.g.
   * "[CoinGecko]" → "CoinGecko", "[DeFiLlama]" → "DeFiLlama".
   * Falls back to "unknown" so the NOT NULL column is always populated.
   */
  static extractSource(message: string): string {
    const match = /\[([^\]]+)\]/.exec(message);
    if (!match) return "unknown";
    // Strip extra context from compound tags like
    // "[CoinGecko; Horizon testnet ledger #123 @ ...]"
    return match[1].split(";")[0].trim().substring(0, 40);
  }
}
