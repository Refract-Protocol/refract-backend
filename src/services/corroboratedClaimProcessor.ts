export type PendingTrustReason =
  | "missing_decision"
  | "quorum_not_met"
  | "stale_decision"
  | "low_confidence";

export type PolicySettlementStatus =
  | "active_monitoring"
  | "pending_trust"
  | "settled"
  | "not_triggered";

export interface ConsensusSettlementDecision {
  decisionId: string;
  feedId: string;
  agreedValue: number;
  quorumSatisfied: boolean;
  participatingSourcesCount: number;
  requiredQuorumSources: number;
  confidenceBps: number;
  decidedAtMs: number;
}

export interface CoveragePolicyRecord {
  policyId: string;
  feedId: string;
  payoutAmountUsd: number;
  status: PolicySettlementStatus;
  pendingTrustReason?: PendingTrustReason;
  settledDecisionId?: string;
  settledAtMs?: number;
  triggerPredicate: (agreedValue: number) => boolean;
}

export interface DecisionValidationOutcome {
  valid: boolean;
  decision?: ConsensusSettlementDecision;
  invalidReason?: PendingTrustReason;
}

export interface CorroboratedClaimProcessorConfig {
  maxDecisionAgeMs: number;
  minConfidenceBps: number;
}

export class CorroboratedClaimProcessor {
  private readonly latestDecisionsByFeed = new Map<
    string,
    ConsensusSettlementDecision
  >();
  private readonly policies = new Map<string, CoveragePolicyRecord>();
  private readonly settledPolicyIds = new Set<string>();
  private readonly inFlightPolicyLocks = new Set<string>();
  private readonly config: CorroboratedClaimProcessorConfig;

  constructor(config?: Partial<CorroboratedClaimProcessorConfig>) {
    this.config = {
      maxDecisionAgeMs: config?.maxDecisionAgeMs ?? 60_000,
      minConfidenceBps: config?.minConfidenceBps ?? 7_000,
    };
  }

  public recordConsensusDecision(decision: ConsensusSettlementDecision): void {
    this.latestDecisionsByFeed.set(decision.feedId, { ...decision });
  }

  public registerPolicy(policy: CoveragePolicyRecord): void {
    this.policies.set(policy.policyId, { ...policy });
    if (policy.status === "settled") {
      this.settledPolicyIds.add(policy.policyId);
    }
  }

  public getSettlementDecision(
    feedId: string,
    nowMs: number = Date.now()
  ): DecisionValidationOutcome {
    const decision = this.latestDecisionsByFeed.get(feedId);
    if (!decision) {
      return { valid: false, invalidReason: "missing_decision" };
    }

    if (
      !decision.quorumSatisfied ||
      decision.participatingSourcesCount < decision.requiredQuorumSources
    ) {
      return { valid: false, invalidReason: "quorum_not_met" };
    }

    const ageMs = nowMs - decision.decidedAtMs;
    if (ageMs > this.config.maxDecisionAgeMs || ageMs < -5_000) {
      return { valid: false, invalidReason: "stale_decision" };
    }

    if (decision.confidenceBps < this.config.minConfidenceBps) {
      return { valid: false, invalidReason: "low_confidence" };
    }

    return { valid: true, decision: { ...decision } };
  }

  public scanAndEvaluatePolicies(nowMs: number = Date.now()): {
    settledPolicyIds: string[];
    pendingTrustPolicyIds: string[];
    notTriggeredPolicyIds: string[];
  } {
    const settledPolicyIds: string[] = [];
    const pendingTrustPolicyIds: string[] = [];
    const notTriggeredPolicyIds: string[] = [];

    for (const policy of this.policies.values()) {
      if (
        this.settledPolicyIds.has(policy.policyId) ||
        this.inFlightPolicyLocks.has(policy.policyId)
      ) {
        continue;
      }

      this.inFlightPolicyLocks.add(policy.policyId);
      try {
        const validation = this.getSettlementDecision(policy.feedId, nowMs);
        if (!validation.valid || !validation.decision) {
          policy.status = "pending_trust";
          policy.pendingTrustReason = validation.invalidReason;
          pendingTrustPolicyIds.push(policy.policyId);
          continue;
        }

        const decision = validation.decision;
        if (policy.triggerPredicate(decision.agreedValue)) {
          this.settledPolicyIds.add(policy.policyId);
          policy.status = "settled";
          policy.settledDecisionId = decision.decisionId;
          policy.settledAtMs = nowMs;
          policy.pendingTrustReason = undefined;
          settledPolicyIds.push(policy.policyId);
        } else {
          policy.status = "not_triggered";
          policy.pendingTrustReason = undefined;
          notTriggeredPolicyIds.push(policy.policyId);
        }
      } finally {
        this.inFlightPolicyLocks.delete(policy.policyId);
      }
    }

    return {
      settledPolicyIds,
      pendingTrustPolicyIds,
      notTriggeredPolicyIds,
    };
  }

  public rejectRawReadingSettlement(): never {
    throw new Error(
      "RAW_READING_SETTLEMENT_FORBIDDEN: claimProcessor settles exclusively on corroborated consensus decisions"
    );
  }

  public getPolicy(policyId: string): CoveragePolicyRecord | undefined {
    const p = this.policies.get(policyId);
    return p ? { ...p } : undefined;
  }

  public getPendingTrustPolicies(): CoveragePolicyRecord[] {
    const list: CoveragePolicyRecord[] = [];
    for (const p of this.policies.values()) {
      if (p.status === "pending_trust") {
        list.push({ ...p });
      }
    }
    return list;
  }
}
