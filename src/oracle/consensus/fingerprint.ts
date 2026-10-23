import { canonicalJson, sha256Hex } from "./canonical";
import { positiveFloat, positiveInt } from "./consensus.config";
import { ReadingState } from "./ledger-view";

/**
 * Mirror detection settings. All thresholds are documented in
 * docs/runbooks/oracle-consensus.md and can be overridden by environment.
 */
export interface MirrorDetectionConfig {
  /** Sliding window of readings compared per scan. */
  windowMs: number;
  /** Coarse timestamp bucket; each source contributes its last value per bucket. */
  bucketMs: number;
  /** Two values "match" when |a - b| ≤ relativeTolerance × max(|a|, |b|). */
  relativeTolerance: number;
  /** A mirror delayed by up to this many buckets is still aligned. */
  maxLagBuckets: number;
  /** Minimum buckets in which the series actually moved before judging a pair. */
  minInformativeSamples: number;
  /** Fraction of informative buckets that must match to flag a pair. */
  minMatchRatio: number;
  /** Matched values must span at least this many distinct levels (guards categorical feeds). */
  minDistinctValues: number;
  /** Weight multiplier applied to the lighter source of a flagged pair. */
  penaltyFactor: number;
  /** How often the batch scan runs. */
  scanIntervalMs: number;
}

export function loadMirrorDetectionConfig(env: NodeJS.ProcessEnv = process.env): MirrorDetectionConfig {
  return {
    windowMs: positiveInt(env.MIRROR_WINDOW_MS, 6 * 60 * 60 * 1000),
    bucketMs: positiveInt(env.MIRROR_BUCKET_MS, 60_000),
    relativeTolerance: positiveFloat(env.MIRROR_RELATIVE_TOLERANCE, 0.00005),
    maxLagBuckets: Math.floor(positiveFloat(env.MIRROR_MAX_LAG_BUCKETS, 2)),
    minInformativeSamples: positiveInt(env.MIRROR_MIN_INFORMATIVE_SAMPLES, 8),
    minMatchRatio: positiveFloat(env.MIRROR_MIN_MATCH_RATIO, 0.9),
    minDistinctValues: positiveInt(env.MIRROR_MIN_DISTINCT_VALUES, 3),
    penaltyFactor: positiveFloat(env.MIRROR_PENALTY_FACTOR, 0.25),
    scanIntervalMs: positiveInt(env.MIRROR_SCAN_INTERVAL_MS, 5 * 60_000),
  };
}

/**
 * Canonical value: rounded to 12 significant digits so float noise and
 * cosmetic formatting ("0.9100" vs 0.91) do not change the fingerprint.
 */
export function canonicalValue(value: number): number {
  return Number(value.toPrecision(12));
}

/** Fingerprint of a normalised reading: canonical value + coarse time bucket. */
export function fingerprintReading(feedId: string, value: number, observedAt: number, bucketMs: number): string {
  return sha256Hex(canonicalJson({ feedId, value: canonicalValue(value), bucket: Math.floor(observedAt / bucketMs) }));
}

export interface MatchedSample {
  bucket: number;
  readingA: string;
  readingB: string;
  valueA: number;
  valueB: number;
}

export interface PairAnalysis {
  feedId: string;
  sourceA: string;
  sourceB: string;
  /** Lag (in buckets) of B behind A that best aligns the series. */
  lagBuckets: number;
  informativeSamples: number;
  matches: number;
  /** Lag-0 buckets whose fingerprints are byte-identical. */
  exactMatches: number;
  matchRatio: number;
  distinctMatchedValues: number;
  mirrored: boolean;
  evidence: MatchedSample[];
}

interface BucketPoint {
  bucket: number;
  value: number;
  readingId: string;
  fingerprint: string;
}

