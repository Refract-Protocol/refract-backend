/**
 * Declarative, Versioned Trigger Rule Engine for Per-Coverage Payout Conditions (Issue #222)
 *
 * Replaces hard-coded payout comparisons with a validated, versioned rule set
 * evaluated purely over corroborated consensus decision history. Enforces confidence
 * floors, persistence duration/round requirements, and fail-closed handling on
 * incomplete history, no-quorum, or operator-paused states, plus offline backtesting.
 */

export type CoverageTypeName =
  | "StablecoinDepeg"
  | "FlightDelay"
  | "LiquidationShield"
  | "MarketCrash"
  | "SmartContractRisk";

export type DecisionExecutionState =
  | "corroborated_quorum"
  | "degraded_quorum"
  | "no_quorum"
  | "operator_paused";

export interface CorroboratedDecisionRecord {
  decisionId: string;
  feedId: string;
  roundNumber: number;
  valueBps: number;
  confidenceScoreBps: number;
  state: DecisionExecutionState;
  decidedAtMs: number;
}

export interface CoverageTriggerRule {
  ruleId: string;
  coverageType: CoverageTypeName;
  feedId: string;
  comparisonOp: "gte" | "lte";
  thresholdBps: number;
  /** Minimum consecutive corroborated rounds meeting threshold (1 = instantaneous) */
  minPersistenceRounds: number;
  /** Minimum elapsed duration (ms) across consecutive qualifying rounds (0 = instantaneous) */
  minPersistenceDurationMs: number;
  /** Minimum required confidence score in basis points */
  minConfidenceFloorBps: number;
  /** Maximum age (ms) of the latest decision relative to evaluation time */
  maxDecisionAgeMs: number;
  /** Whether degraded_quorum decisions are allowed if they still meet minConfidenceFloorBps */
  allowDegradedQuorum: boolean;
}

export interface CoverageTriggerRuleSet {
  ruleSetVersion: number;
  createdAtMs: number;
  rules: CoverageTriggerRule[];
}

export type TriggerEvaluationOutcomeCode =
  | "triggered"
  | "blocked_no_quorum"
  | "blocked_operator_paused"
  | "blocked_degraded_quorum_disallowed"
  | "blocked_stale_decision"
  | "blocked_confidence_below_floor"
  | "threshold_not_met"
  | "blocked_insufficient_persistence_history";

export interface TriggerEvaluationResult {
  coverageType: CoverageTypeName;
  ruleSetVersion: number;
  ruleId: string;
  decisionId: string;
  triggered: boolean;
  outcomeCode: TriggerEvaluationOutcomeCode;
  qualifyingConsecutiveRounds: number;
  qualifyingPersistenceDurationMs: number;
  explanation: string;
}

export interface HistoricalBacktestComparison {
  decisionId: string;
  coverageType: CoverageTypeName;
  baselineTriggered: boolean;
  candidateTriggered: boolean;
  candidateOutcomeCode: TriggerEvaluationOutcomeCode;
  changed: boolean;
}

