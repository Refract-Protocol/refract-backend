export type ReadingProvenance = "live_polled" | "bootstrap_seeded";

export type BootstrapReadinessState = "warm_seeded" | "cold_start";

export interface RawHistoricalPoint {
  sourceId: string;
  observedAtMs: number;
  value: number;
}

export interface StoredHistoricalReading extends RawHistoricalPoint {
  feedId: string;
  provenance: ReadingProvenance;
  eligibleForPayoutTrigger: boolean;
  eligibleForOnChainPublish: boolean;
  seededAtMs: number;
}

export interface FeedStatisticalBaseline {
  feedId: string;
  state: BootstrapReadinessState;
  sampleCount: number;
  medianValue: number;
  madDispersion: number;
  medianInterReadingIntervalMs: number;
  perSourceDeviationRatio: Record<string, number>;
  outlierRejectionMultiplier: number;
  computedAtMs: number;
}

export interface HistoricalBootstrapOptions {
  feedId: string;
  windowStartMs: number;
  windowEndMs: number;
  maxWindowDurationMs?: number;
  maxPagesToFetch?: number;
  minSamplesForWarmState?: number;
  nowMs?: number;
}

export type HistoricalPageFetcher = (params: {
  feedId: string;
  windowStartMs: number;
  windowEndMs: number;
  pageIndex: number;
}) => Promise<{
  points: RawHistoricalPoint[];
  nextPageAvailable: boolean;
  supportsHistoricalBackfill?: boolean;
}>;

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

export class HistoricalBootstrapSeeder {
  private readonly readingsByKey = new Map<string, StoredHistoricalReading>();
  private readonly baselinesByFeed = new Map<string, FeedStatisticalBaseline>();

  public async seedHistoricalWindow(
    options: HistoricalBootstrapOptions,
    fetchPage: HistoricalPageFetcher
  ): Promise<FeedStatisticalBaseline> {
    const nowMs = options.nowMs ?? Date.now();
    const maxWindowDurationMs =
      options.maxWindowDurationMs ?? 7 * 24 * 60 * 60 * 1_000;
    const maxPagesToFetch = options.maxPagesToFetch ?? 25;
    const minSamplesForWarmState = options.minSamplesForWarmState ?? 5;

    if (options.windowEndMs <= options.windowStartMs) {
      throw new Error("Invalid bootstrap window: windowEndMs must be > windowStartMs");
    }

    const durationMs = options.windowEndMs - options.windowStartMs;
    if (durationMs > maxWindowDurationMs) {
      throw new Error(
        `Bootstrap window duration (${durationMs}ms) exceeds maxWindowDurationMs (${maxWindowDurationMs}ms)`
      );
    }

    const stagedPoints: RawHistoricalPoint[] = [];
    let pageIndex = 0;
    let supportsHistory = true;

    while (pageIndex < maxPagesToFetch) {
      const page = await fetchPage({
        feedId: options.feedId,
        windowStartMs: options.windowStartMs,
        windowEndMs: options.windowEndMs,
        pageIndex,
      });

      if (page.supportsHistoricalBackfill === false) {
        supportsHistory = false;
        break;
      }

      for (const pt of page.points) {
        if (
          Number.isFinite(pt.value) &&
          pt.observedAtMs >= options.windowStartMs &&
          pt.observedAtMs <= options.windowEndMs
        ) {
          stagedPoints.push(pt);
        }
      }

      pageIndex += 1;
      if (!page.nextPageAvailable) {
        break;
      }
      if (pageIndex >= maxPagesToFetch && page.nextPageAvailable) {
        throw new Error(
          `Bootstrap aborted for feed ${options.feedId}: exceeded maxPagesToFetch (${maxPagesToFetch})`
        );
      }
    }

    if (!supportsHistory || stagedPoints.length < minSamplesForWarmState) {
      const coldBaseline: FeedStatisticalBaseline = {
        feedId: options.feedId,
        state: "cold_start",
        sampleCount: stagedPoints.length,
        medianValue: stagedPoints.length > 0
          ? computeMedian(stagedPoints.map((p) => p.value))
          : 0,
        madDispersion: 0,
        medianInterReadingIntervalMs: 0,
        perSourceDeviationRatio: {},
        outlierRejectionMultiplier: 5.0, // Conservative cold-start multiplier
        computedAtMs: nowMs,
      };
      this.baselinesByFeed.set(options.feedId, coldBaseline);
      return coldBaseline;
    }

    // Atomically commit deduplicated seeded readings
    for (const pt of stagedPoints) {
      const dedupKey = `${options.feedId}:${pt.sourceId}:${pt.observedAtMs}`;
      if (!this.readingsByKey.has(dedupKey)) {
        this.readingsByKey.set(dedupKey, {
          feedId: options.feedId,
          sourceId: pt.sourceId,
          observedAtMs: pt.observedAtMs,
          value: pt.value,
          provenance: "bootstrap_seeded",
          eligibleForPayoutTrigger: false,
          eligibleForOnChainPublish: false,
          seededAtMs: nowMs,
        });
      }
    }

    const feedReadings = this.getFeedReadings(options.feedId);
    const values = feedReadings.map((r) => r.value);
    const medianValue = computeMedian(values);
    const absDeviations = values.map((v) => Math.abs(v - medianValue));
    const madDispersion = computeMedian(absDeviations);

    const sortedTimestamps = feedReadings
      .map((r) => r.observedAtMs)
      .sort((a, b) => a - b);
    const intervals: number[] = [];
    for (let i = 1; i < sortedTimestamps.length; i++) {
      const delta = sortedTimestamps[i]! - sortedTimestamps[i - 1]!;
      if (delta > 0) {
        intervals.push(delta);
      }
    }
    const medianInterReadingIntervalMs = computeMedian(intervals);

    const bySource = new Map<string, number[]>();
    for (const r of feedReadings) {
      const list = bySource.get(r.sourceId) ?? [];
      list.push(r.value);
      bySource.set(r.sourceId, list);
    }

    const perSourceDeviationRatio: Record<string, number> = {};
    const denom = Math.max(Math.abs(medianValue), 1e-9);
    for (const [sourceId, srcValues] of bySource.entries()) {
      const srcMedian = computeMedian(srcValues);
      perSourceDeviationRatio[sourceId] =
        Math.abs(srcMedian - medianValue) / denom;
    }

    const baseline: FeedStatisticalBaseline = {
      feedId: options.feedId,
      state: "warm_seeded",
      sampleCount: feedReadings.length,
      medianValue,
      madDispersion,
      medianInterReadingIntervalMs,
      perSourceDeviationRatio,
      outlierRejectionMultiplier: 3.0,
      computedAtMs: nowMs,
    };

    this.baselinesByFeed.set(options.feedId, baseline);
    return baseline;
  }

  public getFeedReadings(feedId: string): StoredHistoricalReading[] {
    const results: StoredHistoricalReading[] = [];
    for (const reading of this.readingsByKey.values()) {
      if (reading.feedId === feedId) {
        results.push(reading);
      }
    }
    return results.sort((a, b) => a.observedAtMs - b.observedAtMs);
  }

  public getPayoutEligibleReadings(feedId: string): StoredHistoricalReading[] {
    return this.getFeedReadings(feedId).filter(
      (r) =>
        r.provenance === "live_polled" &&
        r.eligibleForPayoutTrigger &&
        r.eligibleForOnChainPublish
    );
  }

  public getBaseline(feedId: string): FeedStatisticalBaseline | undefined {
    return this.baselinesByFeed.get(feedId);
  }
}
