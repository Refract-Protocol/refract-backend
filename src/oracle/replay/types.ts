/** Injectable time source. The pipeline never calls Date.now() directly. */
export interface Clock {
  now(): number;
  /** Real clocks wait; the replay clock advances explicitly. */
  sleep(ms: number): Promise<void>;
}

/** Injectable randomness (jitter, tie-breaks). Returns a float in [0, 1). */
export type Random = () => number;

export type ProviderErrorKind = "timeout" | "http_5xx" | "malformed";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ProviderPayload {
  value: number;
  /** Source-reported observation time, epoch ms. */
  observedAt: number;
}

/** Provider client the pipeline depends on instead of live network calls. */
export interface ProviderClient {
  fetch(source: string): Promise<unknown>;
}

export interface PipelineConfig {
  sources: string[];
  /** Readings older than this (by ingestion clock) are stale. */
  maxAgeMs: number;
  /** Readings observed further in the future than this are clock-skewed. */
  maxFutureSkewMs: number;
  /** Max allowed spread between fresh sources, in basis points of the median. */
  toleranceBps: number;
  /** Minimum fresh, valid sources required to corroborate. */
  minSources: number;
  /** Value at or above which a payout is triggered. */
  triggerThreshold: number;
  /** Retries per source on timeout / 5xx. */
  maxRetries: number;
  retryBaseMs: number;
}

export type SourceStatus =
  | "ok"
  | "timeout"
  | "http_5xx"
  | "malformed"
  | "stale"
  | "future_timestamp"
  | "out_of_order";

export interface SourceOutcome {
  source: string;
  status: SourceStatus;
  value?: number;
  observedAt?: number;
  attempts: number;
}

export type DecisionAction = "pay" | "no_action" | "pause";

export type DecisionReason =
  | "triggered"
  | "below_threshold"
  | "insufficient_sources"
  | "sources_diverged"
  | "all_sources_down";

export interface Decision {
  at: number;
  action: DecisionAction;
  reason: DecisionReason;
  value: number | null;
  sources: SourceOutcome[];
}

// ---- fixtures & scenarios ----

export interface FixtureSample {
  /** Offset from scenario start, ms. Sample is served from this offset on. */
  offsetMs: number;
  value: number;
  /** Offset of the source-reported observation time from scenario start. */
  observedOffsetMs: number;
}

export interface Fixture {
  version: 1;
  feed: string;
  recordedAt: string;
  sources: Record<string, FixtureSample[]>;
  /** sha256 of the canonical JSON of {version, feed, recordedAt, sources}. */
  checksum: string;
}

export type FaultKind =
  | "timeout"
  | "http_5xx"
  | "malformed"
  | "diverge"
  | "all_down"
  | "delay"
  | "clock_skew";

export interface Fault {
  kind: FaultKind;
  /** Omitted for all_down. */
  source?: string;
  fromMs: number;
  toMs: number;
  /**
   * diverge: multiplicative factor on value (e.g. 1.5)
   * delay: ms the observation timestamp lags behind
   * clock_skew: ms added to the observation timestamp (negative = behind)
   */
  param?: number;
}

export interface Scenario {
  name: string;
  description?: string;
  fixture: string;
  seed: number;
  startMs: number;
  config: PipelineConfig;
  faults: Fault[];
  /** Offsets from start at which the pipeline runs. */
  ticks: number[];
  /** Expected action per tick; the runner fails loudly on mismatch. */
  expect?: DecisionAction[];
}