export const DEFAULT_COVERAGE_TRIGGER_RULE_SET: CoverageTriggerRuleSet = {
  ruleSetVersion: 1,
  createdAtMs: 1_750_000_000_000,
  rules: [
    {
      ruleId: "rule_stablecoin_depeg_v1",
      coverageType: "StablecoinDepeg",
      feedId: "StablecoinDepeg",
      comparisonOp: "lte",
      thresholdBps: 9_500, // <= $0.9500 (500 bps depeg)
      minPersistenceRounds: 2,
      minPersistenceDurationMs: 60_000,
      minConfidenceFloorBps: 8_000,
      maxDecisionAgeMs: 120_000,
      allowDegradedQuorum: false,
    },
    {
      ruleId: "rule_flight_delay_v1",
      coverageType: "FlightDelay",
      feedId: "FlightDelay",
      comparisonOp: "gte",
      thresholdBps: 180, // >= 180 minutes delay
      minPersistenceRounds: 1,
      minPersistenceDurationMs: 0,
      minConfidenceFloorBps: 7_500,
      maxDecisionAgeMs: 300_000,
      allowDegradedQuorum: true,
    },
    {
      ruleId: "rule_liquidation_shield_v1",
      coverageType: "LiquidationShield",
      feedId: "LiquidationShield",
      comparisonOp: "gte",
      thresholdBps: 5_000,
      minPersistenceRounds: 2,
      minPersistenceDurationMs: 30_000,
      minConfidenceFloorBps: 8_500,
      maxDecisionAgeMs: 90_000,
      allowDegradedQuorum: false,
    },
    {
      ruleId: "rule_market_crash_v1",
      coverageType: "MarketCrash",
      feedId: "MarketCrash",
      comparisonOp: "gte",
      thresholdBps: 2_000,
      minPersistenceRounds: 2,
      minPersistenceDurationMs: 60_000,
      minConfidenceFloorBps: 8_000,
      maxDecisionAgeMs: 120_000,
      allowDegradedQuorum: false,
    },
    {
      ruleId: "rule_smart_contract_risk_v1",
      coverageType: "SmartContractRisk",
      feedId: "SmartContractRisk",
      comparisonOp: "gte",
      thresholdBps: 7_500,
      minPersistenceRounds: 1,
      minPersistenceDurationMs: 0,
      minConfidenceFloorBps: 9_000,
      maxDecisionAgeMs: 120_000,
      allowDegradedQuorum: false,
    },
  ],
};

export function validateTriggerRuleSet(ruleSet: CoverageTriggerRuleSet): void {
  if (!Number.isInteger(ruleSet.ruleSetVersion) || ruleSet.ruleSetVersion <= 0) {
    throw new Error("ruleSetVersion must be a positive integer");
  }
  if (!Array.isArray(ruleSet.rules) || ruleSet.rules.length === 0) {
    throw new Error("Trigger ruleSet must contain at least one rule");
  }
  const seenCoverages = new Set<string>();
  for (const r of ruleSet.rules) {
    if (!r.ruleId || r.ruleId.trim() === "") {
      throw new Error("ruleId must be non-empty");
    }
    if (seenCoverages.has(r.coverageType)) {
      throw new Error(`Duplicate rule for coverageType "${r.coverageType}" in ruleSet v${ruleSet.ruleSetVersion}`);
    }
    seenCoverages.add(r.coverageType);
    if (r.minPersistenceRounds < 1) {
      throw new Error(`Rule "${r.ruleId}": minPersistenceRounds must be >= 1`);
    }
    if (r.minPersistenceDurationMs < 0) {
      throw new Error(`Rule "${r.ruleId}": minPersistenceDurationMs cannot be negative`);
    }
    if (r.minConfidenceFloorBps < 0 || r.minConfidenceFloorBps > 10_000) {
      throw new Error(`Rule "${r.ruleId}": minConfidenceFloorBps must be within 0..10000`);
    }
    if (r.maxDecisionAgeMs <= 0) {
      throw new Error(`Rule "${r.ruleId}": maxDecisionAgeMs must be positive`);
    }
  }
}

function meetsThreshold(
  valueBps: number,
  op: "gte" | "lte",
  thresholdBps: number
): boolean {
  return op === "gte" ? valueBps >= thresholdBps : valueBps <= thresholdBps;
}

/**
 * Pure, deterministic evaluation of a corroborated decision and its preceding
 * round history against a versioned rule set.
 */
