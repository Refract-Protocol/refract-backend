import { Injectable } from "@nestjs/common";
import { ClaimRepository } from "../../claim/claim.repository";
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
 * Projects a `claim_processed` contract event into `claims` and deactivates
 * the matched policy.
 *
 * Assumed topics: [..., "claim_processed"] (Symbol).
 * Assumed value map keys:
 *   policy_id (u64), holder (Address), payout (i128), coverage_type,
 *   trigger_value (numeric), trigger_source (optional string).
 */
@Injectable()
export class ClaimProcessedHandler {
  constructor(
    private readonly claims: ClaimRepository,
    private readonly policies: PolicyRepository
  ) {}

  async handle(event: DecodedContractEvent): Promise<void> {
    const v = asRecord(event.value);
    const onChainPolicyId = asString(v.policy_id ?? v.policyId, "policy_id");
    const holder = asString(v.holder, "holder");
    const payout = asBigInt(v.payout, "payout");
    const coverageType = asCoverageTypeOrdinal(v.coverage_type ?? v.coverageType);
    const triggerValue = asNumber(v.trigger_value ?? v.triggerValue ?? 0, "trigger_value");
    const triggerSource = asString(v.trigger_source ?? v.triggerSource ?? "on_chain", "trigger_source");

    let policyUuid = await this.policies.findIdByOnChainPolicyId(onChainPolicyId);
    if (!policyUuid) {
      // Ensure FK target exists if we missed the purchase event.
      const upserted = await this.policies.upsertFromChain({
        onChainPolicyId,
        holder,
        coverageType,
        coverageAmount: 0n,
        premium: 0n,
        durationDays: 0,
        expiresAt: new Date(0),
        isActive: false,
      });
      policyUuid = upserted.id;
    }

    await this.claims.insertFromChain({
      policyUuid,
      holder,
      coverageType,
      payout,
      triggerValue,
      triggerSource,
      txHash: event.txHash,
    });

    await this.policies.deactivateByOnChainPolicyId(onChainPolicyId);
  }
}
