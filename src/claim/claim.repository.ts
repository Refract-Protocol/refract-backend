import { Injectable } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { CoverageTypeDb, COVERAGE_TYPE_DB } from "../policy/policy.repository";

export interface InsertClaimInput {
  /** Internal UUID of the policies row (FK). */
  policyUuid: string;
  holder: string;
  coverageType: CoverageTypeDb | number;
  payout: bigint | string;
  triggerValue: number | string;
  triggerSource: string;
  txHash?: string;
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
 * Projects claim_processed events into the `claims` table.
 */
@Injectable()
export class ClaimRepository {
  constructor(private readonly db: DbService) {}

  async insertFromChain(input: InsertClaimInput): Promise<{ id: string }> {
    const coverageType = toCoverageTypeDb(input.coverageType);
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO claims (
         policy_id, holder, coverage_type, payout, trigger_value, trigger_source, tx_hash
       ) VALUES ($1, $2, $3::coverage_type, $4, $5, $6, $7)
       RETURNING id`,
      [
        input.policyUuid,
        input.holder,
        coverageType,
        input.payout.toString(),
        input.triggerValue.toString(),
        input.triggerSource,
        input.txHash ?? null,
      ]
    );
    return { id: result.rows[0].id };
  }
}
