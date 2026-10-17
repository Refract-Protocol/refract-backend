export type WindowAggregationStrategy =
  | "rolling_median"
  | "time_weighted_median"
  | "last_value_outlier_rejected";

export type WindowAggregateStatus =
  | "ready"
  | "spike_suppressed"
  | "stale_insufficient_samples";

export interface RawTimestampedSample {
  sourceId: string;
  feedId: string;
  value: number;
  observedAtMs: number;
}

export interface WindowAggregationConfig {
  windowDurationMs: number;
  minSamplesInWindow: number;
  maxSamplesPerRingBuffer?: number;
  maxOutlierDeviationRatio: number;
  strategy: WindowAggregationStrategy;
}

export interface WindowedAggregateSnapshot {
  sourceId: string;
  feedId: string;
  status: WindowAggregateStatus;
  aggregatedValue: number | null;
  suppressedOutlierSamples: RawTimestampedSample[];
  retainedRawSamples: RawTimestampedSample[];
  windowStartMs: number;
  windowEndMs: number;
}

export class TimeWindowedSpikeSuppressingAggregator {
  private readonly buffers = new Map<string, RawTimestampedSample[]>();

  private getKey(sourceId: string, feedId: string): string {
    return `${sourceId}::${feedId}`;
  }

  public recordSample(
    sample: RawTimestampedSample,
    maxRingCapacity: number = 256
  ): void {
    if (!Number.isFinite(sample.value) || !Number.isFinite(sample.observedAtMs)) {
      return;
    }
    const key = this.getKey(sample.sourceId, sample.feedId);
    const buf = this.buffers.get(key) ?? [];
    buf.push(sample);
    buf.sort((a, b) => a.observedAtMs - b.observedAtMs);
    if (buf.length > maxRingCapacity) {
      buf.splice(0, buf.length - maxRingCapacity);
    }
    this.buffers.set(key, buf);
  }

  public evaluateWindow(
    sourceId: string,
    feedId: string,
    config: WindowAggregationConfig,
    nowMs: number = Date.now()
  ): WindowedAggregateSnapshot {
    const windowStartMs = nowMs - config.windowDurationMs;
    const key = this.getKey(sourceId, feedId);
    const allSamples = this.buffers.get(key) ?? [];

    // Strictly enforce rolling window without silently widening across gaps
    const inWindow = allSamples.filter(
      (s) => s.observedAtMs >= windowStartMs && s.observedAtMs <= nowMs
    );

    if (inWindow.length < config.minSamplesInWindow) {
      return {
        sourceId,
        feedId,
        status: "stale_insufficient_samples",
        aggregatedValue: null,
        suppressedOutlierSamples: [],
        retainedRawSamples: inWindow,
        windowStartMs,
        windowEndMs: nowMs,
      };
    }

    const baselineMedian = this.computeSimpleMedian(
      inWindow.map((s) => s.value)
    );
    const denom = Math.max(Math.abs(baselineMedian), 1e-9);

    const cleanSamples: RawTimestampedSample[] = [];
    const suppressedOutlierSamples: RawTimestampedSample[] = [];

    for (const sample of inWindow) {
      const relDev = Math.abs(sample.value - baselineMedian) / denom;
      if (relDev > config.maxOutlierDeviationRatio) {
        suppressedOutlierSamples.push(sample);
      } else {
        cleanSamples.push(sample);
      }
    }

    if (cleanSamples.length === 0) {
      return {
        sourceId,
        feedId,
        status: "stale_insufficient_samples",
        aggregatedValue: null,
        suppressedOutlierSamples,
        retainedRawSamples: inWindow,
        windowStartMs,
        windowEndMs: nowMs,
      };
    }

    let aggregatedValue: number;
    if (config.strategy === "rolling_median") {
      aggregatedValue = this.computeSimpleMedian(
        cleanSamples.map((s) => s.value)
      );
    } else if (config.strategy === "time_weighted_median") {
      aggregatedValue = this.computeTimeWeightedMedian(
        cleanSamples,
        windowStartMs,
        nowMs
      );
    } else {
      // last_value_outlier_rejected: latest non-outlier sample in the window
      aggregatedValue = cleanSamples[cleanSamples.length - 1]!.value;
    }

    return {
      sourceId,
      feedId,
      status:
        suppressedOutlierSamples.length > 0 ? "spike_suppressed" : "ready",
      aggregatedValue: Number(aggregatedValue.toFixed(8)),
      suppressedOutlierSamples,
      retainedRawSamples: inWindow,
      windowStartMs,
      windowEndMs: nowMs,
    };
  }

  private computeSimpleMedian(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1]! + sorted[mid]!) / 2
      : sorted[mid]!;
  }

  private computeTimeWeightedMedian(
    samples: RawTimestampedSample[],
    windowStartMs: number,
    windowEndMs: number
  ): number {
    const span = Math.max(1, windowEndMs - windowStartMs);
    const weighted = samples
      .map((s) => ({
        value: s.value,
        // More recent readings in the window receive linearly higher weight [1.0 .. 2.0]
        weight: 1 + Math.max(0, s.observedAtMs - windowStartMs) / span,
      }))
      .sort((a, b) => a.value - b.value);

    const totalWeight = weighted.reduce((acc, w) => acc + w.weight, 0);
    let cumulative = 0;
    for (const item of weighted) {
      cumulative += item.weight;
      if (cumulative >= totalWeight / 2) {
        return item.value;
      }
    }
    return weighted[weighted.length - 1]!.value;
  }
}
