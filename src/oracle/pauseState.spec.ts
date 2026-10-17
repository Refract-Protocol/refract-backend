import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryPauseControlStore,
  TrustEnginePauseController,
} from "./pauseState.ts";

test("Issue #276: blocks publication and settlement when paused, survives relayer outage via durable outbox, and confirms on-chain txHash", async () => {
  const sharedStore = new InMemoryPauseControlStore();
  const controller1 = new TrustEnginePauseController({
    store: sharedStore,
    enableOnChainPropagation: true,
  });

  const now = 1_750_000_000_000;
  controller1.pauseTarget({
    targetKind: "feed",
    targetId: "StablecoinDepeg",
    source: "operator_manual",
    actorId: "ops_lead",
    reason: "Upstream USDC liquidity pool anomaly",
    nowMs: now,
  });

  // Immediately blocks reading publish and coverage settlement
  assert.equal(controller1.canPublishReading("StablecoinDepeg").allowed, false);
  assert.equal(
    controller1.canSettleCoverage("DepegShield", "StablecoinDepeg").allowed,
    false
  );
  assert.equal(controller1.canPublishReading("FlightDelay").allowed, true);

  // Simulate RPC / relayer outage on first flush attempt
  const failedFlush = await controller1.flushOnChainOutbox(async () => {
    throw new Error("Soroban RPC 503 Service Unavailable");
  }, now + 1_000);
  assert.equal(failedFlush.length, 1);
  assert.equal(failedFlush[0].status, "pending_submission");
  assert.equal(failedFlush[0].attempts, 1);
  assert.match(failedFlush[0].lastError ?? "", /503/);

  // Simulate process restart with new controller instance sharing durable store
  const controllerAfterRestart = new TrustEnginePauseController({
    store: sharedStore,
    enableOnChainPropagation: true,
  });
  assert.equal(
    controllerAfterRestart.canPublishReading("StablecoinDepeg").allowed,
    false
  );
  assert.equal(
    controllerAfterRestart.getTrustPauseStatus().pendingOutboxCount,
    1
  );

  // Retry succeeds and records txHash
  const confirmedFlush = await controllerAfterRestart.flushOnChainOutbox(
    async (payload) => {
      assert.equal(payload.contractMethod, "set_feed_status");
      assert.equal(payload.paused, true);
      return { txHash: "tx_soroban_pause_998877" };
    },
    now + 5_000
  );
  assert.equal(confirmedFlush.length, 1);
  assert.equal(confirmedFlush[0].status, "confirmed");
  assert.equal(confirmedFlush[0].txHash, "tx_soroban_pause_998877");
  assert.equal(
    controllerAfterRestart.getTrustPauseStatus().pendingOutboxCount,
    0
  );
});

test("Issue #276: requires explicit actor, reason, and circuit-breaker acknowledgment before resuming an auto-paused feed", () => {
  const controller = new TrustEnginePauseController();
  const now = 1_750_000_000_000;

  controller.pauseTarget({
    targetKind: "feed",
    targetId: "LiquidationShield",
    source: "circuit_breaker_auto",
    actorId: "circuitBreaker",
    reason: "3 consecutive quorum misses",
    nowMs: now,
  });

  // Silent resume without acknowledgeCircuitBreakerAutoPause=true is rejected
  assert.throws(
    () =>
      controller.resumeTarget({
        targetKind: "feed",
        targetId: "LiquidationShield",
        actorId: "ops_1",
        reason: "Trying to resume",
        nowMs: now + 10_000,
      }),
    /acknowledgeCircuitBreakerAutoPause=true/
  );

  // Explicit acknowledgment succeeds and re-enables publication
  const resumed = controller.resumeTarget({
    targetKind: "feed",
    targetId: "LiquidationShield",
    actorId: "ops_1",
    reason: "Canary ramp-back verified healthy",
    acknowledgeCircuitBreakerAutoPause: true,
    nowMs: now + 20_000,
  });
  assert.equal(resumed.record.paused, false);
  assert.equal(controller.canPublishReading("LiquidationShield").allowed, true);
});
