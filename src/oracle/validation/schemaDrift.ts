/**
 * Upstream provider schema drift detection.
 *
 * Each adapter declares an expected response shape (structural schema plus
 * required units and nullability) separately from its parsing code. Every
 * fetch validates the payload against that declared shape *before* parsing so
 * a tolerant parser can never mask an upstream change.
 *
 * Unexpected structures are classified as either:
 *  - `drift`    informational: optional fields added, empty arrays, etc.
 *  - `breaking` ingestion must be rejected, the source quarantined and an
 *               alert fired.
 */

export type ProviderId = 'coingecko' | 'horizon' | 'defillama';

export type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface FieldShape {
  type: FieldType;
  /** Required fields must be present and non-null. */
  required?: boolean;
  /** Field may legitimately be null without being classified as drift. */
  nullable?: boolean;
  /** Declared unit for numeric fields (e.g. 'usd', 'stroops', 'ratio'). */
  unit?: string;
  /** Nested object shape. */
  fields?: Record<string, FieldShape>;
  /** Element shape for arrays. */
  items?: FieldShape;
}

export interface ResponseShape {
  provider: ProviderId;
  /** Version of the declared shape; bump when the contract changes. */
  version: string;
  fields: Record<string, FieldShape>;
}

export type DriftClassification = 'ok' | 'drift' | 'breaking';

export interface DriftIssue {
  path: string;
  kind:
    | 'missing_required'
    | 'null_required'
    | 'type_mismatch'
    | 'unit_missing'
    | 'optional_added'
    | 'empty_array';
  detail: string;
  severity: 'drift' | 'breaking';
}

export interface DriftResult {
  provider: ProviderId;
  shapeVersion: string;
  classification: DriftClassification;
  issues: DriftIssue[];
  /** Redacted, size-limited sample of the offending payload. */
  sample?: unknown;
  /** True when the payload looks like a rate-limit/quota response. */
  rateLimited: boolean;
  checkedAt: string;
}

const MAX_SAMPLE_BYTES = 4096;
const REDACTED = '[redacted]';
const SENSITIVE_KEY = /(key|token|secret|auth|signature|password)/i;

/**
 * Rate-limit / quota responses are structurally different by design and must
 * not be misclassified as drift.
 */
