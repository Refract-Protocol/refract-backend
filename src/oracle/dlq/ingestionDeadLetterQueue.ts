export type IngestionFailureClass =
  | "TRANSPORT_TIMEOUT"
  | "HTTP_RATE_LIMITED"
  | "SCHEMA_VALIDATION_ERROR"
  | "PERSISTENCE_ERROR";

export type ReadingIngestionProvenance =
  | "first_pass_live"
  | "dlq_replay"
  | "historical_backfill";

export interface PersistedObservationReading {
  sourceId: string;
  feedId: string;
  observationWindowStartMs: number;
  canonicalValue: number;
  provenance: ReadingIngestionProvenance;
  recordedAtMs: number;
}

export interface DeadLetterIngestionRecord {
  dlqId: string;
  sourceId: string;
  feedId: string;
  observationWindowStartMs: number;
  observationWindowEndMs: number;
  errorClass: IngestionFailureClass;
  errorMessage: string;
  rawPayload: string | null;
  status: "pending" | "replayed";
  createdAtMs: number;
  replayedAtMs: number | null;
}

export class OracleIngestionDeadLetterQueue {
  private readonly maxDlqEntries: number;
  private readonly dlqById = new Map<string, DeadLetterIngestionRecord>();
  private readonly readingsByWindowKey = new Map<
    string,
    PersistedObservationReading
  >();
  private readonly parseRawPayload: (
    rawPayload: string
  ) => number | null;
  private nextId = 1;
  private replayedTotal = 0;
  private failedReplayTotal = 0;

  constructor(options: {
    maxDlqEntries?: number;
    parseRawPayload: (rawPayload: string) => number | null;
  }) {
    this.maxDlqEntries = options.maxDlqEntries ?? 5_000;
    this.parseRawPayload = options.parseRawPayload;
  }

  private getWindowKey(
    sourceId: string,
    feedId: string,
    windowStartMs: number
  ): string {
    return `${sourceId}::${feedId}::${windowStartMs}`;
  }

  public recordLiveReading(params: {
    sourceId: string;
    feedId: string;
    observationWindowStartMs: number;
    canonicalValue: number;
    nowMs?: number;
  }): boolean {
    const key = this.getWindowKey(
      params.sourceId,
      params.feedId,
      params.observationWindowStartMs
    );
    if (this.readingsByWindowKey.has(key)) {
      return false;
    }
    this.readingsByWindowKey.set(key, {
      sourceId: params.sourceId,
      feedId: params.feedId,
      observationWindowStartMs: params.observationWindowStartMs,
      canonicalValue: params.canonicalValue,
      provenance: "first_pass_live",
      recordedAtMs: params.nowMs ?? Date.now(),
    });
    return true;
  }

  public enqueueFailedIngestion(params: {
    sourceId: string;
    feedId: string;
    observationWindowStartMs: number;
    observationWindowEndMs: number;
    errorClass: IngestionFailureClass;
    errorMessage: string;
    rawPayload: string | null;
    nowMs?: number;
  }): DeadLetterIngestionRecord {
    const nowMs = params.nowMs ?? Date.now();
    if (this.dlqById.size >= this.maxDlqEntries) {
      // Evict oldest already-replayed entry first, or oldest entry if full
      const oldestKey = this.dlqById.keys().next().value;
      if (oldestKey) {
        this.dlqById.delete(oldestKey);
      }
    }

    const dlqId = `dlq-${this.nextId++}`;
    const record: DeadLetterIngestionRecord = {
      dlqId,
      sourceId: params.sourceId,
      feedId: params.feedId,
      observationWindowStartMs: params.observationWindowStartMs,
      observationWindowEndMs: params.observationWindowEndMs,
      errorClass: params.errorClass,
      errorMessage: params.errorMessage,
      rawPayload: params.rawPayload,
      status: "pending",
      createdAtMs: nowMs,
      replayedAtMs: null,
    };
    this.dlqById.set(dlqId, record);
    return record;
  }

