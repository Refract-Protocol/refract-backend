/**
 * Statistical baselines for oracle sources.
 *
 * A baseline summarises a source's recent history so anomaly checks have a
 * reference point. It uses robust statistics (median and median absolute
 * deviation) next to mean and standard deviation, because historical price
 * series contain the very spikes the anomaly check is meant to catch, and
 * those would inflate a plain standard deviation.
 */

export interface HistoricalSample {
  /** Unix epoch milliseconds. */
  timestamp: number;
  value: number;
}

export interface SourceBaseline {
  sampleCount: number;
  windowStart: number;
  windowEnd: number;
  mean: number;
  stddev: number;
  median: number;
  /** Median absolute deviation, scaled by 1.4826 to be comparable with stddev for normal data. */
  mad: number;
  min: number;
  max: number;
  p05: number;
  p95: number;
}

/** Scales MAD to estimate the standard deviation of normally distributed data. */
const MAD_TO_SIGMA = 1.4826;

/**
 * Drops non-finite values, keeps the last value for duplicate timestamps, and
 * sorts by time. Upstream APIs occasionally return nulls, repeated points, and
 * out-of-order pages.
 */
export function cleanSamples(samples: HistoricalSample[]): HistoricalSample[] {
  const byTimestamp = new Map<number, number>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.timestamp) || !Number.isFinite(sample.value)) continue;
    byTimestamp.set(sample.timestamp, sample.value);
  }
  return [...byTimestamp.entries()]
    .sort(([a], [b]) => a - b)
    .map(([timestamp, value]) => ({ timestamp, value }));
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/** Computes a baseline from cleaned samples. Throws when there are none. */
export function computeBaseline(samples: HistoricalSample[]): SourceBaseline {
  if (samples.length === 0) {
    throw new Error("Cannot compute a baseline from zero samples");
  }

  const values = samples.map((sample) => sample.value);
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.length > 1
      ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
      : 0;
  const median = quantile(sorted, 0.5);
  const deviations = values.map((value) => Math.abs(value - median)).sort((a, b) => a - b);

  return {
    sampleCount: samples.length,
    windowStart: samples[0].timestamp,
    windowEnd: samples[samples.length - 1].timestamp,
    mean,
    stddev: Math.sqrt(variance),
    median,
    mad: quantile(deviations, 0.5) * MAD_TO_SIGMA,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p05: quantile(sorted, 0.05),
    p95: quantile(sorted, 0.95),
  };
}

/**
 * Robust z-score of `value` against the baseline: distance from the median
 * in MAD units. Falls back to stddev when MAD is zero (a flat series such as a
 * pegged stablecoin), and to a relative distance when both are zero.
 */
export function deviationScore(baseline: SourceBaseline, value: number): number {
  const spread = baseline.mad > 0 ? baseline.mad : baseline.stddev;
  if (spread > 0) return Math.abs(value - baseline.median) / spread;
  if (baseline.median === 0) return value === 0 ? 0 : Number.POSITIVE_INFINITY;
  // Flat history: score 1 per 0.1% move so a pegged asset still gets a usable signal.
  return Math.abs(value - baseline.median) / Math.abs(baseline.median) / 0.001;
}

/** Fraction of expected sample slots that are present in the window. */
export function historyCoverage(
  samples: HistoricalSample[],
  lookbackMs: number,
  expectedIntervalMs: number
): number {
  if (expectedIntervalMs <= 0 || lookbackMs <= 0) return 0;
  const expected = Math.max(1, Math.floor(lookbackMs / expectedIntervalMs));
  return Math.min(1, samples.length / expected);
}

/**
 * How often a source agreed with its peers over the bootstrap window.
 *
 * Samples are aligned into `bucketMs` buckets. For every bucket where the
 * source and at least one peer have a value, the source agrees when it is
 * within `toleranceBps` of the bucket consensus. With one peer the consensus
 * is that peer's value. With two or more it is the median of all values
 * including the source's own, so one outlying peer cannot drag the consensus
 * away from an honest majority. Returns `null` when no bucket overlaps, so
 * callers can tell "no evidence" apart from "always disagrees".
 */
export function corroborationRate(
  source: HistoricalSample[],
  peers: HistoricalSample[][],
  bucketMs: number,
  toleranceBps: number
): { rate: number; comparedBuckets: number } | null {
  if (bucketMs <= 0 || peers.length === 0) return null;

  const bucketOf = (timestamp: number): number => Math.floor(timestamp / bucketMs);
  const peerBuckets = new Map<number, number[]>();
  for (const series of peers) {
    // One value per peer per bucket (the latest), so a dense peer does not outvote a sparse one.
    const latest = new Map<number, number>();
    for (const sample of series) latest.set(bucketOf(sample.timestamp), sample.value);
    for (const [bucket, value] of latest) {
      const values = peerBuckets.get(bucket) ?? [];
      values.push(value);
      peerBuckets.set(bucket, values);
    }
  }

  const own = new Map<number, number>();
  for (const sample of source) own.set(bucketOf(sample.timestamp), sample.value);

  let compared = 0;
  let agreed = 0;
  for (const [bucket, value] of own) {
    const peerValues = peerBuckets.get(bucket);
    if (!peerValues || peerValues.length === 0) continue;
    const voters = peerValues.length === 1 ? peerValues : [...peerValues, value];
    const consensus = quantile([...voters].sort((a, b) => a - b), 0.5);
    compared += 1;
    const deviationBps =
      consensus === 0
        ? value === 0
          ? 0
          : Number.POSITIVE_INFINITY
        : (Math.abs(value - consensus) / Math.abs(consensus)) * 10_000;
    if (deviationBps <= toleranceBps) agreed += 1;
  }

  return compared === 0 ? null : { rate: agreed / compared, comparedBuckets: compared };
}

/** Upper bound on a seeded reputation: new sources must earn full trust live. */
export const SEED_REPUTATION_CAP = 0.8;
/** Reputation for a source with no usable evidence either way. */
export const NEUTRAL_REPUTATION = 0.5;

/**
 * Initial reputation from bootstrap evidence. History coverage and peer
 * agreement both raise it. Missing peer evidence counts as neutral, not as
 * disagreement. The result is capped at {@link SEED_REPUTATION_CAP}.
 */
export function seedReputation(coverage: number, corroboration: number | null): number {
  const agreement = corroboration ?? NEUTRAL_REPUTATION;
  const raw = 0.2 + 0.3 * coverage + 0.5 * agreement;
  return Math.round(Math.min(SEED_REPUTATION_CAP, Math.max(0, raw)) * 10_000) / 10_000;
}
