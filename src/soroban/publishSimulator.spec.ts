import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SorobanPublishSimulator,
  type OraclePublishIntent,
} from "./publishSimulator.ts";

describe("SorobanPublishSimulator (Issue #239)", () => {
  const baseIntent: OraclePublishIntent = {
    feedId: "rainfall-miami",
    roundId: 42,
    value: 118.5,
    observedAtMs: 1_700_000_000_000,
    contractAddress: "CDUMMYORACLECONTRACT12345",
    signerPublicKey: "GOPERATORSIGNERKEY12345",
  };

  it("blocks signing and submission when simulation fails and classifies failures into actionable categories", async () => {
    let signCalled = 0;
    let submitCalled = 0;
    let simulatedErrorCode = "UNAUTHORIZED_SIGNER";

    const simulator = new SorobanPublishSimulator(
      {
        simulateTransaction: async () => ({
          ok: false,
          errorCode: simulatedErrorCode,
          errorMessage: `Simulation failed: ${simulatedErrorCode}`,
        }),
        signTransaction: async () => {
          signCalled += 1;
          return "signed-xdr";
        },
        submitTransaction: async () => {
          submitCalled += 1;
          return { txHash: "tx-123" };
        },
      },
      { simulationCacheTtlMs: 0, baseRetryBackoffMs: 1_000 }
    );

    // 1. Config / auth error -> alerts operator, does not retry, never signs
    const authFail = await simulator.executePublishPipeline(baseIntent, 1_000);
    assert.equal(authFail.status, "blocked_by_simulation");
    assert.equal(authFail.signed, false);
    assert.equal(authFail.submitted, false);
    assert.equal(authFail.failureCategory, "config_or_auth_error");
    assert.equal(authFail.shouldAlertOperator, true);
    assert.equal(authFail.shouldRetry, false);

    // 2. Transient RPC error -> schedules retry with exponential backoff
    simulatedErrorCode = "RPC_TIMEOUT";
    const rpcFail = await simulator.executePublishPipeline(
      { ...baseIntent, roundId: 43 },
      2_000,
      2
    );
    assert.equal(rpcFail.failureCategory, "transient_rpc_error");
    assert.equal(rpcFail.shouldRetry, true);
    assert.equal(rpcFail.retryBackoffMs, 2_000);

    // 3. Invalid reading error -> quarantines reading and records diagnostic
    simulatedErrorCode = "STALE_TIMESTAMP_ON_CHAIN";
    const readingFail = await simulator.executePublishPipeline(
      { ...baseIntent, roundId: 44 },
      3_000
    );
    assert.equal(readingFail.failureCategory, "invalid_reading_error");
    assert.equal(readingFail.quarantinedReading, true);
    assert.equal(readingFail.evidenceDiagnostic.simulatedOk, false);

    assert.equal(signCalled, 0);
    assert.equal(submitCalled, 0);

    const metrics = simulator.getMetrics();
    assert.equal(metrics.simulationBlockedCount, 3);
    assert.equal(metrics.blockedByCategory.config_or_auth_error, 1);
    assert.equal(metrics.blockedByCategory.transient_rpc_error, 1);
    assert.equal(metrics.blockedByCategory.invalid_reading_error, 1);
  });

  it("signs and submits when simulation succeeds, detects unexpected footprint changes, and caches identical simulations", async () => {
    let simCallCount = 0;

    const simulator = new SorobanPublishSimulator(
      {
        simulateTransaction: async () => {
          simCallCount += 1;
          return {
            ok: true,
            cpuInstructions: 450_000,
            estimatedFeeStroops: 1200,
            readWriteFootprintKeys: ["feed:rainfall-miami", "unexpected:admin-slot"],
            assembledTxXdr: "assembled-tx-xdr",
          };
        },
        signTransaction: async (xdr) => `signed:${xdr}`,
        submitTransaction: async () => ({ txHash: "soroban-tx-hash-999" }),
      },
      {
        expectedFootprintKeysByFeed: {
          "rainfall-miami": ["feed:rainfall-miami"],
        },
        simulationCacheTtlMs: 10_000,
      }
    );

    const firstRun = await simulator.executePublishPipeline(baseIntent, 10_000);
    assert.equal(firstRun.status, "submitted");
    assert.equal(firstRun.signed, true);
    assert.equal(firstRun.submitted, true);
    assert.equal(firstRun.txHash, "soroban-tx-hash-999");
    assert.equal(firstRun.footprintChangedWarning, true);
    assert.deepEqual(firstRun.unexpectedFootprintKeys, ["unexpected:admin-slot"]);
    assert.equal(firstRun.usedCachedSimulation, false);

    // Second run within cache TTL reuses simulation response
    const secondRun = await simulator.executePublishPipeline(baseIntent, 12_000);
    assert.equal(secondRun.status, "submitted");
    assert.equal(secondRun.usedCachedSimulation, true);
    assert.equal(simCallCount, 1);

    const metrics = simulator.getMetrics();
    assert.equal(metrics.simulatedOkCount, 2);
    assert.equal(metrics.cacheHitCount, 1);
  });
});
