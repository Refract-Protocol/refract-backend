import { createHash } from "crypto";
import { performance } from "perf_hooks";
import { OracleReading } from "./oracle-reading";

export type ObservationRejectionReason =
  | "MISSING_OBSERVATION_TIME"
  | "DATE_ONLY_OBSERVATION_TIME"
  | "INVALID_OBSERVATION_TIME"
  | "FUTURE_OBSERVATION_TIME"
  | "STALE_OBSERVATION_TIME";

export type ObservationAdmission =
  | { accepted: true; observedAt: Date }
  | { accepted: false; reason: ObservationRejectionReason; observedAt?: Date };

export interface SourceClockOffset {
  source: string;
  samples: number;
  /** receipt − observation, in ms. Positive: provider clock is behind. Negative: ahead. */
  medianOffsetMs: number;
  skewed: boolean;
}

export interface AdmissionOptions {
  /** How far an observation time may lead receipt time before it is rejected. */
  futureToleranceMs: number;
  /** How old an observation may be at receipt before it is rejected. */
  freshnessWindowMs: number;
  /** |median offset| above which a source is reported as skewed. */
  skewThresholdMs: number;
}

export const DEFAULT_ADMISSION_OPTIONS: AdmissionOptions = {
  futureToleranceMs: 5_000,
  freshnessWindowMs: 30 * 60_000, // matches STALENESS_LIMIT_SECONDS in claim.service.ts
  skewThresholdMs: 10_000,
};

const MAX_OFFSET_SAMPLES = 50;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// Requires an explicit UTC offset so a provider's local time is never silently
// interpreted as the backend's local time.
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

// Wall-clock anchor taken once at boot. performance.now() does not jump when the
// host clock is stepped (NTP correction, VM resume), so receipt times derived
// from it cannot mass-reject readings after a local clock change.
const WALL_CLOCK_ANCHOR_MS = Date.now() - performance.now();

export function monotonicNow(): Date {
  return new Date(WALL_CLOCK_ANCHOR_MS + performance.now());
}

/**
 * Parses an upstream observation time. Date-only strings are rejected explicitly
 * rather than being defaulted to midnight or to receipt time.
 */
export function parseObservedAt(value: unknown): Date | ObservationRejectionReason {
  if (value === undefined || value === null || value === "") return "MISSING_OBSERVATION_TIME";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "INVALID_OBSERVATION_TIME" : value;
  }
  if (typeof value !== "string") return "INVALID_OBSERVATION_TIME";
  if (DATE_ONLY.test(value)) return "DATE_ONLY_OBSERVATION_TIME";
  if (!ISO_WITH_OFFSET.test(value)) return "INVALID_OBSERVATION_TIME";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "INVALID_OBSERVATION_TIME" : parsed;
}

/** SHA-256 over the reading payload. Observation time is excluded: it is part of the dedupe key. */
export function readingDigest(reading: OracleReading): string {
  const canonical = JSON.stringify([
    reading.coverageType,
    reading.value,
    reading.threshold,
    reading.severity,
    reading.message,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Shared ingestion gate: validates observation times against the backend's
 * monotonic receipt clock and tracks per-source clock offset.
 */
export class ReadingAdmissionGate {
  private readonly offsets = new Map<string, number[]>();

  constructor(
    private readonly options: AdmissionOptions = DEFAULT_ADMISSION_OPTIONS,
    private readonly receivedNow: () => Date = monotonicNow
  ) {}

  admit(source: string, observedAt: unknown): ObservationAdmission {
    const parsed = parseObservedAt(observedAt);
    if (typeof parsed === "string") return { accepted: false, reason: parsed };

    const receivedAt = this.receivedNow().getTime();
    this.recordOffset(source, receivedAt - parsed.getTime());

    if (parsed.getTime() - receivedAt > this.options.futureToleranceMs) {
      return { accepted: false, reason: "FUTURE_OBSERVATION_TIME", observedAt: parsed };
    }
    if (receivedAt - parsed.getTime() > this.options.freshnessWindowMs) {
      return { accepted: false, reason: "STALE_OBSERVATION_TIME", observedAt: parsed };
    }
    return { accepted: true, observedAt: parsed };
  }

  clockOffsets(): SourceClockOffset[] {
    return [...this.offsets.entries()].map(([source, samples]) => {
      const medianOffsetMs = median(samples);
      return {
        source,
        samples: samples.length,
        medianOffsetMs,
        skewed: Math.abs(medianOffsetMs) > this.options.skewThresholdMs,
      };
    });
  }

  private recordOffset(source: string, offsetMs: number): void {
    const samples = this.offsets.get(source) ?? [];
    samples.push(offsetMs);
    if (samples.length > MAX_OFFSET_SAMPLES) samples.shift();
    this.offsets.set(source, samples);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
