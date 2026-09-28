import { Inject, Injectable, Logger } from "@nestjs/common";
import { Pool } from "pg";
import { DATABASE_POOL } from "../db/database.module";
import { ClaimResult } from "./claim-result";

const COVERAGE_TYPE_ENUM: readonly string[] = [
  "stablecoin_depeg",
  "market_crash",
  "liquidation_shield",
  "smart_contract_risk",
  "flight_delay",
];

/**
 * Maps a raw Postgres row from the `claims` table back to a ClaimResult.
 * trigger_value and trigger_source are stored in the DB but not present on
 * ClaimResult — they are written on insert and surfaced via raw SQL when
 * needed.  For now the hydrated record just fills the fields ClaimResult
 * defines.
 */
function rowToClaimResult(row: Record<string, unknown>): ClaimResult {
  return {
    policyId: row.policy_id as string,
    holder: row.holder as string,
    coverageType: row.coverage_type_index as number,
    triggered: true, // only settled (triggered) claims are ever persisted
    payout: row.payout as string,
    reason: (row.trigger_source as string) ?? "",
    processedAt: new Date(row.processed_at as string).getTime(),
    settlementTxHash: (row.tx_hash as string | null) ?? undefined,
  };
}

/**
 * Postgres-backed repository for the `claims` table.
 * Replaces the in-memory history array in ClaimService.
 */
@Injectable()
export class ClaimRepository {
  private readonly logger = new Logger(ClaimRepository.name);

  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  /**
   * Persist a settled claim.  trigger_value defaults to 0 when not provided
   * (ClaimResult doesn't carry the raw oracle reading; callers that have it
   * should pass it explicitly for auditability).
   */
  async insert(
    result: ClaimResult,
    opts: { triggerValue?: number; triggerSource?: string } = {}
  ): Promise<void> {
    const coverageEnum = COVERAGE_TYPE_ENUM[result.coverageType];
    const triggerSource = opts.triggerSource ?? (result.reason.slice(0, 40) || "unknown");
    const triggerValue = opts.triggerValue ?? 0;

    await this.pool.query(
      `INSERT INTO claims (
         policy_id, holder, coverage_type, payout,
         trigger_value, trigger_source, tx_hash, processed_at
       ) VALUES ($1, $2, $3::coverage_type, $4, $5, $6, $7, $8)`,
      [
        result.policyId,
        result.holder,
        coverageEnum,
        result.payout,
        triggerValue,
        triggerSource,
        result.settlementTxHash ?? null,
        new Date(result.processedAt).toISOString(),
      ]
    );
    this.logger.debug(`Persisted claim for policy ${result.policyId}, holder ${result.holder}`);
  }

  async findByHolder(holder: string): Promise<ClaimResult[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT
         c.*,
         CASE c.coverage_type
           WHEN 'stablecoin_depeg'   THEN 0
           WHEN 'market_crash'       THEN 1
           WHEN 'liquidation_shield' THEN 2
           WHEN 'smart_contract_risk' THEN 3
           WHEN 'flight_delay'       THEN 4
         END AS coverage_type_index
       FROM claims c
       WHERE c.holder = $1
       ORDER BY c.processed_at DESC`,
      [holder]
    );
    return rows.map(rowToClaimResult);
  }

  async findRecent(limit = 10): Promise<ClaimResult[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT
         c.*,
         CASE c.coverage_type
           WHEN 'stablecoin_depeg'   THEN 0
           WHEN 'market_crash'       THEN 1
           WHEN 'liquidation_shield' THEN 2
           WHEN 'smart_contract_risk' THEN 3
           WHEN 'flight_delay'       THEN 4
         END AS coverage_type_index
       FROM claims c
       ORDER BY c.processed_at DESC
       LIMIT $1`,
      [limit]
    );
    return rows.map(rowToClaimResult);
  }
}
