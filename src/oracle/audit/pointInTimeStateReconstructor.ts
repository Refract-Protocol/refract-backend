export type CallerRole = "public" | "operator" | "auditor";

export interface HistoricalReadingEvent {
  sourceId: string;
  feedId: string;
  observedAtMs: number;
  ingestedAtMs: number;
  ledgerSequence: number;
  value: number;
  payloadHash: string;
}

export interface HistoricalSourceStateEvent {
  sourceId: string;
  effectiveAtMs: number;
  ledgerSequence: number;
  eligible: boolean;
  trustTier: string;
}

export interface HistoricalQuorumPolicyEvent {
  policyHash: string;
  effectiveAtMs: number;
  ledgerSequence: number;
  minIndependentSources: number;
  maxRelativeSpreadBps: number;
}

export interface ReconstructedPointInTimeState {
  asOfTimestampMs: number;
  asOfLedgerSequence: number;
  feedId: string;
  activePolicy: HistoricalQuorumPolicyEvent;
  sourceEligibility: Record<string, { eligible: boolean; trustTier: string }>;
  visibleReadings: HistoricalReadingEvent[];
  recomputedMedianValue: number | null;
  quorumMet: boolean;
}

export class PointInTimeStateReconstructor {
  private readonly readings: HistoricalReadingEvent[] = [];
  private readonly sourceStates: HistoricalSourceStateEvent[] = [];
  private readonly policies: HistoricalQuorumPolicyEvent[] = [];

  public appendReading(reading: HistoricalReadingEvent): void {
    this.readings.push({ ...reading });
  }

  public appendSourceState(state: HistoricalSourceStateEvent): void {
    this.sourceStates.push({ ...state });
  }

  public appendPolicy(policy: HistoricalQuorumPolicyEvent): void {
    this.policies.push({ ...policy });
  }

  public reconstructState(params: {
    callerRole: CallerRole;
    feedId: string;
    asOfTimestampMs: number;
    asOfLedgerSequence: number;
    maxFreshnessWindowMs: number;
  }): ReconstructedPointInTimeState {
    if (params.callerRole !== "auditor" && params.callerRole !== "operator") {
      throw new Error(`Unauthorized role '${params.callerRole}' for point-in-time state reconstruction`);
    }

    const eligiblePolicies = this.policies
      .filter(
        (p) =>
          p.effectiveAtMs <= params.asOfTimestampMs &&
          p.ledgerSequence <= params.asOfLedgerSequence
      )
      .sort((a, b) => b.effectiveAtMs - a.effectiveAtMs || b.ledgerSequence - a.ledgerSequence);

    if (eligiblePolicies.length === 0) {
      throw new Error("No quorum policy snapshot found at or before requested point in time");
    }
    const activePolicy = eligiblePolicies[0];

    const sourceEligibility: Record<string, { eligible: boolean; trustTier: string }> = {};
    const sortedStates = this.sourceStates
      .filter(
        (s) =>
          s.effectiveAtMs <= params.asOfTimestampMs &&
          s.ledgerSequence <= params.asOfLedgerSequence
      )
      .sort((a, b) => a.effectiveAtMs - b.effectiveAtMs || a.ledgerSequence - b.ledgerSequence);

    for (const st of sortedStates) {
      sourceEligibility[st.sourceId] = { eligible: st.eligible, trustTier: st.trustTier };
    }

    const minObservedAtMs = params.asOfTimestampMs - params.maxFreshnessWindowMs;
    const latestPerSource = new Map<string, HistoricalReadingEvent>();

    const candidateReadings = this.readings
      .filter(
        (r) =>
          r.feedId === params.feedId &&
          r.ingestedAtMs <= params.asOfTimestampMs &&
          r.ledgerSequence <= params.asOfLedgerSequence &&
          r.observedAtMs >= minObservedAtMs &&
          r.observedAtMs <= params.asOfTimestampMs &&
          sourceEligibility[r.sourceId]?.eligible === true
      )
      .sort((a, b) => a.observedAtMs - b.observedAtMs || a.ingestedAtMs - b.ingestedAtMs);

    for (const r of candidateReadings) {
      latestPerSource.set(r.sourceId, r);
    }

    const visibleReadings = Array.from(latestPerSource.values()).sort((a, b) =>
      a.sourceId.localeCompare(b.sourceId)
    );

    const values = visibleReadings.map((r) => r.value).sort((a, b) => a - b);
    let recomputedMedianValue: number | null = null;
    if (values.length > 0) {
      const mid = Math.floor(values.length / 2);
      recomputedMedianValue =
        values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
    }

    const quorumMet = visibleReadings.length >= activePolicy.minIndependentSources;

    return {
      asOfTimestampMs: params.asOfTimestampMs,
      asOfLedgerSequence: params.asOfLedgerSequence,
      feedId: params.feedId,
      activePolicy,
      sourceEligibility,
      visibleReadings,
      recomputedMedianValue,
      quorumMet,
    };
  }
}
