import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BatchedOnChainOraclePublisher,
  type PendingOnChainDecision,
} from "./batchedOnChainPublisher.ts";

describe("Batch and Backpressure On-Chain Oracle Publishing (#209)", () => {
  it("preserves per-feed sequence ordering, prioritizes payout triggers, and splits oversized batches on TX_SIZE_OR_FEE_EXCEEDED", async () => {
    const submittedBatches: string[][] = [];
    let txCounter = 0;

    const publisher = new BatchedOnChainOraclePublisher({
      maxBatchSize: 4,
      maxBatchBytes: 10_000,
      backpressureQueueThreshold: 3,
      backpressureLatencyThresholdMs: 2_000,
      submitBatchRpc: async (batch: PendingOnChainDecision[]) => {
        if (batch.length > 2) {
          throw new Error("TX_SIZE_OR_FEE_EXCEEDED: Soroban instruction limit");
        }
        submittedBatches.push(batch.map((d) => d.decisionId));
        txCounter += 1;
        return {
          txHash: `0xtx_${txCounter}`,
          ledgerSequence: 1000 + txCounter,
          latencyMs: 450,
        };
      },
    });

    // Enqueue out-of-order sequence numbers for feed A (normal priority) and feed B (high payout priority)
    publisher.enqueueDecision({
      decisionId: "A-seq-2",
      feedId: "XLM/USD",
      sequenceNumber: 2,
      priority: "normal_telemetry",
      estimatedBytes: 500,
      payload: { price: 0.12 },
    });
    publisher.enqueueDecision({
      decisionId: "A-seq-1",
      feedId: "XLM/USD",
      sequenceNumber: 1,
      priority: "normal_telemetry",
      estimatedBytes: 500,
      payload: { price: 0.11 },
    });
    publisher.enqueueDecision({
      decisionId: "B-seq-2",
      feedId: "USDC/USD",
      sequenceNumber: 2,
      priority: "high_payout_trigger",
      estimatedBytes: 500,
      payload: { price: 0.93 },
    });
    publisher.enqueueDecision({
      decisionId: "B-seq-1",
      feedId: "USDC/USD",
      sequenceNumber: 1,
      priority: "high_payout_trigger",
      estimatedBytes: 500,
      payload: { price: 0.94 },
    });

    // Duplicate enqueue is ignored
    assert.equal(
      publisher.enqueueDecision({
        decisionId: "B-seq-1",
        feedId: "USDC/USD",
        sequenceNumber: 1,
        priority: "high_payout_trigger",
        estimatedBytes: 500,
        payload: { price: 0.94 },
      }),
      false
    );

    // Queue depth is 4 >= threshold 3 -> backpressureActive is true
    const bpBefore = publisher.getBackpressureStatus();
    assert.equal(bpBefore.backpressureActive, true);
    assert.equal(bpBefore.recommendedLowPriorityPollScale, 3.0);

    // Flush batch of 4: RPC rejects >2 items with TX_SIZE_OR_FEE_EXCEEDED, so publisher splits into two 2-item txs
    const flushRes = await publisher.flushNextBatch();
    assert.deepEqual(flushRes.publishedDecisionIds, [
      "B-seq-1",
      "B-seq-2",
      "A-seq-1",
      "A-seq-2",
    ]);
    assert.equal(flushRes.txHashes.length, 2);
    assert.deepEqual(submittedBatches, [
      ["B-seq-1", "B-seq-2"],
      ["A-seq-1", "A-seq-2"],
    ]);

    // Queue drained and latency (450ms) < 2000ms -> backpressure cleared
    const bpAfter = publisher.getBackpressureStatus();
    assert.equal(bpAfter.backpressureActive, false);
    assert.equal(bpAfter.pendingDepth, 0);
  });
});
