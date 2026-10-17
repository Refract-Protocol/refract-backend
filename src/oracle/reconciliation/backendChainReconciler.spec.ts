import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BackendChainReconciler,
  type LocalPublishedRecord,
  type OnChainPublishedRecord,
} from "./backendChainReconciler.ts";

test("BackendChainReconciler classifies all 5 drift types, auto-repairs only missing receipts, and respects finality buffer", () => {
  const reconciler = new BackendChainReconciler({
    lookbackWindowMs: 60_000,
    finalityBufferMs: 10_000,
    authorizedSubmitters: ["G_RELAYER_MAIN"],
  });

  const nowMs = 100_000; // Finalized window: [40_000, 90_000]

  const localRecords: LocalPublishedRecord[] = [
    // 1. Missing local receipt (value + ts match on-chain -> auto-repaired)
    {
      decisionId: "dec-1",
      feedId: "USDC-USD",
      roundId: "r-1",
      value: 1.0,
      observedAtMs: 50_000,
      txHash: null,
    },
    // 2. Value mismatch (never auto-repaired -> human review)
    {
      decisionId: "dec-2",
      feedId: "USDC-USD",
      roundId: "r-2",
      value: 1.0,
      observedAtMs: 60_000,
      txHash: "0xabc2",
    },
    // 3. Timestamp mismatch
    {
      decisionId: "dec-3",
      feedId: "USDC-USD",
      roundId: "r-3",
      value: 1.0,
      observedAtMs: 70_000,
      txHash: "0xabc3",
    },
    // 4. Missing on-chain value
    {
      decisionId: "dec-4",
      feedId: "USDC-USD",
      roundId: "r-4",
      value: 1.0,
      observedAtMs: 80_000,
      txHash: "0xabc4",
    },
    // 5. Unfinalized entry inside finality buffer (95_000 > 90_000 -> ignored)
    {
      decisionId: "dec-unfinalized",
      feedId: "USDC-USD",
      roundId: "r-unfinalized",
      value: 1.0,
      observedAtMs: 95_000,
      txHash: null,
    },
  ];

  const onChainRecords: OnChainPublishedRecord[] = [
    {
      feedId: "USDC-USD",
      roundId: "r-1",
      value: 1.0,
      observedAtMs: 50_000,
      txHash: "0xrepaired1",
      submitter: "G_RELAYER_MAIN",
    },
    {
      feedId: "USDC-USD",
      roundId: "r-2",
      value: 0.94, // value mismatch!
      observedAtMs: 60_000,
      txHash: "0xabc2",
      submitter: "G_RELAYER_MAIN",
    },
    {
      feedId: "USDC-USD",
      roundId: "r-3",
      value: 1.0,
      observedAtMs: 70_500, // timestamp mismatch!
      txHash: "0xabc3",
      submitter: "G_RELAYER_MAIN",
    },
    // Extra on-chain write from unauthorized submitter
    {
      feedId: "USDC-USD",
      roundId: "r-rogue",
      value: 0.85,
      observedAtMs: 85_000,
      txHash: "0xrogue",
      submitter: "G_ROGUE_ACTOR",
    },
  ];

  const summary = reconciler.reconcile({
    nowMs,
    localRecords,
    onChainRecords,
  });

  // Missing local receipt was backfilled
  assert.equal(summary.autoRepairedReceipts, 1);
  assert.equal(localRecords[0].txHash, "0xrepaired1");

  // Value mismatch was NOT auto-repaired
  assert.equal(localRecords[1].value, 1.0);

  // Verify drift class counts
  assert.deepEqual(summary.countsByClass, {
    MISSING_LOCAL_RECEIPT: 1,
    MISSING_ON_CHAIN_VALUE: 1,
    VALUE_MISMATCH: 1,
    TIMESTAMP_MISMATCH: 1,
    UNEXPECTED_ON_CHAIN_WRITER: 1,
  });
  assert.equal(summary.humanReviewCount, 4);
  assert.equal(
    reconciler.getCumulativeDriftMetrics().VALUE_MISMATCH,
    1
  );
});
