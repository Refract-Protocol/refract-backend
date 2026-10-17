import test from "node:test";
import assert from "node:assert/strict";
import {
  PayoutAnomalyMonitor,
  type PayoutAnomalyBreach,
} from "./payout-anomaly-monitor.ts";

const HOUR_MS = 60 * 60 * 1000;

test("Issue #278: cold-start guard prevents false-positive z-score trips during launch week and retries are de-duplicated", () => {
  const breaches: PayoutAnomalyBreach[] = [];
  const monitor = new PayoutAnomalyMonitor({
    defaultMode: "enforcing",
    configs: [
      {
        coverageType: "StablecoinDepeg",
        minBaselineBuckets: 6,
        zScoreThreshold: 3.5,
        maxHourlyPayoutStroops: 1_000_000_000_000n,
      },
    ],
    onBreach: (b) => breaches.push(b),
  });

  // Only 2 historical buckets (< minBaselineBuckets = 6): moderate spike must not false-positive
  monitor.recordSettlement({
    settlementId: "s-1",
    coverageType: "StablecoinDepeg",
    policyId: "p-1",
    payoutStroops: 10_000_000n,
    activePoliciesCount: 100,
    timestampMs: 1 * HOUR_MS,
  });
  monitor.recordSettlement({
    settlementId: "s-2",
    coverageType: "StablecoinDepeg",
    policyId: "p-2",
    payoutStroops: 50_000_000n,
    activePoliciesCount: 100,
    timestampMs: 2 * HOUR_MS,
  });

  // Duplicate settlement retry with same settlementId is ignored
  const retry = monitor.recordSettlement({
    settlementId: "s-2",
    coverageType: "StablecoinDepeg",
    policyId: "p-2",
    payoutStroops: 50_000_000n,
    activePoliciesCount: 100,
    timestampMs: 2 * HOUR_MS + 5_000,
  });
  assert.equal(retry.duplicate, true);
  assert.equal(breaches.length, 0);
  assert.equal(monitor.isSettlementHeld("StablecoinDepeg"), false);
});

test("Issue #278: abnormal payout surge trips breaker in enforcing mode, holds settlement, and resumes after operator ack", () => {
  const breaches: PayoutAnomalyBreach[] = [];
  const monitor = new PayoutAnomalyMonitor({
    defaultMode: "enforcing",
    configs: [
      {
        coverageType: "MarketCrash",
        minBaselineBuckets: 6,
        zScoreThreshold: 4.0,
        maxHourlyPayoutStroops: 500_000_000_000n,
      },
    ],
    onBreach: (b) => breaches.push(b),
  });

  // Seed 6 baseline hours with steady 10 USDC..12 USDC payouts
  for (let h = 1; h <= 6; h++) {
    monitor.recordSettlement({
      settlementId: `base-${h}`,
      coverageType: "MarketCrash",
      policyId: `pol-${h}`,
      payoutStroops: BigInt((10 + (h % 3)) * 10_000_000),
      activePoliciesCount: 200,
      timestampMs: h * HOUR_MS + 1000,
    });
  }

  // Hour 7: normal high-volume activity within tolerance does NOT trip breaker
  const normal = monitor.recordSettlement({
    settlementId: "normal-7",
    coverageType: "MarketCrash",
    policyId: "pol-7",
    payoutStroops: BigInt(13 * 10_000_000),
    activePoliciesCount: 200,
    timestampMs: 7 * HOUR_MS + 1000,
  });
  assert.equal(normal.breach, null);
  assert.equal(monitor.isSettlementHeld("MarketCrash"), false);

  // Hour 8: sudden 50x payout surge trips z-score threshold and holds settlement
  const surge = monitor.recordSettlement({
    settlementId: "surge-8",
    coverageType: "MarketCrash",
    policyId: "pol-8",
    payoutStroops: BigInt(600 * 10_000_000),
    activePoliciesCount: 200,
    timestampMs: 8 * HOUR_MS + 1000,
  });
  assert.ok(surge.breach);
  assert.equal(surge.breach?.holdPlaced, true);
  assert.equal(surge.allowedToSettle, false);
  assert.equal(monitor.isSettlementHeld("MarketCrash"), true);
  assert.equal(breaches.length, 1);

  // Operator acknowledges and resumes settlement
  const resumed = monitor.acknowledgeAndResume("MarketCrash", "ops-lead", "Verified flash crash payout");
  assert.equal(resumed.held, false);
  assert.equal(resumed.acknowledgedBy, "ops-lead");
  assert.equal(monitor.isSettlementHeld("MarketCrash"), false);
});

test("Issue #278: advisory mode emits breach telemetry without placing a settlement hold", () => {
  const breaches: PayoutAnomalyBreach[] = [];
  const monitor = new PayoutAnomalyMonitor({
    defaultMode: "advisory",
    configs: [
      {
        coverageType: "FlightDelay",
        maxHourlyPayoutStroops: 100_000_000n,
      },
    ],
    onBreach: (b) => breaches.push(b),
  });

  const res = monitor.recordSettlement({
    settlementId: "fd-1",
    coverageType: "FlightDelay",
    policyId: "pol-fd-1",
    payoutStroops: 250_000_000n,
    activePoliciesCount: 50,
    timestampMs: 10 * HOUR_MS,
  });
  assert.ok(res.breach);
  assert.equal(res.breach?.mode, "advisory");
  assert.equal(res.breach?.holdPlaced, false);
  assert.equal(res.allowedToSettle, true);
  assert.equal(monitor.isSettlementHeld("FlightDelay"), false);
});
