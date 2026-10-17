import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HorizonFinalityEvaluator } from "./horizonFinalityEvaluator.ts";

describe("HorizonFinalityEvaluator (Issue #199)", () => {
  it("tags recent Horizon readings as provisional, excludes them from quorum until confirmed, and promotes them to final", () => {
    const evaluator = new HorizonFinalityEvaluator({ confirmationDepth: 3 });
    const t0 = 1_700_000_000_000;

    // 1. Reading at ledger 500 when latestNetworkLedger = 505 -> immediately final (depth 5 >= 3)
    const r500 = evaluator.ingestHorizonReading({
      feedId: "stablecoin_depeg",
      value: 1.0,
      ledgerSeq: 500,
      ledgerHash: "hash-500-canonical",
      latestNetworkLedger: 505,
      observedAtMs: t0,
    });
    assert.equal(r500.reading.finalityStatus, "final");

    // 2. Reading at ledger 504 when latestNetworkLedger = 505 -> provisional (depth 1 < 3)
    const r504 = evaluator.ingestHorizonReading({
      feedId: "stablecoin_depeg",
      value: 0.99,
      ledgerSeq: 504,
      ledgerHash: "hash-504-a",
      latestNetworkLedger: 505,
      observedAtMs: t0 + 5_000,
    });
    assert.equal(r504.reading.finalityStatus, "provisional");

    // Only r500 is quorum-eligible while r504 is still provisional
    assert.equal(
      evaluator.getQuorumEligibleReadings("stablecoin_depeg").length,
      1
    );
    assert.equal(evaluator.getSafeResumeCheckpointLedger(), 500);

    // 3. Network advances to ledger 508 -> r504 promoted to final
    const promoted = evaluator.advanceFinalityWindow(508);
    assert.equal(promoted, 1);
    assert.equal(
      evaluator.getReading(r504.reading.readingId)?.finalityStatus,
      "final"
    );
    assert.equal(
      evaluator.getQuorumEligibleReadings("stablecoin_depeg").length,
      2
    );
    assert.equal(evaluator.getSafeResumeCheckpointLedger(), 504);
  });

  it("detects ledger reorgs by hash mismatch, invalidates affected readings and decisions without touching unaffected history, and rolls back checkpoint", () => {
    const evaluator = new HorizonFinalityEvaluator({ confirmationDepth: 2 });
    const t0 = 1_700_000_000_000;

    const r100 = evaluator.ingestHorizonReading({
      feedId: "stablecoin_depeg",
      value: 1.0,
      ledgerSeq: 100,
      ledgerHash: "hash-100-good",
      latestNetworkLedger: 105,
      observedAtMs: t0,
    });

    const r104Forked = evaluator.ingestHorizonReading({
      feedId: "stablecoin_depeg",
      value: 0.85,
      ledgerSeq: 104,
      ledgerHash: "hash-104-orphan-branch",
      latestNetworkLedger: 106,
      observedAtMs: t0 + 10_000,
    });

    const decisionOnOrphan = evaluator.registerDecision({
      decisionId: "dec-orphan-1",
      feedId: "stablecoin_depeg",
      agreedValue: 0.85,
      contributingReadingIds: [r104Forked.reading.readingId],
    });
    assert.equal(decisionOnOrphan.status, "valid");
    assert.equal(evaluator.getSafeResumeCheckpointLedger(), 104);

    // Reorg arrives at ledger 104 with a new canonical hash!
    const r104Canonical = evaluator.ingestHorizonReading({
      feedId: "stablecoin_depeg",
      value: 0.998,
      ledgerSeq: 104,
      ledgerHash: "hash-104-canonical-branch",
      latestNetworkLedger: 105,
      observedAtMs: t0 + 15_000,
    });

    assert.equal(r104Canonical.reorgDetected, true);
    assert.equal(
      evaluator.getReading(r104Forked.reading.readingId)?.finalityStatus,
      "invalidated_by_reorg"
    );
    assert.equal(
      evaluator.getDecision("dec-orphan-1")?.status,
      "superseded_by_reorg"
    );

    // Unaffected earlier reading at ledger 100 remains final and safe checkpoint rolls back to 100 (since r104Canonical is still provisional at latest=105, depth=2)
    assert.equal(
      evaluator.getReading(r100.reading.readingId)?.finalityStatus,
      "final"
    );
    assert.equal(evaluator.getSafeResumeCheckpointLedger(), 100);
    assert.equal(evaluator.getReorgAuditEvents().length, 1);
  });
});
