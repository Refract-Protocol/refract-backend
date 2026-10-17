/**
 * Read-Only What-If Simulator for Quorum, Threshold, and Anomaly Parameter Changes
 * Against Historical Readings (Issue #244)
 *
 * Replays recorded historical reading windows through pure consensus, outlier,
 * freshness, and payout-trigger logic without mutating any state, diffs simulated
 * decisions against historical baseline decisions, computes policy payout impact,
 * and refuses to run when historical evidence coverage is incomplete.
 */

export interface HistoricalSourceReading {
  sourceId: string;
  valueBps: number;
  observedAtMs: number;
}

export interface HistoricalRoundWindow {
  roundId: string;
  windowEndMs: number;
  readings: readonly HistoricalSourceReading[];
  /** Baseline decision recorded in production for this round (if quorum was reached) */
  baselineDecision?: {
    consensusValueBps: number;
    triggeredPayout: boolean;
    contributingSources: readonly string[];
    decidedAtMs: number;
  };
}

export interface SimulatedPolicySnapshot {
  policyId: string;
  coverageAmountStroops: bigint;
  /** Optional policy-specific trigger override; defaults to parameter set's payoutTriggerThresholdBps */
  customTriggerThresholdBps?: number;
}

export interface WhatIfParameterSet {
  quorumCount: number;
  freshnessWindowMs: number;
  maxOutlierDeviationBps: number;
  payoutTriggerThresholdBps: number;
}

export type DecisionDiffKind =
  | "unchanged"
  | "added"
  | "suppressed"
  | "changed_in_value"
  | "trigger_flipped";

export type ResponsibleParameterRule =
  | "none"
  | "quorum_count_change"
  | "freshness_window_change"
  | "outlier_filter_change"
  | "trigger_threshold_change";

export interface RoundSimulationDiff {
  roundId: string;
  windowEndMs: number;
  diffKind: DecisionDiffKind;
  responsibleRule: ResponsibleParameterRule;
  baselineConsensusValueBps?: number;
  simulatedConsensusValueBps?: number;
  baselineTriggered: boolean;
  simulatedTriggered: boolean;
  simulatedContributingSources: string[];
}

export interface PolicyPayoutImpactSummary {
  baselineTriggeredPolicyIds: string[];
  simulatedTriggeredPolicyIds: string[];
  newlyTriggeredPolicyIds: string[];
  newlySuppressedPolicyIds: string[];
  baselineTotalPayoutStroops: bigint;
  simulatedTotalPayoutStroops: bigint;
  netPayoutDeltaStroops: bigint;
}

export interface WhatIfSimulationReport {
  feedId: string;
  startTimeMs: number;
  endTimeMs: number;
  evaluatedRoundsCount: number;
  counts: {
    unchanged: number;
    added: number;
    suppressed: number;
    changedInValue: number;
    triggerFlipped: number;
  };
  roundDiffs: RoundSimulationDiff[];
  payoutImpact: PolicyPayoutImpactSummary;
}

export interface SimulationRunRequest {
  feedId: string;
  startTimeMs: number;
  endTimeMs: number;
  minRequiredWindows?: number;
  maxAllowedEvidenceGapMs?: number;
  historicalWindows: readonly HistoricalRoundWindow[];
  activePolicies: readonly SimulatedPolicySnapshot[];
  candidateParams: WhatIfParameterSet;
}

