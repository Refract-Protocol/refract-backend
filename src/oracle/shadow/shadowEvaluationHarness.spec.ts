import { test } from "node:test";
import assert from "node:assert/strict";
import { ShadowEvaluationHarness } from "./shadowEvaluationHarness.ts";

test("ShadowEvaluationHarness excludes shadow sources from active consensus and reports window-aligned statistics", () => {
  const harness = new ShadowEvaluationHarness();
  harness.registerSource({
    feedId: "USDC-DEPEG",
    sourceId: "coingecko",
    mode: "active",
  });
  harness.registerSource({
    feedId: "USDC-DEPEG",
    sourceId: "defillama",
    mode: "active",
  });
  harness.registerSource({
    feedId: "USDC-DEPEG",
    sourceId: "pyth-candidate",
    mode: "shadow",
  });

  // Window 1000: active consensus = 1.0000; shadow agrees (1.0005, 5 bps)
  harness.recordReading({
    feedId: "USDC-DEPEG",
    sourceId: "coingecko",
    windowTimestampMs: 1_000,
    value: 1.0,
  });
  harness.recordReading({
    feedId: "USDC-DEPEG",
    sourceId: "defillama",
    windowTimestampMs: 1_000,
    value: 1.0,
  });
  harness.recordReading({
    feedId: "USDC-DEPEG",
    sourceId: "pyth-candidate",
    windowTimestampMs: 1_000,
    value: 1.0005,
  });

  // Verify shadow reading does not influence active consensus even when extreme
  harness.recordReading({
    feedId: "USDC-DEPEG",
    sourceId: "coingecko",
    windowTimestampMs: 2_000,
    value: 1.0,
  });
  harness.recordReading({
    feedId: "USDC-DEPEG",
    sourceId: "defillama",
    windowTimestampMs: 2_000,
    value: 1.0,
  });
  harness.recordReading({
    feedId: "USDC-DEPEG",
    sourceId: "pyth-candidate",
    windowTimestampMs: 2_000,
    value: 0.85, // 1500 bps divergence
  });

  // Window 3000: shadow source has a coverage gap (did not report)
  harness.recordReading({
    feedId: "USDC-DEPEG",
    sourceId: "coingecko",
    windowTimestampMs: 3_000,
    value: 1.0,
  });
  harness.recordReading({
    feedId: "USDC-DEPEG",
    sourceId: "defillama",
    windowTimestampMs: 3_000,
    value: 1.0,
  });

  const activeAt2000 = harness.evaluateActiveConsensusForWindow(
    "USDC-DEPEG",
    2_000
  );
  assert.equal(activeAt2000.consensusValue, 1.0);
  assert.deepEqual(activeAt2000.activeContributorIds, [
    "coingecko",
    "defillama",
  ]);

  const report = harness.generateComparisonReport({
    evaluationId: "eval-001",
    feedId: "USDC-DEPEG",
    candidateSourceId: "pyth-candidate",
    windowStartMs: 1_000,
    windowEndMs: 3_000,
    agreementToleranceBps: 25,
  });

  assert.equal(report.totalIncumbentWindows, 3);
  assert.equal(report.sampleSize, 2);
  assert.deepEqual(report.coverageGapWindows, [3_000]);
  assert.equal(report.agreementRate, 0.5);
  assert.equal(report.disagreementEpisodes.length, 1);
  assert.equal(report.disagreementEpisodes[0].windowTimestampMs, 2_000);

  // Reject promotion when agreement rate is below threshold
  assert.throws(() =>
    harness.promoteShadowSource({
      feedId: "USDC-DEPEG",
      candidateSourceId: "pyth-candidate",
      evaluationId: "eval-001",
      actor: "ops@refract.finance",
      minSampleSize: 2,
      minAgreementRate: 0.9,
      nowMs: 4_000,
    })
  );

  // Allow promotion when threshold matches evaluation evidence
  const promotion = harness.promoteShadowSource({
    feedId: "USDC-DEPEG",
    candidateSourceId: "pyth-candidate",
    evaluationId: "eval-001",
    actor: "ops@refract.finance",
    minSampleSize: 2,
    minAgreementRate: 0.5,
    nowMs: 4_000,
  });
  assert.equal(promotion.evaluationId, "eval-001");
  assert.equal(
    harness.getSource("USDC-DEPEG", "pyth-candidate")?.mode,
    "active"
  );
});