export function evaluateCoverageTrigger(params: {
  coverageType: CoverageTypeName;
  latestDecision: CorroboratedDecisionRecord;
  /** Preceding decisions for the same feed ordered oldest -> newest (including or excluding latestDecision) */
  decisionHistory: readonly CorroboratedDecisionRecord[];
  ruleSet?: CoverageTriggerRuleSet;
  evaluatedAtMs: number;
}): TriggerEvaluationResult {
  const ruleSet = params.ruleSet ?? DEFAULT_COVERAGE_TRIGGER_RULE_SET;
  validateTriggerRuleSet(ruleSet);

  const rule = ruleSet.rules.find((r) => r.coverageType === params.coverageType);
  if (!rule) {
    throw new Error(
      `No trigger rule defined for coverageType "${params.coverageType}" in ruleSet v${ruleSet.ruleSetVersion}`
    );
  }

  const latest = params.latestDecision;

  // Hard constraint (#222): No rule may fire on no_quorum or operator_paused
  if (latest.state === "no_quorum") {
    return {
      coverageType: params.coverageType,
      ruleSetVersion: ruleSet.ruleSetVersion,
      ruleId: rule.ruleId,
      decisionId: latest.decisionId,
      triggered: false,
      outcomeCode: "blocked_no_quorum",
      qualifyingConsecutiveRounds: 0,
      qualifyingPersistenceDurationMs: 0,
      explanation: `Blocked: decision "${latest.decisionId}" has state=no_quorum`,
    };
  }

  if (latest.state === "operator_paused") {
    return {
      coverageType: params.coverageType,
      ruleSetVersion: ruleSet.ruleSetVersion,
      ruleId: rule.ruleId,
      decisionId: latest.decisionId,
      triggered: false,
      outcomeCode: "blocked_operator_paused",
      qualifyingConsecutiveRounds: 0,
      qualifyingPersistenceDurationMs: 0,
      explanation: `Blocked: decision "${latest.decisionId}" has state=operator_paused`,
    };
  }

  if (latest.state === "degraded_quorum" && !rule.allowDegradedQuorum) {
    return {
      coverageType: params.coverageType,
      ruleSetVersion: ruleSet.ruleSetVersion,
      ruleId: rule.ruleId,
      decisionId: latest.decisionId,
      triggered: false,
      outcomeCode: "blocked_degraded_quorum_disallowed",
      qualifyingConsecutiveRounds: 0,
      qualifyingPersistenceDurationMs: 0,
      explanation: `Blocked: rule "${rule.ruleId}" disallows degraded_quorum decisions`,
    };
  }

  if (params.evaluatedAtMs - latest.decidedAtMs > rule.maxDecisionAgeMs) {
    return {
      coverageType: params.coverageType,
      ruleSetVersion: ruleSet.ruleSetVersion,
      ruleId: rule.ruleId,
      decisionId: latest.decisionId,
      triggered: false,
      outcomeCode: "blocked_stale_decision",
      qualifyingConsecutiveRounds: 0,
      qualifyingPersistenceDurationMs: 0,
      explanation: `Blocked: decision age (${params.evaluatedAtMs - latest.decidedAtMs}ms) exceeds maxDecisionAgeMs (${rule.maxDecisionAgeMs}ms)`,
    };
  }

  if (latest.confidenceScoreBps < rule.minConfidenceFloorBps) {
    return {
      coverageType: params.coverageType,
      ruleSetVersion: ruleSet.ruleSetVersion,
      ruleId: rule.ruleId,
      decisionId: latest.decisionId,
      triggered: false,
      outcomeCode: "blocked_confidence_below_floor",
      qualifyingConsecutiveRounds: 0,
      qualifyingPersistenceDurationMs: 0,
      explanation: `Blocked: confidence (${latest.confidenceScoreBps} bps) is below floor (${rule.minConfidenceFloorBps} bps)`,
    };
  }

  if (!meetsThreshold(latest.valueBps, rule.comparisonOp, rule.thresholdBps)) {
    return {
      coverageType: params.coverageType,
      ruleSetVersion: ruleSet.ruleSetVersion,
      ruleId: rule.ruleId,
      decisionId: latest.decisionId,
      triggered: false,
      outcomeCode: "threshold_not_met",
      qualifyingConsecutiveRounds: 0,
      qualifyingPersistenceDurationMs: 0,
      explanation: `Value ${latest.valueBps} bps did not satisfy ${rule.comparisonOp} ${rule.thresholdBps} bps`,
    };
  }

  // Evaluate consecutive persistence across decision history ending at `latest`
  const mergedMap = new Map<string, CorroboratedDecisionRecord>();
  for (const d of params.decisionHistory) {
    if (d.feedId === rule.feedId && d.decidedAtMs <= latest.decidedAtMs) {
      mergedMap.set(d.decisionId, d);
    }
  }
  mergedMap.set(latest.decisionId, latest);

  const chronological = Array.from(mergedMap.values()).sort(
    (a, b) => b.roundNumber - a.roundNumber
  );

  const qualifyingStreak: CorroboratedDecisionRecord[] = [];
  for (let i = 0; i < chronological.length; i++) {
    const d = chronological[i];
    if (
      i > 0 &&
      chronological[i - 1].roundNumber - d.roundNumber !== 1
    ) {
      // Missing intermediate round in history -> streak breaks (fail closed on incomplete history)
      break;
    }
    const stateOk =
      d.state === "corroborated_quorum" ||
      (d.state === "degraded_quorum" && rule.allowDegradedQuorum);
    const confOk = d.confidenceScoreBps >= rule.minConfidenceFloorBps;
    const threshOk = meetsThreshold(
      d.valueBps,
      rule.comparisonOp,
      rule.thresholdBps
    );
    if (!stateOk || !confOk || !threshOk) {
      break;
    }
    qualifyingStreak.push(d);
  }

  const qualifyingConsecutiveRounds = qualifyingStreak.length;
  const oldestQualifying = qualifyingStreak[qualifyingStreak.length - 1] ?? latest;
  const qualifyingPersistenceDurationMs =
    latest.decidedAtMs - oldestQualifying.decidedAtMs;

  if (
    qualifyingConsecutiveRounds < rule.minPersistenceRounds ||
    qualifyingPersistenceDurationMs < rule.minPersistenceDurationMs
  ) {
    return {
      coverageType: params.coverageType,
      ruleSetVersion: ruleSet.ruleSetVersion,
      ruleId: rule.ruleId,
      decisionId: latest.decisionId,
      triggered: false,
      outcomeCode: "blocked_insufficient_persistence_history",
      qualifyingConsecutiveRounds,
      qualifyingPersistenceDurationMs,
      explanation: `Insufficient persistence: observed ${qualifyingConsecutiveRounds}/${rule.minPersistenceRounds} consecutive rounds over ${qualifyingPersistenceDurationMs}/${rule.minPersistenceDurationMs}ms`,
    };
  }

  return {
    coverageType: params.coverageType,
    ruleSetVersion: ruleSet.ruleSetVersion,
    ruleId: rule.ruleId,
    decisionId: latest.decisionId,
    triggered: true,
    outcomeCode: "triggered",
    qualifyingConsecutiveRounds,
    qualifyingPersistenceDurationMs,
    explanation: `Triggered under ${rule.ruleId} (ruleSet v${ruleSet.ruleSetVersion}): ${latest.valueBps} bps ${rule.comparisonOp} ${rule.thresholdBps} bps for ${qualifyingConsecutiveRounds} rounds (${qualifyingPersistenceDurationMs}ms)`,
  };
}