function series(feedId: string, readings: ReadingState[], bucketMs: number): Map<number, BucketPoint> {
  const byBucket = new Map<number, BucketPoint & { observedAt: number; seq: number }>();
  for (const r of readings) {
    const bucket = Math.floor(r.observedAt / bucketMs);
    const prev = byBucket.get(bucket);
    if (!prev || r.observedAt > prev.observedAt || (r.observedAt === prev.observedAt && r.seq > prev.seq)) {
      byBucket.set(bucket, {
        bucket,
        value: canonicalValue(r.value),
        readingId: r.readingId,
        fingerprint: fingerprintReading(feedId, r.value, r.observedAt, bucketMs),
        observedAt: r.observedAt,
        seq: r.seq,
      });
    }
  }
  return byBucket;
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b));

/**
 * Compares two sources on the same feed. A bucket is *informative* when
 * either source's value moved since its previous bucket. Agreement on a flat
 * series proves nothing, so only movement counts. The pair is flagged when,
 * at the best lag, nearly every informative bucket matches within tolerance,
 * over enough samples and enough distinct levels.
 */
export function analysePair(
  feedId: string,
  sourceA: string,
  readingsA: ReadingState[],
  sourceB: string,
  readingsB: ReadingState[],
  cfg: MirrorDetectionConfig,
): PairAnalysis {
  const a = series(feedId, readingsA, cfg.bucketMs);
  const b = series(feedId, readingsB, cfg.bucketMs);
  const bucketsA = [...a.keys()].sort((x, y) => x - y);
  const exactMatches = bucketsA.filter((k) => b.get(k)?.fingerprint === a.get(k)!.fingerprint).length;

  let best: PairAnalysis | null = null;
  for (let lag = -cfg.maxLagBuckets; lag <= cfg.maxLagBuckets; lag++) {
    let informative = 0;
    let matches = 0;
    const distinct = new Set<number>();
    const evidence: MatchedSample[] = [];
    let prevA: number | undefined;
    let prevB: number | undefined;
    for (const bucket of bucketsA) {
      const pa = a.get(bucket)!;
      const pb = b.get(bucket + lag);
      if (!pb) continue;
      const moved =
        prevA !== undefined &&
        prevB !== undefined &&
        (!near(pa.value, prevA, cfg.relativeTolerance) || !near(pb.value, prevB, cfg.relativeTolerance));
      if (moved) {
        informative++;
        if (near(pa.value, pb.value, cfg.relativeTolerance)) {
          matches++;
          distinct.add(pa.value);
          if (evidence.length < 10) {
            evidence.push({ bucket, readingA: pa.readingId, readingB: pb.readingId, valueA: pa.value, valueB: pb.value });
          }
        }
      }
      prevA = pa.value;
      prevB = pb.value;
    }
    const matchRatio = informative ? matches / informative : 0;
    const candidate: PairAnalysis = {
      feedId,
      sourceA,
      sourceB,
      lagBuckets: lag,
      informativeSamples: informative,
      matches,
      exactMatches,
      matchRatio: Math.round(matchRatio * 1e4) / 1e4,
      distinctMatchedValues: distinct.size,
      mirrored:
        informative >= cfg.minInformativeSamples &&
        matchRatio >= cfg.minMatchRatio &&
        distinct.size >= cfg.minDistinctValues,
      evidence,
    };
    if (
      !best ||
      candidate.matchRatio > best.matchRatio ||
      (candidate.matchRatio === best.matchRatio && Math.abs(lag) < Math.abs(best.lagBuckets))
    ) {
      best = candidate;
    }
  }
  return best as PairAnalysis;
}

/** Analyses every source pair on one feed. Pairs are ordered sourceA < sourceB. */
export function analyseFeed(feedId: string, readings: ReadingState[], cfg: MirrorDetectionConfig): PairAnalysis[] {
  const bySource = new Map<string, ReadingState[]>();
  for (const r of readings) {
    if (r.feedId !== feedId) continue;
    bySource.set(r.sourceId, [...(bySource.get(r.sourceId) ?? []), r]);
  }
  const ids = [...bySource.keys()].sort();
  const out: PairAnalysis[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      out.push(analysePair(feedId, ids[i], bySource.get(ids[i])!, ids[j], bySource.get(ids[j])!, cfg));
    }
  }
  return out;
}
