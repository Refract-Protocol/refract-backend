export type HoldReasonCode =
  | "missing_raw_payload"
  | "quorum_shortfall"
  | "warming_up_source_included"
  | "unverified_provider_signature";

export interface ContributingEvidenceItem {
  sourceId: string;
  hasRawPayload: boolean;
  isWarmingUp: boolean;
  signatureVerified: boolean;
}

export interface PayoutHoldEvaluationInput {
  decisionId: string;
  requiredIndependentSources: number;
  actualIndependentSources: number;
  evidenceItems: ContributingEvidenceItem[];
  evaluatedAtMs: number;
}

export interface PayoutHoldRecord {
  decisionId: string;
  status: "ready_for_settlement" | "payout_held" | "escalated_for_review";
  holdReasons: HoldReasonCode[];
  heldSinceMs?: number;
  releasedAtMs?: number;
}

export class IncompleteEvidencePayoutHoldManager {
  private readonly maxHoldDurationMs: number;
  private readonly records = new Map<string, PayoutHoldRecord>();

  constructor(maxHoldDurationMs: number) {
    this.maxHoldDurationMs = maxHoldDurationMs;
  }

  public evaluateDecision(input: PayoutHoldEvaluationInput): PayoutHoldRecord {
    const reasons = new Set<HoldReasonCode>();

    if (input.actualIndependentSources < input.requiredIndependentSources) {
      reasons.add("quorum_shortfall");
    }

    for (const item of input.evidenceItems) {
      if (!item.hasRawPayload) reasons.add("missing_raw_payload");
      if (item.isWarmingUp) reasons.add("warming_up_source_included");
      if (!item.signatureVerified) reasons.add("unverified_provider_signature");
    }

    const existing = this.records.get(input.decisionId);
    const holdReasons = Array.from(reasons);

    if (holdReasons.length === 0) {
      const released: PayoutHoldRecord = {
        decisionId: input.decisionId,
        status: "ready_for_settlement",
        holdReasons: [],
        heldSinceMs: existing?.heldSinceMs,
        releasedAtMs: existing?.status === "payout_held" ? input.evaluatedAtMs : existing?.releasedAtMs,
      };
      this.records.set(input.decisionId, released);
      return released;
    }

    const heldSinceMs = existing?.heldSinceMs ?? input.evaluatedAtMs;
    const elapsedMs = input.evaluatedAtMs - heldSinceMs;
    const status =
      elapsedMs >= this.maxHoldDurationMs ? "escalated_for_review" : "payout_held";

    const record: PayoutHoldRecord = {
      decisionId: input.decisionId,
      status,
      holdReasons,
      heldSinceMs,
    };
    this.records.set(input.decisionId, record);
    return record;
  }
}
