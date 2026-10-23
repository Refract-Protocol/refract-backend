/**
 * Per-source reliability scoring for oracle feeds.
 *
 * Pure functions only: callers load counters from `oracle_source_health`
 * (see src/db/schema.sql), compute the trailing-window rates, call
 * `nextSourceState`, and persist the result in one batch per polling cycle.
 *
 * Transitions move one step per evaluation:
 *   healthy -> degraded -> quarantined
 * and recover one step at a time, only after `recoverConsecutiveSuccesses`
 * clean polls in a row. A single failed poll can never change state on its
 * own because degradation needs `degradeConsecutiveFailures >= 2`.
 */

export type SourceState = "healthy" | "degraded" | "quarantined";

export type SourceOverrideAction = "force_quarantine" | "force_clear";

export interface SourceHealthCounters {
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  /** Failed polls / total polls over the trailing window, 0..1. */
  errorRate: number;
  /** Readings outside the consensus noise band / total readings over the trailing window, 0..1. */
  divergenceRate: number;
  /** Readings in the trailing window. Rate signals are ignored below `minSamples`. */
  sampleCount: number;
}

export interface SourceHealthThresholds {
  degradeConsecutiveFailures: number;
  quarantineConsecutiveFailures: number;
  degradeErrorRate: number;
  quarantineErrorRate: number;
  degradeDivergenceRate: number;
  quarantineDivergenceRate: number;
  recoverConsecutiveSuccesses: number;
  minSamples: number;
}

/**
 * Rationale:
 * - Consecutive failures: 2 degrades (one timeout is noise), 5 quarantines
 *   (about 1-2 minutes of silence at the default poll interval).
 * - Error and divergence rates: 20% degrades, 50% quarantines. Honest feeds
 *   occasionally miss a poll or land just outside the band; only a source that
 *   is wrong most of the time should be dropped from quorum.
 * - Recovery: 10 clean polls in a row before stepping back up, so a flapping
 *   source cannot oscillate on every good reading.
 * - minSamples: 20. A source with no history is trusted but watched; rate
 *   signals stay silent until the trailing window holds enough readings to mean
 *   something.
 */
export const DEFAULT_SOURCE_HEALTH_THRESHOLDS: SourceHealthThresholds = {
  degradeConsecutiveFailures: 2,
  quarantineConsecutiveFailures: 5,
  degradeErrorRate: 0.2,
  quarantineErrorRate: 0.5,
  degradeDivergenceRate: 0.2,
  quarantineDivergenceRate: 0.5,
  recoverConsecutiveSuccesses: 10,
  minSamples: 20,
};

export interface SourceHealthTransition {
  state: SourceState;
  /**
   * True when automation wanted to quarantine a source that is the only
   * participant for its feed. The source stays degraded (still in quorum) and
   * the caller must log an alert-level message.
   */
  alert: boolean;
}

function classify(
  counters: SourceHealthCounters,
  thresholds: SourceHealthThresholds,
): { bad: boolean; severe: boolean } {
  const rated = counters.sampleCount >= thresholds.minSamples;

  const bad =
    counters.consecutiveFailures >= thresholds.degradeConsecutiveFailures ||
    (rated &&
      (counters.errorRate >= thresholds.degradeErrorRate ||
        counters.divergenceRate >= thresholds.degradeDivergenceRate));

  const severe =
    counters.consecutiveFailures >= thresholds.quarantineConsecutiveFailures ||
    (rated &&
      (counters.errorRate >= thresholds.quarantineErrorRate ||
        counters.divergenceRate >= thresholds.quarantineDivergenceRate));

  return { bad, severe };
}

/**
 * Computes the next state for one source on one feed.
 *
 * `soleParticipant` is true when no other source currently contributes to the
 * feed. Quarantining it would leave the feed with no quorum input, so the
 * source is kept degraded and `alert` is raised instead.
 */
export function nextSourceState(
  current: SourceState,
  counters: SourceHealthCounters,
  thresholds: SourceHealthThresholds = DEFAULT_SOURCE_HEALTH_THRESHOLDS,
  soleParticipant = false,
): SourceHealthTransition {
  const { bad, severe } = classify(counters, thresholds);
  const clean =
    !bad && counters.consecutiveSuccesses >= thresholds.recoverConsecutiveSuccesses;

  switch (current) {
    case "healthy":
      return { state: bad ? "degraded" : "healthy", alert: false };

    case "degraded":
      if (severe) {
        return soleParticipant
          ? { state: "degraded", alert: true }
          : { state: "quarantined", alert: false };
      }
      return { state: clean ? "healthy" : "degraded", alert: false };

    case "quarantined":
      return { state: clean ? "degraded" : "quarantined", alert: false };
  }
}

/** Updates the consecutive counters after one poll. Rate windows are maintained by the caller. */
export function applyPollOutcome(
  counters: SourceHealthCounters,
  succeeded: boolean,
): SourceHealthCounters {
  return {
    ...counters,
    consecutiveFailures: succeeded ? 0 : counters.consecutiveFailures + 1,
    consecutiveSuccesses: succeeded ? counters.consecutiveSuccesses + 1 : 0,
  };
}

/** Relative distance of one reading from the consensus value. */
export function relativeDeviation(value: number, consensus: number): number {
  if (consensus === 0) {
    return value === 0 ? 0 : Number.POSITIVE_INFINITY;
  }
  return Math.abs(value - consensus) / Math.abs(consensus);
}

/**
 * Noise band for a feed: the `percentile` of relative deviations pooled across
 * all sources in the trailing window. Using a percentile instead of a fixed
 * delta lets noisy feeds widen the band on their own. With few sources the
 * band is wide, which errs toward keeping a source in quorum.
 */
export function noiseBand(deviations: number[], percentile = 0.9): number {
  if (deviations.length === 0) {
    return 0;
  }
  const sorted = [...deviations].sort((a, b) => a - b);
  const rank = Math.ceil(percentile * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

/** Fraction of readings whose deviation exceeds the noise band. */
export function outsideBandRate(deviations: number[], band: number): number {
  if (deviations.length === 0) {
    return 0;
  }
  return deviations.filter((deviation) => deviation > band).length / deviations.length;
}
