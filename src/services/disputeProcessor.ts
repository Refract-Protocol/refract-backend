export type DisputeStatus =
  | "open"
  | "under_review"
  | "upheld"
  | "reversed"
  | "withdrawn";

export type BondDisposition = "locked" | "forfeited" | "refunded";

export interface OracleDecisionSnapshot {
  readonly decisionId: string;
  readonly coverageType: string;
  readonly claimId: string;
  readonly agreedValue: number;
  readonly payoutTriggered: boolean;
  readonly decidedAtMs: number;
  readonly supersedesDecisionId?: string;
}

export interface DisputeRecord {
  disputeId: string;
  decisionId: string;
  coverageType: string;
  challengerId: string;
  reason: string;
  bondReferenceId: string;
  bondAmount: bigint;
  bondDisposition: BondDisposition;
  status: DisputeStatus;
  openedAtMs: number;
  resolvedAtMs?: number;
  replacementDecisionId?: string;
}

export interface DisputeLifecycleEvent {
  eventId: string;
  disputeId: string;
  decisionId: string;
  status: DisputeStatus;
  timestampMs: number;
}

export interface DisputeProcessorConfig {
  challengeWindowMsByCoverage: Record<string, number>;
  minDisputeBondAmount: bigint;
  authorizedChallengers?: string[];
}

export class BondedDisputeProcessor {
  private readonly config: DisputeProcessorConfig;
  private readonly decisions = new Map<string, OracleDecisionSnapshot>();
  private readonly disputes = new Map<string, DisputeRecord>();
  private readonly activeDisputeByDecision = new Map<string, string>();
  private readonly paidClaims = new Set<string>();
  private readonly events: DisputeLifecycleEvent[] = [];
  private seq = 0;

  constructor(config: DisputeProcessorConfig) {
    this.config = config;
  }

  public recordDecision(decision: OracleDecisionSnapshot): void {
    // Store frozen copy to guarantee strict immutability of original decision records
    this.decisions.set(decision.decisionId, Object.freeze({ ...decision }));
  }

  public openDispute(params: {
    decisionId: string;
    challengerId: string;
    reason: string;
    bondReferenceId: string;
    bondAmount: bigint;
    nowMs?: number;
  }): DisputeRecord {
    const nowMs = params.nowMs ?? Date.now();
    if (
      this.config.authorizedChallengers &&
      !this.config.authorizedChallengers.includes(params.challengerId)
    ) {
      throw new Error("UNAUTHORIZED_CHALLENGER");
    }

    if (
      !params.bondReferenceId ||
      params.bondAmount < this.config.minDisputeBondAmount
    ) {
      throw new Error("INSUFFICIENT_OR_MISSING_DISPUTE_BOND");
    }

    const decision = this.decisions.get(params.decisionId);
    if (!decision) {
      throw new Error(`UNKNOWN_DECISION:${params.decisionId}`);
    }

    const windowMs =
      this.config.challengeWindowMsByCoverage[decision.coverageType] ?? 300_000;
    if (nowMs - decision.decidedAtMs > windowMs) {
      throw new Error("DECISION_CHALLENGE_WINDOW_CLOSED");
    }

    if (this.activeDisputeByDecision.has(params.decisionId)) {
      throw new Error("DUPLICATE_ACTIVE_DISPUTE");
    }

    this.seq += 1;
    const dispute: DisputeRecord = {
      disputeId: `dsp-${this.seq}`,
      decisionId: params.decisionId,
      coverageType: decision.coverageType,
      challengerId: params.challengerId,
      reason: params.reason,
      bondReferenceId: params.bondReferenceId,
      bondAmount: params.bondAmount,
      bondDisposition: "locked",
      status: "open",
      openedAtMs: nowMs,
    };

    this.disputes.set(dispute.disputeId, dispute);
    this.activeDisputeByDecision.set(params.decisionId, dispute.disputeId);
    this.emitEvent(dispute.disputeId, dispute.decisionId, "open", nowMs);
    return { ...dispute };
  }

  public beginReview(
    disputeId: string,
    nowMs: number = Date.now()
  ): DisputeRecord {
    const dispute = this.getMutableDispute(disputeId);
    if (dispute.status !== "open") {
      throw new Error(`Cannot transition to under_review from ${dispute.status}`);
    }
    dispute.status = "under_review";
    this.emitEvent(dispute.disputeId, dispute.decisionId, "under_review", nowMs);
    return { ...dispute };
  }

