import { createHash, createHmac } from "node:crypto";

export interface PartitionedRawReading {
  readingId: string;
  partitionKey: string; // e.g., "2026-10-01"
  sourceId: string;
  feedId: string;
  canonicalValue: number;
  observedAtMs: number;
}

export interface ImmutableEvidenceLedgerRecord {
  decisionId: string;
  feedId: string;
  agreedValue: number;
  inputReadingIds: string[];
  disputeOpen: boolean;
  decidedAtMs: number;
}

export interface SignedPartitionArchiveBundle {
  partitionKey: string;
  exportedAtMs: number;
  readings: PartitionedRawReading[];
  evidenceDecisions: ImmutableEvidenceLedgerRecord[];
  sha256Checksum: string;
  hmacSignature: string;
}

export class OracleRetentionAndArchivalEngine {
  private readonly rawReadings = new Map<string, PartitionedRawReading>();
  private readonly evidenceLedger = new Map<
    string,
    ImmutableEvidenceLedgerRecord
  >();
  private readonly archiveSigningSecret: string;

  constructor(options: { archiveSigningSecret: string }) {
    this.archiveSigningSecret = options.archiveSigningSecret;
  }

  public static toPartitionKey(timestampMs: number): string {
    return new Date(timestampMs).toISOString().slice(0, 10);
  }

  public insertRawReading(reading: PartitionedRawReading): void {
    this.rawReadings.set(reading.readingId, { ...reading });
  }

  public recordEvidenceDecision(record: ImmutableEvidenceLedgerRecord): void {
    this.evidenceLedger.set(record.decisionId, {
      ...record,
      inputReadingIds: [...record.inputReadingIds],
    });
  }

  /**
   * Collects all raw reading IDs referenced by any consensus decision or open dispute.
   * Referential integrity ensures these readings are never pruned by compaction.
   */
  public getPinnedReadingIds(): Set<string> {
    const pinned = new Set<string>();
    for (const ev of this.evidenceLedger.values()) {
      for (const rId of ev.inputReadingIds) {
        pinned.add(rId);
      }
    }
    return pinned;
  }

  /**
   * Compacts aged raw readings older than `rawReadingRetentionMs` that are NOT referenced
   * by any consensus decision or open dispute. Evidence ledger rows are never dropped.
   */
  public runRetentionAndCompaction(params: {
    nowMs: number;
    rawReadingRetentionMs: number;
    dryRun?: boolean;
  }): {
    prunedReadingIds: string[];
    preservedPinnedReadingIds: string[];
    preservedRecentReadingIds: string[];
    evidenceRecordsPreserved: number;
  } {
    const cutoffMs = params.nowMs - params.rawReadingRetentionMs;
    const pinned = this.getPinnedReadingIds();

    const prunedReadingIds: string[] = [];
    const preservedPinnedReadingIds: string[] = [];
    const preservedRecentReadingIds: string[] = [];

    for (const [id, reading] of this.rawReadings.entries()) {
      if (reading.observedAtMs >= cutoffMs) {
        preservedRecentReadingIds.push(id);
        continue;
      }
      if (pinned.has(id)) {
        preservedPinnedReadingIds.push(id);
        continue;
      }
      prunedReadingIds.push(id);
      if (!params.dryRun) {
        this.rawReadings.delete(id);
      }
    }

    return {
      prunedReadingIds,
      preservedPinnedReadingIds,
      preservedRecentReadingIds,
      evidenceRecordsPreserved: this.evidenceLedger.size,
    };
  }

  public exportPartitionArchive(
    partitionKey: string,
    exportedAtMs: number = Date.now()
  ): SignedPartitionArchiveBundle {
    const readings = Array.from(this.rawReadings.values())
      .filter((r) => r.partitionKey === partitionKey)
      .sort((a, b) => a.readingId.localeCompare(b.readingId));

    const readingSet = new Set(readings.map((r) => r.readingId));
    const evidenceDecisions = Array.from(this.evidenceLedger.values())
      .filter(
        (ev) =>
          OracleRetentionAndArchivalEngine.toPartitionKey(ev.decidedAtMs) ===
            partitionKey || ev.inputReadingIds.some((id) => readingSet.has(id))
      )
      .sort((a, b) => a.decisionId.localeCompare(b.decisionId));

    const canonicalPayload = JSON.stringify({
      partitionKey,
      readings,
      evidenceDecisions,
    });
    const sha256Checksum = createHash("sha256")
      .update(canonicalPayload)
      .digest("hex");
    const hmacSignature = createHmac("sha256", this.archiveSigningSecret)
      .update(`${partitionKey}:${sha256Checksum}`)
      .digest("hex");

    return {
      partitionKey,
      exportedAtMs,
      readings,
      evidenceDecisions,
      sha256Checksum,
      hmacSignature,
    };
  }

  public verifyAndRestoreArchive(bundle: SignedPartitionArchiveBundle): {
    restoredReadings: number;
    restoredDecisions: number;
  } {
    const canonicalPayload = JSON.stringify({
      partitionKey: bundle.partitionKey,
      readings: bundle.readings,
      evidenceDecisions: bundle.evidenceDecisions,
    });
    const computedChecksum = createHash("sha256")
      .update(canonicalPayload)
      .digest("hex");
    if (computedChecksum !== bundle.sha256Checksum) {
      throw new Error("ARCHIVE_CHECKSUM_MISMATCH: Archive payload corrupted");
    }

    const expectedHmac = createHmac("sha256", this.archiveSigningSecret)
      .update(`${bundle.partitionKey}:${bundle.sha256Checksum}`)
      .digest("hex");
    if (expectedHmac !== bundle.hmacSignature) {
      throw new Error("ARCHIVE_SIGNATURE_INVALID: HMAC verification failed");
    }

    for (const r of bundle.readings) {
      this.insertRawReading(r);
    }
    for (const ev of bundle.evidenceDecisions) {
      this.recordEvidenceDecision(ev);
    }

    return {
      restoredReadings: bundle.readings.length,
      restoredDecisions: bundle.evidenceDecisions.length,
    };
  }

  public getRawReading(readingId: string): PartitionedRawReading | null {
    return this.rawReadings.get(readingId) ?? null;
  }

  public getEvidenceDecision(
    decisionId: string
  ): ImmutableEvidenceLedgerRecord | null {
    return this.evidenceLedger.get(decisionId) ?? null;
  }
}
