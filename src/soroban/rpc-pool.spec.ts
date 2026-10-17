import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DefinitiveTransactionRejectionError,
  SorobanRpcPool,
} from "./rpc-pool.ts";

test("Issue #238: rotates away from lagging or timed-out endpoints, recovers when probe returns healthy, and prevents duplicate publish submissions", async () => {
  const pool = new SorobanRpcPool({
    endpoints: [
      { endpointId: "rpc_primary", url: "https://rpc1.soroban.example", priority: 1 },
      { endpointId: "rpc_secondary", url: "https://rpc2.soroban.example", priority: 2 },
      { endpointId: "rpc_tertiary", url: "https://rpc3.soroban.example", priority: 3 },
    ],
    maxAllowedLedgerLag: 5,
    maxAllowedLatencyMs: 2_000,
    unhealthyFailureThreshold: 1,
  });

  // Probe 1: rpc_primary is lagging by 20 ledgers (500 vs 520), rpc_secondary and rpc_tertiary are caught up at 520
  pool.applyHealthProbeSamples([
    { endpointId: "rpc_primary", reachable: true, latencyMs: 120, latestLedger: 500 },
    { endpointId: "rpc_secondary", reachable: true, latencyMs: 150, latestLedger: 520 },
    { endpointId: "rpc_tertiary", reachable: true, latencyMs: 180, latestLedger: 520 },
  ]);

  const metricsAfterProbe1 = pool.getEndpointMetrics();
  assert.equal(
    metricsAfterProbe1.find((m) => m.endpointId === "rpc_primary")?.status,
    "lagging"
  );

  // Publish transaction: rpc_primary is skipped (lagging); simulate rpc_secondary timing out -> fails over to rpc_tertiary!
  const attemptedEndpoints: string[] = [];
  const pubRes = await pool.executePublishTransaction(
    "idem_round_101",
    async (ep) => {
      attemptedEndpoints.push(ep.endpointId);
      if (ep.endpointId === "rpc_secondary") {
        throw new Error("ETIMEDOUT connecting to rpc_secondary");
      }
      return { txHash: "tx_soroban_101" };
    }
  );

  assert.deepEqual(attemptedEndpoints, ["rpc_secondary", "rpc_tertiary"]);
  assert.equal(pubRes.servedByEndpointId, "rpc_tertiary");
  assert.equal(pubRes.txHash, "tx_soroban_101");

  // Re-submitting same idempotencyKey returns cached result without invoking RPC again
  const duplicateCall = await pool.executePublishTransaction(
    "idem_round_101",
    async () => {
      throw new Error("Should not be called for duplicate idempotencyKey");
    }
  );
  assert.equal(duplicateCall.txHash, "tx_soroban_101");

  // Probe 2: rpc_primary catches up to ledger 525 -> recovers to 'healthy'
  pool.applyHealthProbeSamples([
    { endpointId: "rpc_primary", reachable: true, latencyMs: 90, latestLedger: 525 },
  ]);
  assert.equal(
    pool.getEndpointMetrics().find((m) => m.endpointId === "rpc_primary")?.status,
    "healthy"
  );
});

test("Issue #238: does not retry definitive transaction rejections and supports single-endpoint configuration", async () => {
  const singlePool = new SorobanRpcPool({
    endpoints: [
      { endpointId: "rpc_single", url: "https://single.soroban.example", priority: 1 },
    ],
  });

  const pollRes = await singlePool.executeReadOrPoll(async (ep) => ({
    ledger: 1000,
    url: ep.url,
  }));
  assert.equal(pollRes.servedByEndpointId, "rpc_single");
  assert.equal(pollRes.data.ledger, 1000);

  // Definitive transaction rejection must not fail over across endpoints
  const multiPool = new SorobanRpcPool({
    endpoints: [
      { endpointId: "ep_1", url: "https://ep1.example", priority: 1 },
      { endpointId: "ep_2", url: "https://ep2.example", priority: 2 },
    ],
  });

  let callCount = 0;
  await assert.rejects(
    () =>
      multiPool.executePublishTransaction("idem_bad_tx", async () => {
        callCount += 1;
        throw new DefinitiveTransactionRejectionError("tx_failed_contract_panic");
      }),
    /tx_failed_contract_panic/
  );
  assert.equal(callCount, 1);
});
