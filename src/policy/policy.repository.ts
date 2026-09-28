import { Inject, Injectable, Logger } from "@nestjs/common";
import { Pool } from "pg";
import { DATABASE_POOL } from "../db/database.module";
import { StoredPolicy } from "./policy.service";

/**
 * Maps a raw Postgres row (snake_case, string numerics, Date objects) to
 * the StoredPolicy shape consumed by the rest of the application.
 */
function rowToPolicy(row: Record<string, unknown>): StoredPolicy {
  return {
    id: row.id as string,
    holder: row.holder as string,
    coverageType: row.coverage_type_index as number,
    coverageTypeName: row.coverage_type_name as string,
    coverageAmount: row.coverage_amount as string,
    premium: row.premium as string,
    durationDays: row.duration_days as number,
    expiresAt: Math.floor(new Date(row.expires_at as string).getTime() / 1000),
    isActive: row.is_active as boolean,
    createdAt: new Date(row.created_at as string).toISOString(),
    triggerParams: (row.trigger_params as Record<string, unknown>) ?? {},
  };
}

/**
 * Maps the string enum value stored in Postgres (e.g. 'market_crash') back
 * to the integer index used by the application layer.
 */
const COVERAGE_TYPE_ENUM: readonly string[] = [
  "stablecoin_depeg",
  "market_crash",
  "liquidation_shield",
  "smart_contract_risk",
  "flight_delay",
];

/**
 * Postgres-backed repository for the `policies` table.
 * Replaces the in-memory Map in PolicyService.
 */
@Injectable()
export class PolicyRepository {
  private readonly logger = new Logger(PolicyRepository.name);

  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async findById(id: string): Promise<StoredPolicy | undefined> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT
         p.*,
         CASE p.coverage_type
           WHEN 'stablecoin_depeg'  THEN 0
           WHEN 'market_crash'      THEN 1
           WHEN 'liquidation_shield' THEN 2
           WHEN 'smart_contract_risk' THEN 3
           WHEN 'flight_delay'      THEN 4
         END AS coverage_type_index,
         CASE p.coverage_type
           WHEN 'stablecoin_depeg'  THEN 'Stablecoin Depeg'
           WHEN 'market_crash'      THEN 'Market Crash'
           WHEN 'liquidation_shield' THEN 'Liquidation Shield'
           WHEN 'smart_contract_risk' THEN 'Smart Contract Risk'
           WHEN 'flight_delay'      THEN 'Flight Delay'
         END AS coverage_type_name
       FROM policies p
       WHERE p.id = $1`,
      [id]
    );
    if (rows.length === 0) return undefined;
    return rowToPolicy(rows[0]);
  }

  async findByHolder(holder: string): Promise<StoredPolicy[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT
         p.*,
         CASE p.coverage_type
           WHEN 'stablecoin_depeg'  THEN 0
           WHEN 'market_crash'      THEN 1
           WHEN 'liquidation_shield' THEN 2
           WHEN 'smart_contract_risk' THEN 3
           WHEN 'flight_delay'      THEN 4
         END AS coverage_type_index,
         CASE p.coverage_type
           WHEN 'stablecoin_depeg'  THEN 'Stablecoin Depeg'
           WHEN 'market_crash'      THEN 'Market Crash'
           WHEN 'liquidation_shield' THEN 'Liquidation Shield'
           WHEN 'smart_contract_risk' THEN 'Smart Contract Risk'
           WHEN 'flight_delay'      THEN 'Flight Delay'
         END AS coverage_type_name
       FROM policies p
       WHERE p.holder = $1
       ORDER BY p.created_at DESC`,
      [holder]
    );
    return rows.map(rowToPolicy);
  }

  async listActive(): Promise<StoredPolicy[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT
         p.*,
         CASE p.coverage_type
           WHEN 'stablecoin_depeg'  THEN 0
           WHEN 'market_crash'      THEN 1
           WHEN 'liquidation_shield' THEN 2
           WHEN 'smart_contract_risk' THEN 3
           WHEN 'flight_delay'      THEN 4
         END AS coverage_type_index,
         CASE p.coverage_type
           WHEN 'stablecoin_depeg'  THEN 'Stablecoin Depeg'
           WHEN 'market_crash'      THEN 'Market Crash'
           WHEN 'liquidation_shield' THEN 'Liquidation Shield'
           WHEN 'smart_contract_risk' THEN 'Smart Contract Risk'
           WHEN 'flight_delay'      THEN 'Flight Delay'
         END AS coverage_type_name
       FROM policies p
       WHERE p.is_active = TRUE AND p.expires_at > NOW()
       ORDER BY p.created_at DESC`
    );
    return rows.map(rowToPolicy);
  }

  async insert(policy: StoredPolicy): Promise<void> {
    const coverageEnum = COVERAGE_TYPE_ENUM[policy.coverageType];
    await this.pool.query(
      `INSERT INTO policies (
         id, holder, coverage_type, coverage_amount, premium,
         duration_days, expires_at, trigger_params, is_active, created_at
       ) VALUES ($1, $2, $3::coverage_type, $4, $5, $6, $7, $8, $9, $10)`,
      [
        policy.id,
        policy.holder,
        coverageEnum,
        policy.coverageAmount,
        policy.premium,
        policy.durationDays,
        new Date(policy.expiresAt * 1000).toISOString(),
        JSON.stringify(policy.triggerParams ?? {}),
        policy.isActive,
        policy.createdAt,
      ]
    );
    this.logger.debug(`Inserted policy ${policy.id} for holder ${policy.holder}`);
  }

  async deactivate(id: string): Promise<void> {
    await this.pool.query(`UPDATE policies SET is_active = FALSE WHERE id = $1`, [id]);
    this.logger.debug(`Deactivated policy ${id}`);
  }
}
