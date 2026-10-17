import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SharedPipelineStateStore,
  OracleSettlementWorkerRuntime,
  ApiProcessPipelineReader,
} from "./oracleSettlementWorker.ts";

describe("Dedicated Oracle Ingestion and Claim Settlement Worker Process (#248)", () => {
  it("propagates worker cycle decisions and correlation IDs to the API process and degrades cleanly when the worker stops", async () => {
    const store = new SharedPipelineStateStore();
    const apiReader = new ApiProcessPipelineReader({
      store,
      maxWorkerHeartbeatAgeMs: 15_000,
    });

    // 1. Before worker starts -> API reports degraded_worker_offline
    const initialStatus = apiReader.getApiPipelineStatus(
      "USDC/USD",
      1_700_000_000_000
    );
    assert.equal(initialStatus.status, "degraded_worker_offline");
    assert.equal(initialStatus.freshForQuoting, false);

    // 2. Start dedicated worker and execute tick
    const worker = new OracleSettlementWorkerRuntime({
      workerId: "worker-1",
      fencingToken: 1,
      store,
      runPollAndSettleCycle: async (correlationId, nowMs) => ({
        publishedFeeds: [
          {
            feedId: "USDC/USD",
            canonicalValue: 0.9999,
            decidedAtMs: nowMs,
            correlationId,
          },
        ],
        settledClaimsCount: 2,
      }),
    });

    worker.start();
    const tickRes = await worker.executeTick(1_700_000_005_000);
    assert.equal(tickRes.executed, true);
    assert.equal(tickRes.correlationId, "worker-1-cycle-1");

    // 3. API process reads fresh state via SharedPipelineStateStore
    const liveStatus = apiReader.getApiPipelineStatus(
      "USDC/USD",
      1_700_000_010_000
    );
    assert.equal(liveStatus.status, "healthy");
    assert.equal(liveStatus.freshForQuoting, true);
    assert.equal(liveStatus.feed?.canonicalValue, 0.9999);
    assert.equal(liveStatus.lastCorrelationId, "worker-1-cycle-1");

    // 4. Stop/kill worker and advance time beyond maxWorkerHeartbeatAgeMs (15s) -> API reports degraded_worker_offline
    worker.stop();
    const degradedStatus = apiReader.getApiPipelineStatus(
      "USDC/USD",
      1_700_000_030_000
    );
    assert.equal(degradedStatus.status, "degraded_worker_offline");
    assert.equal(degradedStatus.freshForQuoting, false);
  });
});