  public withdrawDispute(
    disputeId: string,
    challengerId: string,
    nowMs: number = Date.now()
  ): DisputeRecord {
    const dispute = this.getMutableDispute(disputeId);
    if (dispute.challengerId !== challengerId) {
      throw new Error("ONLY_CHALLENGER_CAN_WITHDRAW");
    }
    if (dispute.status !== "open") {
      throw new Error(`Cannot withdraw dispute in state ${dispute.status}`);
    }
    dispute.status = "withdrawn";
    dispute.bondDisposition = "refunded";
    dispute.resolvedAtMs = nowMs;
    this.activeDisputeByDecision.delete(dispute.decisionId);
    this.emitEvent(dispute.disputeId, dispute.decisionId, "withdrawn", nowMs);
    return { ...dispute };
  }

  public resolveDispute(params: {
    disputeId: string;
    outcome: "upheld" | "reversed";
    recomputedValue?: number;
    recomputedPayoutTriggered?: boolean;
    nowMs?: number;
  }): {
    dispute: DisputeRecord;
    replacementDecision?: OracleDecisionSnapshot;
    compensatingPayoutExecuted: boolean;
  } {
    const nowMs = params.nowMs ?? Date.now();
    const dispute = this.getMutableDispute(params.disputeId);
    if (dispute.status !== "open" && dispute.status !== "under_review") {
      throw new Error(`Dispute ${params.disputeId} is already terminal`);
    }

    const originalDecision = this.decisions.get(dispute.decisionId)!;
    this.activeDisputeByDecision.delete(dispute.decisionId);
    dispute.resolvedAtMs = nowMs;

    if (params.outcome === "upheld") {
      dispute.status = "upheld";
      dispute.bondDisposition = "forfeited";
      this.emitEvent(dispute.disputeId, dispute.decisionId, "upheld", nowMs);
      return {
        dispute: { ...dispute },
        compensatingPayoutExecuted: false,
      };
    }

    // Outcome === "reversed": create a new immutable superseding decision without mutating original
    this.seq += 1;
    const replacementDecision: OracleDecisionSnapshot = Object.freeze({
      decisionId: `dec-rev-${this.seq}`,
      coverageType: originalDecision.coverageType,
      claimId: originalDecision.claimId,
      agreedValue: params.recomputedValue ?? originalDecision.agreedValue,
      payoutTriggered:
        params.recomputedPayoutTriggered ?? !originalDecision.payoutTriggered,
      decidedAtMs: nowMs,
      supersedesDecisionId: originalDecision.decisionId,
    });
    this.decisions.set(replacementDecision.decisionId, replacementDecision);

    dispute.status = "reversed";
    dispute.bondDisposition = "refunded";
    dispute.replacementDecisionId = replacementDecision.decisionId;
    this.emitEvent(dispute.disputeId, dispute.decisionId, "reversed", nowMs);

    let compensatingPayoutExecuted = false;
    if (
      replacementDecision.payoutTriggered &&
      !this.paidClaims.has(replacementDecision.claimId)
    ) {
      this.paidClaims.add(replacementDecision.claimId);
      compensatingPayoutExecuted = true;
    }

    return {
      dispute: { ...dispute },
      replacementDecision,
      compensatingPayoutExecuted,
    };
  }

  public trySettleClaimForDecision(decisionId: string): {
    settled: boolean;
    reason?: "ACTIVE_DISPUTE_HOLD" | "ALREADY_PAID" | "NOT_TRIGGERED";
  } {
    const decision = this.decisions.get(decisionId);
    if (!decision) {
      throw new Error(`UNKNOWN_DECISION:${decisionId}`);
    }
    if (this.activeDisputeByDecision.has(decisionId)) {
      return { settled: false, reason: "ACTIVE_DISPUTE_HOLD" };
    }
    if (!decision.payoutTriggered) {
      return { settled: false, reason: "NOT_TRIGGERED" };
    }
    if (this.paidClaims.has(decision.claimId)) {
      return { settled: false, reason: "ALREADY_PAID" };
    }
    this.paidClaims.add(decision.claimId);
    return { settled: true };
  }

  public getDecision(decisionId: string): OracleDecisionSnapshot | undefined {
    return this.decisions.get(decisionId);
  }

  public getDispute(disputeId: string): DisputeRecord | undefined {
    const d = this.disputes.get(disputeId);
    return d ? { ...d } : undefined;
  }

  public getOpenDisputeCount(): number {
    let count = 0;
    for (const d of this.disputes.values()) {
      if (d.status === "open" || d.status === "under_review") {
        count += 1;
      }
    }
    return count;
  }

  public getTrustEvents(): DisputeLifecycleEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  private getMutableDispute(disputeId: string): DisputeRecord {
    const d = this.disputes.get(disputeId);
    if (!d) {
      throw new Error(`UNKNOWN_DISPUTE:${disputeId}`);
    }
    return d;
  }

  private emitEvent(
    disputeId: string,
    decisionId: string,
    status: DisputeStatus,
    timestampMs: number
  ): void {
    this.seq += 1;
    this.events.push({
      eventId: `evt-${this.seq}`,
      disputeId,
      decisionId,
      status,
      timestampMs,
    });
  }
}
