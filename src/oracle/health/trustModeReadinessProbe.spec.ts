import { test } from "node:test";
import assert from "node:assert/strict";
import { TrustModeReadinessProbe } from "./trustModeReadinessProbe.ts";

test("TrustModeReadinessProbe separates cheap /health liveness from trust-mode-aware /ready checks", () => {
  const probe = new TrustModeReadinessProbe();

  assert.equal(probe.checkLiveness().httpStatus, 200);

  // Production fails if mock sources are active or real quorum is not met
  const prodFail = probe.checkReadiness({
    trustMode: "production",
    databaseConnected: true,
    redisConnected: true,
    sorobanRpcReachable: true,
    feeds: [
      {
        feedId: "XLM_USD",
        requiredQuorum: 2,
        healthyRealSourceCount: 1,
        healthyMockSourceCount: 1,
      },
    ],
  });
  assert.equal(prodFail.httpStatus, 503);
  assert.equal(prodFail.ready, false);
  assert.ok(prodFail.failingChecks.includes("feed_XLM_USD_mock_sources_forbidden_in_production"));
  assert.ok(prodFail.failingChecks.includes("feed_XLM_USD_insufficient_real_quorum"));

  // Production passes when dependencies and real source quorum are healthy
  const prodOk = probe.checkReadiness({
    trustMode: "production",
    databaseConnected: true,
    redisConnected: true,
    sorobanRpcReachable: true,
    feeds: [
      {
        feedId: "XLM_USD",
        requiredQuorum: 2,
        healthyRealSourceCount: 2,
        healthyMockSourceCount: 0,
      },
    ],
  });
  assert.equal(prodOk.httpStatus, 200);
  assert.equal(prodOk.ready, true);
});
