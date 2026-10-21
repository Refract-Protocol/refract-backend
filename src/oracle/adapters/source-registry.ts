import { Logger } from "@nestjs/common";
import { MAX_FUTURE_SKEW_MS, METRIC_SPECS, roundTo } from "./metric-specs";
import {
  AdapterSchemaError,
  MetricId,
  ObservationRequest,
  OracleSourceAdapter,
  SourceObservation,
} from "./source-adapter";

export type ObservationFailureReason = "quarantined" | "fetch_error" | "invalid" | "stale";
export type ObservationOutcome = "ok" | ObservationFailureReason;

export type ObservationResult =
  | { ok: true; observation: SourceObservation }
  | { ok: false; sourceId: string; metric: MetricId; reason: ObservationFailureReason; detail: string };

/** Hook for metrics/alerting. Implementations must never throw. */
export interface OracleObservabilitySink {
  recordSourceObservation(sourceId: string, metric: MetricId, outcome: ObservationOutcome, durationMs: number): void;
  recordQuarantine?(sourceId: string, metric: MetricId, until: number, reason: string): void;
}

export const ORACLE_OBSERVABILITY_SINK = Symbol("ORACLE_OBSERVABILITY_SINK");

export interface RegistryOptions {
  timeoutMs: number;
  quarantineAfterFailures: number;
  quarantineMs: number;
  now?: () => number;
  sink?: OracleObservabilitySink;
}

interface HealthState {
  consecutiveFailures: number;
  quarantinedUntil: number;
  lastReason?: string;
}

export interface SourceHealth {
  sourceId: string;
  metric: MetricId;
  consecutiveFailures: number;
  quarantinedUntil: number | null;
  lastReason?: string;
}

/**
 * Single ingestion path for every oracle source. Callers ask for a metric;
 * the registry fans out to every adapter that provides it and runs each
 * response through the same pipeline:
 *
 *   quarantine gate → fetch (with timeout) → schema check → canonicalize
 *   (finite, in-bounds, fixed precision) → freshness → evidence attached
 *
 * Failures are returned as typed results, never thrown, so one bad source
 * cannot take down a check. Repeated failures — or a single malformed or
 * out-of-bounds response — quarantine that source for the metric.
 */
export class OracleSourceRegistry {
  private readonly logger = new Logger(OracleSourceRegistry.name);
  private readonly adapters = new Map<string, OracleSourceAdapter>();
  private readonly health = new Map<string, HealthState>();
  private readonly now: () => number;

  constructor(private readonly options: RegistryOptions) {
    this.now = options.now ?? Date.now;
  }

