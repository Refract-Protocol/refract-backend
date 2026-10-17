import test from "node:test";
import assert from "node:assert/strict";
import {
  OracleCircuitBreakerService,
  InMemoryCircuitBreakerStore,
} from "./circuit-breaker.ts";

test("Issue #277: breaker transitions closed -> open -> half_open_canary -> closed only after N healthy rounds and canary dwell time", async () => {
  const store = new InMemoryCircuitBreakerStore();
  const breaker = new OracleCircuitBreakerService({
    store,
    configs: [
      {
        feedId: "StablecoinDepeg",
        baseOpenDwellMs: 10_000,
        canaryDwellMs: 20_000,
        requiredHealthyRounds: 3,
        canaryToleranceBps: 50,
      },
    ],
  });

  // 1. Initially closed -> publishes for payout
  const r0 = await breaker.evaluateRound({
    feedId: "StablecoinDepeg",
    canaryValue: 1.0,
    referenceSourceValues: [1.0, 1.0],
    nowMs: 1_000,
  });
  assert.equal(r0.stateAfter, "closed");
  assert.equal(r0.publishForPayout, true);

  // 2. Trip breaker -> open
  await breaker.trip("StablecoinDepeg", "Implausible 15% single-step drop", 2_000);
  const whileOpen = await breaker.evaluateRound({
    feedId: "StablecoinDepeg",
    canaryValue: 1.0,
    referenceSourceValues: [1.0, 1.0],
    nowMs: 8_000,
  });
  assert.equal(whileOpen.stateAfter, "open");
  assert.equal(whileOpen.publishForPayout, false);

  // 3. After baseOpenDwellMs (2_000 + 10_000 = 12_000), enters half_open_canary
  const c1 = await breaker.evaluateRound({
    feedId: "StablecoinDepeg",
    canaryValue: 1.0,
    referenceSourceValues: [1.001, 0.999],
    nowMs: 12_000,
  });
  assert.equal(c1.stateBefore, "half_open_canary");
  assert.equal(c1.stateAfter, "half_open_canary");
  assert.equal(c1.publishForPayout, false, "Canary rounds must not publish for payouts");
  assert.equal(c1.consecutiveHealthyRounds, 1);

  // Round 2 at 22_000ms
  const c2 = await breaker.evaluateRound({
    feedId: "StablecoinDepeg",
    canaryValue: 1.0,
    referenceSourceValues: [1.0, 1.0],
    nowMs: 22_000,
  });
  assert.equal(c2.stateAfter, "half_open_canary");
  assert.equal(c2.consecutiveHealthyRounds, 2);

  // Round 3 at 32_000ms (canaryDwellMs = 20_000 satisfied, 3 consecutive healthy rounds satisfied) -> promotes to closed
  const c3 = await breaker.evaluateRound({
    feedId: "StablecoinDepeg",
    canaryValue: 1.0,
    referenceSourceValues: [1.0, 1.0],
    nowMs: 32_000,
  });
  assert.equal(c3.stateBefore, "half_open_canary");
  assert.equal(c3.stateAfter, "closed");
  assert.equal(c3.transitioned, true);

  // Next round in closed state publishes for payout again
  const afterClose = await breaker.evaluateRound({
    feedId: "StablecoinDepeg",
    canaryValue: 1.0,
    referenceSourceValues: [1.0, 1.0],
    nowMs: 35_000,
  });
  assert.equal(afterClose.publishForPayout, true);

  // Verify evidence ledger recorded system transitions and never jumped open -> closed directly
  const ledger = breaker.getEvidenceLedger();
  assert.equal(ledger.length, 3);
  assert.deepEqual(
    ledger.map((t) => `${t.fromState}->${t.toState}`),
    ["closed->open", "open->half_open_canary", "half_open_canary->closed"]
  );
  assert.ok(ledger.every((t) => t.actor === "system"));
});

test("Issue #277: canary divergence re-opens the breaker, escalates dwell time on flapping, and survives restart via store", async () => {
  const sharedStore = new InMemoryCircuitBreakerStore();
  const breaker1 = new OracleCircuitBreakerService({
    store: sharedStore,
    configs: [
      {
        feedId: "MarketCrash",
        baseOpenDwellMs: 10_000,
        maxOpenDwellMs: 120_000,
        canaryDwellMs: 10_000,
        requiredHealthyRounds: 2,
        canaryToleranceBps: 100, // 1%
      },
    ],
  });

  // Trip 1 at t=1_000 (dwell = 10_000)
  await breaker1.trip("MarketCrash", "Initial anomaly", 1_000);
  await breaker1.advanceTimers("MarketCrash", 11_000);

  // Simulate process restart during half_open_canary
  const breakerAfterRestart = new OracleCircuitBreakerService({
    store: sharedStore,
    configs: [
      {
        feedId: "MarketCrash",
        baseOpenDwellMs: 10_000,
        maxOpenDwellMs: 120_000,
        canaryDwellMs: 10_000,
        requiredHealthyRounds: 2,
        canaryToleranceBps: 100,
      },
    ],
  });
  const snap = await breakerAfterRestart.getSnapshot("MarketCrash");
  assert.equal(snap.state, "half_open_canary");

  // Canary round diverges by 5% (500 bps > 100 bps) -> re-opens breaker and doubles dwell to 20_000ms
  const failedCanary = await breakerAfterRestart.evaluateRound({
    feedId: "MarketCrash",
    canaryValue: 95,
    referenceSourceValues: [100, 100],
    nowMs: 12_000,
  });
  assert.equal(failedCanary.stateAfter, "open");
  assert.equal(failedCanary.reason, "canary_failed_reopened");

  const reTrippedSnap = await breakerAfterRestart.getSnapshot("MarketCrash");
  assert.equal(reTrippedSnap.tripCount, 2);
  assert.equal(reTrippedSnap.currentOpenDwellMs, 20_000);
});
