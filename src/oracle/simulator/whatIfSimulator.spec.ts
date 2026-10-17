import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runWhatIfParameterSimulation,
  type HistoricalRoundWindow,
  type SimulatedPolicySnapshot,
} from "./whatIfSimulator.ts";

test("Issue #244: replays historical windows, computes decision diffs and policy payout impact without mutating inputs, and is deterministic", () => {
  const t0 = 1_750_000_000_000;
  const historicalWindows: HistoricalRoundWindow[] = [
    {
      // Round 1: 3 fresh sources report ~600 bps. Under baseline (threshold 500 bps), triggered payout.
      // Under candidate (threshold raised to 700 bps), trigger flips to false!
      roundId: "r_1",
      windowEndMs: t0 + 60_000,
      readings: [
        { sourceId: "coingecko", valueBps: 590, observedAtMs: t0 + 55_000 },
        { sourceId: "defillama", valueBps: 600, observedAtMs: t0 + 56_000 },
        { sourceId: "horizon", valueBps: 610, observedAtMs: t0 + 57_000 },
      ],
      baselineDecision: {
        consensusValueBps: 600,
        triggeredPayout: true,
        contributingSources: ["coingecko", "defillama", "horizon"],
        decidedAtMs: t0 + 60_000,
      },
    },
    {
      // Round 2: 3rd source is 45s old. Baseline had 60s freshness so quorum(3) succeeded.
      // Candidate tightens freshness to 20s -> only 2 fresh sources -> suppressed!
      roundId: "r_2",
      windowEndMs: t0 + 120_000,
      readings: [
        { sourceId: "coingecko", valueBps: 200, observedAtMs: t0 + 115_000 },
        { sourceId: "defillama", valueBps: 210, observedAtMs: t0 + 116_000 },
        { sourceId: "horizon", valueBps: 205, observedAtMs: t0 + 75_000 }, // 45s old
      ],
      baselineDecision: {
        consensusValueBps: 205,
        triggeredPayout: false,
        contributingSources: ["coingecko", "defillama", "horizon"],
        decidedAtMs: t0 + 120_000,
      },
    },
  ];

  const policies: SimulatedPolicySnapshot[] = [
    { policyId: "pol_1", coverageAmountStroops: 50_000_000_000n },
    { policyId: "pol_2", coverageAmountStroops: 30_000_000_000n },
  ];

  const snapshotBefore = JSON.stringify(historicalWindows);

  const report1 = runWhatIfParameterSimulation({
    feedId: "StablecoinDepeg",
    startTimeMs: t0,
    endTimeMs: t0 + 180_000,
    historicalWindows,
    activePolicies: policies,
    candidateParams: {
      quorumCount: 3,
      freshnessWindowMs: 20_000, // Tightened from 60s to 20s
      maxOutlierDeviationBps: 500,
      payoutTriggerThresholdBps: 700, // Raised from 500 bps to 700 bps
    },
  });

  const report2 = runWhatIfParameterSimulation({
    feedId: "StablecoinDepeg",
    startTimeMs: t0,
    endTimeMs: t0 + 180_000,
    historicalWindows,
    activePolicies: policies,
    candidateParams: {
      quorumCount: 3,
      freshnessWindowMs: 20_000,
      maxOutlierDeviationBps: 500,
      payoutTriggerThresholdBps: 700,
    },
  });

  // Zero mutation of input windows
  assert.equal(JSON.stringify(historicalWindows), snapshotBefore);
  // Deterministic output
  assert.deepEqual(report1, report2);

  assert.equal(report1.counts.triggerFlipped, 1);
  assert.equal(report1.counts.suppressed, 1);
  assert.equal(report1.roundDiffs[0].diffKind, "trigger_flipped");
  assert.equal(report1.roundDiffs[0].responsibleRule, "trigger_threshold_change");
  assert.equal(report1.roundDiffs[1].diffKind, "suppressed");
  assert.equal(report1.roundDiffs[1].responsibleRule, "freshness_window_change");

  // Both policies were triggered in baseline (80B stroops) and suppressed in simulation (0 stroops)
  assert.deepEqual(report1.payoutImpact.newlySuppressedPolicyIds, ["pol_1", "pol_2"]);
  assert.equal(report1.payoutImpact.baselineTotalPayoutStroops, 80_000_000_000n);
  assert.equal(report1.payoutImpact.simulatedTotalPayoutStroops, 0n);
  assert.equal(report1.payoutImpact.netPayoutDeltaStroops, -80_000_000_000n);
});

test("Issue #244: refuses to run when historical evidence coverage has fewer than minRequiredWindows or exceeds maxAllowedEvidenceGapMs", () => {
  const t0 = 1_750_000_000_000;
  const sparseWindows: HistoricalRoundWindow[] = [
    {
      roundId: "r_1",
      windowEndMs: t0 + 60_000,
      readings: [],
    },
    {
      roundId: "r_2",
      windowEndMs: t0 + 600_000, // 540s gap
      readings: [],
    },
  ];

  assert.throws(
    () =>
      runWhatIfParameterSimulation({
        feedId: "MarketCrash",
        startTimeMs: t0,
        endTimeMs: t0 + 1_000_000,
        minRequiredWindows: 5,
        historicalWindows: sparseWindows,
        activePolicies: [],
        candidateParams: {
          quorumCount: 3,
          freshnessWindowMs: 30_000,
          maxOutlierDeviationBps: 500,
          payoutTriggerThresholdBps: 1_000,
        },
      }),
    /minimum required is 5/
  );

  assert.throws(
    () =>
      runWhatIfParameterSimulation({
        feedId: "MarketCrash",
        startTimeMs: t0,
        endTimeMs: t0 + 1_000_000,
        maxAllowedEvidenceGapMs: 120_000,
        historicalWindows: sparseWindows,
        activePolicies: [],
        candidateParams: {
          quorumCount: 3,
          freshnessWindowMs: 30_000,
          maxOutlierDeviationBps: 500,
          payoutTriggerThresholdBps: 1_000,
        },
      }),
    /exceeds maxAllowedEvidenceGapMs/
  );
});
