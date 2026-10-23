import { Inject, Injectable, Logger } from "@nestjs/common";
import { Pool } from "pg";
import { PG_POOL } from "../db/db.module";

/**
 * closed    → settlement and publication allowed
 * open      → blocked; set automatically by AnomalyDetector
 * half_open → blocked; operator probe state, reachable only from open after cooldown
 *
 * Allowed transitions:
 *   closed    → open        (automatic, anomaly trigger)
 *   half_open → open        (automatic, anomaly trigger)
 *   open      → half_open   (operator only, after HALF_OPEN_COOLDOWN_MS)
 *   half_open → closed      (operator only)
 * open → closed is not allowed: an operator must half-open first.
 */
export type BreakerState = "closed" | "open" | "half_open";

/** Minimum time a breaker must stay open before an operator may half-open it (prevents flapping). */
export const HALF_OPEN_COOLDOWN_MS = 30 * 60_000;

/**
 * Persisted per-coverage-type circuit breaker (oracle_circuit_breakers table).
 * State lives in Postgres so a process restart cannot silently resume payouts.
 * A missing row means closed.
 */
@Injectable()
export class CircuitBreaker {
  private readonly logger = new Logger(CircuitBreaker.name);

  constructor(@Inject(PG_POOL) private readonly db: Pool) {}

  /** Throws on DB error. Callers that gate payouts must treat a throw as blocked. */
  async getState(coverageType: string): Promise<BreakerState> {
    const { rows } = await this.db.query<{ state: BreakerState }>(
      `SELECT state FROM oracle_circuit_breakers WHERE coverage_type = $1`,
      [coverageType]
    );
    return rows[0]?.state ?? "closed";
  }

  /** Fails closed: an unreadable breaker blocks settlement. */
  async isSettlementAllowed(coverageType: string): Promise<boolean> {
    try {
      return (await this.getState(coverageType)) === "closed";
    } catch (err) {
      this.logger.error(
        `Circuit breaker state unreadable for ${coverageType}; blocking settlement`,
        err instanceof Error ? err.stack : String(err)
      );
      return false;
    }
  }

  /**
   * Automatic opening. Returns true only when this call changed the state, so
   * repeated triggers while already open do not overwrite the original evidence.
   */
  async open(coverageType: string, reason: string, readings: unknown[]): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `INSERT INTO oracle_circuit_breakers (coverage_type, state, trigger_reason, trigger_readings, opened_at, updated_at)
       VALUES ($1, 'open', $2, $3, NOW(), NOW())
       ON CONFLICT (coverage_type) DO UPDATE SET
         state = 'open',
         trigger_reason = EXCLUDED.trigger_reason,
         trigger_readings = EXCLUDED.trigger_readings,
         opened_at = NOW(),
         half_open_at = NULL,
         updated_at = NOW()
       WHERE oracle_circuit_breakers.state <> 'open'`,
      [coverageType, reason, JSON.stringify(readings)]
    );
    return (rowCount ?? 0) > 0;
  }

  /** Operator-only (called from the operator control endpoint). open → half_open after cooldown. */
  async halfOpen(coverageType: string, now = Date.now()): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE oracle_circuit_breakers
          SET state = 'half_open', half_open_at = NOW(), updated_at = NOW()
        WHERE coverage_type = $1 AND state = 'open' AND opened_at <= $2`,
      [coverageType, new Date(now - HALF_OPEN_COOLDOWN_MS)]
    );
    return (rowCount ?? 0) > 0;
  }

  /** Operator-only (called from the operator control endpoint). half_open → closed. */
  async close(coverageType: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE oracle_circuit_breakers
          SET state = 'closed', trigger_reason = NULL, trigger_readings = '[]',
              opened_at = NULL, half_open_at = NULL, updated_at = NOW()
        WHERE coverage_type = $1 AND state = 'half_open'`,
      [coverageType]
    );
    return (rowCount ?? 0) > 0;
  }
}
