export type FieldPrimitiveType = "number" | "string" | "boolean" | "object" | "array";

export interface FieldExpectation {
  path: string;
  type: FieldPrimitiveType;
  required: boolean;
  nullable?: boolean;
  unit?: string;
  min?: number;
  max?: number;
  nonEmptyArray?: boolean;
}

export interface ProviderPayloadSchema {
  sourceId: string;
  schemaVersion: string;
  fields: readonly FieldExpectation[];
  strictObjectPaths?: readonly string[];
}

export type SchemaValidationClassification = "ok" | "drift" | "breaking" | "rate_limited";

export interface SchemaFinding {
  path: string;
  severity: "drift" | "breaking";
  reason: string;
}

export interface SchemaValidationResult {
  sourceId: string;
  schemaVersion: string;
  classification: SchemaValidationClassification;
  quarantined: boolean;
  allowIngestion: boolean;
  findings: SchemaFinding[];
  redactedSample: string | null;
  checkedAtMs: number;
}

export interface SourceDriftReport {
  sourceId: string;
  schemaVersion: string;
  quarantined: boolean;
  quarantinedReason: string | null;
  driftCount: number;
  breakingCount: number;
  rateLimitedCount: number;
  lastKnownGoodSample: string | null;
  lastKnownGoodAtMs: number | null;
  lastOffendingSample: string | null;
  lastOffendingFindings: SchemaFinding[];
  lastCheckedAtMs: number | null;
}

export const DEFAULT_PROVIDER_SCHEMAS: Readonly<Record<string, ProviderPayloadSchema>> = Object.freeze({
  coingecko: {
    sourceId: "coingecko",
    schemaVersion: "coingecko-v3-simple-price@1",
    fields: [
      {
        path: "usd-coin",
        type: "object",
        required: true,
      },
      {
        path: "usd-coin.usd",
        type: "number",
        required: true,
        unit: "USD",
        min: 0.0001,
        max: 10,
      },
    ],
    strictObjectPaths: ["", "usd-coin"],
  },
  defillama: {
    sourceId: "defillama",
    schemaVersion: "defillama-protocol-tvl@1",
    fields: [
      {
        path: "tvl",
        type: "array",
        required: true,
        nonEmptyArray: true,
      },
      {
        path: "tvl.0.date",
        type: "number",
        required: true,
        unit: "epoch_seconds",
        min: 1_000_000_000,
      },
      {
        path: "tvl.0.totalLiquidityUSD",
        type: "number",
        required: true,
        unit: "USD",
        min: 0,
      },
    ],
    strictObjectPaths: ["tvl.0"],
  },
  horizon: {
    sourceId: "horizon",
    schemaVersion: "stellar-horizon-ledgers@1",
    fields: [
      {
        path: "_embedded.records",
        type: "array",
        required: true,
        nonEmptyArray: true,
      },
      {
        path: "_embedded.records.0.sequence",
        type: "number",
        required: true,
        unit: "ledger_seq",
        min: 1,
      },
      {
        path: "_embedded.records.0.closed_at",
        type: "string",
        required: true,
        unit: "iso8601",
      },
    ],
    strictObjectPaths: ["_embedded"],
  },
});

const SECRET_KEY_PATTERN = /(secret|token|api[-_]?key|authorization|password|signature)/i;

export function redactAndTruncateSample(payload: unknown, maxBytes = 1024): string {
  const redactValue = (val: unknown, depth = 0): unknown => {
    if (depth > 4) return "[truncated_depth]";
    if (val === null || val === undefined || typeof val !== "object") return val;
    if (Array.isArray(val)) {
      return val.slice(0, 3).map((item) => redactValue(item, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? "[REDACTED]" : redactValue(v, depth + 1);
    }
    return out;
  };

  const serialized = JSON.stringify(redactValue(payload));
  if (!serialized) return "null";
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return serialized;
  return `${serialized.slice(0, Math.max(0, maxBytes - 15))}...[truncated]`;
}

/**
 * Detects rate-limit or quota-exceeded responses that look structurally
 * different from data payloads so they are not misclassified as schema drift.
 */
export function isQuotaOrRateLimitPayload(payload: unknown, httpStatus?: number): boolean {
  if (httpStatus === 429) return true;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const obj = payload as Record<string, unknown>;

  const statusObj = obj.status as Record<string, unknown> | undefined;
  if (statusObj && (statusObj.error_code === 429 || /rate limit|quota/i.test(String(statusObj.error_message ?? "")))) {
    return true;
  }
  if (/rate limit|too many requests|quota exceeded/i.test(String(obj.error ?? obj.message ?? obj.detail ?? ""))) {
    return true;
  }
  return false;
}

function getValueAtPath(root: unknown, dotPath: string): { exists: boolean; value: unknown } {
  if (!dotPath) return { exists: true, value: root };
  const parts = dotPath.split(".");
  let cursor: unknown = root;

  for (const part of parts) {
    if (cursor === null || cursor === undefined || typeof cursor !== "object") {
      return { exists: false, value: undefined };
    }
    if (Array.isArray(cursor)) {
      const idx = Number.parseInt(part, 10);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) {
        return { exists: false, value: undefined };
      }
      cursor = cursor[idx];
    } else {
      const record = cursor as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, part)) {
        return { exists: false, value: undefined };
      }
      cursor = record[part];
    }
  }
  return { exists: true, value: cursor };
}

