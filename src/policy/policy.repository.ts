import { Injectable } from "@nestjs/common";
import { DbService } from "../db/db.service";

/** Maps on-chain CoverageType ordinal (0–4) to the schema.sql enum. */
export const COVERAGE_TYPE_DB = [
  "stablecoin_depeg",
  "market_crash",
  "liquidation_shield",
  "smart_contract_risk",
  "flight_delay",
] as const;

export type CoverageTypeDb = (typeof COVERAGE_TYPE_DB)[number];

export interface UpsertPolicyInput {
  /** On-chain policy id (u64), stored in policies.policy_id. */
  onChainPolicyId: string;
  holder: string;
  coverageType: CoverageTypeDb | number;
  coverageAmount: bigint | string;
  premium: bigint | string;
  durationDays: number;
  expiresAt: Date;
  triggerParams?: Record<string, unknown>;
  isActive?: boolean;
}

function toCoverageTypeDb(value: CoverageTypeDb | number): CoverageTypeDb {
  if (typeof value === "number") {
    const mapped = COVERAGE_TYPE_DB[value];
    if (!mapped) {
      throw new Error(`Unknown coverage type ordinal: ${value}`);
    }
    return mapped;
  }
  return value;
}

/**
 * Postgres-backed policy projection keyed on the on-chain u64 policy id.
 */
@Injectable()
export class PolicyRepository {
  constructor(private readonly db: DbService) {}

  async upsertFromChain(input: UpsertPolicyInput): Promise<{ id: string }> {
    const coverageType = toCoverageTypeDb(input.coverageType);
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO policies (
         policy_id, holder, coverage_type, coverage_amount, premium,
         duration_days, expires_at, trigger_params, is_active
       ) VALUES ($1, $2, $3::coverage_type, $4, $5, $6, $7, $8::jsonb, $9)
       ON CONFLICT (policy_id) DO UPDATE SET
         holder = EXCLUDED.holder,
         coverage_type = EXCLUDED.coverage_type,
         coverage_amount = EXCLUDED.coverage_amount,
         premium = EXCLUDED.premium,
         duration_days = EXCLUDED.duration_days,
         expires_at = EXCLUDED.expires_at,
         trigger_params = EXCLUDED.trigger_params,
         is_active = EXCLUDED.is_active
       RETURNING id`,
      [
        input.onChainPolicyId,
        input.holder,
        coverageType,
        input.coverageAmount.toString(),
        input.premium.toString(),
        input.durationDays,
        input.expiresAt,
        JSON.stringify(input.triggerParams ?? {}),
        input.isActive ?? true,
      ]
    );
    return { id: result.rows[0].id };
  }

  async findIdByOnChainPolicyId(onChainPolicyId: string): Promise<string | null> {
    const result = await this.db.query<{ id: string }>(
      "SELECT id FROM policies WHERE policy_id = $1",
      [onChainPolicyId]
    );
    return result.rows[0]?.id ?? null;
  }

  async deactivateByOnChainPolicyId(onChainPolicyId: string): Promise<void> {
    await this.db.query("UPDATE policies SET is_active = false WHERE policy_id = $1", [onChainPolicyId]);
  }
}
