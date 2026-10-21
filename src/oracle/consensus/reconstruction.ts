import { canonicalJson } from "./canonical";
import { computeConsensus, SourceEligibility } from "./consensus.engine";
import { DecisionEvent, EvidenceEvent, QuorumPolicyEvent } from "./evidence.types";
import { decisionInForceAt, policyAt, readingsAt, sourcesAt } from "./ledger-view";

export interface ReconstructionQuery {
  feedId: string;
  /** ms epoch */
  at?: number;
  /** Stellar ledger sequence */
  ledgerSeq?: number;
}

export interface ReconstructedSource extends SourceEligibility {
  providerId: string;
  effectiveFrom: number;
}

export interface ReconstructedReading {
  readingId: string;
  sourceId: string;
  value: number;
  observedAt: number;
  ledgerSeq: number | null;
  payloadHash: string | null;
  signature: string;
}

type DecisionSummary = Pick<
  DecisionEvent,
  "outcome" | "value" | "triggered" | "reason" | "policyVersion" | "contributing"
>;

export interface ReconstructedState {
  query: { feedId: string; at: string | null; ledgerSeq: number | null };
  /** The instant reconstructed (ms epoch and ISO). */
  resolvedAt: number | null;
  resolvedAtIso: string | null;
  /** Last ledger event visible at T: the exact knowledge cutoff. */
  knowledgeCutoffSeq: number | null;
  quorumPolicy: Omit<QuorumPolicyEvent, "kind" | "seq"> | null;
  sources: ReconstructedSource[];
  /** Readings that contributed to the decision at T. */
  contributingReadings: ReconstructedReading[];
  /** Consensus recomputed from evidence known at T. */
  decision: DecisionSummary;
  /** The decision the system had actually recorded and was acting on at T. */
  recordedDecision: (DecisionSummary & { decisionId: string; at: number; atIso: string }) | null;
  /**
   * `matches_recorded` / `differs_from_recorded` when a decision was recorded
   * at exactly T; `no_decision_recorded_at_t` otherwise.
   */
  consistency: "matches_recorded" | "differs_from_recorded" | "no_decision_recorded_at_t";
}

/**
 * Validates and normalises a query from the API or the CLI (same rules).
 * Exactly one of an ISO-8601 timestamp or a ledger sequence is required.
 */
export function parseReconstructionQuery(feedId: string, raw: { at?: string; ledger?: string }): ReconstructionQuery {
  if (!feedId || !/^[A-Za-z0-9_.:-]{1,80}$/.test(feedId)) throw new Error("invalid feed id");
  const hasAt = raw.at !== undefined && raw.at !== "";
  const hasLedger = raw.ledger !== undefined && raw.ledger !== "";
  if (hasAt === hasLedger) throw new Error("provide exactly one of `at` (ISO-8601 timestamp) or `ledger` (sequence)");
  if (hasAt) {
    const at = raw.at as string;
    const ms = Date.parse(at);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(at) || Number.isNaN(ms)) throw new Error(`\`at\` is not an ISO-8601 timestamp: ${at}`);
    return { feedId, at: ms };
  }
  const ledgerRaw = raw.ledger as string;
  if (!/^\d+$/.test(ledgerRaw)) throw new Error(`\`ledger\` must be a non-negative integer: ${ledgerRaw}`);
  return { feedId, ledgerSeq: Number(ledgerRaw) };
}

/**
 * Reconstructs the consensus state of a feed as it was at a past instant.
 *
 * Pure: depends only on `events` and the query, never on live config,
 * in-memory caches, the payload store or the clock. Only events recorded at
 * or before T are considered, so the answer to "what did the system know
 * and believe at T" stays stable as the ledger grows, and stays stable
 * after raw payload bodies are purged (hashes and values are in the ledger).
 *
 * A ledger query resolves T to the recordedAt of the last event stamped with
 * a ledger sequence ≤ L, and also excludes any event stamped with a later L.
 */
