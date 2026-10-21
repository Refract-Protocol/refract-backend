import {
  DecisionEvent,
  EvidenceEvent,
  QuorumPolicyEvent,
  ReadingEvent,
  SignatureStatus,
  SourceStatus,
  SourceVersionEvent,
} from "./evidence.types";

/**
 * Pure, version-aware lookups over ledger events.
 *
 * Every function takes a knowledge cutoff `t`: only events *recorded* at or
 * before `t` are considered, and configuration rows only apply once their
 * `effectiveFrom` has passed. The same functions back live decisions and
 * historical reconstruction, so there is one definition of "state at T".
 */

export function knownAt(events: readonly EvidenceEvent[], t: number): EvidenceEvent[] {
  return events.filter((e) => e.recordedAt <= t);
}

export interface SourceState {
  sourceId: string;
  providerId: string;
  feedId: string;
  version: number;
  /** Status after applying warm-up at time t. */
  status: SourceStatus;
  weight: number;
  retentionDays: number;
  credentialRef?: string;
  declaredUpstream?: string;
  effectiveFrom: number;
}

/** Latest effective version of every source on `feedId`, sorted by sourceId. */
export function sourcesAt(events: readonly EvidenceEvent[], feedId: string, t: number): SourceState[] {
  const latest = new Map<string, SourceVersionEvent>();
  for (const e of events) {
    if (e.kind !== "source_version" || e.feedId !== feedId) continue;
    if (e.recordedAt > t || e.effectiveFrom > t) continue;
    const prev = latest.get(e.sourceId);
    if (!prev || e.version > prev.version) latest.set(e.sourceId, e);
  }
  return [...latest.values()]
    .map((v) => ({
      sourceId: v.sourceId,
      providerId: v.providerId,
      feedId: v.feedId,
      version: v.version,
      status: v.status === "active" && v.warmupUntil !== undefined && t < v.warmupUntil ? "warmup" : v.status,
      weight: v.weight,
      retentionDays: v.retentionDays,
      credentialRef: v.credentialRef,
      declaredUpstream: v.declaredUpstream,
      effectiveFrom: v.effectiveFrom,
    }) as SourceState)
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

/** Latest version of a source regardless of feed, as known at t. */
export function sourceVersionAt(
  events: readonly EvidenceEvent[],
  sourceId: string,
  t: number,
): SourceVersionEvent | undefined {
  let found: SourceVersionEvent | undefined;
  for (const e of events) {
    if (e.kind !== "source_version" || e.sourceId !== sourceId) continue;
    if (e.recordedAt > t || e.effectiveFrom > t) continue;
    if (!found || e.version > found.version) found = e;
  }
  return found;
}

/** Highest version number ever recorded for a source (for allocating the next one). */
export function latestSourceVersionNumber(events: readonly EvidenceEvent[], sourceId: string): number {
  let max = 0;
  for (const e of events) {
    if (e.kind === "source_version" && e.sourceId === sourceId) max = Math.max(max, e.version);
  }
  return max;
}

export function policyAt(events: readonly EvidenceEvent[], feedId: string, t: number): QuorumPolicyEvent | null {
  let found: QuorumPolicyEvent | null = null;
  for (const e of events) {
    if (e.kind !== "quorum_policy" || e.feedId !== feedId) continue;
    if (e.recordedAt > t || e.effectiveFrom > t) continue;
    if (!found || e.version > found.version) found = e;
  }
  return found;
}

export function latestPolicyVersionNumber(events: readonly EvidenceEvent[], feedId: string): number {
  let max = 0;
  for (const e of events) {
    if (e.kind === "quorum_policy" && e.feedId === feedId) max = Math.max(max, e.version);
  }
  return max;
}

export interface ReadingState {
  readingId: string;
  feedId: string;
  sourceId: string;
  value: number;
  observedAt: number;
  ledgerSeq?: number;
  payloadHash: string | null;
  /** Signature status after applying any signature_result known at t. */
  signature: SignatureStatus;
  seq: number;
}

/** Readings on `feedId` observed in [from, t], with signature status as known at t. */
export function readingsAt(
  events: readonly EvidenceEvent[],
  feedId: string,
  t: number,
  from = Number.NEGATIVE_INFINITY,
): ReadingState[] {
  const sig = signatureResultsAt(events, t);
  const out: ReadingState[] = [];
  for (const e of events) {
    if (e.kind !== "reading" || e.feedId !== feedId || e.recordedAt > t) continue;
    if (e.observedAt > t || e.observedAt < from) continue;
    out.push(toReadingState(e, sig.get(e.readingId)));
  }
  return out;
}

export function readingById(events: readonly EvidenceEvent[], readingId: string, t: number): ReadingState | undefined {
  const sig = signatureResultsAt(events, t);
  for (const e of events) {
    if (e.kind === "reading" && e.readingId === readingId && e.recordedAt <= t) {
      return toReadingState(e, sig.get(e.readingId));
    }
  }
  return undefined;
}

function toReadingState(e: ReadingEvent, override?: "verified" | "failed"): ReadingState {
  return {
    readingId: e.readingId,
    feedId: e.feedId,
    sourceId: e.sourceId,
    value: e.value,
    observedAt: e.observedAt,
    ledgerSeq: e.ledgerSeq,
    payloadHash: e.payloadHash,
    signature: e.signature === "pending" && override ? override : e.signature,
    seq: e.seq,
  };
}

function signatureResultsAt(events: readonly EvidenceEvent[], t: number): Map<string, "verified" | "failed"> {
  const m = new Map<string, "verified" | "failed">();
  for (const e of events) {
    if (e.kind === "signature_result" && e.recordedAt <= t) m.set(e.readingId, e.result);
  }
  return m;
}

/** Payload hashes whose bodies were stored as of t. */
export function storedPayloadsAt(events: readonly EvidenceEvent[], t: number): Set<string> {
  const s = new Set<string>();
  for (const e of events) {
    if (e.kind === "payload_stored" && e.recordedAt <= t) s.add(e.hash);
  }
  return s;
}

/** Most recent recorded decision for a feed with decision time ≤ t. */
export function decisionInForceAt(events: readonly EvidenceEvent[], feedId: string, t: number): DecisionEvent | null {
  let found: DecisionEvent | null = null;
  for (const e of events) {
    if (e.kind !== "decision" || e.feedId !== feedId || e.recordedAt > t || e.at > t) continue;
    if (!found || e.at > found.at || (e.at === found.at && e.seq > found.seq)) found = e;
  }
  return found;
}

export function decisionById(events: readonly EvidenceEvent[], decisionId: string): DecisionEvent | undefined {
  for (const e of events) {
    if (e.kind === "decision" && e.decisionId === decisionId) return e;
  }
  return undefined;
}
