import {
  Clock,
  Decision,
  PipelineConfig,
  ProviderClient,
  ProviderError,
  ProviderErrorKind,
  ProviderPayload,
  Random,
  SourceOutcome,
} from "./types";

function parsePayload(raw: unknown): ProviderPayload {
  const p = raw as Partial<ProviderPayload> | null;
  if (
    !p ||
    typeof p !== "object" ||
    typeof p.value !== "number" ||
    !Number.isFinite(p.value) ||
    typeof p.observedAt !== "number" ||
    !Number.isFinite(p.observedAt)
  ) {
    throw new ProviderError("malformed", "payload failed validation");
  }
  return { value: p.value, observedAt: p.observedAt };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * ingestion -> freshness -> corroboration -> decision, with clock, provider
 * client and randomness all injected so runs are reproducible.
 */
export class OraclePipeline {
  /** Latest accepted observation time per source, for out-of-order checks. */
  private readonly lastObserved = new Map<string, number>();

  constructor(
    private readonly config: PipelineConfig,
    private readonly client: ProviderClient,
    private readonly clock: Clock,
    private readonly random: Random,
  ) {}

  async evaluate(): Promise<Decision> {
    // Seeded shuffle so call order is reproducible but injectable.
    const order = [...this.config.sources]
      .map((s) => ({ s, k: this.random() }))
      .sort((a, b) => a.k - b.k || a.s.localeCompare(b.s))
      .map((x) => x.s);

    const outcomes: SourceOutcome[] = [];
    for (const source of order) {
      outcomes.push(await this.ingest(source));
    }
    outcomes.sort((a, b) => a.source.localeCompare(b.source));
    return this.decide(outcomes);
  }

  private async ingest(source: string): Promise<SourceOutcome> {
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        const payload = parsePayload(await this.client.fetch(source));
        return this.checkFreshness(source, payload, attempts);
      } catch (err) {
        if (!(err instanceof ProviderError)) {
          throw err;
        }
        const kind: ProviderErrorKind = err.kind;
        // Malformed payloads are not transient; don't retry them.
        if (kind === "malformed" || attempts > this.config.maxRetries) {
          return { source, status: kind, attempts };
        }
        const jitter = Math.floor(this.random() * this.config.retryBaseMs);
        await this.clock.sleep(this.config.retryBaseMs * attempts + jitter);
      }
    }
  }

  private checkFreshness(
    source: string,
    payload: ProviderPayload,
    attempts: number,
  ): SourceOutcome {
    const now = this.clock.now();
    const base = {
      source,
      value: payload.value,
      observedAt: payload.observedAt,
      attempts,
    };
    if (payload.observedAt - now > this.config.maxFutureSkewMs) {
      return { ...base, status: "future_timestamp" };
    }
    const prev = this.lastObserved.get(source);
    if (prev !== undefined && payload.observedAt < prev) {
      return { ...base, status: "out_of_order" };
    }
    if (now - payload.observedAt > this.config.maxAgeMs) {
      return { ...base, status: "stale" };
    }
    this.lastObserved.set(source, payload.observedAt);
    return { ...base, status: "ok" };
  }

  private decide(sources: SourceOutcome[]): Decision {
    const at = this.clock.now();
    const fresh = sources.filter((s) => s.status === "ok");
    const allDown = sources.every(
      (s) =>
        s.status === "timeout" ||
        s.status === "http_5xx" ||
        s.status === "malformed",
    );
    if (allDown) {
      return { at, action: "pause", reason: "all_sources_down", value: null, sources };
    }
    if (fresh.length < this.config.minSources) {
      return { at, action: "pause", reason: "insufficient_sources", value: null, sources };
    }
    const values = fresh.map((s) => s.value as number);
    const mid = median(values);
    const spreadBps =
      mid === 0
        ? Infinity
        : ((Math.max(...values) - Math.min(...values)) / Math.abs(mid)) * 10_000;
    if (spreadBps > this.config.toleranceBps) {
      return { at, action: "pause", reason: "sources_diverged", value: mid, sources };
    }
    if (mid >= this.config.triggerThreshold) {
      return { at, action: "pay", reason: "triggered", value: mid, sources };
    }
    return { at, action: "no_action", reason: "below_threshold", value: mid, sources };
  }
}
