import { createHash } from "node:crypto";

export type EvidenceRecordStage =
  | "evidence_reading"
  | "consensus_decision"
  | "settlement_outcome";

export interface OracleEvidenceRecord {
  idempotencyKey: string;
  stage: EvidenceRecordStage;
  feedId: string;
  observedAtMs: number;
  payload: Record<string, unknown>;
}

export interface SpooledEnvelope {
  sequenceNumber: number;
  spooledAtMs: number;
  record: OracleEvidenceRecord;
  sha256Checksum: string;
}

export interface SpoolMetricsSnapshot {
  spoolDepth: number;
  oldestEntryAgeMs: number;
  draining: boolean;
  quarantinedTornRecords: number;
  overflowAlarmActive: boolean;
}

const STAGE_ORDER: Record<EvidenceRecordStage, number> = {
  evidence_reading: 1,
  consensus_decision: 2,
  settlement_outcome: 3,
};

export class OracleEvidenceWriteAheadSpool {
  private readonly maxSpoolEntries: number;
  private readonly persistToPostgres: (
    record: OracleEvidenceRecord
  ) => Promise<void>;
  private spoolLines: string[] = [];
  private nextSequence = 1;
  private draining = false;
  private quarantinedTornRecords = 0;
  private overflowAlarmActive = false;

  constructor(options: {
    maxSpoolEntries?: number;
    persistToPostgres: (record: OracleEvidenceRecord) => Promise<void>;
  }) {
    this.maxSpoolEntries = options.maxSpoolEntries ?? 1_000;
    this.persistToPostgres = options.persistToPostgres;
  }

  public static computeRecordChecksum(
    sequenceNumber: number,
    spooledAtMs: number,
    record: OracleEvidenceRecord
  ): string {
    const canonical = JSON.stringify({
      sequenceNumber,
      spooledAtMs,
      idempotencyKey: record.idempotencyKey,
      stage: record.stage,
      feedId: record.feedId,
      observedAtMs: record.observedAtMs,
      payload: record.payload,
    });
    return createHash("sha256").update(canonical).digest("hex");
  }

  public async writeOrSpool(
    record: OracleEvidenceRecord,
    nowMs: number = Date.now()
  ): Promise<{
    destination: "postgres_direct" | "local_wal_spool";
    sequenceNumber?: number;
  }> {
    // Only bypass spool if spool is empty and not currently draining (preserves causal order)
    if (this.spoolLines.length === 0 && !this.draining) {
      try {
        await this.persistToPostgres(record);
        return { destination: "postgres_direct" };
      } catch {
        // Fall through to local write-ahead spool on Postgres outage
      }
    }

    if (this.spoolLines.length >= this.maxSpoolEntries) {
      this.overflowAlarmActive = true;
      throw new Error(
        `SPOOL_OVERFLOW_ALARM: Local write-ahead spool reached capacity (${this.maxSpoolEntries} entries); refusing silent truncation`
      );
    }

    const sequenceNumber = this.nextSequence++;
    const sha256Checksum = OracleEvidenceWriteAheadSpool.computeRecordChecksum(
      sequenceNumber,
      nowMs,
      record
    );
    const envelope: SpooledEnvelope = {
      sequenceNumber,
      spooledAtMs: nowMs,
      record,
      sha256Checksum,
    };

    this.spoolLines.push(JSON.stringify(envelope));
    return { destination: "local_wal_spool", sequenceNumber };
  }

  /**
   * Injects a raw WAL line (useful for crash recovery tests with torn tail records).
   */
  public appendRawWalLineForRecovery(rawLine: string): void {
    this.spoolLines.push(rawLine);
  }

  public async drainSpoolToPostgres(): Promise<{
    replayedCount: number;
    quarantinedCount: number;
    remainingDepth: number;
  }> {
    if (this.draining) {
      return {
        replayedCount: 0,
        quarantinedCount: 0,
        remainingDepth: this.spoolLines.length,
      };
    }

    this.draining = true;
    let replayedCount = 0;
    let newlyQuarantined = 0;

    try {
      const validEnvelopes: SpooledEnvelope[] = [];
      for (const line of this.spoolLines) {
        const parsed = this.verifyAndParseEnvelope(line);
        if (!parsed) {
          this.quarantinedTornRecords += 1;
          newlyQuarantined += 1;
          continue;
        }
        validEnvelopes.push(parsed);
      }

      // Order by causal dependency stage first (evidence_reading -> consensus_decision -> settlement_outcome),
      // then by original observedAtMs, then by WAL sequenceNumber.
      validEnvelopes.sort((a, b) => {
        const stageDiff =
          STAGE_ORDER[a.record.stage] - STAGE_ORDER[b.record.stage];
        if (stageDiff !== 0) return stageDiff;
        if (a.record.observedAtMs !== b.record.observedAtMs) {
          return a.record.observedAtMs - b.record.observedAtMs;
        }
        return a.sequenceNumber - b.sequenceNumber;
      });

      const remaining: SpooledEnvelope[] = [];
      let failed = false;

      for (const env of validEnvelopes) {
        if (failed) {
          remaining.push(env);
          continue;
        }
        try {
          await this.persistToPostgres(env.record);
          replayedCount += 1;
        } catch {
          failed = true;
          remaining.push(env);
        }
      }

      this.spoolLines = remaining.map((env) => JSON.stringify(env));
      if (this.spoolLines.length < this.maxSpoolEntries) {
        this.overflowAlarmActive = false;
      }

      return {
        replayedCount,
        quarantinedCount: newlyQuarantined,
        remainingDepth: this.spoolLines.length,
      };
    } finally {
      this.draining = false;
    }
  }

  public getMetrics(nowMs: number = Date.now()): SpoolMetricsSnapshot {
    let oldestSpooledAt: number | null = null;
    for (const line of this.spoolLines) {
      const env = this.verifyAndParseEnvelope(line);
      if (env) {
        if (oldestSpooledAt === null || env.spooledAtMs < oldestSpooledAt) {
          oldestSpooledAt = env.spooledAtMs;
        }
      }
    }

    return {
      spoolDepth: this.spoolLines.length,
      oldestEntryAgeMs:
        oldestSpooledAt === null ? 0 : Math.max(0, nowMs - oldestSpooledAt),
      draining: this.draining,
      quarantinedTornRecords: this.quarantinedTornRecords,
      overflowAlarmActive: this.overflowAlarmActive,
    };
  }

  private verifyAndParseEnvelope(rawLine: string): SpooledEnvelope | null {
    try {
      const env = JSON.parse(rawLine) as SpooledEnvelope;
      if (
        !env ||
        typeof env.sequenceNumber !== "number" ||
        typeof env.spooledAtMs !== "number" ||
        !env.record ||
        typeof env.sha256Checksum !== "string"
      ) {
        return null;
      }
      const expected = OracleEvidenceWriteAheadSpool.computeRecordChecksum(
        env.sequenceNumber,
        env.spooledAtMs,
        env.record
      );
      if (expected !== env.sha256Checksum) {
        return null;
      }
      return env;
    } catch {
      return null;
    }
  }
}
