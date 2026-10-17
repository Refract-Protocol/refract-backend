import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OracleRetentionAndArchivalEngine } from "./retentionAndCompactionEngine.ts";

describe("Retention, Compaction, and Exportable Archival for Oracle Readings and Evidence (#211)", () => {
  it("prunes unreferenced aged raw readings while preserving decision-pinned readings and immutable evidence, and verifies archive export/restore round-trip", () => {
    const engine = new OracleRetentionAndArchivalEngine({
      archiveSigningSecret: "archive-hmac-secret-2026",
    });

    const oldTimestampMs = Date.parse("2026-09-01T10:00:00.000Z");
    const nowMs = Date.parse("2026-10-17T10:00:00.000Z");

    // 1. Aged reading r-unreferenced (not linked to any decision)
    engine.insertRawReading({
      readingId: "r-unreferenced",
      partitionKey: "2026-09-01",
      sourceId: "coingecko",
      feedId: "USDC/USD",
      canonicalValue: 1.0,
      observedAtMs: oldTimestampMs,
    });

    // 2. Aged reading r-pinned (referenced by decision-1)
    engine.insertRawReading({
      readingId: "r-pinned",
      partitionKey: "2026-09-01",
      sourceId: "pyth",
      feedId: "USDC/USD",
      canonicalValue: 0.94,
      observedAtMs: oldTimestampMs + 1_000,
    });

    // 3. Recent reading r-recent
    engine.insertRawReading({
      readingId: "r-recent",
      partitionKey: "2026-10-17",
      sourceId: "pyth",
      feedId: "USDC/USD",
      canonicalValue: 1.0,
      observedAtMs: nowMs - 5_000,
    });

    engine.recordEvidenceDecision({
      decisionId: "decision-1",
      feedId: "USDC/USD",
      agreedValue: 0.94,
      inputReadingIds: ["r-pinned"],
      disputeOpen: true,
      decidedAtMs: oldTimestampMs + 2_000,
    });

    // Dry-run compaction previews pruning without deleting r-unreferenced
    const dryRes = engine.runRetentionAndCompaction({
      nowMs,
      rawReadingRetentionMs: 7 * 86_400_000,
      dryRun: true,
    });
    assert.deepEqual(dryRes.prunedReadingIds, ["r-unreferenced"]);
    assert.ok(engine.getRawReading("r-unreferenced") !== null);

    // Live compaction prunes r-unreferenced while preserving r-pinned, r-recent, and decision-1
    const liveRes = engine.runRetentionAndCompaction({
      nowMs,
      rawReadingRetentionMs: 7 * 86_400_000,
      dryRun: false,
    });
    assert.deepEqual(liveRes.prunedReadingIds, ["r-unreferenced"]);
    assert.deepEqual(liveRes.preservedPinnedReadingIds, ["r-pinned"]);
    assert.equal(liveRes.evidenceRecordsPreserved, 1);
    assert.equal(engine.getRawReading("r-unreferenced"), null);
    assert.ok(engine.getRawReading("r-pinned") !== null);

    // Export partition 2026-09-01 and restore into a fresh engine instance
    const archiveBundle = engine.exportPartitionArchive("2026-09-01", nowMs);
    assert.equal(archiveBundle.readings.length, 1);
    assert.equal(archiveBundle.evidenceDecisions.length, 1);

    const restoredEngine = new OracleRetentionAndArchivalEngine({
      archiveSigningSecret: "archive-hmac-secret-2026",
    });
    const restoreStats = restoredEngine.verifyAndRestoreArchive(archiveBundle);
    assert.equal(restoreStats.restoredReadings, 1);
    assert.equal(restoreStats.restoredDecisions, 1);
    assert.deepEqual(
      restoredEngine.getEvidenceDecision("decision-1"),
      engine.getEvidenceDecision("decision-1")
    );

    // Tampered archive fails checksum verification
    assert.throws(
      () =>
        restoredEngine.verifyAndRestoreArchive({
          ...archiveBundle,
          sha256Checksum: "0000",
        }),
      /ARCHIVE_CHECKSUM_MISMATCH/
    );
  });
});