/**
 * Offline backtest runner: evaluates a sequence of historical decisions against
 * both a baseline rule set and a candidate rule set, reporting all differences.
 */
export function backtestRuleSetAgainstHistory(params: {
  coverageType: CoverageTypeName;
  decisions: readonly CorroboratedDecisionRecord[];
  baselineRuleSet: CoverageTriggerRuleSet;
  candidateRuleSet: CoverageTriggerRuleSet;
}): {
  totalEvaluated: number;
  changedDecisions: HistoricalBacktestComparison[];
} {
  const sorted = [...params.decisions].sort(
    (a, b) => a.roundNumber - b.roundNumber
  );
  const changedDecisions: HistoricalBacktestComparison[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];
    const historyUpToCurrent = sorted.slice(0, i + 1);

    const baseRes = evaluateCoverageTrigger({
      coverageType: params.coverageType,
      latestDecision: current,
      decisionHistory: historyUpToCurrent,
      ruleSet: params.baselineRuleSet,
      evaluatedAtMs: current.decidedAtMs,
    });

    const candRes = evaluateCoverageTrigger({
      coverageType: params.coverageType,
      latestDecision: current,
      decisionHistory: historyUpToCurrent,
      ruleSet: params.candidateRuleSet,
      evaluatedAtMs: current.decidedAtMs,
    });

    if (baseRes.triggered !== candRes.triggered) {
      changedDecisions.push({
        decisionId: current.decisionId,
        coverageType: params.coverageType,
        baselineTriggered: baseRes.triggered,
        candidateTriggered: candRes.triggered,
        candidateOutcomeCode: candRes.outcomeCode,
        changed: true,
      });
    }
  }

  return {
    totalEvaluated: sorted.length,
    changedDecisions,
  };
}
