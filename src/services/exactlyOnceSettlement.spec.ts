import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ExactlyOnceSettlementCoordinator,
  deriveDeterministicDecisionId,
} from "./exactlyOnceSettlement.ts";

describe("ExactlyOnceSettlementCoordinator (Issue #198)", () => {
  const sampleKeyInput = {
    feedId: "stablecoin_depeg",
    policyId: "policy-1001",
    conditionRuleKey: "lte:0.95",
    windowStartMs: 1_700_000_000_000,
    windowEndMs: 1_700_000_060_000,
  };

  it("produces deterministic node-independent decision IDs and guarantees exactly one on-chain submission under concurrent duplicate deliveries", async () => {
    const id1 = deriveDeterministicDecisionId(sampleKeyInput);
    const id2 = deriveDeterministicDecisionId({ ...sampleKeyInput });
    assert.equal(id1, id2);

    let onChainSubmitCount = 0;
    const coordinator = new ExactlyOnceSettlementCoordinator({
      checkOnChainTransactionByDedupeKey: async () => ({ foundOnChain: false }),
      submitSettlementOnChain: async ({ decisionDedupeKey }) => {
        onChainSubmitCount += 1;
        await new Promise((r) => setTimeout(r, 10));
        return { txHash: `tx-hash-${decisionDedupeKey.slice(-6)}` };
      },
    });

    // Fire 4 concurrent settlement requests for the exact same decision
    const results = await Promise.all([
      coordinator.settleDecisionIdempotently({
        keyInput: sampleKeyInput,
        evidenceId: "ev-1",
        payoutAmountUsd: 5_000,
      }),
      coordinator.settleDecisionIdempotently({
        keyInput: sampleKeyInput,
        evidenceId: "ev-1",
        payoutAmountUsd: 5_000,
      }),
      coordinator.settleDecisionIdempotently({
        keyInput: sampleKeyInput,
        evidenceId: "ev-1",
        payoutAmountUsd: 5_000,
      }),
      coordinator.settleDecisionIdempotently({
        keyInput: sampleKeyInput,
        evidenceId: "ev-1",
        payoutAmountUsd: 5_000,
      }),
    ]);

    assert.equal(onChainSubmitCount, 1);
    const confirmedNew = results.filter(
      (r) => r.status === "confirmed_new_submission"
    );
    const suppressed = results.filter(
      (r) => r.status === "suppressed_duplicate"
    );
    assert.equal(confirmedNew.length, 1);
    assert.equal(suppressed.length, 3);
    assert.equal(coordinator.getSuppressedDuplicateCount(), 3);
  });

  it("reconciles a transaction that timed out locally but landed on-chain without submitting a second transaction", async () => {
    let submitCalls = 0;
    const landedOnChain = new Map<string, string>();

    const coordinator = new ExactlyOnceSettlementCoordinator({
      checkOnChainTransactionByDedupeKey: async (dedupeKey) => {
        const txHash = landedOnChain.get(dedupeKey);
        return txHash
          ? { foundOnChain: true, txHash }
          : { foundOnChain: false };
      },
      submitSettlementOnChain: async ({ decisionDedupeKey }) => {
        submitCalls += 1;
        // Simulate transaction landing on-chain right as local RPC connection times out
        landedOnChain.set(decisionDedupeKey, "tx-landed-before-crash-999");
        throw new Error("Local RPC socket timeout waiting for confirmation");
      },
    });

    // Attempt 1: times out locally -> leaves record in recoverable failed state
    const attempt1 = await coordinator.settleDecisionIdempotently({
      keyInput: sampleKeyInput,
      evidenceId: "ev-2",
      payoutAmountUsd: 5_000,
    });
    assert.equal(attempt1.status, "submission_failed_recoverable");
    assert.equal(submitCalls, 1);

    // Attempt 2 (post-crash / retry): pre-submission check sees tx-landed-before-crash-999 on-chain and reconciles without re-submitting!
    const attempt2 = await coordinator.settleDecisionIdempotently({
      keyInput: sampleKeyInput,
      evidenceId: "ev-2",
      payoutAmountUsd: 5_000,
    });
    assert.equal(attempt2.status, "reconciled_existing_on_chain_submission");
    assert.equal(attempt2.txHash, "tx-landed-before-crash-999");
    assert.equal(attempt2.record.state, "confirmed");
    assert.equal(submitCalls, 1);
  });
});
