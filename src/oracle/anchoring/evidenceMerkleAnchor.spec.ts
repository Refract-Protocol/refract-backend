import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EvidenceMerkleAnchorService,
  type EvidenceLedgerEntry,
} from "./evidenceMerkleAnchor.ts";

describe("Anchor Evidence Ledger Merkle Roots On-Chain for Tamper Evidence (#218)", () => {
  it("anchors contiguous sequence ranges, verifies Merkle inclusion proofs, and detects post-hoc record tampering", async () => {
    let txCount = 0;
    const anchorService = new EvidenceMerkleAnchorService({
      publishRootOnChain: async () => {
        txCount += 1;
        return {
          txHash: `0xanchor_tx_${txCount}`,
          sorobanLedger: 50_000 + txCount,
        };
      },
    });

    const entries: EvidenceLedgerEntry[] = [
      {
        sequenceNumber: 1,
        recordId: "ev-1",
        feedId: "USDC/USD",
        stage: "evidence_reading",
        payloadHash: "sha256:aaa",
        observedAtMs: 1_700_000_001_000,
      },
      {
        sequenceNumber: 2,
        recordId: "ev-2",
        feedId: "USDC/USD",
        stage: "consensus_decision",
        payloadHash: "sha256:bbb",
        observedAtMs: 1_700_000_002_000,
      },
      {
        sequenceNumber: 3,
        recordId: "ev-3",
        feedId: "USDC/USD",
        stage: "settlement_outcome",
        payloadHash: "sha256:ccc",
        observedAtMs: 1_700_000_003_000,
      },
    ];

    for (const e of entries) {
      anchorService.appendLedgerEntry(e);
    }

    // Anchor range [1..3]
    const receipt1 = await anchorService.anchorNextUnanchoredRange(
      1_700_000_005_000
    );
    assert.ok(receipt1);
    assert.equal(receipt1.fromSequence, 1);
    assert.equal(receipt1.toSequence, 3);

    // Calling anchor again with no new entries is idempotent (returns null)
    const noopReceipt = await anchorService.anchorNextUnanchoredRange(
      1_700_000_006_000
    );
    assert.equal(noopReceipt, null);

    // Append entries 4 and 5 and verify contiguous range [4..5]
    anchorService.appendLedgerEntry({
      sequenceNumber: 4,
      recordId: "ev-4",
      feedId: "XLM/USD",
      stage: "evidence_reading",
      payloadHash: "sha256:ddd",
      observedAtMs: 1_700_000_010_000,
    });
    anchorService.appendLedgerEntry({
      sequenceNumber: 5,
      recordId: "ev-5",
      feedId: "XLM/USD",
      stage: "consensus_decision",
      payloadHash: "sha256:eee",
      observedAtMs: 1_700_000_011_000,
    });

    const receipt2 = await anchorService.anchorNextUnanchoredRange(
      1_700_000_015_000
    );
    assert.ok(receipt2);
    assert.equal(receipt2.fromSequence, 4);
    assert.equal(receipt2.toSequence, 5);

    // Verify inclusion proof for ev-2
    const verification = anchorService.buildInclusionProof("ev-2");
    assert.ok(verification);
    assert.equal(
      EvidenceMerkleAnchorService.verifyEntryAgainstProof(
        entries[1]!,
        verification.proof,
        verification.merkleRoot
      ),
      true
    );

    // Mutate payloadHash on ev-2 -> fails verification against published on-chain root
    const tamperedEntry: EvidenceLedgerEntry = {
      ...entries[1]!,
      payloadHash: "sha256:forged_payload",
    };
    assert.equal(
      EvidenceMerkleAnchorService.verifyEntryAgainstProof(
        tamperedEntry,
        verification.proof,
        verification.merkleRoot
      ),
      false
    );
  });
});
