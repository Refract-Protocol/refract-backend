import { createHash } from "node:crypto";

export type TimestampRejectionReason =
  | "MISSING_OBSERVATION_TIMESTAMP"
  | "DATE_ONLY_TIMESTAMP_REJECTED"
  | "FUTURE_DATED_READING"
  | "STALE_READING"
  | "DUPLICATE_REPLAYED_READING";

export interface IncomingProviderReading {
  sourceId: string;
  feedId: string;
  value: number;
  observedAt?: number | string | null;
  rawPayload: string;
}

export interface ValidatedOracleReading {
  sourceId: string;
  feedId: string;
  value: number;
  observedAtMs: number;
  receivedAtMs: number;
  payloadDigest: string;
  dedupeKey: string;
}

export interface ReadingIngestionResult {
  accepted: boolean;
  rejectionReason: TimestampRejectionReason | null;
  reading: ValidatedOracleReading | null;
}

export interface SourceClockSkewStats {
  sourceId: string;
  sampleCount: number;
  meanOffsetMs: number;
  skewFlagged: boolean;
}

export class ReadingTimestampGuard {
  private readonly maxFutureToleranceMs: number;
  private readonly freshnessWindowMs: number;
  private readonly clockSkewAlertThresholdMs: number;
  private readonly seenDedupeKeys = new Set<string>();
  private readonly offsetsBySource = new Map<string, number[]>();

  constructor(options?: {
    maxFutureToleranceMs?: number;
    freshnessWindowMs?: number;
    clockSkewAlertThresholdMs?: number;
  }) {
    this.maxFutureToleranceMs = options?.maxFutureToleranceMs ?? 5_000;
    this.freshnessWindowMs = options?.freshnessWindowMs ?? 60_000;
    this.clockSkewAlertThresholdMs =
      options?.clockSkewAlertThresholdMs ?? 3_000;
  }

  public validateAndIngest(
    incoming: IncomingProviderReading,
    receivedAtMs: number
  ): ReadingIngestionResult {
    if (
      incoming.observedAt === undefined ||
      incoming.observedAt === null ||
      incoming.observedAt === ""
    ) {
      return {
        accepted: false,
        rejectionReason: "MISSING_OBSERVATION_TIMESTAMP",
        reading: null,
      };
    }

    // Explicitly reject date-only strings (e.g. "2026-10-17") rather than defaulting to midnight/now
    if (
      typeof incoming.observedAt === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(incoming.observedAt.trim())
    ) {
      return {
        accepted: false,
        rejectionReason: "DATE_ONLY_TIMESTAMP_REJECTED",
        reading: null,
      };
    }

    const observedAtMs =
      typeof incoming.observedAt === "number"
        ? incoming.observedAt
        : Date.parse(incoming.observedAt);

    if (!Number.isFinite(observedAtMs) || observedAtMs <= 0) {
      return {
        accepted: false,
        rejectionReason: "MISSING_OBSERVATION_TIMESTAMP",
        reading: null,
      };
    }

    // Check future-dating and freshness window
    const offsetMs = receivedAtMs - observedAtMs;
    if (observedAtMs - receivedAtMs > this.maxFutureToleranceMs) {
      this.recordOffset(incoming.sourceId, offsetMs);
      return {
        accepted: false,
        rejectionReason: "FUTURE_DATED_READING",
        reading: null,
      };
    }

    if (offsetMs > this.freshnessWindowMs) {
      this.recordOffset(incoming.sourceId, offsetMs);
      return {
        accepted: false,
        rejectionReason: "STALE_READING",
        reading: null,
      };
    }

    const payloadDigest = createHash("sha256")
      .update(incoming.rawPayload)
      .digest("hex");
    const dedupeKey = `${incoming.sourceId}:${observedAtMs}:${payloadDigest}`;

    if (this.seenDedupeKeys.has(dedupeKey)) {
      return {
        accepted: false,
        rejectionReason: "DUPLICATE_REPLAYED_READING",
        reading: null,
      };
    }

    this.seenDedupeKeys.add(dedupeKey);
    this.recordOffset(incoming.sourceId, offsetMs);

    return {
      accepted: true,
      rejectionReason: null,
      reading: {
        sourceId: incoming.sourceId,
        feedId: incoming.feedId,
        value: incoming.value,
        observedAtMs,
        receivedAtMs,
        payloadDigest,
        dedupeKey,
      },
    };
  }

  private recordOffset(sourceId: string, offsetMs: number): void {
    const list = this.offsetsBySource.get(sourceId) ?? [];
    list.push(offsetMs);
    this.offsetsBySource.set(sourceId, list);
  }

  public getSourceClockSkewStats(sourceId: string): SourceClockSkewStats {
    const list = this.offsetsBySource.get(sourceId) ?? [];
    if (list.length === 0) {
      return {
        sourceId,
        sampleCount: 0,
        meanOffsetMs: 0,
        skewFlagged: false,
      };
    }
    const sum = list.reduce((acc, v) => acc + v, 0);
    const meanOffsetMs = sum / list.length;
    return {
      sourceId,
      sampleCount: list.length,
      meanOffsetMs,
      skewFlagged: Math.abs(meanOffsetMs) > this.clockSkewAlertThresholdMs,
    };
  }
}
