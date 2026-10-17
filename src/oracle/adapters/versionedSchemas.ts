/**
 * Adapter Payload Schema Versioning, Compatibility Shims, and Deprecation Lifecycle (Issue #241)
 *
 * Validates provider payloads against strict versioned schemas, applies compatibility
 * shims for known provider response migrations, supports concurrent active versions
 * during migration windows, rate-limits deprecation warnings, stamps adapter/schema
 * versions onto readings and evidence, and backfills legacy unversioned records.
 */

export interface AdapterVersionDescriptor {
  adapterId: string;
  adapterVersion: string;
  payloadSchemaVersion: number;
  deprecated?: boolean;
  removalAtMs?: number;
  deprecationNotice?: string;
}

export interface NormalizedReadingOutput {
  metricValueBps: number;
  observedTimestampMs: number;
}

export interface VersionStampedReadingRecord extends NormalizedReadingOutput {
  adapterId: string;
  adapterVersion: string;
  payloadSchemaVersion: number;
  shimApplied: boolean;
  deprecationWarningEmitted: boolean;
}

export interface AdapterSchemaHandler {
  descriptor: AdapterVersionDescriptor;
  /** Optional shim converting legacy or additive provider shapes into the canonical schema shape */
  compatibilityShim?: (raw: Record<string, unknown>) => {
    shimmedPayload: Record<string, unknown>;
    shimApplied: boolean;
  };
  /** Strict validator and extractor; throws or returns error string on unexpected/invalid shape */
  strictValidateAndExtract: (
    payload: Record<string, unknown>
  ) => NormalizedReadingOutput;
}

export class VersionedAdapterSchemaRegistry {
  private readonly handlers = new Map<string, Map<number, AdapterSchemaHandler>>();
  private readonly liveServingVersionByAdapter = new Map<string, number>();
  private readonly warningWindowMs: number;
  private readonly maxWarningsPerWindow: number;
  private readonly warningTimestampsByKey = new Map<string, number[]>();
  private readonly warningLogs: string[] = [];

  constructor(options: { warningWindowMs?: number; maxWarningsPerWindow?: number } = {}) {
    this.warningWindowMs = options.warningWindowMs ?? 60_000;
    this.maxWarningsPerWindow = options.maxWarningsPerWindow ?? 2;
  }

  registerSchemaVersion(handler: AdapterSchemaHandler): void {
    const { adapterId, payloadSchemaVersion } = handler.descriptor;
    if (!adapterId || adapterId.trim() === "") {
      throw new Error("adapterId must be non-empty");
    }
    if (payloadSchemaVersion <= 0 || !Number.isInteger(payloadSchemaVersion)) {
      throw new Error("payloadSchemaVersion must be a positive integer");
    }

    const byVer = this.handlers.get(adapterId) ?? new Map<number, AdapterSchemaHandler>();
    byVer.set(payloadSchemaVersion, handler);
    this.handlers.set(adapterId, byVer);

    if (!this.liveServingVersionByAdapter.has(adapterId)) {
      this.liveServingVersionByAdapter.set(adapterId, payloadSchemaVersion);
    }
  }

  /**
   * Selects which registered schema version serves live consensus decisions during
   * a concurrent multi-version migration window.
   */
  setLiveServingSchemaVersion(adapterId: string, payloadSchemaVersion: number): void {
    const byVer = this.handlers.get(adapterId);
    if (!byVer || !byVer.has(payloadSchemaVersion)) {
      throw new Error(
        `Adapter "${adapterId}" schema version ${payloadSchemaVersion} is not registered`
      );
    }
    this.liveServingVersionByAdapter.set(adapterId, payloadSchemaVersion);
  }

