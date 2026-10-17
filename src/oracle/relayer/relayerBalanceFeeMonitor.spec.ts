import { test } from "node:test";
import assert from "node:assert/strict";
import { RelayerBalanceFeeMonitor } from "./relayerBalanceFeeMonitor.ts";

test("RelayerBalanceFeeMonitor tracks balance, deduplicates fee spend, estimates remaining publishes, and aborts publish at critical threshold", () => {
  const monitor = new RelayerBalanceFeeMonitor({
    warningThresholdXlm: 50,
    criticalThresholdXlm: 10,
    defaultFeeEstimateXlm: 0.1,
  });

  // Unfunded initially -> cannot publish
  assert.equal(monitor.getMetricsSnapshot().healthState, "unfunded");
  assert.throws(
    () => monitor.assertCanPublishOrThrow(),
    /RELAYER_CRITICAL_LOW_FUNDS/
  );

  // Funded at 41 XLM -> warning state (< 50, >= 10), can still publish
  monitor.updateCachedBalance(41);
  monitor.recordPublishFee({
    txHash: "0xtx1",
    feedId: "USDC-DEPEG",
    feeSpentXlm: 0.5,
  });
  // Duplicate txHash is ignored
  const dup = monitor.recordPublishFee({
    txHash: "0xtx1",
    feedId: "USDC-DEPEG",
    feeSpentXlm: 0.5,
  });
  assert.equal(dup.deduplicated, true);

  const snapWarning = monitor.getMetricsSnapshot();
  assert.equal(snapWarning.healthState, "warning");
  assert.equal(snapWarning.currentBalanceXlm, 40.5);
  assert.equal(snapWarning.cumulativeFeesByFeedXlm["USDC-DEPEG"], 0.5);
  assert.equal(snapWarning.estimatedPublishesRemaining, 79); // (40.5 - 1) / 0.5
  assert.doesNotThrow(() => monitor.assertCanPublishOrThrow());

  // Drop below critical threshold (10 XLM) -> aborts publish
  monitor.updateCachedBalance(8.5);
  assert.equal(monitor.getMetricsSnapshot().healthState, "critical");
  assert.throws(
    () => monitor.assertCanPublishOrThrow(),
    /RELAYER_CRITICAL_LOW_FUNDS/
  );
});
