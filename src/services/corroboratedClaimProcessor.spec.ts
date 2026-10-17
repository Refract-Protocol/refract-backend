import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CorroboratedClaimProcessor } from "./corroboratedClaimProcessor.ts";

describe("CorroboratedClaimProcessor (Issue #229)", () => {
  it("marks policies as pending_trust on missing, quorum-short, stale, or low-confidence decisions, and settles exclusively on valid corroborated decisions", () => {
    const processor = new CorroboratedClaimProcessor({
      maxDecisionAgeMs: 60_000,
      minConfidenceBps: 7_500,
    });
    const t0 = 1_700_000_000_000;

    processor.registerPolicy({
      policyId: "pol-depeg-1",
      feedId: "usdc-usd",
      payoutAmountUsd: 10_000,
      status: "active_monitoring",
      triggerPredicate: (val) => val <= 0.95,
    });

    // 1. Missing decision -> pending_trust (missing_decision)
    processor.scanAndEvaluatePolicies(t0);
    assert.equal(processor.getPolicy("pol-depeg-1")?.status, "pending_trust");
    assert.equal(
      processor.getPolicy("pol-depeg-1")?.pendingTrustReason,
      "missing_decision"
    );

    // 2. Quorum not met -> pending_trust (quorum_not_met)
    processor.recordConsensusDecision({
      decisionId: "dec-uncorroborated",
      feedId: "usdc-usd",
      agreedValue: 0.91,
      quorumSatisfied: false,
      participatingSourcesCount: 1,
      requiredQuorumSources: 3,
      confidenceBps: 9_000,
      decidedAtMs: t0,
    });
    processor.scanAndEvaluatePolicies(t0 + 1_000);
    assert.equal(
      processor.getPolicy("pol-depeg-1")?.pendingTrustReason,
      "quorum_not_met"
    );

    // 3. Stale decision -> pending_trust (stale_decision)
    processor.recordConsensusDecision({
      decisionId: "dec-stale",
      feedId: "usdc-usd",
      agreedValue: 0.91,
      quorumSatisfied: true,
      participatingSourcesCount: 3,
      requiredQuorumSources: 3,
      confidenceBps: 9_000,
      decidedAtMs: t0 - 120_000,
    });
    processor.scanAndEvaluatePolicies(t0 + 2_000);
    assert.equal(
      processor.getPolicy("pol-depeg-1")?.pendingTrustReason,
      "stale_decision"
    );

    // 4. Valid fresh corroborated decision -> settles and links settledDecisionId
    processor.recordConsensusDecision({
      decisionId: "dec-valid-700",
      feedId: "usdc-usd",
      agreedValue: 0.92,
      quorumSatisfied: true,
      participatingSourcesCount: 3,
      requiredQuorumSources: 3,
      confidenceBps: 8_800,
      decidedAtMs: t0 + 3_000,
    });

    const scan1 = processor.scanAndEvaluatePolicies(t0 + 4_000);
    assert.deepEqual(scan1.settledPolicyIds, ["pol-depeg-1"]);
    assert.equal(processor.getPolicy("pol-depeg-1")?.status, "settled");
    assert.equal(
      processor.getPolicy("pol-depeg-1")?.settledDecisionId,
      "dec-valid-700"
    );

    // 5. Duplicate scan never double-settles
    const scan2 = processor.scanAndEvaluatePolicies(t0 + 5_000);
    assert.deepEqual(scan2.settledPolicyIds, []);

    // Raw reading settlement path is explicitly forbidden
    assert.throws(() => {
      processor.rejectRawReadingSettlement();
    }, /RAW_READING_SETTLEMENT_FORBIDDEN/);
  });
});
