export type ClaimTrustEvaluationState =
  | "healthy_corroborated"
  | "degraded_held"
  | "degraded_settled";

export type HistoricalClaimStatus =
  | "held_pending_trust"
  | "settled"
  | "not_triggered"
  | "reversed_after_review";

export interface DegradedAffectedClaim {
  claimId: string;
  policyId: string;
  coverageType: string;
  payoutAmountUsd: number;
  policyStartMs: number;
  policyEndMs: number;
  incidentTimestampMs: number;
  evaluatedAtMs: number;
  evaluatedTrustState: ClaimTrustEvaluationState;
  originalDecisionId: string;
  status: HistoricalClaimStatus;
  settledDecisionId?: string;
  reversedByApprovalId?: string;
  payoutTriggerPredicate: (agreedValue: number) => boolean;
}

export interface RestoredCorroboratedDecision {
  decisionId: string;
  coverageType: string;
  windowStartMs: number;
  windowEndMs: number;
  agreedValue: number;
  isValidCorroborated: boolean;
}

export type ProposedReevaluationAction =
  | "settle_held_claim"
  | "dismiss_held_claim_not_triggered"
  | "propose_reversal_of_settled_claim"
  | "no_change_needed"
  | "skip_decision_still_invalid";

export interface ReevaluationDiffItem {
  claimId: string;
  policyId: string;
  previousStatus: HistoricalClaimStatus;
  originalDecisionId: string;
  restoredDecisionId?: string;
  restoredAgreedValue?: number;
  proposedAction: ProposedReevaluationAction;
  payoutDeltaUsd: number;
  requiresOperatorApproval: boolean;
  reason: string;
}

export interface ReevaluationPlan {
  planId: string;
  createdAtMs: number;
  items: ReevaluationDiffItem[];
  hasMorePages: boolean;
  nextCursorOffset: number;
}

export class RetroactiveClaimReevaluator {
  private readonly claims = new Map<string, DegradedAffectedClaim>();
  private readonly restoredDecisions = new Map<
    string,
    RestoredCorroboratedDecision
  >();
  private readonly plans = new Map<string, ReevaluationPlan>();
  private readonly settledClaimIds = new Set<string>();
  private seq = 0;

  public registerClaim(claim: DegradedAffectedClaim): void {
    this.claims.set(claim.claimId, { ...claim });
    if (claim.status === "settled") {
      this.settledClaimIds.add(claim.claimId);
    }
  }

  public registerRestoredDecision(
    decision: RestoredCorroboratedDecision
  ): void {
    this.restoredDecisions.set(decision.decisionId, { ...decision });
  }