function computeMedianBps(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Pure, non-mutating What-If Simulator.
 * Refuses to execute when historical evidence coverage is insufficient.
 */
export function runWhatIfParameterSimulation(
  request: SimulationRunRequest
): WhatIfSimulationReport {
  if (request.endTimeMs <= request.startTimeMs) {
    throw new Error("endTimeMs must be greater than startTimeMs");
  }

  const inRangeWindows = request.historicalWindows
    .filter(
      (w) =>
        w.windowEndMs >= request.startTimeMs && w.windowEndMs <= request.endTimeMs
    )
    .sort((a, b) => a.windowEndMs - b.windowEndMs);

  const minRequired = request.minRequiredWindows ?? 1;
  if (inRangeWindows.length < minRequired) {
    throw new Error(
      `Insufficient historical evidence coverage for feed "${request.feedId}": found ${inRangeWindows.length} window(s), minimum required is ${minRequired}`
    );
  }

  if (request.maxAllowedEvidenceGapMs !== undefined && inRangeWindows.length > 1) {
    for (let i = 1; i < inRangeWindows.length; i++) {
      const gap = inRangeWindows[i].windowEndMs - inRangeWindows[i - 1].windowEndMs;
      if (gap > request.maxAllowedEvidenceGapMs) {
        throw new Error(
          `Insufficient historical evidence coverage for feed "${request.feedId}": gap of ${gap}ms between rounds "${inRangeWindows[i - 1].roundId}" and "${inRangeWindows[i].roundId}" exceeds maxAllowedEvidenceGapMs (${request.maxAllowedEvidenceGapMs}ms)`
        );
      }
    }
  }

  const params = request.candidateParams;
  const roundDiffs: RoundSimulationDiff[] = [];
  const counts = {
    unchanged: 0,
    added: 0,
    suppressed: 0,
    changedInValue: 0,
    triggerFlipped: 0,
  };

  let maxBaselineConsensusBps = -1;
  let maxSimulatedConsensusBps = -1;

  for (const win of inRangeWindows) {
    const baseline = win.baselineDecision;
    if (baseline && baseline.consensusValueBps > maxBaselineConsensusBps) {
      maxBaselineConsensusBps = baseline.consensusValueBps;
    }

    // Step 1: Freshness filter
    const freshReadings = win.readings.filter(
      (r) =>
        r.observedAtMs <= win.windowEndMs &&
        win.windowEndMs - r.observedAtMs <= params.freshnessWindowMs
    );

    // Step 2: Outlier filter against raw median of fresh readings
    let validReadings = freshReadings;
    if (freshReadings.length > 0) {
      const anchorMedian = computeMedianBps(freshReadings.map((r) => r.valueBps));
      validReadings = freshReadings.filter(
        (r) => Math.abs(r.valueBps - anchorMedian) <= params.maxOutlierDeviationBps
      );
    }

    // Deduplicate by sourceId (latest fresh reading wins)
    const bySource = new Map<string, HistoricalSourceReading>();
    for (const r of validReadings) {
      const prev = bySource.get(r.sourceId);
      if (!prev || r.observedAtMs >= prev.observedAtMs) {
        bySource.set(r.sourceId, r);
      }
    }
    const distinctValid = Array.from(bySource.values()).sort((a, b) =>
      a.sourceId.localeCompare(b.sourceId)
    );

    const hasQuorum = distinctValid.length >= params.quorumCount;
    const simulatedConsensusValueBps = hasQuorum
      ? computeMedianBps(distinctValid.map((r) => r.valueBps))
      : undefined;

    if (
      simulatedConsensusValueBps !== undefined &&
      simulatedConsensusValueBps > maxSimulatedConsensusBps
    ) {
      maxSimulatedConsensusBps = simulatedConsensusValueBps;
    }

    const simulatedTriggered =
      simulatedConsensusValueBps !== undefined &&
      simulatedConsensusValueBps >= params.payoutTriggerThresholdBps;
    const baselineTriggered = baseline?.triggeredPayout ?? false;

    let diffKind: DecisionDiffKind = "unchanged";
    let responsibleRule: ResponsibleParameterRule = "none";

    if (!baseline && hasQuorum) {
      diffKind = "added";
      responsibleRule = "quorum_count_change";
      counts.added += 1;
    } else if (baseline && !hasQuorum) {
      diffKind = "suppressed";
      if (freshReadings.length < params.quorumCount) {
        responsibleRule = "freshness_window_change";
      } else if (distinctValid.length < freshReadings.length) {
        responsibleRule = "outlier_filter_change";
      } else {
        responsibleRule = "quorum_count_change";
      }
      counts.suppressed += 1;
    } else if (baseline && hasQuorum) {
      if (baselineTriggered !== simulatedTriggered) {
        diffKind = "trigger_flipped";
        responsibleRule =
          baseline.consensusValueBps !== simulatedConsensusValueBps
            ? "outlier_filter_change"
            : "trigger_threshold_change";
        counts.triggerFlipped += 1;
      } else if (baseline.consensusValueBps !== simulatedConsensusValueBps) {
        diffKind = "changed_in_value";
        responsibleRule =
          distinctValid.length < freshReadings.length
            ? "outlier_filter_change"
            : "freshness_window_change";
        counts.changedInValue += 1;
      } else {
        counts.unchanged += 1;
      }
    } else {
      counts.unchanged += 1;
    }

    roundDiffs.push({
      roundId: win.roundId,
      windowEndMs: win.windowEndMs,
      diffKind,
      responsibleRule,
      baselineConsensusValueBps: baseline?.consensusValueBps,
      simulatedConsensusValueBps,
      baselineTriggered,
      simulatedTriggered,
      simulatedContributingSources: hasQuorum
        ? distinctValid.map((r) => r.sourceId)
        : [],
    });
  }

  // Evaluate policy-level payout impact across the simulated range
  const baselineTriggeredPolicyIds: string[] = [];
  const simulatedTriggeredPolicyIds: string[] = [];
  const newlyTriggeredPolicyIds: string[] = [];
  const newlySuppressedPolicyIds: string[] = [];
  let baselineTotalPayoutStroops = 0n;
  let simulatedTotalPayoutStroops = 0n;

  const anyBaselineRoundTriggered = inRangeWindows.some(
    (w) => w.baselineDecision?.triggeredPayout === true
  );

  for (const pol of request.activePolicies) {
    const threshold =
      pol.customTriggerThresholdBps ?? params.payoutTriggerThresholdBps;
    const baseTrig =
      pol.customTriggerThresholdBps !== undefined
        ? maxBaselineConsensusBps >= pol.customTriggerThresholdBps
        : anyBaselineRoundTriggered;
    const simTrig = maxSimulatedConsensusBps >= threshold;

    if (baseTrig) {
      baselineTriggeredPolicyIds.push(pol.policyId);
      baselineTotalPayoutStroops += pol.coverageAmountStroops;
    }
    if (simTrig) {
      simulatedTriggeredPolicyIds.push(pol.policyId);
      simulatedTotalPayoutStroops += pol.coverageAmountStroops;
    }
    if (!baseTrig && simTrig) {
      newlyTriggeredPolicyIds.push(pol.policyId);
    }
    if (baseTrig && !simTrig) {
      newlySuppressedPolicyIds.push(pol.policyId);
    }
  }

  return {
    feedId: request.feedId,
    startTimeMs: request.startTimeMs,
    endTimeMs: request.endTimeMs,
    evaluatedRoundsCount: inRangeWindows.length,
    counts,
    roundDiffs,
    payoutImpact: {
      baselineTriggeredPolicyIds,
      simulatedTriggeredPolicyIds,
      newlyTriggeredPolicyIds,
      newlySuppressedPolicyIds,
      baselineTotalPayoutStroops,
      simulatedTotalPayoutStroops,
      netPayoutDeltaStroops:
        simulatedTotalPayoutStroops - baselineTotalPayoutStroops,
    },
  };
}
