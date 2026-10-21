/**
 * Event shapes for the append-only consensus evidence ledger.
 *
 * Every fact the consensus layer relies on (source configuration, quorum
 * policy, readings, signature results, decisions, claim holds) is written as
 * an immutable event. Current state and historical state are both *derived*
 * from these events, so "what did the system know at T" is answered by
 * replaying events recorded at or before T.
 */

/**
 * Lifecycle of a source. `warmup` sources contribute but are flagged as
 * immature evidence; `quarantined` and `retired` sources are ineligible.
 */
export type SourceStatus = "active" | "warmup" | "quarantined" | "retired";

/** Result of verifying a reading's provider signature. */
export type SignatureStatus = "verified" | "pending" | "failed" | "not_required";

/** Comparison a consensus value is tested against to decide "triggered". */
export interface TriggerRule {
  op: "lt" | "gt";
  threshold: number;
}

interface BaseEvent {
  /** Monotonic position in the ledger, assigned on append. */
  seq: number;
  /** Wall-clock ms when the system learned this fact. */
  recordedAt: number;
}

/** A new version of a source's configuration. Never edited in place. */
export interface SourceVersionEvent extends BaseEvent {
  kind: "source_version";
  sourceId: string;
  providerId: string;
  feedId: string;
  version: number;
  status: SourceStatus;
  weight: number;
  /** ms epoch; while now < warmupUntil the source counts as `warmup`. */
  warmupUntil?: number;
  /** License-permitted retention for raw payload bodies, in days. */
  retentionDays: number;
  /** Opaque reference to the stored credential (never the secret itself). */
  credentialRef?: string;
  /** Free-form provenance declaration, e.g. the upstream the provider claims to use. */
  declaredUpstream?: string;
  effectiveFrom: number;
}

/** A new version of a feed's quorum policy. */
export interface QuorumPolicyEvent extends BaseEvent {
  kind: "quorum_policy";
  feedId: string;
  version: number;
  /** Fewer eligible independent sources than this → no_decision. */
  minSources: number;
  /** Number of sources the policy expects for full-confidence evidence. */
  expectedSources: number;
  /** Minimum summed effective weight of eligible sources. */
  minTotalWeight: number;
  /** Readings older than this relative to decision time are ignored. */
  maxReadingAgeMs: number;
  trigger: TriggerRule;
  effectiveFrom: number;
}

export interface ReadingEvent extends BaseEvent {
  kind: "reading";
  readingId: string;
  feedId: string;
  sourceId: string;
  /** Normalised numeric value (post-canonicalisation). */
  value: number;
  observedAt: number;
  ledgerSeq?: number;
  /** Content hash of the raw payload, or null if capture failed. */
  payloadHash: string | null;
  signature: SignatureStatus;
  /** sha256 of canonical value + coarse time bucket (see fingerprint.ts). */
  fingerprint?: string;
}

/** Late-arriving signature verification for a reading recorded as `pending`. */
export interface SignatureResultEvent extends BaseEvent {
  kind: "signature_result";
  readingId: string;
  result: "verified" | "failed";
}

export interface PayloadStoredEvent extends BaseEvent {
  kind: "payload_stored";
  hash: string;
  sourceId: string;
  sizeBytes: number;
}

export interface ContributingReading {
  readingId: string;
  sourceId: string;
  value: number;
  effectiveWeight: number;
  /** False when this source is a suspected mirror of another contributor. */
  independent?: boolean;
}

export interface DecisionEvent extends BaseEvent {
  kind: "decision";
  decisionId: string;
  feedId: string;
  /** Decision time; equals recordedAt for live decisions. */
  at: number;
  ledgerSeq?: number;
  outcome: "decision" | "no_decision";
  value: number | null;
  triggered: boolean;
  reason: string;
  policyVersion: number | null;
  contributing: ContributingReading[];
}

/** Machine-readable reasons an otherwise-triggering decision is not payable yet. */
export type EvidenceGapType =
  | "missing_raw_payload"
  | "insufficient_sources"
  | "source_in_warmup"
  | "signature_pending";

export interface EvidenceGap {
  type: EvidenceGapType;
  /** Human-readable explanation, safe to show operators. */
  detail: string;
  readingId?: string;
  sourceId?: string;
}

export type HoldEscalationReason =
  | "deadline_exceeded"
  | "verdict_contradicted"
  | "policy_expired_while_held";

export type HoldDisposition = "approve_payout" | "deny" | "extend_hold";

export interface HoldPlacedEvent extends BaseEvent {
  kind: "hold_placed";
  holdId: string;
  policyId: string;
  holder: string;
  feedId: string;
  decisionId: string;
  gaps: EvidenceGap[];
  reason: string;
  deadline: number;
  policyExpiresAt: number;
}

export interface HoldReevaluatedEvent extends BaseEvent {
  kind: "hold_reevaluated";
  holdId: string;
  decisionId: string;
  gaps: EvidenceGap[];
}

export interface HoldReleasedEvent extends BaseEvent {
  kind: "hold_released";
  holdId: string;
  decisionId: string;
  reason: string;
}

export interface HoldEscalatedEvent extends BaseEvent {
  kind: "hold_escalated";
  holdId: string;
  escalation: HoldEscalationReason;
  reason: string;
}

export interface HoldDisposedEvent extends BaseEvent {
  kind: "hold_disposed";
  holdId: string;
  disposition: HoldDisposition;
  actor: string;
  note: string;
  /** For extend_hold: the new deadline. */
  deadline?: number;
}

/** Payout of a released/approved hold was handed to settlement. */
export interface HoldSettledEvent extends BaseEvent {
  kind: "hold_settled";
  holdId: string;
}

/**
 * Persisted finding that two nominally independent sources on one feed are
 * mirroring each other. While active, consensus scales down the lighter
 * source's weight and does not count it as independent corroboration.
 */
export interface IndependencePenaltyEvent extends BaseEvent {
  kind: "independence_penalty";
  penaltyId: string;
  feedId: string;
  sourceA: string;
  sourceB: string;
  factor: number;
  windowStart: number;
  windowEnd: number;
  lagBuckets: number;
  informativeSamples: number;
  matches: number;
  exactMatches: number;
  matchRatio: number;
  evidence: { bucket: number; readingA: string; readingB: string; valueA: number; valueB: number }[];
}

export interface IndependencePenaltyClearedEvent extends BaseEvent {
  kind: "independence_penalty_cleared";
  penaltyId: string;
  feedId: string;
  sourceA: string;
  sourceB: string;
  reason: string;
  matchRatio: number;
  informativeSamples: number;
}

/** Operator-facing audit trail entry. */
export interface AuditEvent extends BaseEvent {
  kind: "audit";
  action: string;
  actor: string;
  reason: string;
  details: Record<string, unknown>;
}

export type EvidenceEvent =
  | SourceVersionEvent
  | QuorumPolicyEvent
  | ReadingEvent
  | SignatureResultEvent
  | PayloadStoredEvent
  | DecisionEvent
  | HoldPlacedEvent
  | HoldReevaluatedEvent
  | HoldReleasedEvent
  | HoldEscalatedEvent
  | HoldDisposedEvent
  | HoldSettledEvent
  | IndependencePenaltyEvent
  | IndependencePenaltyClearedEvent
  | AuditEvent;

/** An event before the ledger assigns `seq` / `recordedAt`. */
export type NewEvidenceEvent = EvidenceEvent extends infer E
  ? E extends EvidenceEvent
    ? Omit<E, "seq" | "recordedAt"> & { recordedAt?: number }
    : never
  : never;
