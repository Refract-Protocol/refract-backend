import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeOperatorReputation,
  computeReputationWeightedConsensus,
} from "./reputation.ts";

describe("Operator Reputation & Consensus Weighting (Issue #193)", () => {
  it("computes deterministic, monotonic, time-decayed reputation scores and enforces new-operator probation", () => {
    const t0 = 1_700_000_000_000;
    const dayMs = 24 * 60 * 60 * 1_000;

    // 1. Cold start / sparse history (< 5 observations) -> probationary = true
    const newOp = computeOperatorReputation({
      operatorId: "op-newbie",
      registeredAtMs: t0 - dayMs,
      events: [
        {
          timestampMs: t0 - 10_000,
          respondedToHeartbeat: true,
          deviationRatioFromConsensus: 0.001,
        },
      ],
      nowMs: t0,
    });
    assert.equal(newOp.probationary, true);

    // 2. Consistently accurate veteran operator -> high score, not probationary
    const accurateEvents = Array.from({ length: 8 }, (_, idx) => ({
      timestampMs: t0 - (8 - idx) * 3_600_000,
      respondedToHeartbeat: true,
      deviationRatioFromConsensus: 0.002,
    }));

    const veteranAccurate = computeOperatorReputation({
      operatorId: "op-veteran",
      registeredAtMs: t0 - 30 * dayMs,
      events: accurateEvents,
      nowMs: t0,
    });
    const veteranReplay = computeOperatorReputation({
      operatorId: "op-veteran",
      registeredAtMs: t0 - 30 * dayMs,
      events: accurateEvents,
      nowMs: t0,
    });
    assert.equal(
      veteranAccurate.effectiveScoreBps,
      veteranReplay.effectiveScoreBps
    );
    assert.equal(veteranAccurate.probationary, false);
    assert.ok(veteranAccurate.effectiveScoreBps >= 9_000);

    // 3. Divergent / slashed operator has lower score than accurate operator, but recovers as old slash decays
    const recentlySlashed = computeOperatorReputation({
      operatorId: "op-recovering",
      registeredAtMs: t0 - 30 * dayMs,
      events: [
        ...accurateEvents,
        {
          timestampMs: t0 - 1_000,
          respondedToHeartbeat: true,
          deviationRatioFromConsensus: 0.04,
          slashedOrDisputeLost: true,
        },
      ],
      nowMs: t0,
    });
    assert.ok(
      recentlySlashed.effectiveScoreBps < veteranAccurate.effectiveScoreBps
    );

    // 5 days later with clean recent readings -> score recovers significantly
    const recoveredLater = computeOperatorReputation({
      operatorId: "op-recovering",
      registeredAtMs: t0 - 30 * dayMs,
      events: [
        {
          timestampMs: t0 - 1_000,
          respondedToHeartbeat: true,
          deviationRatioFromConsensus: 0.04,
          slashedOrDisputeLost: true,
        },
        ...Array.from({ length: 6 }, (_, idx) => ({
          timestampMs: t0 + 5 * dayMs - (6 - idx) * 1_800_000,
          respondedToHeartbeat: true,
          deviationRatioFromConsensus: 0.001,
        })),
      ],
      nowMs: t0 + 5 * dayMs,
    });
    assert.ok(
      recoveredLater.effectiveScoreBps > recentlySlashed.effectiveScoreBps
    );
  });

  it("excludes probationary operators from quorum and caps single-operator weight share so no operator unilaterally controls consensus", () => {
    const nowMs = 1_700_000_000_000;
    const snapshots = {
      "op-whale": {
        operatorId: "op-whale",
        observationCount: 100,
        accuracyBps: 10_000,
        availabilityBps: 10_000,
        tenureBonusBps: 1_000,
        penaltyBps: 0,
        effectiveScoreBps: 10_000,
        probationary: false,
        computedAtMs: nowMs,
      },
      "op-modest-1": {
        operatorId: "op-modest-1",
        observationCount: 10,
        accuracyBps: 5_000,
        availabilityBps: 5_000,
        tenureBonusBps: 200,
        penaltyBps: 0,
        effectiveScoreBps: 4_200,
        probationary: false,
        computedAtMs: nowMs,
      },
      "op-modest-2": {
        operatorId: "op-modest-2",
        observationCount: 10,
        accuracyBps: 5_000,
        availabilityBps: 5_000,
        tenureBonusBps: 200,
        penaltyBps: 0,
        effectiveScoreBps: 4_200,
        probationary: false,
        computedAtMs: nowMs,
      },
      "op-probation": {
        operatorId: "op-probation",
        observationCount: 2,
        accuracyBps: 9_000,
        availabilityBps: 9_000,
        tenureBonusBps: 0,
        penaltyBps: 0,
        effectiveScoreBps: 8_000,
        probationary: true,
        computedAtMs: nowMs,
      },
    };

    // Without weight cap, op-whale (10,000) would have >50% of total weight (10,000 / 18,400 = 54.3%) and dictate value 999!
    // With maxSingleOperatorWeightShareBps = 4,500 (45%), op-whale is capped at <= 45%, so op-modest-1 (100) and op-modest-2 (102) win the median!
    const decision = computeReputationWeightedConsensus({
      readings: [
        { operatorId: "op-whale", value: 999 },
        { operatorId: "op-modest-1", value: 100 },
        { operatorId: "op-modest-2", value: 102 },
        { operatorId: "op-probation", value: 999 },
      ],
      reputationSnapshots: snapshots,
      minEligibleOperators: 3,
      maxSingleOperatorWeightShareBps: 4_500,
    });

    assert.equal(decision.status, "corroborated");
    assert.deepEqual(decision.probationaryExcludedOperators, ["op-probation"]);
    assert.ok(
      decision.operatorWeightSnapshot["op-whale"]!.cappedNormalizedWeightBps <=
        4_500
    );
    assert.equal(decision.agreedValue, 102);
  });
});