  public replayDeadLetter(
    dlqId: string,
    nowMs: number = Date.now()
  ): {
    replayed: boolean;
    reason:
      | "REPLAYED_OK"
      | "ALREADY_REPLAYED_IDEMPOTENT"
      | "WINDOW_ALREADY_OCCUPIED"
      | "PAYLOAD_MISSING_OR_INVALID"
      | "NOT_FOUND";
    reading: PersistedObservationReading | null;
  } {
    const entry = this.dlqById.get(dlqId);
    if (!entry) {
      return { replayed: false, reason: "NOT_FOUND", reading: null };
    }

    const windowKey = this.getWindowKey(
      entry.sourceId,
      entry.feedId,
      entry.observationWindowStartMs
    );

    if (entry.status === "replayed") {
      return {
        replayed: true,
        reason: "ALREADY_REPLAYED_IDEMPOTENT",
        reading: this.readingsByWindowKey.get(windowKey) ?? null,
      };
    }

    if (this.readingsByWindowKey.has(windowKey)) {
      return {
        replayed: false,
        reason: "WINDOW_ALREADY_OCCUPIED",
        reading: this.readingsByWindowKey.get(windowKey) ?? null,
      };
    }

    if (!entry.rawPayload) {
      this.failedReplayTotal += 1;
      return {
        replayed: false,
        reason: "PAYLOAD_MISSING_OR_INVALID",
        reading: null,
      };
    }

    const parsedValue = this.parseRawPayload(entry.rawPayload);
    if (parsedValue === null || !Number.isFinite(parsedValue)) {
      this.failedReplayTotal += 1;
      return {
        replayed: false,
        reason: "PAYLOAD_MISSING_OR_INVALID",
        reading: null,
      };
    }

    const reading: PersistedObservationReading = {
      sourceId: entry.sourceId,
      feedId: entry.feedId,
      observationWindowStartMs: entry.observationWindowStartMs,
      canonicalValue: parsedValue,
      provenance: "dlq_replay",
      recordedAtMs: nowMs,
    };

    this.readingsByWindowKey.set(windowKey, reading);
    entry.status = "replayed";
    entry.replayedAtMs = nowMs;
    this.replayedTotal += 1;

    return {
      replayed: true,
      reason: "REPLAYED_OK",
      reading,
    };
  }

  public backfillHistoricalWindow(params: {
    sourceId: string;
    feedId: string;
    historicalPoints: Array<{
      observationWindowStartMs: number;
      rawPayload: string;
    }>;
    nowMs?: number;
  }): {
    insertedCount: number;
    skippedExistingCount: number;
    rejectedInvalidCount: number;
  } {
    const nowMs = params.nowMs ?? Date.now();
    let insertedCount = 0;
    let skippedExistingCount = 0;
    let rejectedInvalidCount = 0;

    for (const pt of params.historicalPoints) {
      const key = this.getWindowKey(
        params.sourceId,
        params.feedId,
        pt.observationWindowStartMs
      );
      if (this.readingsByWindowKey.has(key)) {
        skippedExistingCount += 1;
        continue;
      }

      const val = this.parseRawPayload(pt.rawPayload);
      if (val === null || !Number.isFinite(val)) {
        rejectedInvalidCount += 1;
        continue;
      }

      this.readingsByWindowKey.set(key, {
        sourceId: params.sourceId,
        feedId: params.feedId,
        observationWindowStartMs: pt.observationWindowStartMs,
        canonicalValue: val,
        provenance: "historical_backfill",
        recordedAtMs: nowMs,
      });
      insertedCount += 1;
    }

    return { insertedCount, skippedExistingCount, rejectedInvalidCount };
  }

  public getMetrics(): {
    pendingDlqDepth: number;
    replayedTotal: number;
    failedReplayTotal: number;
  } {
    let pendingDlqDepth = 0;
    for (const entry of this.dlqById.values()) {
      if (entry.status === "pending") pendingDlqDepth += 1;
    }
    return {
      pendingDlqDepth,
      replayedTotal: this.replayedTotal,
      failedReplayTotal: this.failedReplayTotal,
    };
  }
}
