import { ContributingReading, QuorumPolicyEvent, SourceStatus } from "./evidence.types";
import { ReadingState, SourceState } from "./ledger-view";

export type IneligibleReason =
  | "retired"
  | "quarantined"
  | "zero_weight"
  | "no_reading_in_window"
  | "signature_failed";

export interface SourceEligibility {
  sourceId: string;
  version: number;
  status: SourceStatus;
  eligible: boolean;
  reason: IneligibleReason | null;
  /** True for warm-up sources: eligible, but immature evidence. */
  immature: boolean;
  weight: number;
  effectiveWeight: number;
  readingId: string | null;
  /** False when shadowed by a heavier source it is suspected of mirroring. */
  independent: boolean;
  /** The source this one is a suspected mirror of, if penalised. */
  mirrorOf: string | null;
}

/** Active independence penalty between two sources (see fingerprint.ts). */
export interface PairPenalty {
  sourceA: string;
  sourceB: string;
  factor: number;
}

export interface ConsensusInput {
  feedId: string;
  at: number;
  policy: QuorumPolicyEvent | null;
  sources: SourceState[];
  readings: ReadingState[];
  penalties?: PairPenalty[];
}

export interface ConsensusResult {
  feedId: string;
  at: number;
  outcome: "decision" | "no_decision";
  value: number | null;
  triggered: boolean;
  reason: string;
  policyVersion: number | null;
  contributing: ContributingReading[];
  eligibility: SourceEligibility[];
}

/**
 * Pure consensus over one feed at one instant: picks each source's latest
 * reading inside the policy window, filters ineligible sources, checks
 * quorum, and takes the weighted median of the rest.
 *
 * No I/O, no clock, no mutable state. Same input → same output.
 */
export function computeConsensus(input: ConsensusInput): ConsensusResult {
  const { feedId, at, policy } = input;
  const base = { feedId, at, policyVersion: policy?.version ?? null };

  if (!policy) {
    return {
      ...base,
      outcome: "no_decision",
      value: null,
      triggered: false,
      reason: "no_quorum_policy",
      contributing: [],
      eligibility: input.sources.map((s) => ineligible(s, null, "no_reading_in_window")),
    };
  }

  const windowStart = at - policy.maxReadingAgeMs;
  const latestBySource = new Map<string, ReadingState>();
  for (const r of input.readings) {
    if (r.observedAt > at || r.observedAt < windowStart) continue;
    const prev = latestBySource.get(r.sourceId);
    if (!prev || r.observedAt > prev.observedAt || (r.observedAt === prev.observedAt && r.seq > prev.seq)) {
      latestBySource.set(r.sourceId, r);
    }
  }

  const eligibility = [...input.sources]
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
    .map((s): SourceEligibility => {
      const reading = latestBySource.get(s.sourceId) ?? null;
      if (s.status === "retired") return ineligible(s, reading, "retired");
      if (s.status === "quarantined") return ineligible(s, reading, "quarantined");
      if (s.weight <= 0) return ineligible(s, reading, "zero_weight");
      if (!reading) return ineligible(s, null, "no_reading_in_window");
      if (reading.signature === "failed") return ineligible(s, reading, "signature_failed");
      return {
        sourceId: s.sourceId,
        version: s.version,
        status: s.status,
        eligible: true,
        reason: null,
        immature: s.status === "warmup",
        weight: s.weight,
        effectiveWeight: s.weight,
        readingId: reading.readingId,
        independent: true,
        mirrorOf: null,
      };
    });

  applyPenalties(eligibility, input.penalties ?? []);

  const eligible = eligibility.filter((e) => e.eligible);
  const independentCount = eligible.filter((e) => e.independent).length;
  const contributing: ContributingReading[] = eligible.map((e) => ({
    readingId: e.readingId as string,
    sourceId: e.sourceId,
    value: (latestBySource.get(e.sourceId) as ReadingState).value,
    effectiveWeight: e.effectiveWeight,
    independent: e.independent,
  }));
  const totalWeight = contributing.reduce((sum, c) => sum + c.effectiveWeight, 0);

  if (independentCount < policy.minSources) {
    const mirrored = eligible.length - independentCount;
    return {
      ...base,
      outcome: "no_decision",
      value: null,
      triggered: false,
      reason:
        `quorum_not_met: ${independentCount} independent eligible source(s)` +
        `${mirrored ? ` (+${mirrored} suspected mirror)` : ""}, policy requires ${policy.minSources}`,
      contributing,
      eligibility,
    };
  }
  if (totalWeight < policy.minTotalWeight) {
    return {
      ...base,
      outcome: "no_decision",
      value: null,
      triggered: false,
      reason: `weight_not_met: eligible weight ${round(totalWeight)}, policy requires ${policy.minTotalWeight}`,
      contributing,
      eligibility,
    };
  }

  const value = weightedMedian(contributing);
  const triggered = policy.trigger.op === "lt" ? value < policy.trigger.threshold : value > policy.trigger.threshold;
  return {
    ...base,
    outcome: "decision",
    value,
    triggered,
    reason: `${triggered ? "triggered" : "not_triggered"}: ${value} ${policy.trigger.op} ${policy.trigger.threshold}`,
    contributing,
    eligibility,
  };
}

function ineligible(s: SourceState, reading: ReadingState | null, reason: IneligibleReason): SourceEligibility {
  return {
    sourceId: s.sourceId,
    version: s.version,
    status: s.status,
    eligible: false,
    reason,
    immature: s.status === "warmup",
    weight: s.weight,
    effectiveWeight: 0,
    readingId: reading?.readingId ?? null,
    independent: true,
    mirrorOf: null,
  };
}

/**
 * For each penalised pair where both sources are eligible, the lighter one
 * (ties: the later sourceId) is shadowed. Its weight is scaled by the
 * penalty factor and it no longer counts toward the independent-source
 * quorum. The two together therefore weigh less than two independent sources.
 */
function applyPenalties(eligibility: SourceEligibility[], penalties: PairPenalty[]): void {
  const byId = new Map(eligibility.map((e) => [e.sourceId, e]));
  const ordered = [...penalties].sort(
    (x, y) => x.sourceA.localeCompare(y.sourceA) || x.sourceB.localeCompare(y.sourceB),
  );
  for (const p of ordered) {
    const a = byId.get(p.sourceA);
    const b = byId.get(p.sourceB);
    if (!a?.eligible || !b?.eligible) continue;
    const [keep, shadow] =
      a.weight > b.weight || (a.weight === b.weight && a.sourceId < b.sourceId) ? [a, b] : [b, a];
    if (!shadow.independent) continue;
    shadow.independent = false;
    shadow.mirrorOf = keep.mirrorOf ?? keep.sourceId;
    shadow.effectiveWeight = round(shadow.weight * p.factor);
  }
}

/** Lower weighted median; ties ordered by value then sourceId for determinism. */
export function weightedMedian(items: ContributingReading[]): number {
  const sorted = [...items].sort((a, b) => a.value - b.value || a.sourceId.localeCompare(b.sourceId));
  const total = sorted.reduce((s, i) => s + i.effectiveWeight, 0);
  let acc = 0;
  for (const item of sorted) {
    acc += item.effectiveWeight;
    if (acc >= total / 2) return item.value;
  }
  return sorted[sorted.length - 1].value;
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