  /**
   * Parses and validates a raw provider payload against a specific schema version
   * (or the adapter's configured live serving version), applying compatibility shims
   * and stamping version metadata. Rejects unknown future schema versions or malformed shapes.
   */
  parseAndStampReading(params: {
    adapterId: string;
    requestedSchemaVersion?: number;
    rawPayload: Record<string, unknown>;
    nowMs: number;
  }): VersionStampedReadingRecord {
    const byVer = this.handlers.get(params.adapterId);
    if (!byVer) {
      throw new Error(`[ADAPTER_NOT_FOUND] Unknown adapter "${params.adapterId}"`);
    }

    const targetVersion =
      params.requestedSchemaVersion ??
      this.liveServingVersionByAdapter.get(params.adapterId)!;

    const handler = byVer.get(targetVersion);
    if (!handler) {
      throw new Error(
        `[UNKNOWN_SCHEMA_VERSION] Adapter "${params.adapterId}" does not support payloadSchemaVersion=${targetVersion}`
      );
    }

    const { descriptor } = handler;
    if (
      descriptor.deprecated &&
      descriptor.removalAtMs !== undefined &&
      params.nowMs >= descriptor.removalAtMs
    ) {
      throw new Error(
        `[DEPRECATED_SCHEMA_REMOVED] Adapter "${params.adapterId}" schema v${targetVersion} passed its removal deadline (${descriptor.removalAtMs})`
      );
    }

    let deprecationWarningEmitted = false;
    if (descriptor.deprecated) {
      deprecationWarningEmitted = this.maybeEmitDeprecationWarning(
        descriptor,
        params.nowMs
      );
    }

    let workingPayload = params.rawPayload;
    let shimApplied = false;
    if (handler.compatibilityShim) {
      const shimmed = handler.compatibilityShim(params.rawPayload);
      workingPayload = shimmed.shimmedPayload;
      shimApplied = shimmed.shimApplied;
    }

    let extracted: NormalizedReadingOutput;
    try {
      extracted = handler.strictValidateAndExtract(workingPayload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[STRICT_SCHEMA_VALIDATION_FAILED] ${descriptor.adapterId}@${descriptor.adapterVersion} (schema v${descriptor.payloadSchemaVersion}): ${msg}`
      );
    }

    return {
      adapterId: descriptor.adapterId,
      adapterVersion: descriptor.adapterVersion,
      payloadSchemaVersion: descriptor.payloadSchemaVersion,
      metricValueBps: extracted.metricValueBps,
      observedTimestampMs: extracted.observedTimestampMs,
      shimApplied,
      deprecationWarningEmitted,
    };
  }

  /**
   * Backfills legacy unversioned historical reading rows without altering their
   * existing deterministic evidence fields.
   */
  static backfillLegacyReadingRow<T extends Record<string, unknown>>(
    row: T,
    defaultAdapterId = "legacy_adapter"
  ): T & {
    adapterId: string;
    adapterVersion: string;
    payloadSchemaVersion: number;
  } {
    return {
      ...row,
      adapterId:
        typeof row.adapterId === "string" && row.adapterId.length > 0
          ? row.adapterId
          : defaultAdapterId,
      adapterVersion:
        typeof row.adapterVersion === "string" && row.adapterVersion.length > 0
          ? row.adapterVersion
          : "1.0.0-legacy",
      payloadSchemaVersion:
        typeof row.payloadSchemaVersion === "number" &&
        Number.isInteger(row.payloadSchemaVersion)
          ? row.payloadSchemaVersion
          : 1,
    };
  }

  /**
   * Exposes current adapter and schema versions for the trust status API and reconciliation.
   */
  getTrustStatusAdapterVersions() {
    const out: Array<{
      adapterId: string;
      liveSchemaVersion: number;
      registeredVersions: AdapterVersionDescriptor[];
    }> = [];

    for (const [adapterId, byVer] of this.handlers.entries()) {
      out.push({
        adapterId,
        liveSchemaVersion: this.liveServingVersionByAdapter.get(adapterId)!,
        registeredVersions: Array.from(byVer.values()).map((h) => ({
          ...h.descriptor,
        })),
      });
    }
    return out;
  }

  getWarningLogs(): readonly string[] {
    return this.warningLogs;
  }

  private maybeEmitDeprecationWarning(
    descriptor: AdapterVersionDescriptor,
    nowMs: number
  ): boolean {
    const key = `${descriptor.adapterId}:v${descriptor.payloadSchemaVersion}`;
    const recent = (this.warningTimestampsByKey.get(key) ?? []).filter(
      (ts) => nowMs - ts <= this.warningWindowMs
    );
    if (recent.length >= this.maxWarningsPerWindow) {
      this.warningTimestampsByKey.set(key, recent);
      return false;
    }
    recent.push(nowMs);
    this.warningTimestampsByKey.set(key, recent);
    this.warningLogs.push(
      `[DEPRECATED_ADAPTER_SCHEMA] ${descriptor.adapterId} schema v${descriptor.payloadSchemaVersion} is deprecated (${descriptor.deprecationNotice ?? "upgrade required"})`
    );
    return true;
  }
}
