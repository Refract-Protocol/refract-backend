import { Inject, Injectable, Logger } from "@nestjs/common";
import { Pool } from "pg";
import { PG_POOL } from "../db/db.module";
import { PremiumHistoryEntry } from "./pool.service";

/**
 * Reads from and writes to the `premium_revenue` table defined in
 * src/db/schema.sql (policy_id, amount, coverage_type, collected_at).
 *
 * Written by PolicyService.buy() when a policy is created.
 * Read by PoolService.getPremiumHistory() to replace the Math.random()
 * fabrication with real SQL aggregation.
 */
@Injectable()
export class PremiumRevenueRepository {
  private readonly logger = new Logger(PremiumRevenueRepository.name);

  // Normalise PolicyService's numeric coverageType indices to the schema's
  // snake_case coverage_type enum values.
  static readonly COVERAGE_TYPE_MAP: Record<number, string> = {
    0: "stablecoin_depeg",
    1: "market_crash",
    2: "liquidation_shield",
    3: "smart_contract_risk",
    4: "flight_delay",
  };

  constructor(@Inject(PG_POOL) private readonly db: Pool) {}

  /**
   * Records a premium collected when a policy is purchased.
   * `policyDbId` must be the UUID from the `policies` table (the FK
   * constraint requires it). Fire-and-forget — errors are logged, never
   * rethrown.
   */
  async record(policyDbId: string, amount: bigint, coverageTypeIndex: number): Promise<void> {
    const coverageType = PremiumRevenueRepository.COVERAGE_TYPE_MAP[coverageTypeIndex];
    if (!coverageType) {
      this.logger.warn(`Unknown coverageType index ${coverageTypeIndex} — skipping premium_revenue insert`);
      return;
    }
    try {
      await this.db.query(
        `INSERT INTO premium_revenue (policy_id, amount, coverage_type)
         VALUES ($1, $2, $3)`,
        [policyDbId, amount.toString(), coverageType]
      );
    } catch (err) {
      this.logger.error(
        `Failed to record premium for policy ${policyDbId}`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /**
   * Returns the last `days` calendar days of daily premium and payout
   * aggregates. Payouts come from settled claims already in the `claims`
   * table. APY is recomputed from the pool_snapshots trailing average.
   *
   * Returns an empty array (not random data) when there are no rows yet.
   */
  async getDailyHistory(days = 30): Promise<PremiumHistoryEntry[]> {
    try {
      const { rows } = await this.db.query<{
        date: string;
        premiums: string;
        payouts: string;
        apy_bps: number | null;
      }>(
        `WITH dates AS (
           SELECT generate_series(
             CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day',
             CURRENT_DATE,
             INTERVAL '1 day'
           )::date AS day
         ),
         daily_premiums AS (
           SELECT DATE(collected_at) AS day, SUM(amount) AS premiums
           FROM premium_revenue
           WHERE collected_at >= CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day'
           GROUP BY 1
         ),
         daily_payouts AS (
           SELECT DATE(processed_at) AS day, SUM(payout) AS payouts
           FROM claims
           WHERE processed_at >= CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day'
           GROUP BY 1
         ),
         daily_apy AS (
           SELECT
             DATE(snapshotted_at) AS day,
             AVG(apy_bps)         AS apy_bps
           FROM pool_snapshots
           WHERE snapshotted_at >= CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day'
           GROUP BY 1
         )
         SELECT
           d.day::text                          AS date,
           COALESCE(p.premiums, 0)::text        AS premiums,
           COALESCE(c.payouts,  0)::text        AS payouts,
           a.apy_bps
         FROM dates          d
         LEFT JOIN daily_premiums p ON p.day = d.day
         LEFT JOIN daily_payouts  c ON c.day = d.day
         LEFT JOIN daily_apy      a ON a.day = d.day
         ORDER BY d.day DESC`,
        [days]
      );

      return rows.map((row) => ({
        date: row.date,
        premiums: row.premiums,
        payouts: row.payouts,
        // Fall back to 0 when no snapshot exists for a day yet.
        apyBps: row.apy_bps !== null ? Math.round(row.apy_bps) : 0,
      }));
    } catch (err) {
      this.logger.error("Failed to query premium history", err instanceof Error ? err.message : String(err));
      return [];
    }
  }
}
