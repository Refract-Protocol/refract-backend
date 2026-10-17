export interface CanaryProbeReading {
  sourceId: string;
  feedId: string;
  value: number;
  unit: string;
  observedAtMs: number;
  probe: boolean;
}

export interface ProviderRawPayload {
  value?: unknown;
  unit?: unknown;
  observedAtMs?: unknown;
  [key: string]: unknown;
}

export interface CanaryProbeSchemaSpec {
  expectedUnit: string;
  minPlausibleValue: number;
  maxPlausibleValue: number;
  allowedFields: string[];
}

export interface SourceCanaryMetrics {
  sourceId: string;
  totalProbes: number;
  successfulProbes: number;
  probeSuccessRate: number;
  lastProbeLatencyMs: number;
  frozenPayloadDetections: number;
  schemaDriftDetections: number;
  consecutiveFailures: number;
  quarantined: boolean;
}

export interface CanaryProbeOutcome {
  sourceId: string;
  ok: boolean;
  failureReason:
    | null
    | "LIVENESS_ERROR"
    | "SCHEMA_DRIFT"
    | "UNIT_SCALE_DRIFT"
    | "FROZEN_PAYLOAD";
  reading: CanaryProbeReading | null;
  quarantinedTriggered: boolean;
}

export class SyntheticCanaryProbeRunner {
  private readonly quarantineFailureThreshold: number;
  private readonly maxIdenticalPayloads: number;
  private readonly metricsBySource = new Map<string, SourceCanaryMetrics>();
  private readonly payloadHistoryBySource = new Map<string, string[]>();

  constructor(options?: {
    quarantineFailureThreshold?: number;
    maxIdenticalPayloads?: number;
  }) {
    this.quarantineFailureThreshold = options?.quarantineFailureThreshold ?? 3;
    this.maxIdenticalPayloads = options?.maxIdenticalPayloads ?? 3;
  }

  private getOrCreateMetrics(sourceId: string): SourceCanaryMetrics {
    let m = this.metricsBySource.get(sourceId);
    if (!m) {
      m = {
        sourceId,
        totalProbes: 0,
        successfulProbes: 0,
        probeSuccessRate: 0,
        lastProbeLatencyMs: 0,
        frozenPayloadDetections: 0,
        schemaDriftDetections: 0,
        consecutiveFailures: 0,
        quarantined: false,
      };
      this.metricsBySource.set(sourceId, m);
    }
    return m;
  }

  public async runCanaryProbe(params: {
    sourceId: string;
    feedId: string;
    schema: CanaryProbeSchemaSpec;
    fetchRawPayload: () => Promise<ProviderRawPayload>;
  }): Promise<CanaryProbeOutcome> {
    const metrics = this.getOrCreateMetrics(params.sourceId);
    metrics.totalProbes += 1;
    const startNs = process.hrtime.bigint();

    let raw: ProviderRawPayload;
    try {
      raw = await params.fetchRawPayload();
    } catch {
      metrics.lastProbeLatencyMs =
        Number(process.hrtime.bigint() - startNs) / 1_000_000;
      return this.recordFailure(metrics, "LIVENESS_ERROR");
    }

    metrics.lastProbeLatencyMs =
      Number(process.hrtime.bigint() - startNs) / 1_000_000;

    // 1. Validate required fields, types, and unknown fields
    const keys = Object.keys(raw);
    const hasUnknownField = keys.some(
      (k) => !params.schema.allowedFields.includes(k)
    );
    if (
      hasUnknownField ||
      typeof raw.value !== "number" ||
      !Number.isFinite(raw.value) ||
      typeof raw.unit !== "string" ||
      typeof raw.observedAtMs !== "number"
    ) {
      metrics.schemaDriftDetections += 1;
      return this.recordFailure(metrics, "SCHEMA_DRIFT");
    }

    // 2. Validate unit / scale drift
    if (
      raw.unit !== params.schema.expectedUnit ||
      raw.value < params.schema.minPlausibleValue ||
      raw.value > params.schema.maxPlausibleValue
    ) {
      metrics.schemaDriftDetections += 1;
      return this.recordFailure(metrics, "UNIT_SCALE_DRIFT");
    }

    // 3. Frozen payload detection
    const fingerprint = `${raw.value}:${raw.observedAtMs}`;
    const history = this.payloadHistoryBySource.get(params.sourceId) ?? [];
    history.push(fingerprint);
    if (history.length > this.maxIdenticalPayloads) {
      history.shift();
    }
    this.payloadHistoryBySource.set(params.sourceId, history);

    if (
      history.length >= this.maxIdenticalPayloads &&
      history.every((item) => item === fingerprint)
    ) {
      metrics.frozenPayloadDetections += 1;
      return this.recordFailure(metrics, "FROZEN_PAYLOAD");
    }

    metrics.successfulProbes += 1;
    metrics.consecutiveFailures = 0;
    metrics.probeSuccessRate = metrics.successfulProbes / metrics.totalProbes;

    return {
      sourceId: params.sourceId,
      ok: true,
      failureReason: null,
      reading: {
        sourceId: params.sourceId,
        feedId: params.feedId,
        value: raw.value,
        unit: raw.unit,
        observedAtMs: raw.observedAtMs,
        probe: true,
      },
      quarantinedTriggered: false,
    };
  }

  private recordFailure(
    metrics: SourceCanaryMetrics,
    reason:
      | "LIVENESS_ERROR"
      | "SCHEMA_DRIFT"
      | "UNIT_SCALE_DRIFT"
      | "FROZEN_PAYLOAD"
  ): CanaryProbeOutcome {
    metrics.consecutiveFailures += 1;
    metrics.probeSuccessRate = metrics.successfulProbes / metrics.totalProbes;
    let quarantinedTriggered = false;
    if (
      !metrics.quarantined &&
      metrics.consecutiveFailures >= this.quarantineFailureThreshold
    ) {
      metrics.quarantined = true;
      quarantinedTriggered = true;
    }
    return {
      sourceId: metrics.sourceId,
      ok: false,
      failureReason: reason,
      reading: null,
      quarantinedTriggered,
    };
  }

  public getSourceMetrics(sourceId: string): SourceCanaryMetrics | undefined {
    const m = this.metricsBySource.get(sourceId);
    return m ? { ...m } : undefined;
  }

  /**
   * Filters out canary probe readings (`probe: true`) and quarantined sources so synthetic
   * probes never count toward corroboration quorum or on-chain publication.
   */
  public filterConsensusEligibleReadings(
    readings: CanaryProbeReading[]
  ): CanaryProbeReading[] {
    return readings.filter((r) => {
      if (r.probe) return false;
      const m = this.metricsBySource.get(r.sourceId);
      return !m?.quarantined;
    });
  }
}
