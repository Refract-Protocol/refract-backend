import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { createHash } from "node:crypto";
import { AlertingService } from "../alerting/alerting.service";
import { MetricsService } from "../metrics/metrics.service";

export type FieldType = "string" | "number" | "boolean";

export interface ProviderSchema {
  required: Record<string, FieldType>;
  optional?: Record<string, FieldType>;
}

/**
 * Canary-side view of a data provider. `fetchRaw` and `parse` are the same
 * production fetch/parse path so validation stays in one place. `parse` must
 * throw on input it cannot decode.
 */
export interface ProviderAdapter {
  readonly name: string;
  readonly schema: ProviderSchema;
  /** Plausible range for the decoded value; outside it signals unit/scale drift. */
  readonly expectedRange: { min: number; max: number };
  fetchRaw(signal: AbortSignal): Promise<string>;
  parse(body: Record<string, unknown>): number;
}

export type ProbeFailureKind =
  | "liveness"
  | "egress"
  | "non_json"
  | "schema_missing"
  | "schema_type"
  | "schema_unknown"
  | "decode"
  | "scale_drift"
  | "frozen";

export interface ProbeFailure {
  kind: ProbeFailureKind;
  detail: string;
}

/** Canary result. `probe: true` marks it as ineligible for publishing or quorum. */
export interface ProbeResult {
  probe: true;
  source: string;
  ok: boolean;
  latencyMs: number;
  failures: ProbeFailure[];
  at: string;
}

export interface ProviderProbeOptions {
  intervalMs: number;
  jitterMs: number;
  timeoutMs: number;
  /** Consecutive byte-identical payloads that count as a frozen feed. */
  frozenWindow: number;
  /** Consecutive provider failures before the source is quarantined. */
  quarantineAfter: number;
  /** Resolves false when our own egress is broken; such failures are not charged to the provider. */
  egressCheck?: () => Promise<boolean>;
}

/** Pure schema check: reports missing, mistyped, and unexpected fields. */
export function validateSchema(body: unknown, schema: ProviderSchema): ProbeFailure[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return [{ kind: "schema_type", detail: "top-level body is not an object" }];
  }

  const record = body as Record<string, unknown>;
  const known: Record<string, FieldType> = { ...schema.optional, ...schema.required };
  const failures: ProbeFailure[] = [];

  for (const field of Object.keys(schema.required)) {
    if (!(field in record)) {
      failures.push({ kind: "schema_missing", detail: `missing required field ${field}` });
    }
  }

  for (const [field, value] of Object.entries(record)) {
    const type = known[field];
    if (type === undefined) {
      failures.push({ kind: "schema_unknown", detail: `unexpected field ${field}` });
    } else if (typeof value !== type) {
      failures.push({ kind: "schema_type", detail: `${field} expected ${type}, got ${typeof value}` });
    }
  }

  return failures;
}

/**
 * Reads PROVIDER_PROBE_* settings (see .env.example). Egress checks are
 * supplied by the caller, not read from the environment.
 */