  public computeReevaluationDiff(params: {
    coverageType: string;
    degradedIntervalStartMs: number;
    degradedIntervalEndMs: number;
    restoredDecisionId: string;
    cursorOffset?: number;
    maxBatchSize?: number;
    nowMs?: number;
  }): ReevaluationPlan {
    const nowMs = params.nowMs ?? Date.now();
    const offset = Math.max(0, params.cursorOffset ?? 0);
    const maxBatchSize = Math.max(1, params.maxBatchSize ?? 50);
    const restored = this.restoredDecisions.get(params.restoredDecisionId);

    const matchingClaims = Array.from(this.claims.values())
      .filter(
        (c) =>
          c.coverageType === params.coverageType &&
          c.evaluatedTrustState !== "healthy_corroborated" &&
          c.incidentTimestampMs >= params.degradedIntervalStartMs &&
          c.incidentTimestampMs <= params.degradedIntervalEndMs
      )
      .sort((a, b) => a.claimId.localeCompare(b.claimId));

    const batch = matchingClaims.slice(offset, offset + maxBatchSize);
    const hasMorePages = offset + maxBatchSize < matchingClaims.length;

    const items: ReevaluationDiffItem[] = [];

    for (const claim of batch) {
      if (!restored || !restored.isValidCorroborated) {
        items.push({
          claimId: claim.claimId,
          policyId: claim.policyId,
          previousStatus: claim.status,
          originalDecisionId: claim.originalDecisionId,
          proposedAction: "skip_decision_still_invalid",
          payoutDeltaUsd: 0,
          requiresOperatorApproval: false,
          reason: "Target consensus decision is missing or still not corroborated",
        });
        continue;
      }

      // Verify the incident occurred while the policy was active (even if the policy expired before re-evaluation)
      const incidentWithinPolicyTerm =
        claim.incidentTimestampMs >= claim.policyStartMs &&
        claim.incidentTimestampMs <= claim.policyEndMs;

      const triggersNow =
        incidentWithinPolicyTerm &&
        claim.payoutTriggerPredicate(restored.agreedValue);

      if (claim.status === "held_pending_trust") {
        if (triggersNow) {
          items.push({
            claimId: claim.claimId,
            policyId: claim.policyId,
            previousStatus: claim.status,
            originalDecisionId: claim.originalDecisionId,
            restoredDecisionId: restored.decisionId,
            restoredAgreedValue: restored.agreedValue,
            proposedAction: "settle_held_claim",
            payoutDeltaUsd: claim.payoutAmountUsd,
            requiresOperatorApproval: false,
            reason: `Corroborated value ${restored.agreedValue} satisfies trigger condition during active policy term`,
          });
        } else {
          items.push({
            claimId: claim.claimId,
            policyId: claim.policyId,
            previousStatus: claim.status,
            originalDecisionId: claim.originalDecisionId,
            restoredDecisionId: restored.decisionId,
            restoredAgreedValue: restored.agreedValue,
            proposedAction: "dismiss_held_claim_not_triggered",
            payoutDeltaUsd: 0,
            requiresOperatorApproval: false,
            reason: incidentWithinPolicyTerm
              ? `Corroborated value ${restored.agreedValue} did not meet payout threshold`
              : "Incident occurred outside active policy coverage term",
          });
        }
      } else if (claim.status === "settled") {
        if (!triggersNow) {
          items.push({
            claimId: claim.claimId,
            policyId: claim.policyId,
            previousStatus: claim.status,
            originalDecisionId: claim.originalDecisionId,
            restoredDecisionId: restored.decisionId,
            restoredAgreedValue: restored.agreedValue,
            proposedAction: "propose_reversal_of_settled_claim",
            payoutDeltaUsd: -claim.payoutAmountUsd,
            requiresOperatorApproval: true,
            reason: `Claim settled under degraded trust (${claim.originalDecisionId}), but corroborated decision ${restored.decisionId} (${restored.agreedValue}) does not trigger payout`,
          });
        } else {
          items.push({
            claimId: claim.claimId,
            policyId: claim.policyId,
            previousStatus: claim.status,
            originalDecisionId: claim.originalDecisionId,
            restoredDecisionId: restored.decisionId,
            restoredAgreedValue: restored.agreedValue,
            proposedAction: "no_change_needed",
            payoutDeltaUsd: 0,
            requiresOperatorApproval: false,
            reason: "Settled claim confirmed by restored corroborated decision",
          });
        }
      } else {
        items.push({
          claimId: claim.claimId,
          policyId: claim.policyId,
          previousStatus: claim.status,
          originalDecisionId: claim.originalDecisionId,
          restoredDecisionId: restored.decisionId,
          restoredAgreedValue: restored.agreedValue,
          proposedAction: "no_change_needed",
          payoutDeltaUsd: 0,
          requiresOperatorApproval: false,
          reason: "Already terminal",
        });
      }
    }

    this.seq += 1;
    const plan: ReevaluationPlan = {
      planId: `reeval-plan-${this.seq}`,
      createdAtMs: nowMs,
      items,
      hasMorePages,
      nextCursorOffset: offset + batch.length,
    };

    this.plans.set(plan.planId, plan);
    return plan;
  }

  public applyReevaluationPlan(params: {
    planId: string;
    operatorApprovalId?: string;
    nowMs?: number;
  }): {
    settledClaimIds: string[];
    dismissedClaimIds: string[];
    reversedClaimIds: string[];
    skippedUnapprovedReversalIds: string[];
  } {
    const plan = this.plans.get(params.planId);
    if (!plan) {
      throw new Error(`Unknown re-evaluation plan: ${params.planId}`);
    }

    const settledClaimIds: string[] = [];
    const dismissedClaimIds: string[] = [];
    const reversedClaimIds: string[] = [];
    const skippedUnapprovedReversalIds: string[] = [];

    for (const item of plan.items) {
      const claim = this.claims.get(item.claimId);
      if (!claim) continue;

      if (item.proposedAction === "settle_held_claim") {
        // Idempotent & respects exactly-once settlement
        if (!this.settledClaimIds.has(claim.claimId)) {
          this.settledClaimIds.add(claim.claimId);
          claim.status = "settled";
          claim.evaluatedTrustState = "healthy_corroborated";
          claim.settledDecisionId = item.restoredDecisionId;
          settledClaimIds.push(claim.claimId);
        }
      } else if (item.proposedAction === "dismiss_held_claim_not_triggered") {
        if (claim.status === "held_pending_trust") {
          claim.status = "not_triggered";
          claim.evaluatedTrustState = "healthy_corroborated";
          dismissedClaimIds.push(claim.claimId);
        }
      } else if (
        item.proposedAction === "propose_reversal_of_settled_claim"
      ) {
        if (!params.operatorApprovalId) {
          skippedUnapprovedReversalIds.push(claim.claimId);
          continue;
        }
        if (claim.status === "settled") {
          claim.status = "reversed_after_review";
          claim.reversedByApprovalId = params.operatorApprovalId;
          claim.evaluatedTrustState = "healthy_corroborated";
          reversedClaimIds.push(claim.claimId);
        }
      }
    }

    return {
      settledClaimIds,
      dismissedClaimIds,
      reversedClaimIds,
      skippedUnapprovedReversalIds,
    };
  }

  public getClaim(claimId: string): DegradedAffectedClaim | undefined {
    const c = this.claims.get(claimId);
    return c ? { ...c } : undefined;
  }
}
