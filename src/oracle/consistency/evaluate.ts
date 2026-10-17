/**
 * Pure, Deterministic Cross-Feed Economic Consistency Evaluator (Issue #280)
 *
 * Evaluates a candidate primary feed round against point-in-time snapshots of
 * related feeds. Ensures missing or stale paired feeds degrade gracefully to
 * `skipped_missing_pair` / `skipped_stale_pair` and NEVER block round finalization.
 */

import {
  DEFAULT_CROSS_FEED_CONSISTENCY_RULES,
  type CrossFeedConsistencyRule,
  type ConsistencyRuleSeverity,
} from "./rules.ts";

export interface FeedObservationSnapshot {
  feedId: string;
  /** Normalized metric value in basis points (0..10000+) */
  valueBps: number;
  /** Observation timestamp in epoch milliseconds */
  observedAtMs: number;
  /** Optional round identifier for audit logging */
  roundId?: string;
}

export type RuleEvaluationStatus =
  | "not_applicable_below_trigger"
  | "satisfied"
  | "skipped_missing_pair"
  | "skipped_stale_pair"
  | "violated";

export interface RuleEvaluationDetail {
  ruleId: string;
  primaryFeedId: string;
  severity: ConsistencyRuleSeverity;
  status: RuleEvaluationStatus;
  confidencePenaltyBps: number;
  corroboratingChecks: Array<{
    feedId: string;
    present: boolean;
    withinLeadLagWindow: boolean;
    observedValueBps?: number;
    minExpectedValueBps: number;
    timeDeltaMs?: number;
    satisfied: boolean;
  }>;
  message: string;
}

export interface CrossFeedConsistencyReport {
  primaryFeedId: string;
  primaryValueBps: number;
  primaryObservedAtMs: number;
  /** False only when at least one rule with severity === "block" has status === "violated" */
  allowFinalization: boolean;
  /** True when any rule is violated or skipped due to missing/stale paired feed */
  hasWarnings: boolean;
  /** Adjusted confidence score in basis points (clamped to 0..10000) */
  adjustedConfidenceBps: number;
  ruleEvaluations: RuleEvaluationDetail[];
}

/**
 * Evaluates cross-feed consistency for a candidate primary feed observation against
 * a deterministic point-in-time snapshot map of all feeds.
 */
export function evaluateCrossFeedConsistency(
  primaryObservation: FeedObservationSnapshot,
  snapshotByFeedId: Readonly<Record<string, FeedObservationSnapshot | undefined>>,
  rules: readonly CrossFeedConsistencyRule[] = DEFAULT_CROSS_FEED_CONSISTENCY_RULES,
  initialConfidenceBps = 10_000
): CrossFeedConsistencyReport {
  const applicableRules = rules.filter(
    (r) => r.primaryFeedId === primaryObservation.feedId
  );

  let allowFinalization = true;
  let hasWarnings = false;
  let totalPenaltyBps = 0;
  const ruleEvaluations: RuleEvaluationDetail[] = [];

  for (const rule of applicableRules) {
    if (primaryObservation.valueBps < rule.primaryTriggerThresholdBps) {
      ruleEvaluations.push({
        ruleId: rule.ruleId,
        primaryFeedId: rule.primaryFeedId,
        severity: rule.severity,
        status: "not_applicable_below_trigger",
        confidencePenaltyBps: 0,
        corroboratingChecks: [],
        message: `Primary feed ${primaryObservation.feedId} value (${primaryObservation.valueBps} bps) is below trigger threshold (${rule.primaryTriggerThresholdBps} bps).`,
      });
      continue;
    }

    const corroboratingChecks: RuleEvaluationDetail["corroboratingChecks"] = [];
    let anySatisfied = false;
    let freshPresentCount = 0;
    let presentCount = 0;

    for (const cond of rule.corroboratingFeeds) {
      const paired = snapshotByFeedId[cond.feedId];
      if (!paired) {
        corroboratingChecks.push({
          feedId: cond.feedId,
          present: false,
          withinLeadLagWindow: false,
          minExpectedValueBps: cond.minExpectedValueBps,
          satisfied: false,
        });
        continue;
      }

      presentCount += 1;
      const timeDeltaMs = Math.abs(
        primaryObservation.observedAtMs - paired.observedAtMs
      );
      const withinLeadLagWindow = timeDeltaMs <= rule.maxLeadLagWindowMs;
      if (withinLeadLagWindow) {
        freshPresentCount += 1;
      }

      const satisfied =
        withinLeadLagWindow && paired.valueBps >= cond.minExpectedValueBps;
      if (satisfied) {
        anySatisfied = true;
      }

      corroboratingChecks.push({
        feedId: cond.feedId,
        present: true,
        withinLeadLagWindow,
        observedValueBps: paired.valueBps,
        minExpectedValueBps: cond.minExpectedValueBps,
        timeDeltaMs,
        satisfied,
      });
    }

    if (anySatisfied) {
      ruleEvaluations.push({
        ruleId: rule.ruleId,
        primaryFeedId: rule.primaryFeedId,
        severity: rule.severity,
        status: "satisfied",
        confidencePenaltyBps: 0,
        corroboratingChecks,
        message: `Rule ${rule.ruleId} satisfied by corroborating feed within ${rule.maxLeadLagWindowMs}ms window.`,
      });
      continue;
    }

    // Critical requirement (#280): Never block a feed simply because its paired feed is missing or stale.
    if (presentCount === 0) {
      hasWarnings = true;
      ruleEvaluations.push({
        ruleId: rule.ruleId,
        primaryFeedId: rule.primaryFeedId,
        severity: rule.severity,
        status: "skipped_missing_pair",
        confidencePenaltyBps: 0,
        corroboratingChecks,
        message: `Rule ${rule.ruleId} skipped (warning only): corroborating feed(s) missing from snapshot.`,
      });
      continue;
    }

    if (freshPresentCount === 0) {
      hasWarnings = true;
      ruleEvaluations.push({
        ruleId: rule.ruleId,
        primaryFeedId: rule.primaryFeedId,
        severity: rule.severity,
        status: "skipped_stale_pair",
        confidencePenaltyBps: 0,
        corroboratingChecks,
        message: `Rule ${rule.ruleId} skipped (warning only): corroborating feed(s) outside ${rule.maxLeadLagWindowMs}ms lead/lag window.`,
      });
      continue;
    }

    // All fresh present corroborating feeds contradicted the primary spike
    hasWarnings = true;
    totalPenaltyBps += rule.confidencePenaltyBps;
    if (rule.severity === "block") {
      allowFinalization = false;
    }

    ruleEvaluations.push({
      ruleId: rule.ruleId,
      primaryFeedId: rule.primaryFeedId,
      severity: rule.severity,
      status: "violated",
      confidencePenaltyBps: rule.confidencePenaltyBps,
      corroboratingChecks,
      message: `Cross-feed consistency violation (${rule.severity}): ${rule.description}`,
    });
  }

  const adjustedConfidenceBps = Math.max(
    0,
    Math.min(10_000, initialConfidenceBps - totalPenaltyBps)
  );

  return {
    primaryFeedId: primaryObservation.feedId,
    primaryValueBps: primaryObservation.valueBps,
    primaryObservedAtMs: primaryObservation.observedAtMs,
    allowFinalization,
    hasWarnings,
    adjustedConfidenceBps,
    ruleEvaluations,
  };
}
