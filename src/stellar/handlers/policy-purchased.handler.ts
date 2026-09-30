import { Injectable } from "@nestjs/common";
import { PolicyRepository } from "../../policy/policy.repository";
import {
  DecodedContractEvent,
  asBigInt,
  asCoverageTypeOrdinal,
  asNumber,
  asRecord,
  asString,
} from "./event-types";

/**
 * Projects a `policy_purchased` contract event into `policies`.
 *
 * Assumed topics: [..., "policy_purchased"] (Symbol).
 * Assumed value map keys (after scValToNative):
 *   policy_id (u64), holder (Address), coverage_type, coverage_amount (i128),
 *   premium (i128), duration_days (u32), expires_at (u64 unix seconds).
 */
@Injectable()
export class PolicyPurchasedHandler {
  constructor(private readonly policies: PolicyRepository) {}

  async handle(event: DecodedContractEvent): Promise<void> {
    const v = asRecord(event.value);
    const onChainPolicyId = asString(v.policy_id ?? v.policyId, "policy_id");
    const holder = asString(v.holder, "holder");
    const coverageType = asCoverageTypeOrdinal(v.coverage_type ?? v.coverageType);
    const coverageAmount = asBigInt(v.coverage_amount ?? v.coverageAmount, "coverage_amount");
    const premium = asBigInt(v.premium, "premium");
    const durationDays = asNumber(v.duration_days ?? v.durationDays, "duration_days");
    const expiresAtSec = asNumber(v.expires_at ?? v.expiresAt, "expires_at");

    await this.policies.upsertFromChain({
      onChainPolicyId,
      holder,
      coverageType,
      coverageAmount,
      premium,
      durationDays,
      expiresAt: new Date(expiresAtSec * 1000),
      isActive: true,
    });
  }
}
