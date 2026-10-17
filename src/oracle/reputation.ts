export interface OperatorObservationEvent {
  timestampMs: number;
  respondedToHeartbeat: boolean;
  deviationRatioFromConsensus?: number;
  slashedOrDisputeLost?: boolean;
}

export interface ReputationModelConfig {
  halfLifeMs: number;
  minObservationsForQuorum: number;
  probationThresholdBps: number;
  minWeightFloorBps: number;
  maxSingleOperatorWeightShareBps: number;
  tenureFullCreditMs: number;
  maxAcceptableDeviationRatio: number;
}

export interface OperatorReputationBreakdown {
  operatorId: string;
  observationCount: number;
  accuracyBps: number;
  availabilityBps: number;
  tenureBonusBps: number;
  penaltyBps: number;
  effectiveScoreBps: number;
  probationary: boolean;
  computedAtMs: number;
}

export interface WeightedConsensusDecision {
  status: "corroborated" | "insufficient_eligible_operators";
  agreedValue: number | null;
  eligibleOperators: string[];
  probationaryExcludedOperators: string[];
  operatorWeightSnapshot: Record<
    string,
    { rawScoreBps: number; cappedNormalizedWeightBps: number }
  >;
}

const DEFAULT_REPUTATION_CONFIG: ReputationModelConfig = {
  halfLifeMs: 24 * 60 * 60 * 1_000, // 24h half-life
  minObservationsForQuorum: 5,
  probationThresholdBps: 4_000, // 40%
  minWeightFloorBps: 1_000, // 10% floor
  maxSingleOperatorWeightShareBps: 4_500, // 45% max share per operator
  tenureFullCreditMs: 30 * 24 * 60 * 60 * 1_000, // 30 days
  maxAcceptableDeviationRatio: 0.05,
};

export function computeOperatorReputation(params: {
  operatorId: string;
  registeredAtMs: number;
  events: OperatorObservationEvent[];
  nowMs: number;
  config?: Partial<ReputationModelConfig>;
}): OperatorReputationBreakdown {
  const cfg: ReputationModelConfig = {
    ...DEFAULT_REPUTATION_CONFIG,
    ...params.config,
  };

  const validEvents = params.events.filter((e) => e.timestampMs <= params.nowMs);
  if (validEvents.length === 0) {
    return {
      operatorId: params.operatorId,
      observationCount: 0,
      accuracyBps: 5_000,
      availabilityBps: 0,
      tenureBonusBps: 0,
      penaltyBps: 0,
      effectiveScoreBps: cfg.minWeightFloorBps,
      probationary: true,
      computedAtMs: params.nowMs,
    };
  }

  let totalDecayWeight = 0;
  let weightedAvailability = 0;
  let totalAccuracyWeight = 0;
  let weightedAccuracy = 0;
  let weightedPenalty = 0;

  const ln2 = Math.LN2;
  for (const ev of validEvents) {
    const ageMs = Math.max(0, params.nowMs - ev.timestampMs);
    const decayWeight = Math.exp((-ln2 * ageMs) / Math.max(1, cfg.halfLifeMs));
    totalDecayWeight += decayWeight;

    if (ev.respondedToHeartbeat) {
      weightedAvailability += decayWeight;
    }

    if (
      ev.respondedToHeartbeat &&
      ev.deviationRatioFromConsensus !== undefined &&
      Number.isFinite(ev.deviationRatioFromConsensus)
    ) {
      const normalizedErr = Math.min(
        1,
        Math.max(0, ev.deviationRatioFromConsensus) /
          Math.max(1e-9, cfg.maxAcceptableDeviationRatio)
      );
      const eventAccuracy = 1 - normalizedErr;
      weightedAccuracy += decayWeight * eventAccuracy;
      totalAccuracyWeight += decayWeight;
    }

    if (ev.slashedOrDisputeLost) {
      weightedPenalty += decayWeight * 3_500; // 3500 bps decayed penalty per slash/lost dispute
    }
  }

  const availabilityBps = Math.round(
    (weightedAvailability / Math.max(1e-9, totalDecayWeight)) * 10_000
  );
  const accuracyBps =
    totalAccuracyWeight > 0
      ? Math.round(
          (weightedAccuracy / Math.max(1e-9, totalAccuracyWeight)) * 10_000
        )
      : 5_000;

  const tenureMs = Math.max(0, params.nowMs - params.registeredAtMs);
  const tenureBonusBps = Math.round(
    Math.min(1, tenureMs / Math.max(1, cfg.tenureFullCreditMs)) * 1_000
  );

  const penaltyBps = Math.min(8_000, Math.round(weightedPenalty));

  // Weighted blend: 55% accuracy + 35% availability + 10% tenure - decayed penalties
  const rawComposite =
    Math.round(accuracyBps * 0.55 + availabilityBps * 0.35 + tenureBonusBps) -
    penaltyBps;

  const effectiveScoreBps = Math.max(
    cfg.minWeightFloorBps,
    Math.min(10_000, rawComposite)
  );

  const probationary =
    validEvents.length < cfg.minObservationsForQuorum ||
    effectiveScoreBps < cfg.probationThresholdBps;

  return {
    operatorId: params.operatorId,
    observationCount: validEvents.length,
    accuracyBps,
    availabilityBps,
    tenureBonusBps,
    penaltyBps,
    effectiveScoreBps,
    probationary,
    computedAtMs: params.nowMs,
  };
}

