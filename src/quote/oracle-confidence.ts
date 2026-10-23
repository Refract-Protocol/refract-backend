/**
 * Oracle confidence → quote availability and premium multiplier.
 *
 * Pure functions only: callers gather the signals (source count, independence
 * clusters, freshness, divergence, quarantine, pause) and pass them in. No I/O
 * happens here so the mapping is table-testable and cheap on the quote path.
 */

export type OracleAvailabilityVerdict = "available" | "degraded" | "unavailable";

/** Point-in-time trust signals for one coverage type's trigger data. */
export interface OracleConfidenceSignals {
  /** Number of distinct live data sources feeding the trigger. */
  sourceCount: number;
  /** Number of independence clusters (e.g. distinct operators/providers) among them. */
  independentClusters: number;
  /** Age in seconds of the newest accepted reading. */
  freshnessSeconds: number;
  /** True when sources disagreed beyond tolerance within the recent window. */
  recentlyDiverged: boolean;
  /** True when the feed is quarantined by operators. */
  quarantined: boolean;
  /** True when the coverage type's oracle is paused. */
  paused: boolean;
}

/** Thresholds and bounds. Sourced from env via oracleConfidenceConfigFromEnv(). */
export interface OracleConfidenceConfig {
  minSources: number;
  minIndependentClusters: number;
  maxFreshnessSeconds: number;
  /** Factor applied to the score when sources recently diverged (0-1). */
  divergencePenalty: number;
  /** Score below this is `degraded` (0-1). */
  degradedBelow: number;
  /** Score below this is `unavailable` (0-1). */
  unavailableBelow: number;
  /** Upper bound on the premium multiplier (regulatory cap); lower bound is 1. */
  maxPremiumMultiplier: number;
}

export interface OracleConfidenceAssessment {
  verdict: OracleAvailabilityVerdict;
  /** Machine-readable reason; null when the verdict is `available`. */
  reason: OracleConfidenceReason | null;
  /** Confidence score in [0, 1]. */
  score: number;
  /** Premium multiplier in [1, maxPremiumMultiplier]. */
  multiplier: number;
}

export type OracleConfidenceReason =
  | "quarantined"
  | "paused"
  | "no_sources"
  | "insufficient_sources"
  | "insufficient_independence"
  | "stale_feed"
  | "recent_divergence";

export const DEFAULT_ORACLE_CONFIDENCE_CONFIG: OracleConfidenceConfig = {
  minSources: 2,
  minIndependentClusters: 2,
  maxFreshnessSeconds: 300,
  divergencePenalty: 0.5,
  degradedBelow: 0.8,
  unavailableBelow: 0.5,
  maxPremiumMultiplier: 1.5,
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Reads thresholds from env (ORACLE_CONFIDENCE_*). Missing or invalid values
 * fall back to the defaults so a bad env never silently opens up pricing.
 */
export function oracleConfidenceConfigFromEnv(env: NodeJS.ProcessEnv): OracleConfidenceConfig {
  const num = (key: string, fallback: number): number => {
    const raw = env[key];
    const parsed = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const d = DEFAULT_ORACLE_CONFIDENCE_CONFIG;
  return {
    minSources: num("ORACLE_CONFIDENCE_MIN_SOURCES", d.minSources),
    minIndependentClusters: num("ORACLE_CONFIDENCE_MIN_INDEPENDENT_CLUSTERS", d.minIndependentClusters),
    maxFreshnessSeconds: num("ORACLE_CONFIDENCE_MAX_FRESHNESS_SECONDS", d.maxFreshnessSeconds),
    divergencePenalty: clamp(num("ORACLE_CONFIDENCE_DIVERGENCE_PENALTY", d.divergencePenalty), 0, 1),
    degradedBelow: clamp(num("ORACLE_CONFIDENCE_DEGRADED_BELOW", d.degradedBelow), 0, 1),
    unavailableBelow: clamp(num("ORACLE_CONFIDENCE_UNAVAILABLE_BELOW", d.unavailableBelow), 0, 1),
    maxPremiumMultiplier: Math.max(1, num("ORACLE_CONFIDENCE_MAX_PREMIUM_MULTIPLIER", d.maxPremiumMultiplier)),
  };
}

/**
 * Maps trust signals to a verdict, a reason, and a bounded premium multiplier.
 *
 * Score is the product of per-factor scores, each in [0, 1]:
 * - source count vs. minSources
 * - independence clusters vs. minIndependentClusters
 * - freshness: 1 within maxFreshnessSeconds, decaying linearly to 0 at 2x
 * - divergence: multiplied by divergencePenalty when recently diverged
 *
 * Quarantine, pause, and zero sources force `unavailable` regardless of score.
 */
export function assessOracleConfidence(
  signals: OracleConfidenceSignals,
  config: OracleConfidenceConfig = DEFAULT_ORACLE_CONFIDENCE_CONFIG,
): OracleConfidenceAssessment {
  const unavailable = (reason: OracleConfidenceReason): OracleConfidenceAssessment => ({
    verdict: "unavailable",
    reason,
    score: 0,
    multiplier: config.maxPremiumMultiplier,
  });

  if (signals.quarantined) return unavailable("quarantined");
  if (signals.paused) return unavailable("paused");
  if (signals.sourceCount <= 0) return unavailable("no_sources");

  const factors: Array<{ reason: OracleConfidenceReason; value: number }> = [
    { reason: "insufficient_sources", value: clamp(signals.sourceCount / config.minSources, 0, 1) },
    {
      reason: "insufficient_independence",
      value: clamp(signals.independentClusters / config.minIndependentClusters, 0, 1),
    },
    {
      reason: "stale_feed",
      value: clamp(1 - (signals.freshnessSeconds - config.maxFreshnessSeconds) / config.maxFreshnessSeconds, 0, 1),
    },
    { reason: "recent_divergence", value: signals.recentlyDiverged ? config.divergencePenalty : 1 },
  ];

  const score = factors.reduce((product, factor) => product * factor.value, 1);
  // Reason names the weakest factor so operators see what to fix first.
  const weakest = factors.reduce((min, factor) => (factor.value < min.value ? factor : min));

  const multiplier = Number(
    clamp(1 + (1 - score) * (config.maxPremiumMultiplier - 1), 1, config.maxPremiumMultiplier).toFixed(4),
  );

  if (score < config.unavailableBelow) {
    return { verdict: "unavailable", reason: weakest.reason, score, multiplier: config.maxPremiumMultiplier };
  }
  if (score < config.degradedBelow) {
    return { verdict: "degraded", reason: weakest.reason, score, multiplier };
  }
  return { verdict: "available", reason: null, score, multiplier };
}
