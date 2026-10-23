import { createHash } from "crypto";
import { TriggerStabilityConfig, TriggerStabilityEvaluator } from "../trigger/trigger-stability";
import { AdjudicationOutcome, AdjudicationRecord } from "./adjudication";

/**
 * Deterministic re-adjudication of claims decided under an untrusted feed.
 *
 * For every affected record, take the trusted readings in the evidence window
 *   [decidedAt - lookbackMs, min(restoredAt + confirmWindowMs, expiresAt)]
 * and replay them, in (observedAt, value) order, through a fresh
 * TriggerStabilityEvaluator with the policy's coverage-type config, i.e. the
 * same hysteresis/dwell/damping rules a live scan uses. If the trigger is
 * confirmed at any point in the window, the corrected outcome is
 * "triggered"; if it never is, "not_triggered"; with no trusted readings in
 * the window, "insufficient_data".
 *
 * Same inputs give the same run id and the same items in the same order.
 */

export type CorrectedOutcome = "triggered" | "not_triggered" | "insufficient_data";

export type ReevaluationAction =
  /** Held or skipped, but trusted data shows the trigger was met: pay now. */
  | "settle"
  /** Held, and trusted data shows no trigger: release the hold with no payout. */
  | "release"
  /** Settled, but trusted data shows no trigger: flag for manual review (no automatic clawback). */
  | "flag_overpayment"
  /** Trusted data agrees with what was done. */
  | "no_change"
  /** Would settle, but this policy is already paid (earlier in this run or elsewhere). */
  | "superseded"
  /** No trusted readings in the evidence window. */
  | "manual_review";

export interface TrustedReading {
  observedAt: number;
  value: number;
  /** "quorum" for regionally corroborated values, "operator_backfill" for operator-supplied history. */
  provenance: "quorum" | "operator_backfill";
}

export interface ReevaluationItem {
  recordId: string;
  policyId: string;
  holder: string;
  coverageType: number;
  before: AdjudicationOutcome;
  trustStateAtDecision: string;
  after: CorrectedOutcome;
  action: ReevaluationAction;
  changed: boolean;
  /** Signed payout change this item causes (or flags), 1e7 base units. */
  payoutDelta: string;
  evidence: {
    windowStart: number;
    windowEnd: number;
    readingsUsed: number;
    provenance: Array<TrustedReading["provenance"]>;
    decisionReading: number;
    threshold: number;
    triggerConfirmedAt: number | null;
    reason: string;
  };
}

export interface ReevaluationPlanInput {
  feedId: string;
  degradedSince: number;
  restoredAt: number;
  records: readonly AdjudicationRecord[];
  trustedReadings: readonly TrustedReading[];
  triggerConfigFor: (coverageType: number) => TriggerStabilityConfig;
  /** Policies already paid outside this run. */
  alreadyPaidPolicies: ReadonlySet<string>;
  lookbackMs: number;
  confirmWindowMs: number;
}

export interface ReevaluationPlan {
  runId: string;
  feedId: string;
  degradedSince: number;
  restoredAt: number;
  items: ReevaluationItem[];
  summary: Record<ReevaluationAction, number> & { affected: number; changed: number; netPayoutDelta: string };
}

export function planReevaluation(input: ReevaluationPlanInput): ReevaluationPlan {
  const records = [...input.records].sort((a, b) => a.decidedAt - b.decidedAt || a.id.localeCompare(b.id));
  const readings = [...input.trustedReadings]
    .filter((r) => Number.isFinite(r.value) && Number.isFinite(r.observedAt))
    .sort((a, b) => a.observedAt - b.observedAt || a.value - b.value || a.provenance.localeCompare(b.provenance));

  const paid = new Set(input.alreadyPaidPolicies);
  // A settled record in this run means that policy is paid for the rest of it.
  for (const r of records) if (r.outcome === "settled") paid.add(r.policyId);

  const items: ReevaluationItem[] = records.map((rec) => {
    const windowStart = rec.decidedAt - input.lookbackMs;
    const windowEnd = Math.min(input.restoredAt + input.confirmWindowMs, rec.expiresAt);
    const window = readings.filter((r) => r.observedAt >= windowStart && r.observedAt <= windowEnd);

    let after: CorrectedOutcome = "insufficient_data";
    let triggerConfirmedAt: number | null = null;
    let reason = "no trusted readings in evidence window";
    if (window.length > 0) {
      const config = input.triggerConfigFor(rec.coverageType);
      const evaluator = new TriggerStabilityEvaluator(() => config);
      for (const r of window) {
        const d = evaluator.evaluate(rec.id, { value: r.value, threshold: rec.threshold, direction: rec.direction, observedAt: r.observedAt });
        if (d.triggered && triggerConfirmedAt === null) triggerConfirmedAt = d.confirmedAt;
      }
      after = triggerConfirmedAt !== null ? "triggered" : "not_triggered";
      reason =
        triggerConfirmedAt !== null
          ? `trigger confirmed on trusted data at ${new Date(triggerConfirmedAt).toISOString()}`
          : `trigger never confirmed across ${window.length} trusted reading(s)`;
    }

    const { action, payoutDelta } = decideAction(rec, after, paid);
    if (action === "settle") paid.add(rec.policyId);

    return {
      recordId: rec.id,
      policyId: rec.policyId,
      holder: rec.holder,
      coverageType: rec.coverageType,
      before: rec.outcome,
      trustStateAtDecision: rec.trustState,
      after,
      action,
      changed: action !== "no_change",
      payoutDelta,
      evidence: {
        windowStart,
        windowEnd,
        readingsUsed: window.length,
        provenance: [...new Set(window.map((r) => r.provenance))].sort(),
        decisionReading: rec.readingValue,
        threshold: rec.threshold,
        triggerConfirmedAt,
        reason,
      },
    };
  });

  const summary = {
    affected: items.length,
    changed: items.filter((i) => i.changed).length,
    settle: 0,
    release: 0,
    flag_overpayment: 0,
    no_change: 0,
    superseded: 0,
    manual_review: 0,
    netPayoutDelta: items.reduce((sum, i) => sum + BigInt(i.payoutDelta), BigInt(0)).toString(),
  };
  for (const i of items) summary[i.action]++;

  const runId = createHash("sha256")
    .update(
      JSON.stringify({
        feedId: input.feedId,
        degradedSince: input.degradedSince,
        restoredAt: input.restoredAt,
        records: records.map((r) => r.id),
        readings: readings.map((r) => [r.observedAt, r.value, r.provenance]),
      }),
    )
    .digest("hex")
    .slice(0, 24);

  return { runId: `reeval_${runId}`, feedId: input.feedId, degradedSince: input.degradedSince, restoredAt: input.restoredAt, items, summary };
}

function decideAction(
  rec: AdjudicationRecord,
  after: CorrectedOutcome,
  paid: ReadonlySet<string>,
): { action: ReevaluationAction; payoutDelta: string } {
  if (after === "insufficient_data") return { action: "manual_review", payoutDelta: "0" };
  if (rec.outcome === "settled") {
    return after === "triggered" ? { action: "no_change", payoutDelta: "0" } : { action: "flag_overpayment", payoutDelta: (BigInt(0) - BigInt(rec.paid)).toString() };
  }
  if (after === "triggered") {
    return paid.has(rec.policyId) ? { action: "superseded", payoutDelta: "0" } : { action: "settle", payoutDelta: rec.coverageAmount };
  }
  return rec.outcome === "held" ? { action: "release", payoutDelta: "0" } : { action: "no_change", payoutDelta: "0" };
}
