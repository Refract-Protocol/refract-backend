import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_COVERAGE_TRIGGER_RULE_SET,
  backtestRuleSetAgainstHistory,
  evaluateCoverageTrigger,
  type CorroboratedDecisionRecord,
  type CoverageTriggerRuleSet,
} from "./ruleEngine.ts";

test("Issue #222: enforces persistence rounds/duration, confidence floors, and blocks no_quorum or operator_paused decisions", () => {
  const t0 = 1_750_000_000_000;

  const r1: CorroboratedDecisionRecord = {
    decisionId: "dec_1",
    feedId: "StablecoinDepeg",
    roundNumber: 1,
    valueBps: 9_400, // <= 9500 bps threshold
    confidenceScoreBps: 9_000,
    state: "corroborated_quorum",
    decidedAtMs: t0,
  };

  // Single round alone fails minPersistenceRounds=2 / minPersistenceDurationMs=60_000
  const singleEval = evaluateCoverageTrigger({
    coverageType: "StablecoinDepeg",
    latestDecision: r1,
    decisionHistory: [r1],
    evaluatedAtMs: t0 + 1_000,
  });
  assert.equal(singleEval.triggered, false);
  assert.equal(
    singleEval.outcomeCode,
    "blocked_insufficient_persistence_history"
  );

  // Second consecutive round 65s later satisfies persistence (2 rounds, 65_000ms >= 60_000ms)
  const r2: CorroboratedDecisionRecord = {
    decisionId: "dec_2",
    feedId: "StablecoinDepeg",
    roundNumber: 2,
    valueBps: 9_350,
    confidenceScoreBps: 9_200,
    state: "corroborated_quorum",
    decidedAtMs: t0 + 65_000,
  };

  const persistedEval = evaluateCoverageTrigger({
    coverageType: "StablecoinDepeg",
    latestDecision: r2,
    decisionHistory: [r1, r2],
    evaluatedAtMs: t0 + 66_000,
  });
  assert.equal(persistedEval.triggered, true);
  assert.equal(persistedEval.outcomeCode, "triggered");
  assert.equal(persistedEval.ruleSetVersion, 1);

  // no_quorum and operator_paused never fire even if value and persistence match
  assert.equal(
    evaluateCoverageTrigger({
      coverageType: "StablecoinDepeg",
      latestDecision: { ...r2, state: "no_quorum" },
      decisionHistory: [r1],
      evaluatedAtMs: t0 + 66_000,
    }).outcomeCode,
    "blocked_no_quorum"
  );

  assert.equal(
    evaluateCoverageTrigger({
      coverageType: "StablecoinDepeg",
      latestDecision: { ...r2, state: "operator_paused" },
      decisionHistory: [r1],
      evaluatedAtMs: t0 + 66_000,
    }).outcomeCode,
    "blocked_operator_paused"
  );

  // Below confidence floor is blocked
  assert.equal(
    evaluateCoverageTrigger({
      coverageType: "StablecoinDepeg",
      latestDecision: { ...r2, confidenceScoreBps: 7_000 },
      decisionHistory: [r1],
      evaluatedAtMs: t0 + 66_000,
    }).outcomeCode,
    "blocked_confidence_below_floor"
  );
});

test("Issue #222: offline backtest mode identifies historical decisions that settle differently under a candidate rule set", () => {
  const t0 = 1_750_000_000_000;
  const decisions: CorroboratedDecisionRecord[] = [
    {
      decisionId: "d_flight_1",
      feedId: "FlightDelay",
      roundNumber: 1,
      valueBps: 190, // 190m delay: triggers v1 (>=180), does not trigger v2 (>=240)
      confidenceScoreBps: 9_000,
      state: "corroborated_quorum",
      decidedAtMs: t0,
    },
    {
      decisionId: "d_flight_2",
      feedId: "FlightDelay",
      roundNumber: 2,
      valueBps: 260, // 260m delay: triggers both v1 and v2
      confidenceScoreBps: 9_000,
      state: "corroborated_quorum",
      decidedAtMs: t0 + 60_000,
    },
  ];

  const candidateRuleSet: CoverageTriggerRuleSet = {
    ruleSetVersion: 2,
    createdAtMs: t0 + 100_000,
    rules: DEFAULT_COVERAGE_TRIGGER_RULE_SET.rules.map((r) =>
      r.coverageType === "FlightDelay"
        ? { ...r, ruleId: "rule_flight_delay_v2", thresholdBps: 240 }
        : r
    ),
  };

  const backtest = backtestRuleSetAgainstHistory({
    coverageType: "FlightDelay",
    decisions,
    baselineRuleSet: DEFAULT_COVERAGE_TRIGGER_RULE_SET,
    candidateRuleSet,
  });

  assert.equal(backtest.totalEvaluated, 2);
  assert.equal(backtest.changedDecisions.length, 1);
  assert.equal(backtest.changedDecisions[0].decisionId, "d_flight_1");
  assert.equal(backtest.changedDecisions[0].baselineTriggered, true);
  assert.equal(backtest.changedDecisions[0].candidateTriggered, false);
});