export function providerProbeOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderProbeOptions {
  const int = (key: string, fallback: number, min: number): number => {
    const raw = env[key];
    if (raw === undefined || raw === "") return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < min) {
      throw new Error(`${key} must be an integer >= ${min}`);
    }
    return parsed;
  };

  return {
    intervalMs: int("PROVIDER_PROBE_INTERVAL_SECONDS", 300, 10) * 1000,
    jitterMs: int("PROVIDER_PROBE_JITTER_SECONDS", 30, 0) * 1000,
    timeoutMs: int("PROVIDER_PROBE_TIMEOUT_MS", 5000, 100),
    frozenWindow: int("PROVIDER_PROBE_FROZEN_WINDOW", 3, 2),
    quarantineAfter: int("PROVIDER_PROBE_QUARANTINE_AFTER", 3, 1),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Out-of-band canary probes for each data provider. Results feed metrics and
 * the per-source quarantine state. They are never published on-chain or
 * counted toward corroboration.
 */
@Injectable()
export class ProviderProbeService implements OnModuleDestroy {
  private readonly logger = new Logger(ProviderProbeService.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly streaks = new Map<string, number>();
  private readonly recentHashes = new Map<string, string[]>();
  private readonly quarantined = new Set<string>();

  constructor(
    private readonly metrics: MetricsService,
    private readonly alerting: AlertingService,
  ) {}

  start(adapters: ProviderAdapter[], options: ProviderProbeOptions): void {
    for (const adapter of adapters) {
      this.scheduleNext(adapter, options);
    }
  }

  onModuleDestroy(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  isQuarantined(source: string): boolean {
    return this.quarantined.has(source);
  }

  async probe(adapter: ProviderAdapter, options: ProviderProbeOptions): Promise<ProbeResult> {
    const startedAt = process.hrtime.bigint();
    const failures = await this.runChecks(adapter, options);
    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    const result: ProbeResult = {
      probe: true,
      source: adapter.name,
      ok: failures.length === 0,
      latencyMs,
      failures,
      at: new Date().toISOString(),
    };
    this.record(result, options);
    return result;
  }

  private scheduleNext(adapter: ProviderAdapter, options: ProviderProbeOptions): void {
    const jitter = (Math.random() * 2 - 1) * options.jitterMs;
    const delay = Math.max(1000, options.intervalMs + jitter);
    const timer = setTimeout(() => {
      void this.probeAndReschedule(adapter, options);
    }, delay);
    this.timers.set(adapter.name, timer);
  }

  private async probeAndReschedule(adapter: ProviderAdapter, options: ProviderProbeOptions): Promise<void> {
    try {
      await this.probe(adapter, options);
    } catch (error) {
      this.logger.error(`Provider probe for ${adapter.name} crashed`, error as Error);
    } finally {
      // Skip rescheduling if onModuleDestroy ran while the probe was in flight.
      if (this.timers.has(adapter.name)) this.scheduleNext(adapter, options);
    }
  }

  private async runChecks(adapter: ProviderAdapter, options: ProviderProbeOptions): Promise<ProbeFailure[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);

    let raw: string;
    try {
      raw = await adapter.fetchRaw(controller.signal);
    } catch (error) {
      const egressHealthy = await this.egressHealthy(options);
      return [{ kind: egressHealthy ? "liveness" : "egress", detail: describe(error) }];
    } finally {
      clearTimeout(timer);
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return [{ kind: "non_json", detail: "body is not JSON (possibly an HTML error page)" }];
    }

    const schemaFailures = validateSchema(body, adapter.schema);
    if (schemaFailures.length > 0) return schemaFailures;

    const hash = createHash("sha256").update(raw).digest("hex");
    const hashes = this.recentHashes.get(adapter.name) ?? [];
    hashes.push(hash);
    if (hashes.length > options.frozenWindow) hashes.shift();
    this.recentHashes.set(adapter.name, hashes);
    if (hashes.length === options.frozenWindow && hashes.every((seen) => seen === hash)) {
      return [{ kind: "frozen", detail: `identical payload for ${options.frozenWindow} consecutive probes` }];
    }

    let value: number;
    try {
      value = adapter.parse(body as Record<string, unknown>);
    } catch (error) {
      return [{ kind: "decode", detail: describe(error) }];
    }
    if (!Number.isFinite(value)) {
      return [{ kind: "decode", detail: `decoded value is not finite: ${value}` }];
    }
    const { min, max } = adapter.expectedRange;
    if (value < min || value > max) {
      return [{ kind: "scale_drift", detail: `value ${value} outside expected range [${min}, ${max}]` }];
    }

    return [];
  }

  private async egressHealthy(options: ProviderProbeOptions): Promise<boolean> {
    if (!options.egressCheck) return true;
    try {
      return await options.egressCheck();
    } catch {
      return false;
    }
  }

  private record(result: ProbeResult, options: ProviderProbeOptions): void {
    const { source, failures } = result;

    this.metrics.recordProviderProbe(source, result.ok ? "success" : "failure", result.latencyMs / 1000);
    for (const failure of failures) {
      if (failure.kind === "frozen") {
        this.metrics.recordProviderFrozenPayload(source);
      } else if (failure.kind !== "liveness" && failure.kind !== "egress") {
        this.metrics.recordProviderSchemaDrift(source, failure.kind);
      }
    }

    if (result.ok) {
      this.streaks.delete(source);
      if (this.quarantined.delete(source)) {
        this.alerting.emit("info", "Provider recovered", `${source} passed canary probe; quarantine lifted`, { source });
      }
      return;
    }

    if (failures.some((failure) => failure.kind === "egress")) {
      this.logger.warn(`Probe for ${source} failed on local egress; not counted against the provider`);
      return;
    }

    const streak = (this.streaks.get(source) ?? 0) + 1;
    this.streaks.set(source, streak);
    if (streak >= options.quarantineAfter && !this.quarantined.has(source)) {
      this.quarantined.add(source);
      this.alerting.emit("critical", "Provider quarantined", `${source} failed ${streak} consecutive canary probes`, {
        source,
        failures,
      });
    }
  }
}
