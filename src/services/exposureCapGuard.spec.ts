import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PayoutExposureCapGuard } from "./exposureCapGuard.ts";

describe("PayoutExposureCapGuard (Issue #224)", () => {
  const samplePoolConfig = {
    poolId: "pool-main-usdc",
    rollingWindowMs: 60_000,
    warningThresholdRatio: 0.8,
    perFeedWindowCapUsd: { "usdc-usd": 20_000 },
    perCoverageTypeWindowCapUsd: { stablecoin_depeg: 25_000 },
    perConfidenceBandCapUsd: {
      low: 5_000,
      medium: 15_000,
      high: 50_000,
    },
  };

  it("prevents concurrent parallel settlement bursts from overshooting caps and halts the entire batch on breach", async () => {
    const guard = new PayoutExposureCapGuard([samplePoolConfig]);
    const t0 = 1_700_000_000_000;

    // Fire 3 parallel settlement batches of $9,000 each against a $20,000 feed cap -> at most 2 can succeed ($18,000 <= $20,000), 3rd breaches!
    const results = await Promise.all([
      guard.evaluateAndCommitBatch(
        "pool-main-usdc",
        [
          {
            claimId: "claim-1",
            poolId: "pool-main-usdc",
            feedId: "usdc-usd",
            coverageType: "stablecoin_depeg",
            payoutAmountUsd: 9_000,
            decisionId: "dec-1",
            decisionConfidenceBps: 9_000,
          },
        ],
        t0
      ),
      guard.evaluateAndCommitBatch(
        "pool-main-usdc",
        [
          {
            claimId: "claim-2",
            poolId: "pool-main-usdc",
            feedId: "usdc-usd",
            coverageType: "stablecoin_depeg",
            payoutAmountUsd: 9_000,
            decisionId: "dec-1",
            decisionConfidenceBps: 9_000,
          },
        ],
        t0 + 10
      ),
      guard.evaluateAndCommitBatch(
        "pool-main-usdc",
        [
          {
            claimId: "claim-3",
            poolId: "pool-main-usdc",
            feedId: "usdc-usd",
            coverageType: "stablecoin_depeg",
            payoutAmountUsd: 9_000,
            decisionId: "dec-1",
            decisionConfidenceBps: 9_000,
          },
        ],
        t0 + 20
      ),
    ]);

    const allowedBatches = results.filter((r) => r.allowed);
    const blockedBatches = results.filter((r) => !r.allowed);
    assert.equal(allowedBatches.length, 2);
    assert.equal(blockedBatches.length, 1);
    assert.equal(
      guard.getPoolState("pool-main-usdc"),
      "degraded_cap_breach_review"
    );

    const alerts = guard.getAlerts();
    assert.ok(alerts.some((a) => a.severity === "warning"));
    assert.ok(alerts.some((a) => a.severity === "critical"));

    // Subsequent even tiny claim is blocked while pool is in degraded_cap_breach_review
    const blockedWhileDegraded = await guard.evaluateAndCommitBatch(
      "pool-main-usdc",
      [
        {
          claimId: "claim-tiny",
          poolId: "pool-main-usdc",
          feedId: "usdc-usd",
          coverageType: "stablecoin_depeg",
          payoutAmountUsd: 100,
          decisionId: "dec-2",
          decisionConfidenceBps: 9_500,
        },
      ],
      t0 + 50
    );
    assert.equal(blockedWhileDegraded.allowed, false);
  });

  it("enforces confidence-band blast-radius caps without partial batch settlement", async () => {
    const guard = new PayoutExposureCapGuard([samplePoolConfig]);
    const t0 = 1_700_000_000_000;

    // Low confidence band (< 7000 bps) has a $5,000 cap; a batch of two $3,000 claims ($6,000 total) must halt BOTH claims
    const outcome = await guard.evaluateAndCommitBatch(
      "pool-main-usdc",
      [
        {
          claimId: "claim-low-1",
          poolId: "pool-main-usdc",
          feedId: "usdc-usd",
          coverageType: "stablecoin_depeg",
          payoutAmountUsd: 3_000,
          decisionId: "dec-low",
          decisionConfidenceBps: 6_200,
        },
        {
          claimId: "claim-low-2",
          poolId: "pool-main-usdc",
          feedId: "usdc-usd",
          coverageType: "stablecoin_depeg",
          payoutAmountUsd: 3_000,
          decisionId: "dec-low",
          decisionConfidenceBps: 6_200,
        },
      ],
      t0
    );

    assert.equal(outcome.allowed, false);
    assert.deepEqual(outcome.settledClaimIds, []);
    assert.deepEqual(outcome.haltedClaimIds, ["claim-low-1", "claim-low-2"]);
    assert.ok(
      outcome.breachReasons.some((r) => r.includes("confidence_band:low"))
    );
  });
});