function classifyPrimitiveType(val: unknown): FieldPrimitiveType | "null" | "invalid_number" | "unknown" {
  if (val === null) return "null";
  if (Array.isArray(val)) return "array";
  if (typeof val === "number") {
    return Number.isFinite(val) ? "number" : "invalid_number";
  }
  if (typeof val === "string") return "string";
  if (typeof val === "boolean") return "boolean";
  if (typeof val === "object") return "object";
  return "unknown";
}

/**
 * Pure validator that checks a raw provider payload against its declared
 * `ProviderPayloadSchema` before any parsing/coercion step.
 */
export function validatePayloadAgainstSchema(
  payload: unknown,
  schema: ProviderPayloadSchema,
  options: { httpStatus?: number; nowMs?: number; maxSampleBytes?: number } = {}
): SchemaValidationResult {
  const checkedAtMs = options.nowMs ?? Date.now();
  const maxSampleBytes = options.maxSampleBytes ?? 1024;

  if (isQuotaOrRateLimitPayload(payload, options.httpStatus)) {
    return {
      sourceId: schema.sourceId,
      schemaVersion: schema.schemaVersion,
      classification: "rate_limited",
      quarantined: false,
      allowIngestion: false,
      findings: [],
      redactedSample: redactAndTruncateSample(payload, maxSampleBytes),
      checkedAtMs,
    };
  }

  const findings: SchemaFinding[] = [];

  if (payload === null || payload === undefined || typeof payload !== "object" || Array.isArray(payload)) {
    findings.push({
      path: "<root>",
      severity: "breaking",
      reason: `Expected root JSON object, received ${Array.isArray(payload) ? "array" : typeof payload}`,
    });
    return {
      sourceId: schema.sourceId,
      schemaVersion: schema.schemaVersion,
      classification: "breaking",
      quarantined: true,
      allowIngestion: false,
      findings,
      redactedSample: redactAndTruncateSample(payload, maxSampleBytes),
      checkedAtMs,
    };
  }

  for (const field of schema.fields) {
    const resolved = getValueAtPath(payload, field.path);
    if (!resolved.exists || resolved.value === undefined) {
      if (field.required) {
        findings.push({
          path: field.path,
          severity: "breaking",
          reason: `Missing required field "${field.path}"`,
        });
      }
      continue;
    }

    if (resolved.value === null) {
      if (!field.nullable) {
        findings.push({
          path: field.path,
          severity: "breaking",
          reason: `Non-nullable field "${field.path}" is null`,
        });
      }
      continue;
    }

    const actualType = classifyPrimitiveType(resolved.value);
    if (actualType !== field.type) {
      findings.push({
        path: field.path,
        severity: "breaking",
        reason: `Field "${field.path}" expected type "${field.type}"${field.unit ? ` (${field.unit})` : ""}, got "${actualType}"`,
      });
      continue;
    }

    if (field.type === "number" && typeof resolved.value === "number") {
      if (field.min !== undefined && resolved.value < field.min) {
        findings.push({
          path: field.path,
          severity: "breaking",
          reason: `Field "${field.path}" value ${resolved.value} is below minimum ${field.min}`,
        });
      }
      if (field.max !== undefined && resolved.value > field.max) {
        findings.push({
          path: field.path,
          severity: "breaking",
          reason: `Field "${field.path}" value ${resolved.value} exceeds maximum ${field.max}`,
        });
      }
    }

    if (field.type === "array" && Array.isArray(resolved.value)) {
      if (field.nonEmptyArray && resolved.value.length === 0) {
        findings.push({
          path: field.path,
          severity: "breaking",
          reason: `Required non-empty array "${field.path}" arrived empty`,
        });
      }
    }
  }

  // Informational drift detection: flag unexpected version/deprecation headers or
  // unknown sibling keys when a container declares deprecation/schema-change markers
  const rootObj = payload as Record<string, unknown>;
  if ("deprecated" in rootObj || "_deprecation_warning" in rootObj || "schema_version" in rootObj) {
    findings.push({
      path: "<root>",
      severity: "drift",
      reason: "Upstream payload includes deprecation or schema-version change notice",
    });
  }

  const hasBreaking = findings.some((f) => f.severity === "breaking");
  const hasDrift = findings.some((f) => f.severity === "drift");
  const classification: SchemaValidationClassification = hasBreaking
    ? "breaking"
    : hasDrift
    ? "drift"
    : "ok";

  return {
    sourceId: schema.sourceId,
    schemaVersion: schema.schemaVersion,
    classification,
    quarantined: hasBreaking,
    allowIngestion: !hasBreaking,
    findings,
    redactedSample: classification === "ok" ? null : redactAndTruncateSample(payload, maxSampleBytes),
    checkedAtMs,
  };
}

