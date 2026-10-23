import { authorizesPayout, ConsensusDecision } from "../oracle/consensus/consensus-decision";
import { StoredPolicy } from "../policy/policy.service";

declare const authorized: unique symbol;

/**
 * Proof that a payout is backed by an actionable, triggered, recorded
 * consensus decision for the policy's coverage type. It can only be built
 * by {@link authorizeSettlement}, and the payout path only accepts this
 * type, so a raw oracle reading cannot reach settlement.
 */
export interface SettlementAuthorization {
  readonly [authorized]: true;
  readonly policyId: string;
  readonly holder: string;
  readonly payout: bigint;
  readonly decision: ConsensusDecision;
}

export type AuthorizationOutcome =
  | { ok: true; authorization: SettlementAuthorization }
  | { ok: false; reason: string };

export function authorizeSettlement(
  policy: StoredPolicy,
  coverageTypeName: string,
  decision: ConsensusDecision,
): AuthorizationOutcome {
  if (decision.coverageType !== coverageTypeName) {
    return { ok: false, reason: `decision ${decision.id} is for ${decision.coverageType}, not ${coverageTypeName}` };
  }
  if (!decision.actionable) {
    return { ok: false, reason: `decision ${decision.id} not actionable (${decision.status}): ${decision.blockers.join("; ")}` };
  }
  if (!authorizesPayout(decision)) {
    return { ok: false, reason: `decision ${decision.id} not triggered` };
  }
  return {
    ok: true,
    authorization: {
      policyId: policy.id,
      holder: policy.holder,
      payout: BigInt(policy.coverageAmount),
      decision,
    } as SettlementAuthorization,
  };
}