  register(adapter: OracleSourceAdapter): this {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Oracle source "${adapter.id}" is already registered`);
    }
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  list(): OracleSourceAdapter[] {
    return [...this.adapters.values()];
  }

  adaptersFor(metric: MetricId): OracleSourceAdapter[] {
    return this.list().filter((a) => a.metrics.includes(metric));
  }

  /** Observes `metric` from every registered source that provides it, in parallel. */
  async observe(request: ObservationRequest): Promise<ObservationResult[]> {
    const adapters = this.adaptersFor(request.metric);
    return Promise.all(adapters.map((a) => this.observeOne(a, request)));
  }

  healthSnapshot(): SourceHealth[] {
    return [...this.health.entries()].map(([key, state]) => {
      const [sourceId, metric] = key.split("|") as [string, MetricId];
      return {
        sourceId,
        metric,
        consecutiveFailures: state.consecutiveFailures,
        quarantinedUntil: state.quarantinedUntil > this.now() ? state.quarantinedUntil : null,
        lastReason: state.lastReason,
      };
    });
  }

  private async observeOne(adapter: OracleSourceAdapter, request: ObservationRequest): Promise<ObservationResult> {
    const { metric } = request;
    const started = this.now();
    const state = this.stateFor(adapter.id, metric);

    if (state.quarantinedUntil > started) {
      return this.finish(adapter.id, metric, started, {
        ok: false,
        sourceId: adapter.id,
        metric,
        reason: "quarantined",
        detail: `quarantined until ${new Date(state.quarantinedUntil).toISOString()} (${state.lastReason ?? "unknown"})`,
      });
    }

    let raw;
    try {
      raw = await adapter.fetch(request, { timeoutMs: this.options.timeoutMs });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const reason = err instanceof AdapterSchemaError ? "invalid" : "fetch_error";
      return this.fail(adapter.id, metric, started, reason, detail);
    }

    const spec = METRIC_SPECS[metric];
    if (typeof raw.value !== "number" || !Number.isFinite(raw.value)) {
      return this.fail(adapter.id, metric, started, "invalid", `non-finite value ${String(raw.value)}`);
    }
    const value = roundTo(raw.value, spec.decimals);
    if (value < spec.min || value > spec.max) {
      return this.fail(adapter.id, metric, started, "invalid", `value ${value} outside [${spec.min}, ${spec.max}]`);
    }

    const fetchedAt = this.now();
    const hasUpstreamTimestamp = typeof raw.observedAt === "number" && Number.isFinite(raw.observedAt);
    const observedAt = hasUpstreamTimestamp ? (raw.observedAt as number) : fetchedAt;
    if (observedAt > fetchedAt + MAX_FUTURE_SKEW_MS) {
      return this.fail(adapter.id, metric, started, "invalid", `timestamp ${observedAt} is in the future`);
    }
    const ageMs = fetchedAt - observedAt;
    if (ageMs > spec.maxAgeMs) {
      return this.fail(adapter.id, metric, started, "stale", `value is ${Math.round(ageMs / 1000)}s old (max ${spec.maxAgeMs / 1000}s)`);
    }

    state.consecutiveFailures = 0;
    state.quarantinedUntil = 0;
    state.lastReason = undefined;

    return this.finish(adapter.id, metric, started, {
      ok: true,
      observation: {
        sourceId: adapter.id,
        trustTier: adapter.trustTier,
        metric,
        subject: request.subject,
        value,
        observedAt,
        fetchedAt,
        hasUpstreamTimestamp,
        evidence: raw.evidence,
        context: raw.context,
      },
    });
  }

  private fail(
    sourceId: string,
    metric: MetricId,
    started: number,
    reason: Exclude<ObservationFailureReason, "quarantined">,
    detail: string,
  ): ObservationResult {
    const state = this.stateFor(sourceId, metric);
    state.consecutiveFailures++;
    state.lastReason = `${reason}: ${detail}`;
    // A malformed or out-of-bounds response is a trust failure, not an
    // availability blip: quarantine immediately rather than waiting.
    const shouldQuarantine =
      reason === "invalid" || state.consecutiveFailures >= this.options.quarantineAfterFailures;
    if (shouldQuarantine && this.options.quarantineMs > 0) {
      state.quarantinedUntil = this.now() + this.options.quarantineMs;
      this.logger.warn(`Quarantining ${sourceId} for ${metric} until ${new Date(state.quarantinedUntil).toISOString()}: ${state.lastReason}`);
      this.safeSink((s) => s.recordQuarantine?.(sourceId, metric, state.quarantinedUntil, state.lastReason ?? reason));
    } else {
      this.logger.warn(`${sourceId} ${metric} observation failed (${reason}): ${detail}`);
    }
    return this.finish(sourceId, metric, started, { ok: false, sourceId, metric, reason, detail });
  }

  private finish(sourceId: string, metric: MetricId, started: number, result: ObservationResult): ObservationResult {
    const outcome: ObservationOutcome = result.ok ? "ok" : result.reason;
    this.safeSink((s) => s.recordSourceObservation(sourceId, metric, outcome, this.now() - started));
    return result;
  }

  private safeSink(fn: (sink: OracleObservabilitySink) => void): void {
    if (!this.options.sink) return;
    try {
      fn(this.options.sink);
    } catch (err) {
      this.logger.debug(`Observability sink threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private stateFor(sourceId: string, metric: MetricId): HealthState {
    const key = `${sourceId}|${metric}`;
    let state = this.health.get(key);
    if (!state) {
      state = { consecutiveFailures: 0, quarantinedUntil: 0 };
      this.health.set(key, state);
    }
    return state;
  }
}
