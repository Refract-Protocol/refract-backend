import { MetricId, SourceObservation } from "../adapters/source-adapter";

export interface SmoothingOptions {
  /** Samples older than this (by observedAt) fall out of the window. */
  windowMs: number;
  /** Distinct samples a source needs in its window before it can count toward quorum. */
  minSamples: number;
  /** Minimum time between the oldest and newest sample, so a burst of refetches is not "history". */
  minSpanMs: number;
  /** Hard cap on samples kept per source. */
  maxSamples: number;
  now?: () => number;
}

interface Sample {
  value: number;
  observedAt: number;
}

export interface SmoothedValue {
  sourceId: string;
  /** Median of the window. Null while the source is still warming up. */
  value: number | null;
  latest: number;
  samples: number;
  spanMs: number;
  ready: boolean;
  /** Why the source is not ready yet, when it isn't. */
  reason?: string;
}

/**
 * Per-source rolling window over time.
 *
 * Cross-source corroboration protects against one wrong source. This
 * protects against one wrong sample from a good source: a transient spike,
 * a stale or partially deployed CDN cache, or a crafted response aimed at
 * nudging a threshold. A source's contribution to consensus is the median
 * of its recent samples, so a single print cannot move it. A sustained move
 * still comes through once it makes up most of the window.
 *
 * Samples are keyed by upstream `observedAt`: a cache serving the same
 * response repeatedly yields one sample, not many, so it cannot fake history.
 */
export class TemporalSmoother {
  private readonly windows = new Map<string, Sample[]>();
  private readonly now: () => number;

  constructor(private readonly options: SmoothingOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Adds an observation to its source's window. Wire this to OracleSourceRegistry.subscribe. */
  ingest(obs: SourceObservation): void {
    const key = keyOf(obs.sourceId, obs.metric, obs.subject);
    const window = this.windows.get(key) ?? [];
    const existing = window.findIndex((s) => s.observedAt === obs.observedAt);
    if (existing >= 0) {
      // Same upstream timestamp: a repeat of a sample we already have.
      // Keep the first value so a conflicting replay cannot overwrite it.
      return;
    }
    window.push({ value: obs.value, observedAt: obs.observedAt });
    window.sort((a, b) => a.observedAt - b.observedAt);
    this.windows.set(key, this.prune(window));
  }

  /** Smoothed value for the source behind `obs`, including `obs` itself. */
  smooth(obs: SourceObservation): SmoothedValue {
    this.ingest(obs);
    const window = this.prune(this.windows.get(keyOf(obs.sourceId, obs.metric, obs.subject)) ?? []);
    const samples = window.length;
    const spanMs = samples ? window[samples - 1].observedAt - window[0].observedAt : 0;
    const base = { sourceId: obs.sourceId, latest: obs.value, samples, spanMs };

    if (samples < this.options.minSamples) {
      return { ...base, value: null, ready: false, reason: `warming up: ${samples}/${this.options.minSamples} samples` };
    }
    if (spanMs < this.options.minSpanMs) {
      return {
        ...base,
        value: null,
        ready: false,
        reason: `warming up: samples span ${Math.round(spanMs / 1000)}s of ${Math.round(this.options.minSpanMs / 1000)}s`,
      };
    }
    return { ...base, value: median(window.map((s) => s.value)), ready: true };
  }

  /** For diagnostics and tests. */
  windowSize(sourceId: string, metric: MetricId, subject?: string): number {
    return this.prune(this.windows.get(keyOf(sourceId, metric, subject)) ?? []).length;
  }

  private prune(window: Sample[]): Sample[] {
    const cutoff = this.now() - this.options.windowMs;
    let start = 0;
    while (start < window.length && window[start].observedAt < cutoff) start++;
    const pruned = window.slice(Math.max(start, window.length - this.options.maxSamples));
    return pruned;
  }
}

function keyOf(sourceId: string, metric: MetricId, subject?: string): string {
  return `${sourceId}|${metric}|${subject ?? ""}`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
