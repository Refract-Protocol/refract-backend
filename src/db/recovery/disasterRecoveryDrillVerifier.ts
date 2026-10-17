export interface RestoredBackupSnapshot {
  backupCreatedAtMs: number;
  restoreDurationMs: number;
  expectedPartitions: string[];
  restoredPartitions: string[];
  expectedDecisionCount: number;
  restoredDecisionCount: number;
  evidenceChainEntries: Array<{
    sequenceNumber: number;
    evidenceId: string;
    prevHash: string;
    entryHash: string;
  }>;
  settledClaims: Array<{
    claimId: string;
    decisionId: string;
    evidenceId: string;
  }>;
  restoredDecisionIds: string[];
}

export interface RecoveryDrillReport {
  passed: boolean;
  rpoLagMs: number;
  restoreDurationMs: number;
  diagnostics: string[];
}

export function verifyRestoredEvidenceBackup(params: {
  targetEnv: "ephemeral" | "staging" | "production";
  nowMs: number;
  maxRpoWindowMs: number;
  maxRtoDurationMs: number;
  snapshot: RestoredBackupSnapshot;
}): RecoveryDrillReport {
  if (params.targetEnv === "production") {
    throw new Error(
      "REFUSE_PRODUCTION_DRILL_TARGET: Disaster recovery restore drill must never run against production"
    );
  }

  const diagnostics: string[] = [];
  const rpoLagMs = params.nowMs - params.snapshot.backupCreatedAtMs;

  if (rpoLagMs > params.maxRpoWindowMs) {
    diagnostics.push(
      `RPO_WINDOW_BREACHED: Backup age ${rpoLagMs}ms exceeds RPO target ${params.maxRpoWindowMs}ms`
    );
  }

  if (params.snapshot.restoreDurationMs > params.maxRtoDurationMs) {
    diagnostics.push(
      `RTO_DURATION_EXCEEDED: Restore duration ${params.snapshot.restoreDurationMs}ms exceeds RTO target ${params.maxRtoDurationMs}ms`
    );
  }

  // 1. Check recent partitions present
  const restoredPartitionSet = new Set(params.snapshot.restoredPartitions);
  const missingPartitions = params.snapshot.expectedPartitions.filter(
    (p) => !restoredPartitionSet.has(p)
  );
  if (missingPartitions.length > 0) {
    diagnostics.push(
      `MISSING_RECENT_PARTITIONS: Backup is missing partitions: ${missingPartitions.join(", ")}`
    );
  }

  // 2. Check row counts (decisions must be lossless)
  if (
    params.snapshot.restoredDecisionCount <
    params.snapshot.expectedDecisionCount
  ) {
    diagnostics.push(
      `ROW_COUNT_TRUNCATED: Restored decisions (${params.snapshot.restoredDecisionCount}) < expected (${params.snapshot.expectedDecisionCount})`
    );
  }

  // 3. Check gap-free evidence sequence and hash-chain continuity
  const chain = params.snapshot.evidenceChainEntries;
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    const expectedSeq = i + 1;
    const expectedPrev = i === 0 ? "GENESIS" : chain[i - 1].entryHash;
    if (
      entry.sequenceNumber !== expectedSeq ||
      entry.prevHash !== expectedPrev
    ) {
      diagnostics.push(
        `EVIDENCE_CHAIN_CORRUPTED: Sequence or hash break at index ${i} (seq=${entry.sequenceNumber})`
      );
      break;
    }
  }

  // 4. Referential integrity: every settled claim has a decision and evidence record
  const decisionSet = new Set(params.snapshot.restoredDecisionIds);
  const evidenceSet = new Set(chain.map((e) => e.evidenceId));
  for (const claim of params.snapshot.settledClaims) {
    if (
      !decisionSet.has(claim.decisionId) ||
      !evidenceSet.has(claim.evidenceId)
    ) {
      diagnostics.push(
        `ORPHAN_SETTLED_CLAIM: Claim '${claim.claimId}' is missing decision '${claim.decisionId}' or evidence '${claim.evidenceId}'`
      );
    }
  }

  return {
    passed: diagnostics.length === 0,
    rpoLagMs,
    restoreDurationMs: params.snapshot.restoreDurationMs,
    diagnostics,
  };
}
