import { Logger, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { OracleReading } from "../oracle-reading";
import {
  EVIDENCE_COVERAGE_TYPES,
  EvidenceEntry,
  EvidenceGap,
  EvidenceNotDurableError,
  EvidenceRecord,
  EvidenceStore,
  SequencedEvidence,
} from "./evidence-record";
import { EvidenceSpool } from "./evidence-spool";

export interface EvidenceBufferOptions {
  batchSize: number;
  /** First retry delay after a failed flush; doubles up to maxBackoffMs. */
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Compact the spool file after this many acked batches during a long drain. */
  compactEveryBatches: number;
  now?: () => number;
  onStatus?: (status: EvidenceBufferStatus) => void;
}

export interface EvidenceBufferStatus {
  /** Records accepted locally but not yet stored in Postgres. */
  pending: number;
  oldestPendingAgeMs: number | null;
  lastSeq: number;
  lastStoredSeq: number;
  storeHealthy: boolean;
  lastStoreError: string | null;
  /** Seqs that could not be made durable and have not yet been recorded as a gap. */
  openGap: { firstSeq: number; lastSeq: number; lostCount: number; since: number; reason: string } | null;
  /** Total seqs lost since process start (each is also recorded as a gap). */
  lostTotal: number;
  /** False while an unrecorded gap exists: the trail is known to be incomplete. */
  complete: boolean;
}

/**
 * Keeps the oracle evidence trail complete and ordered when Postgres is
 * down, without ever blocking oracle polling on the database.
 *
 *   caller ──append()──▶ seq assigned ──▶ local fsync'd spool ──▶ resolves
 *                                              │
 *                          background flusher  ▼  (in seq order, batched,
 *                                          Postgres   exponential backoff)
 *
 * - Readings are never dropped because the DB is unavailable: they wait in
 *   the spool (which survives restarts) and are replayed in order.
 * - Flushing is head-of-line: a batch is stored only after every earlier
 *   seq is stored, so the table is filled in order.
 * - If even the local write fails (disk full, cap hit), the seqs are not
 *   reused. The run of lost seqs is recorded as an explicit gap record as
 *   soon as writes succeed again, and `append` rejects with
 *   EvidenceNotDurableError so callers that need proof (settlement) fail
 *   closed rather than act on evidence nobody can audit.
 */
export class OracleEvidenceBuffer implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OracleEvidenceBuffer.name);
  private readonly now: () => number;
  private pending: EvidenceRecord[] = [];
  private lastSeq = 0;
  private lastStoredSeq = 0;
  private opened = false;
  private flushing: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private failures = 0;
  private batchesSinceCompact = 0;
  private lastStoreError: string | null = null;
  private storeHealthy = true;
  private openGap: EvidenceBufferStatus["openGap"] = null;
  private lostTotal = 0;
  private stopped = false;

  constructor(
    private readonly spool: EvidenceSpool,
    private readonly store: EvidenceStore,
    private readonly options: EvidenceBufferOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  async onModuleInit(): Promise<void> {
    await this.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop(5_000);
  }

  /** Recovers un-flushed records from the spool and starts draining them. */
  async start(): Promise<void> {
    const recovered = await this.spool.open();
    this.pending = recovered.pending;
    this.lastSeq = recovered.highWaterSeq;
    this.lastStoredSeq = this.pending.length ? this.pending[0].seq - 1 : recovered.highWaterSeq;
    this.opened = true;
    if (recovered.discardedLines > 0) {
      this.noteLoss(this.lastSeq + 1, this.lastSeq, recovered.discardedLines, "unreadable spool lines discarded on recovery");
    }
    if (this.pending.length) {
      this.logger.warn(`Recovered ${this.pending.length} un-flushed oracle evidence record(s); replaying to Postgres`);
    }
    this.kick();
  }

  /**
   * Durably accepts evidence. Resolves with the assigned seqs once the
   * records are fsync'd locally — independent of Postgres availability.
   */
  async append(entries: EvidenceEntry[]): Promise<number[]> {
    if (!this.opened) throw new EvidenceNotDurableError("evidence buffer not started");
    if (entries.length === 0) return [];
    for (const entry of entries) {
      // Programming error, not an outage: reject before consuming a seq.
      if (!(entry.coverageType in EVIDENCE_COVERAGE_TYPES)) {
        throw new Error(`Unknown coverageType "${entry.coverageType}" for oracle evidence`);
      }
    }

    const gap = this.openGap ? this.closeGapRecord() : null;
    const records: EvidenceRecord[] = [];
    if (gap) records.push(gap);
    const seqs: number[] = [];
    for (const entry of entries) {
      const seq = ++this.lastSeq;
      seqs.push(seq);
      records.push({ ...entry, seq } as SequencedEvidence);
    }

    try {
      await this.spool.append(records);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // The gap record (if any) did not make it either: keep it open and
      // extend it to cover this batch (the gap record's own seq is lost too).
      if (gap) this.openGap = { firstSeq: gap.firstSeq, lastSeq: gap.seq, lostCount: gap.lostCount + 1, since: gap.openedAt, reason: gap.reason };
      this.noteLoss(seqs[0], seqs[seqs.length - 1], seqs.length, reason);
      throw new EvidenceNotDurableError(reason);
    }

    this.pending.push(...records);
    this.emitStatus();
    this.kick();
    return seqs;
  }

  /**
   * Polling-path helper: records readings and never throws. Loss is
   * surfaced through status() and the gap record instead.
   */
  async recordReadings(readings: OracleReading[]): Promise<void> {
    try {
      await this.append(readings.map(readingToEvidence));
    } catch (err) {
      this.logger.error(`Oracle readings not durably recorded: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  status(): EvidenceBufferStatus {
    const firstPending = this.pending[0];
    return {
      pending: this.pending.length,
      oldestPendingAgeMs: firstPending ? this.now() - firstPending.recordedAt : null,
      lastSeq: this.lastSeq,
      lastStoredSeq: this.lastStoredSeq,
      storeHealthy: this.storeHealthy,
      lastStoreError: this.lastStoreError,
      openGap: this.openGap ? { ...this.openGap } : null,
      lostTotal: this.lostTotal,
      complete: this.openGap === null,
    };
  }

  /** Drains whatever can be stored now. Safe to call concurrently. */
  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.drain().finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  /** Stops retries and makes one last bounded attempt to drain. Pending records stay in the spool. */
  async stop(timeoutMs: number): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    await Promise.race([this.flush(), new Promise((r) => setTimeout(r, timeoutMs).unref?.())]);
    await this.spool.close();
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.slice(0, this.options.batchSize);
      try {
        await this.store.persist(batch);
      } catch (err) {
        this.failures++;
        this.storeHealthy = false;
        this.lastStoreError = err instanceof Error ? err.message : String(err);
        const delay = Math.min(this.options.maxBackoffMs, this.options.baseBackoffMs * 2 ** (this.failures - 1));
        this.logger.warn(
          `Oracle evidence flush failed (${this.pending.length} pending, retry in ${delay}ms): ${this.lastStoreError}`,
        );
        this.emitStatus();
        this.scheduleRetry(delay);
        return;
      }

      const lastSeq = batch[batch.length - 1].seq;
      this.pending.splice(0, batch.length);
      this.lastStoredSeq = lastSeq;
      if (!this.storeHealthy) {
        this.logger.log(`Oracle evidence store recovered after ${this.failures} failed attempt(s)`);
      }
      this.failures = 0;
      this.storeHealthy = true;
      this.lastStoreError = null;
      this.batchesSinceCompact++;
      const compact = this.batchesSinceCompact >= this.options.compactEveryBatches;
      if (compact || this.pending.length === 0) this.batchesSinceCompact = 0;
      try {
        await this.spool.ack(lastSeq, compact || this.pending.length === 0);
      } catch (err) {
        // Records are already in Postgres; a failed ack only means they may
        // be re-inserted (idempotently) after a restart.
        this.logger.warn(`Evidence spool ack failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.emitStatus();
    }
  }

  private kick(): void {
    if (this.stopped || this.retryTimer) return;
    void this.flush();
  }

  private scheduleRetry(delay: number): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, delay);
    this.retryTimer.unref?.();
  }

  private noteLoss(firstSeq: number, lastSeq: number, count: number, reason: string): void {
    this.lostTotal += count;
    if (this.openGap) {
      this.openGap.lastSeq = Math.max(this.openGap.lastSeq, lastSeq);
      this.openGap.lostCount += count;
      this.openGap.reason = reason;
    } else {
      this.openGap = { firstSeq, lastSeq, lostCount: count, since: this.now(), reason };
    }
    this.logger.error(
      `ORACLE EVIDENCE GAP: ${count} record(s) (seq ${firstSeq}-${lastSeq}) could not be made durable: ${reason}`,
    );
    this.emitStatus();
  }

  private closeGapRecord(): EvidenceGap {
    const gap = this.openGap!;
    this.openGap = null;
    const now = this.now();
    return {
      seq: ++this.lastSeq,
      kind: "gap",
      firstSeq: gap.firstSeq,
      lastSeq: gap.lastSeq,
      lostCount: gap.lostCount,
      openedAt: gap.since,
      closedAt: now,
      reason: gap.reason,
      recordedAt: now,
    };
  }

  private emitStatus(): void {
    try {
      this.options.onStatus?.(this.status());
    } catch {
      // Observability must never affect the evidence path.
    }
  }
}

export function readingToEvidence(reading: OracleReading): EvidenceEntry {
  return {
    kind: "reading",
    coverageType: reading.coverageType,
    value: reading.value,
    severity: reading.severity,
    source: reading.degraded ? "degraded" : reading.sources?.[0] ?? "unknown",
    recordedAt: latestObservedAt(reading) ?? Date.now(),
    payload: reading,
  };
}

function latestObservedAt(reading: OracleReading): number | undefined {
  const times = (reading.observations ?? []).map((o) => o.fetchedAt);
  return times.length ? Math.max(...times) : undefined;
}
