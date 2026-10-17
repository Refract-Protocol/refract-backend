import { test } from "node:test";
import assert from "node:assert/strict";
import { ConsensusLatencyBudgetEnforcer } from "./consensusLatencyBudgetEnforcer.ts";

test("ConsensusLatencyBudgetEnforcer isolates slow sources as late and aborts stale publications", () => {
  const enforcer = new ConsensusLatencyBudgetEnforcer();
  enforcer.registerBudget({
    feedId: "XLM_USD",
    sourceFetchTimeoutMs: 2_000,
    observationToDecisionBudgetMs: 5_000,
    decisionToPublishBudgetMs: 3_000,
    totalEndToEndBudgetMs: 7_000,
  });

  // Timely round with 1 slow source marked late
  const timely = enforcer.evaluateRound({
    feedId: "XLM_USD",
    earliestObservationAtMs: 10_000,
    decisionComputedAtMs: 13_000,
    publishAttemptAtMs: 15_000,
    sourceAttempts: [
      { sourceId: "fast-1", value: 0.12, durationMs: 800 },
      { sourceId: "fast-2", value: 0.12, durationMs: 1_200 },
      { sourceId: "slow-3", value: 0.12, durationMs: 3_500 },
    ],
  });
  assert.equal(timely.publishAllowed, true);
  assert.deepEqual(timely.lateSourceIds, ["slow-3"]);
  assert.equal(timely.timelySources.length, 2);

  // Stale publication exceeding decisionToPublishBudgetMs is aborted
  const stale = enforcer.evaluateRound({
    feedId: "XLM_USD",
    earliestObservationAtMs: 10_000,
    decisionComputedAtMs: 12_000,
    publishAttemptAtMs: 16_000,
    sourceAttempts: [{ sourceId: "fast-1", value: 0.12, durationMs: 500 }],
  });
  assert.equal(stale.publishAllowed, false);
  assert.equal(stale.abortReason, "decision_to_publish_budget_exceeded");
});
