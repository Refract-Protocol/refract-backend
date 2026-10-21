import { createHash } from "node:crypto";

export interface RawWindowReading {
  sourceId: string;
  canonicalWindowTs: number;
  payloadHash: string;
  normalizedValue: number;
  receivedAtMs: number;
}

export type DeduplicationReason =
  | "accepted_first_source_vote"
  | "duplicate_same_source_window"
  | "conflicting_same_source_window";

export interface DeduplicationEvidence {
  sourceId: string;
  canonicalWindowTs: number;
  payloadHash: string;
  reason: DeduplicationReason;
  contributedVote: boolean;
}

export interface DeduplicationResult {
  deduplicatedReadings: RawWindowReading[];
  collapsedDuplicateCount: number;
  conflictingSources: string[];
  evidence: DeduplicationEvidence[];
}

export class SourceReadingDeduplicator {
  static canonicalizeObservationTime(observedAtMs: number, resolutionMs: number): number {
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
      throw new Error("observedAtMs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(resolutionMs) || resolutionMs < 1) {
      throw new Error("resolutionMs must be a positive safe integer");
    }
    return Math.floor(observedAtMs / resolutionMs) * resolutionMs;
  }

  static hashCanonicalPayload(payload: unknown): string {
    return createHash("sha256")
      .update(JSON.stringify(canonicalize(payload)))
      .digest("hex");
  }

  public deduplicateWindowReadings(readings: RawWindowReading[]): DeduplicationResult {
    const bySourceAndWindow = new Map<string, Map<number, RawWindowReading[]>>();
    for (const r of readings) {
      if (!r.sourceId.trim()) throw new Error("sourceId is required");
      if (!Number.isFinite(r.normalizedValue)) {
        throw new Error("normalizedValue must be finite");
      }
      if (!Number.isSafeInteger(r.canonicalWindowTs) || r.canonicalWindowTs < 0) {
        throw new Error("canonicalWindowTs must be a non-negative safe integer");
      }
      if (!/^[a-f0-9]{64}$/i.test(r.payloadHash)) {
        throw new Error("payloadHash must be a SHA-256 hex digest");
      }
      const sourceWindows = bySourceAndWindow.get(r.sourceId) ?? new Map();
      const windowReadings = sourceWindows.get(r.canonicalWindowTs) ?? [];
      windowReadings.push(r);
      sourceWindows.set(r.canonicalWindowTs, windowReadings);
      bySourceAndWindow.set(r.sourceId, sourceWindows);
    }

    const deduplicatedReadings: RawWindowReading[] = [];
    let collapsedDuplicateCount = 0;
    const conflictingSources = new Set<string>();
    const evidence: DeduplicationEvidence[] = [];

    for (const [sourceId, windows] of bySourceAndWindow) {
      for (const [canonicalWindowTs, group] of windows) {
        const sorted = [...group].sort((a, b) => a.receivedAtMs - b.receivedAtMs);
        const primary = sorted[0];
        const hasConflict = sorted.some(
          (reading) =>
            reading.payloadHash !== primary.payloadHash ||
            reading.normalizedValue !== primary.normalizedValue,
        );

        if (hasConflict) {
          conflictingSources.add(sourceId);
          for (const reading of sorted) {
            evidence.push({
              sourceId,
              canonicalWindowTs,
              payloadHash: reading.payloadHash,
              reason: "conflicting_same_source_window",
              contributedVote: false,
            });
          }
          continue;
        }

        deduplicatedReadings.push(primary);
        evidence.push({
          sourceId,
          canonicalWindowTs,
          payloadHash: primary.payloadHash,
          reason: "accepted_first_source_vote",
          contributedVote: true,
        });
        for (const duplicate of sorted.slice(1)) {
          collapsedDuplicateCount++;
          evidence.push({
            sourceId,
            canonicalWindowTs,
            payloadHash: duplicate.payloadHash,
            reason: "duplicate_same_source_window",
            contributedVote: false,
          });
        }
      }
    }

    deduplicatedReadings.sort(
      (a, b) =>
        a.canonicalWindowTs - b.canonicalWindowTs ||
        a.sourceId.localeCompare(b.sourceId),
    );
    evidence.sort(
      (a, b) =>
        a.canonicalWindowTs - b.canonicalWindowTs ||
        a.sourceId.localeCompare(b.sourceId) ||
        a.payloadHash.localeCompare(b.payloadHash) ||
        a.reason.localeCompare(b.reason),
    );

    return {
      deduplicatedReadings,
      collapsedDuplicateCount,
      conflictingSources: Array.from(conflictingSources).sort(),
      evidence,
    };
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Canonical payload numbers must be finite");
  }
  if (typeof value === "bigint" || typeof value === "undefined" || typeof value === "function") {
    throw new Error("Canonical payload contains an unsupported value");
  }
  return value;
}