export function isRateLimitResponse(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const obj = payload as Record<string, unknown>;
  if (obj.status === 429 || obj.statusCode === 429) return true;
  if (typeof obj.error === 'string' && /rate.?limit|quota|too many requests/i.test(obj.error)) {
    return true;
  }
  if (typeof obj.message === 'string' && /rate.?limit|quota|too many requests/i.test(obj.message)) {
    return true;
  }
  return false;
+}
+
+function redact(value: unknown, depth = 0): unknown {
+  if (depth > 6) return REDACTED;
+  if (Array.isArray(value)) {
+    return value.slice(0, 20).map((v) => redact(v, depth + 1));
+  }
+  if (value && typeof value === 'object') {
+    const out: Record<string, unknown> = {};
+    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
+      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
+    }
+    return out;
+  }
+  return value;
+}
+
+/** Capture a redacted, size-limited sample of the offending payload. */
+export function captureSample(payload: unknown): unknown {
+  const redacted = redact(payload);
+  try {
+    const serialized = JSON.stringify(redacted);
+    if (serialized.length <= MAX_SAMPLE_BYTES) return redacted;
+    return { truncated: true, preview: serialized.slice(0, MAX_SAMPLE_BYTES) };
+  } catch {
+    return { truncated: true, preview: String(payload).slice(0, MAX_SAMPLE_BYTES) };
+  }
+}
+
+function typeOf(value: unknown): FieldType | 'null' | 'undefined' {
+  if (value === null) return 'null';
+  if (value === undefined) return 'undefined';
+  if (Array.isArray(value)) return 'array';
+  return typeof value as FieldType;
+}
+
+function validateField(
+  path: string,
+  shape: FieldShape,
+  value: unknown,
+  issues: DriftIssue[],
+): void {
+  const actual = typeOf(value);
+
+  if (actual === 'undefined') {
+    if (shape.required) {
+      issues.push({
+        path,
+        kind: 'missing_required',
+        detail: `required field missing (expected ${shape.type})`,
+        severity: 'breaking',
+      });
+    }
+    return;
+  }
+
+  if (actual === 'null') {
+    if (shape.required && !shape.nullable) {
+      issues.push({
+        path,
+        kind: 'null_required',
+        detail: 'required field is null',
+        severity: 'breaking',
+      });
+    }
+    return;
+  }
+
+  if (actual !== shape.type) {
+    issues.push({
+      path,
+      kind: 'type_mismatch',
+      detail: `expected ${shape.type}, got ${actual}`,
+      severity: 'breaking',
+    });
+    return;
+  }
+
+  if (shape.type === 'number' && shape.unit && !Number.isFinite(value as number)) {
+    issues.push({
+      path,
+      kind: 'unit_missing',
+      detail: `numeric field with unit '${shape.unit}' is not finite`,
+      severity: 'breaking',
+    });
+  }
+
+  if (shape.type === 'object' && shape.fields) {
+    const obj = value as Record<string, unknown>;
+    for (const [key, childShape] of Object.entries(shape.fields)) {
+      validateField(`${path}.${key}`, childShape, obj[key], issues);
+    }
+    for (const key of Object.keys(obj)) {
+      if (!(key in shape.fields)) {
+        issues.push({
+          path: `${path}.${key}`,
+          kind: 'optional_added',
+          detail: 'unexpected field added by provider',
+          severity: 'drift',
+        });
+      }
+    }
+  }
+
+  if (shape.type === 'array' && shape.items) {
+    const arr = value as unknown[];
+    if (arr.length === 0) {
+      issues.push({
+        path,
+        kind: 'empty_array',
+        detail: 'array arrived empty',
+        severity: 'drift',
+      });
+      return;
+    }
+    arr.forEach((item, i) => validateField(`${path}[${i}]`, shape.items as FieldShape, item, issues));
+  }
+}
+
+/**
+ * Validate a provider payload against its declared shape. Must be called
+ * before parsing/normalization.
+ */
+export function validateResponseShape(shape: ResponseShape, payload: unknown): DriftResult {
+  const checkedAt = new Date().toISOString();
+
+  if (isRateLimitResponse(payload)) {
+    return {
+      provider: shape.provider,
+      shapeVersion: shape.version,
+      classification: 'ok',
+      issues: [],
+      rateLimited: true,
+      checkedAt,
+    };
+  }
+
+  const issues: DriftIssue[] = [];
+  const actual = typeOf(payload);
+  if (actual !== 'object') {
+    issues.push({
+      path: '$',
+      kind: 'type_mismatch',
+      detail: `expected object payload, got ${actual}`,
+      severity: 'breaking',
+    });
+  } else {
+    const obj = payload as Record<string, unknown>;
+    for (const [key, fieldShape] of Object.entries(shape.fields)) {
+      validateField(key, fieldShape, obj[key], issues);
+    }
+    for (const key of Object.keys(obj)) {
+      if (!(key in shape.fields)) {
+        issues.push({
+          path: key,
+          kind: 'optional_added',
+          detail: 'unexpected top-level field added by provider',
+          severity: 'drift',
+        });
+      }
+    }
+  }
+
+  const breaking = issues.some((i) => i.severity === 'breaking');
  const classification: DriftClassification = breaking
    ? 'breaking'
    : issues.length > 0
      ? 'drift'
      : 'ok';
+
+  return {
+    provider: shape.provider,
+    shapeVersion: shape.version,
+    classification,
+    issues,
+    sample: classification === 'ok' ? undefined : captureSample(payload),
+    rateLimited: false,
+    checkedAt,
+  };
+}
+
+/**
+ * Declared response shapes for each provider. Kept separate from parsing code
+ * so the contract can be reviewed and versioned independently.
+ */
+export const PROVIDER_SHAPES: Record<ProviderId, ResponseShape> = {
+  coingecko: {
+    provider: 'coingecko',
+    version: '1.0.0',
+    fields: {
+      prices: {
+        type: 'array',
+        required: true,
+        items: {
+          type: 'array',
+          items: { type: 'number', unit: 'usd' },
+        },
+      },
+    },
+  },
+  horizon: {
+    provider: 'horizon',
+    version: '1.0.0',
+    fields: {
+      _embedded: {
+        type: 'object',
+        required: true,
+        fields: {
+          records: { type: 'array', required: true, items: { type: 'object' } },
+        },
+      },
+    },
+  },
+  defillama: {
+    provider: 'defillama',
+    version: '1.0.0',
+    fields: {
+      coins: { type: 'object', required: true },
+    },
+  },
+};
+
+export function getProviderShape(provider: ProviderId): ResponseShape {
+  return PROVIDER_SHAPES[provider];
+}
