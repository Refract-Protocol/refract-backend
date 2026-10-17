import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyRestoredEvidenceBackup } from "./disasterRecoveryDrillVerifier.ts";

test("verifyRestoredEvidenceBackup passes on a clean backup and fails with diagnostics on truncated, missing-partition, or corrupted backups", () => {
  const clean = verifyRestoredEvidenceBackup({
    targetEnv: "ephemeral",
    nowMs: 100_000,
    maxRpoWindowMs: 60_000,
    maxRtoDurationMs: 30_000,
    snapshot: {
      backupCreatedAtMs: 80_000,
      restoreDurationMs: 12_000,
      expectedPartitions: ["oracle_evidence_ledger_p2026_10"],
      restoredPartitions: ["oracle_evidence_ledger_p2026_10"],
      expectedDecisionCount: 2,
      restoredDecisionCount: 2,
      evidenceChainEntries: [
        {
          sequenceNumber: 1,
          evidenceId: "ev-1",
          prevHash: "GENESIS",
          entryHash: "h1",
        },
        {
          sequenceNumber: 2,
          evidenceId: "ev-2",
          prevHash: "h1",
          entryHash: "h2",
        },
      ],
      settledClaims: [
        { claimId: "claim-1", decisionId: "dec-1", evidenceId: "ev-1" },
      ],
      restoredDecisionIds: ["dec-1", "dec-2"],
    },
  });
  assert.equal(clean.passed, true);
  assert.equal(clean.diagnostics.length, 0);

  // Refuse running against production
  assert.throws(
    () =>
      verifyRestoredEvidenceBackup({
        targetEnv: "production",
        nowMs: 100_000,
        maxRpoWindowMs: 60_000,
        maxRtoDurationMs: 30_000,
        snapshot: {
          backupCreatedAtMs: 80_000,
          restoreDurationMs: 12_000,
          expectedPartitions: [],
          restoredPartitions: [],
          expectedDecisionCount: 0,
          restoredDecisionCount: 0,
          evidenceChainEntries: [],
          settledClaims: [],
          restoredDecisionIds: [],
        },
      }),
    /REFUSE_PRODUCTION_DRILL_TARGET/
  );

  // Truncated backup missing recent partition + broken chain + orphan claim
  const corrupted = verifyRestoredEvidenceBackup({
    targetEnv: "ephemeral",
    nowMs: 200_000,
    maxRpoWindowMs: 60_000,
    maxRtoDurationMs: 30_000,
    snapshot: {
      backupCreatedAtMs: 80_000, // 120s > 60s RPO
      restoreDurationMs: 12_000,
      expectedPartitions: ["p2026_10", "p2026_11"],
      restoredPartitions: ["p2026_10"],
      expectedDecisionCount: 10,
      restoredDecisionCount: 8,
      evidenceChainEntries: [
        {
          sequenceNumber: 1,
          evidenceId: "ev-1",
          prevHash: "GENESIS",
          entryHash: "h1",
        },
        {
          sequenceNumber: 3, // gap!
          evidenceId: "ev-3",
          prevHash: "h1",
          entryHash: "h3",
        },
      ],
      settledClaims: [
        { claimId: "claim-orphan", decisionId: "dec-missing", evidenceId: "ev-1" },
      ],
      restoredDecisionIds: ["dec-1"],
    },
  });

  assert.equal(corrupted.passed, false);
  assert.ok(corrupted.diagnostics.some((d) => d.includes("RPO_WINDOW_BREACHED")));
  assert.ok(corrupted.diagnostics.some((d) => d.includes("MISSING_RECENT_PARTITIONS")));
  assert.ok(corrupted.diagnostics.some((d) => d.includes("ROW_COUNT_TRUNCATED")));
  assert.ok(corrupted.diagnostics.some((d) => d.includes("EVIDENCE_CHAIN_CORRUPTED")));
  assert.ok(corrupted.diagnostics.some((d) => d.includes("ORPHAN_SETTLED_CLAIM")));
});
