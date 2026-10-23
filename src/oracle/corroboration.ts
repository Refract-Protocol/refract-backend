import {
  COVERAGE_CORROBORATION_DEFAULTS,
  CoverageType,
} from "../common/coverage-catalog";

/**
 * Multi-source corroboration engine (issue #177, threat-model P1).
 *
 * Pure: no IO, no clock reads (the caller passes `now`). The monitor fetches
 * readings and decides what to do with the result; this module only decides
 * whether a set of readings agrees well enough to publish a value.
 */

/** One reading of a metric from one independent upstream source. */
export interface SourceReading {
  /** Stable upstream identifier (e.g. "coingecko"). Repeats count once. */
  sourceId: string;
  value: number;
  /** Epoch milliseconds at which the source observed the value. */
  observedAt: number;
}

export interface CorroborationConfig {
  /** Distinct, fresh, in-tolerance sources required to corroborate. */
  minSources: number;
  /** Max |value - median| / median for a reading to be accepted, in bps. */
  toleranceBps: number;
  /** Readings older than `now - maxReadingAgeMs` are ignored. */
  maxReadingAgeMs: number;
}

export type CorroborationStatus =
  | "corroborated"
  | "insufficient_quorum"
  | "divergent";

export type RejectionReason =
  | "invalid_value"
  | "stale"
  | "conflicting_duplicate"
  | "outlier";

export interface RejectedReading {
  sourceId: string;
  reason: RejectionReason;
}

export interface CorroborationResult {
  status: CorroborationStatus;
  /** Median of the accepted readings; null unless `corroborated`. */
  value: number | null;
  /** Readings that contributed to `value`, for the evidence store. */
  participating: SourceReading[];
  rejected: RejectedReading[];
  /** (max - min) / value of the participating readings, in bps. */
  dispersionBps: number;
}

/**
 * Corroborates readings for one metric. Only a `corroborated` result may be
 * published as payout-triggering; every other status must be recorded and
 * surfaced instead.
 */
export function corroborate(
  readings: readonly SourceReading[],
  config: CorroborationConfig,
  now: number,
): CorroborationResult {
  const rejected: RejectedReading[] = [];
  const bySource = new Map<string, SourceReading>();
  const conflicted = new Set<string>();

  for (const reading of readings) {
    if (!Number.isFinite(reading.value) || reading.value < 0) {
      rejected.push({ sourceId: reading.sourceId, reason: "invalid_value" });
      continue;
    }
    const age = now - reading.observedAt;
    if (age < 0 || age > config.maxReadingAgeMs) {
      rejected.push({ sourceId: reading.sourceId, reason: "stale" });
      continue;
    }
    const existing = bySource.get(reading.sourceId);
    if (existing === undefined) {
      bySource.set(reading.sourceId, reading);
    } else if (existing.value !== reading.value) {
      conflicted.add(reading.sourceId);
    }
  }

  // A source reporting two different values is ambiguous: drop it entirely
  // rather than guessing which one is right.
  for (const sourceId of conflicted) {
    bySource.delete(sourceId);
    rejected.push({ sourceId, reason: "conflicting_duplicate" });
  }

  const fresh = [...bySource.values()];
  if (fresh.length < config.minSources) {
    return emptyResult("insufficient_quorum", rejected);
  }

  // Reject anything outside the band around the provisional median. The
  // final value is recomputed from the survivors, so it always lies inside
  // their range.
  const provisional = median(fresh.map((reading) => reading.value));
  const accepted: SourceReading[] = [];
  for (const reading of fresh) {
    if (deviationBps(reading.value, provisional) <= config.toleranceBps) {
      accepted.push(reading);
    } else {
      rejected.push({ sourceId: reading.sourceId, reason: "outlier" });
    }
  }

  // Split votes (e.g. two clusters with no majority) leave too few survivors.
  if (accepted.length < config.minSources) {
    return emptyResult("divergent", rejected);
  }

  const values = accepted.map((reading) => reading.value);
  const value = median(values);
  return {
    status: "corroborated",
    value,
    participating: accepted,
    rejected,
    dispersionBps: deviationBps(Math.max(...values) - Math.min(...values), value),
  };
}

function emptyResult(
  status: Exclude<CorroborationStatus, "corroborated">,
  rejected: RejectedReading[],
): CorroborationResult {
  return { status, value: null, participating: [], rejected, dispersionBps: 0 };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Relative deviation in bps; the denominator is floored at 1 unit. */
function deviationBps(value: number, reference: number): number {
  return (Math.abs(value - reference) / Math.max(Math.abs(reference), 1)) * 10_000;
}

const CONFIG_BOUNDS = {
  minSources: { min: 2, max: 50 },
  toleranceBps: { min: 1, max: 10_000 },
  maxReadingAgeMs: { min: 1_000, max: 86_400_000 },
} as const;

/**
 * Resolves the corroboration config for a coverage type. Each key falls back
 * to the catalog default when its env var is unset; a set but invalid value
 * throws so a misconfiguration fails at startup instead of silently loosening
 * the quorum rule.
 */
export function corroborationConfigFor(
  coverageType: CoverageType,
  env: NodeJS.ProcessEnv = process.env,
): CorroborationConfig {
  const defaults = COVERAGE_CORROBORATION_DEFAULTS[coverageType];
  const prefix = `ORACLE_CORROBORATION_${coverageType
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()}_`;

  return {
    minSources: readBoundedInt(env, `${prefix}MIN_SOURCES`, defaults.minSources, CONFIG_BOUNDS.minSources),
    toleranceBps: readBoundedInt(env, `${prefix}TOLERANCE_BPS`, defaults.toleranceBps, CONFIG_BOUNDS.toleranceBps),
    maxReadingAgeMs: readBoundedInt(env, `${prefix}MAX_AGE_MS`, defaults.maxReadingAgeMs, CONFIG_BOUNDS.maxReadingAgeMs),
  };
}

function readBoundedInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const raw = env[key];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    throw new Error(`${key} must be an integer between ${bounds.min} and ${bounds.max}`);
  }
  return parsed;
}
