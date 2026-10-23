/**
 * Deterministic synthetic workload: M feeds, N sources, K node operators.
 *
 * Every run with the same shape and seed produces the same feeds, source
 * assignments and reading values, so latency and throughput differences
 * between runs reflect code changes rather than input variance.
 */

export interface WorkloadShape {
  sources: number;
  feeds: number;
  operators: number;
  payoutFeedRatio: number;
}

export interface SyntheticSource {
  sourceId: string;
  operatorId: string;
}

export interface SyntheticFeed {
  feedId: string;
  payoutTriggering: boolean;
  basePrice: number;
}

export interface SyntheticReading {
  feedId: string;
  sourceId: string;
  operatorId: string;
  value: number;
  observedAt: number;
}

export interface Workload {
  feeds: SyntheticFeed[];
  sources: SyntheticSource[];
  readingsFor(feed: SyntheticFeed, observedAt: number): SyntheticReading[];
}

/** mulberry32: small, fast, seedable PRNG with a [0, 1) output. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildWorkload(shape: WorkloadShape, seed: number): Workload {
  const rng = mulberry32(seed);

  const sources: SyntheticSource[] = Array.from({ length: shape.sources }, (_, i) => ({
    sourceId: `src-${i}`,
    operatorId: `op-${i % shape.operators}`,
  }));

  const payoutCount = Math.round(shape.feeds * shape.payoutFeedRatio);
  const feeds: SyntheticFeed[] = Array.from({ length: shape.feeds }, (_, i) => ({
    feedId: `feed-${i}`,
    payoutTriggering: i < payoutCount,
    basePrice: 1 + rng() * 1000,
  }));

  const readingsFor = (feed: SyntheticFeed, observedAt: number): SyntheticReading[] =>
    sources.map((source) => ({
      feedId: feed.feedId,
      sourceId: source.sourceId,
      operatorId: source.operatorId,
      // ±0.5% jitter around the feed's base price, drawn from the seeded stream
      value: feed.basePrice * (1 + (rng() - 0.5) * 0.01),
      observedAt,
    }));

  return { feeds, sources, readingsFor };
}