export function reconstructConsensusState(
  events: readonly EvidenceEvent[],
  query: ReconstructionQuery,
): ReconstructedState {
  const queryOut = {
    feedId: query.feedId,
    at: query.at !== undefined ? new Date(query.at).toISOString() : null,
    ledgerSeq: query.ledgerSeq ?? null,
  };

  let t: number | null = query.at ?? null;
  let visible: readonly EvidenceEvent[] = events;
  if (query.ledgerSeq !== undefined) {
    const L = query.ledgerSeq;
    visible = events.filter((e) => !("ledgerSeq" in e) || e.ledgerSeq === undefined || e.ledgerSeq <= L);
    t = null;
    for (const e of visible) {
      if ("ledgerSeq" in e && e.ledgerSeq !== undefined && e.ledgerSeq <= L) t = Math.max(t ?? -Infinity, e.recordedAt);
    }
  }

  if (t === null) {
    return {
      query: queryOut,
      resolvedAt: null,
      resolvedAtIso: null,
      knowledgeCutoffSeq: null,
      quorumPolicy: null,
      sources: [],
      contributingReadings: [],
      decision: noDecision(`no_evidence_at_or_before_ledger_${query.ledgerSeq}`),
      recordedDecision: null,
      consistency: "no_decision_recorded_at_t",
    };
  }

  const T = t;
  const known = visible.filter((e) => e.recordedAt <= T);
  const policy = policyAt(known, query.feedId, T);
  const sourceStates = sourcesAt(known, query.feedId, T);
  const readings = readingsAt(known, query.feedId, T);
  const result = computeConsensus({ feedId: query.feedId, at: T, policy, sources: sourceStates, readings });

  const byId = new Map(sourceStates.map((s) => [s.sourceId, s]));
  const readingById = new Map(readings.map((r) => [r.readingId, r]));
  const decision: DecisionSummary = {
    outcome: result.outcome,
    value: result.value,
    triggered: result.triggered,
    reason: sourceStates.length === 0 && policy ? "no_sources_registered_at_t" : result.reason,
    policyVersion: result.policyVersion,
    contributing: result.contributing,
  };

  const recorded = decisionInForceAt(known, query.feedId, T);
  const recordedSummary = recorded
    ? {
        decisionId: recorded.decisionId,
        at: recorded.at,
        atIso: new Date(recorded.at).toISOString(),
        outcome: recorded.outcome,
        value: recorded.value,
        triggered: recorded.triggered,
        reason: recorded.reason,
        policyVersion: recorded.policyVersion,
        contributing: recorded.contributing,
      }
    : null;

  let consistency: ReconstructedState["consistency"] = "no_decision_recorded_at_t";
  if (recorded && recorded.at === T) {
    // Compare against the engine's own reason, not the friendlier override above.
    const recomputed = summarise({ ...decision, reason: result.reason });
    consistency = recomputed === summarise(recorded) ? "matches_recorded" : "differs_from_recorded";
  }

  return {
    query: queryOut,
    resolvedAt: T,
    resolvedAtIso: new Date(T).toISOString(),
    knowledgeCutoffSeq: known.length ? known[known.length - 1].seq : null,
    quorumPolicy: policy
      ? {
          feedId: policy.feedId,
          version: policy.version,
          minSources: policy.minSources,
          expectedSources: policy.expectedSources,
          minTotalWeight: policy.minTotalWeight,
          maxReadingAgeMs: policy.maxReadingAgeMs,
          trigger: policy.trigger,
          effectiveFrom: policy.effectiveFrom,
          recordedAt: policy.recordedAt,
        }
      : null,
    sources: result.eligibility.map((e) => ({
      ...e,
      providerId: byId.get(e.sourceId)?.providerId ?? "",
      effectiveFrom: byId.get(e.sourceId)?.effectiveFrom ?? 0,
    })),
    contributingReadings: result.contributing.map((c) => {
      const r = readingById.get(c.readingId)!;
      return {
        readingId: r.readingId,
        sourceId: r.sourceId,
        value: r.value,
        observedAt: r.observedAt,
        ledgerSeq: r.ledgerSeq ?? null,
        payloadHash: r.payloadHash,
        signature: r.signature,
      };
    }),
    decision,
    recordedDecision: recordedSummary,
    consistency,
  };
}

function summarise(d: DecisionSummary): string {
  const { outcome, value, triggered, reason, policyVersion, contributing } = d;
  return canonicalJson({ outcome, value, triggered, reason, policyVersion, contributing });
}

function noDecision(reason: string): DecisionSummary {
  return { outcome: "no_decision", value: null, triggered: false, reason, policyVersion: null, contributing: [] };
}

/** Canonical serialisation shared by API and CLI, so output is byte-identical. */
export function serializeReconstruction(state: ReconstructedState): string {
  return `${canonicalJson(state)}\n`;
}
