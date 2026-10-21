import { MetricId } from "../adapters/source-adapter";

/**
 * ok           quorum met, sources agree, evidence recorded; every live source answered
 * degraded     as ok, but at least one registered live source failed, was stale or quarantined
 * insufficient fewer usable sources than the quorum requires (includes no live source at all)
 * conflicted   sources disagree by more than the allowed spread
 * unrecorded   the decision could not be written to the evidence trail
 */
export type ConsensusStatus = "ok" | "degraded" | "insufficient" | "conflicted" | "unrecorded";

export type TriggerDirection = "below" | "above";

export interface DecisionInput {
  sourceId: string;
  value: number;
  observedAt: number;
  evidenceSha256: string;
}

export interface ConsensusDecision {
  /** Stable reference for audit, e.g. "StablecoinDepeg@42" (coverage type @ evidence seq). */
  id: string;
  coverageType: string;
  metric: MetricId | null;
  subject?: string;
  /** Aggregated value, or null when no value could be agreed. */
  value: number | null;
  threshold: number;
  direction: TriggerDirection;
  /** Whether the agreed value is past the threshold. Meaningless unless `actionable`. */
  triggered: boolean;
  /** True only when settlement may act on this decision. */
  actionable: boolean;
  status: ConsensusStatus;
  /** 0–1: source coverage × agreement. */
  confidence: number;
  quorum: { required: number; available: number; met: boolean };
  inputs: DecisionInput[];
  failures: Array<{ sourceId: string; reason: string }>;
  /** Human-readable reasons the decision is not actionable. Empty when actionable. */
  blockers: string[];
  decidedAt: number;
  /** Seq of this decision in the evidence trail, when recorded. */
  evidenceSeq: number | null;
}

/** True when settlement may pay out on this decision. */
export function authorizesPayout(decision: ConsensusDecision): boolean {
  return decision.actionable && decision.triggered && decision.evidenceSeq !== null;
}