export function computeReputationWeightedConsensus(params: {
  readings: Array<{ operatorId: string; value: number }>;
  reputationSnapshots: Record<string, OperatorReputationBreakdown>;
  minEligibleOperators: number;
  maxSingleOperatorWeightShareBps?: number;
}): WeightedConsensusDecision {
  const maxShareBps =
    params.maxSingleOperatorWeightShareBps ??
    DEFAULT_REPUTATION_CONFIG.maxSingleOperatorWeightShareBps;

  const probationaryExcludedOperators: string[] = [];
  const eligible: Array<{
    operatorId: string;
    value: number;
    rawScoreBps: number;
  }> = [];

  for (const r of params.readings) {
    const rep = params.reputationSnapshots[r.operatorId];
    if (!rep || rep.probationary) {
      probationaryExcludedOperators.push(r.operatorId);
      continue;
    }
    eligible.push({
      operatorId: r.operatorId,
      value: r.value,
      rawScoreBps: Math.max(1, rep.effectiveScoreBps),
    });
  }

  if (eligible.length < params.minEligibleOperators) {
    return {
      status: "insufficient_eligible_operators",
      agreedValue: null,
      eligibleOperators: eligible.map((e) => e.operatorId),
      probationaryExcludedOperators,
      operatorWeightSnapshot: {},
    };
  }

  // Normalize weights to 10,000 bps and cap any single operator at maxShareBps
  const rawSum = eligible.reduce((acc, e) => acc + e.rawScoreBps, 0);
  const rawShares = eligible.map((e) => ({
    ...e,
    weightBps: Math.max(1, Math.round((e.rawScoreBps / rawSum) * 10_000)),
  }));

  // Iteratively cap and redistribute excess weight so no single operator unilaterally controls the median
  for (let iter = 0; iter < 5; iter++) {
    let excess = 0;
    let uncappedCount = 0;
    for (const item of rawShares) {
      if (item.weightBps > maxShareBps) {
        excess += item.weightBps - maxShareBps;
        item.weightBps = maxShareBps;
      } else {
        uncappedCount += 1;
      }
    }
    if (excess <= 0 || uncappedCount === 0) break;
    const bonusEach = Math.floor(excess / uncappedCount);
    for (const item of rawShares) {
      if (item.weightBps < maxShareBps) {
        item.weightBps = Math.min(maxShareBps, item.weightBps + bonusEach);
      }
    }
  }

  const operatorWeightSnapshot: Record<
    string,
    { rawScoreBps: number; cappedNormalizedWeightBps: number }
  > = {};
  for (const item of rawShares) {
    operatorWeightSnapshot[item.operatorId] = {
      rawScoreBps: item.rawScoreBps,
      cappedNormalizedWeightBps: item.weightBps,
    };
  }

  // Compute weighted median
  const sortedByVal = [...rawShares].sort((a, b) => a.value - b.value);
  const totalWeight = sortedByVal.reduce((acc, e) => acc + e.weightBps, 0);
  const halfWeight = totalWeight / 2;

  let cumulative = 0;
  let agreedValue = sortedByVal[sortedByVal.length - 1]!.value;
  for (let i = 0; i < sortedByVal.length; i++) {
    cumulative += sortedByVal[i]!.weightBps;
    if (cumulative > halfWeight) {
      agreedValue = sortedByVal[i]!.value;
      break;
    }
    if (cumulative === halfWeight && i + 1 < sortedByVal.length) {
      agreedValue = (sortedByVal[i]!.value + sortedByVal[i + 1]!.value) / 2;
      break;
    }
  }

  return {
    status: "corroborated",
    agreedValue,
    eligibleOperators: eligible.map((e) => e.operatorId),
    probationaryExcludedOperators,
    operatorWeightSnapshot,
  };
}