export class SchemaDriftMonitor {
  private readonly schemas = new Map<string, ProviderPayloadSchema>();
  private readonly reports = new Map<string, SourceDriftReport>();
  private readonly maxSampleBytes: number;
  private readonly onBreakingAlert?: (result: SchemaValidationResult) => void;

  constructor(options: {
    schemas?: Record<string, ProviderPayloadSchema>;
    maxSampleBytes?: number;
    onBreakingAlert?: (result: SchemaValidationResult) => void;
  } = {}) {
    this.maxSampleBytes = options.maxSampleBytes ?? 1024;
    this.onBreakingAlert = options.onBreakingAlert;
    const initial = options.schemas ?? DEFAULT_PROVIDER_SCHEMAS;
    for (const schema of Object.values(initial)) {
      this.registerSchema(schema);
    }
  }

  registerSchema(schema: ProviderPayloadSchema): void {
    this.schemas.set(schema.sourceId, schema);
    if (!this.reports.has(schema.sourceId)) {
      this.reports.set(schema.sourceId, {
        sourceId: schema.sourceId,
        schemaVersion: schema.schemaVersion,
        quarantined: false,
        quarantinedReason: null,
        driftCount: 0,
        breakingCount: 0,
        rateLimitedCount: 0,
        lastKnownGoodSample: null,
        lastKnownGoodAtMs: null,
        lastOffendingSample: null,
        lastOffendingFindings: [],
        lastCheckedAtMs: null,
      });
    }
  }

  inspect(
    sourceId: string,
    payload: unknown,
    options: { httpStatus?: number; nowMs?: number } = {}
  ): SchemaValidationResult {
    const schema = this.schemas.get(sourceId);
    if (!schema) {
      throw new Error(`No ProviderPayloadSchema registered for source "${sourceId}"`);
    }
    const nowMs = options.nowMs ?? Date.now();
    const result = validatePayloadAgainstSchema(payload, schema, {
      httpStatus: options.httpStatus,
      nowMs,
      maxSampleBytes: this.maxSampleBytes,
    });

    const report = this.reports.get(sourceId)!;
    report.lastCheckedAtMs = nowMs;

    if (result.classification === "ok") {
      report.lastKnownGoodSample = redactAndTruncateSample(payload, this.maxSampleBytes);
      report.lastKnownGoodAtMs = nowMs;
    } else if (result.classification === "drift") {
      report.driftCount += 1;
      report.lastKnownGoodSample = redactAndTruncateSample(payload, this.maxSampleBytes);
      report.lastKnownGoodAtMs = nowMs;
      report.lastOffendingSample = result.redactedSample;
      report.lastOffendingFindings = result.findings;
    } else if (result.classification === "rate_limited") {
      report.rateLimitedCount += 1;
    } else if (result.classification === "breaking") {
      report.breakingCount += 1;
      report.quarantined = true;
      report.quarantinedReason = result.findings.map((f) => f.reason).join("; ");
      report.lastOffendingSample = result.redactedSample;
      report.lastOffendingFindings = result.findings;
      this.onBreakingAlert?.(result);
    }

    if (report.quarantined) {
      return {
        ...result,
        quarantined: true,
        allowIngestion: false,
      };
    }

    return result;
  }

  clearQuarantine(sourceId: string): void {
    const report = this.reports.get(sourceId);
    if (report) {
      report.quarantined = false;
      report.quarantinedReason = null;
    }
  }

  getReport(sourceId: string): SourceDriftReport | null {
    const report = this.reports.get(sourceId);
    return report ? structuredClone(report) : null;
  }

  listReports(): SourceDriftReport[] {
    return [...this.reports.values()].map((r) => structuredClone(r));
  }
}
