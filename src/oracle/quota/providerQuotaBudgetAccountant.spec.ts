import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderQuotaBudgetAccountant } from "./providerQuotaBudgetAccountant.ts";

test("ProviderQuotaBudgetAccountant tracks rolling-window spend, transitions through soft/hard limits, and fails safe when Redis is down", () => {
  const accountant = new ProviderQuotaBudgetAccountant();
  accountant.registerPolicy({
    providerId: "aviationstack",
    rollingWindowMs: 60_000,
    softCallThreshold: 2,
    hardCallThreshold: 3,
    unitCostUsd: 0.05,
    degradedCadenceMultiplier: 4,
  });

  // Call 1: normal
  const c1 = accountant.recordAndEvaluateCall({
    providerId: "aviationstack",
    feedId: "FLIGHT-DELAY",
    endpointClass: "flights",
    nowMs: 1_000,
  });
  assert.equal(c1.status, "normal");
  assert.equal(c1.windowSpendUsd, 0.05);

  // Call 2: reaches soft threshold -> soft_warning + alert
  const c2 = accountant.recordAndEvaluateCall({
    providerId: "aviationstack",
    feedId: "FLIGHT-DELAY",
    endpointClass: "flights",
    nowMs: 2_000,
  });
  assert.equal(c2.status, "soft_warning");
  assert.equal(c2.alertEmitted, true);

  // Call 3: fills up to hard threshold
  accountant.recordAndEvaluateCall({
    providerId: "aviationstack",
    feedId: "FLIGHT-DELAY",
    endpointClass: "flights",
    nowMs: 3_000,
  });

  // Call 4 at tick=1: throttled gracefully without throwing
  const c4 = accountant.recordAndEvaluateCall({
    providerId: "aviationstack",
    feedId: "FLIGHT-DELAY",
    endpointClass: "flights",
    nowMs: 4_000,
    pollTickIndex: 1,
  });
  assert.equal(c4.status, "hard_throttled");
  assert.equal(c4.allowedToDispatch, false);
  assert.equal(c4.effectivePollCadenceMultiplier, 4);

  // Redis outage -> fails safe by throttling cadence rather than failing open on spend
  accountant.setRedisHealth(false);
  const redisDownEval = accountant.recordAndEvaluateCall({
    providerId: "aviationstack",
    feedId: "FLIGHT-DELAY",
    endpointClass: "flights",
    nowMs: 70_000,
    pollTickIndex: 2,
  });
  assert.equal(redisDownEval.status, "hard_throttled");
  assert.equal(redisDownEval.allowedToDispatch, false);
});
