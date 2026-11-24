import { authorizesPayout, ConsensusDecision } from "../oracle/consensus/consensus-decision";
import { StoredPolicy } from "../policy/policy.service";

declare const authorized: unique symbol;

/**
 * How long an authorization built from a consensus decision stays valid for
 * settlement, measured from the decision's own `decidedAt`. A decision can
 * sit behind a completeness hold (see claim.service.ts's claimHoldService
 * gate) and be re-checked on a later scan; this bounds how stale the market
 * data backing a payout is allowed to be once the hold clears.
 */
const AUTHORIZATION_VALIDITY_MS = 15 * 60 * 1000;
/** Tolerance against clock skew between the decision and verification clocks, so a check landing exactly at the boundary doesn't flap. */
const CLOCK_SKEW_TOLERANCE_MS = 30_000;

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
  /** Epoch ms after which this authorization may no longer be used to settle. */
  readonly deadline: number;
}

export type AuthorizationOutcome =
  | { ok: true; authorization: SettlementAuthorization }
  | { ok: false; reason: string };

export function authorizeSettlement(
  policy: StoredPolicy,
  coverageTypeName: string,
  decision: ConsensusDecision,
  now: number = Date.now(),
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
  const deadline = decision.decidedAt + AUTHORIZATION_VALIDITY_MS;
  if (now > deadline + CLOCK_SKEW_TOLERANCE_MS) {
    return { ok: false, reason: `decision ${decision.id} authorization expired at ${new Date(deadline).toISOString()}` };
  }
  return {
    ok: true,
    authorization: {
      policyId: policy.id,
      holder: policy.holder,
      payout: BigInt(policy.coverageAmount),
      decision,
      deadline,
    } as SettlementAuthorization,
  };
}
