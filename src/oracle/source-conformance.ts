import { scaleOracleValue } from "./oracle-encoding";

/**
 * Provider adapter conformance checks and admission gate.
 *
 * The same module is consumed by local provider runs and by the backend
 * admission gate, so there is one definition of "compliant". Checks are pure
 * and offline: adapters are called through an injected interface, signature
 * verification is injected, and time is passed in explicitly so results do
 * not depend on the host clock or timezone.
 *
 * Out of scope: proving the provider's underlying data is accurate, and
 * certifying the provider's infrastructure security.
 */

export const CONFORMANCE_SPEC_VERSION = "1.0.0";
export const CONFORMANCE_REPORT_VERSION = 1;

/** Tolerated forward clock skew between provider and backend. */
export const MAX_CLOCK_SKEW_MS = 5_000;
/** Default maximum age of a submission before it is considered stale. */
export const DEFAULT_MAX_STALENESS_MS = 60_000;
/** Default adapter response deadline. */
export const DEFAULT_ADAPTER_TIMEOUT_MS = 5_000;
/** Certification validity window. Expired records must be re-run. */
export const DEFAULT_CERTIFICATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Tolerance for detecting precision loss when scaling to the on-chain integer. */
const SCALE_EPSILON = 1e-6;

export interface ProviderSubmission {
  coverageType: string;
  value: number;
  /** Provider-declared observation time, epoch milliseconds. */
  timestamp: number;
  nonce: string;
  signature: string;
}

/** The adapter contract a provider implements. Must resolve or reject within the timeout. */
export interface ProviderAdapter {
  fetch(coverageType: string): Promise<ProviderSubmission>;
}

export interface ConformanceOptions {
  coverageTypes: string[];
  verifySignature: (submission: ProviderSubmission) => boolean;
  /** Current time in epoch milliseconds. */
  now: number;
  maxStalenessMs?: number;
  adapterTimeoutMs?: number;
}

export interface CheckResult {
  id: string;
  passed: boolean;
  detail: string;
}

export interface ConformanceReport {
  reportVersion: typeof CONFORMANCE_REPORT_VERSION;
  specVersion: string;
  sourceId: string;
  generatedAt: number;
  passed: boolean;
  checks: CheckResult[];
}

export interface CertificationRecord {
  sourceId: string;
  specVersion: string;
  reportVersion: number;
  passed: boolean;
  issuedAt: number;
  expiresAt: number;
}

export interface AdmissionDecision {
  admitted: boolean;
  reason: string;
}

function isSubmissionShaped(value: unknown): value is ProviderSubmission {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.coverageType === "string" &&
    typeof s.value === "number" &&
    Number.isFinite(s.value) &&
    typeof s.timestamp === "number" &&
    Number.isFinite(s.timestamp) &&
    typeof s.nonce === "string" &&
    s.nonce.length > 0 &&
    typeof s.signature === "string"
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`adapter did not respond within ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Runs every conformance check against an adapter over the declared coverage
 * types. A check passes only if it passes for every submission.
 */
export async function runConformance(
  sourceId: string,
  adapter: ProviderAdapter,
  options: ConformanceOptions,
): Promise<ConformanceReport> {
  const maxStalenessMs = options.maxStalenessMs ?? DEFAULT_MAX_STALENESS_MS;
  const adapterTimeoutMs = options.adapterTimeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
  const outcomes = new Map<string, CheckResult>();
  const seenNonces = new Set<string>();

  // Keeps the first failure for each check, otherwise the first result.
  const record = (id: string, passed: boolean, detail: string) => {
    const prior = outcomes.get(id);
    if (prior && (!prior.passed || passed)) return;
    outcomes.set(id, { id, passed, detail });
  };

  for (const coverageType of options.coverageTypes) {
    let submission: ProviderSubmission;
    try {
      const raw = await withTimeout(adapter.fetch(coverageType), adapterTimeoutMs);
      record("adapter_timeout", true, "adapter responded in time");
      if (!isSubmissionShaped(raw)) {
        record("schema", false, `${coverageType}: submission missing or malformed fields`);
        continue;
      }
      submission = raw;
      record("schema", true, "submissions match the declared schema");
    } catch (err) {
      const timedOut = err instanceof Error && err.message.includes("did not respond");
      record("adapter_timeout", !timedOut, timedOut ? `${coverageType}: ${(err as Error).message}` : "adapter responded in time");
      record("adapter_error", err instanceof Error, `${coverageType}: rejection must be an Error instance`);
      continue;
    }

    if (submission.coverageType !== coverageType) {
      record("schema", false, `${coverageType}: adapter returned coverageType ${submission.coverageType}`);
    }

    try {
      const scaled = Number(scaleOracleValue(coverageType, submission.value));
      const exact = submission.value * scaledFactor(coverageType);
      const lossy = Math.abs(exact - Math.round(exact)) > SCALE_EPSILON;
      record(
        "units_scale",
        !lossy && Number.isSafeInteger(scaled),
        lossy
          ? `${coverageType}: value ${submission.value} has more precision than the on-chain scale; would be silently rounded`
          : `${coverageType}: value scales to a safe integer`,
      );
    } catch (err) {
      record("units_scale", false, `${coverageType}: ${(err as Error).message}`);
    }

    const ageMs = options.now - submission.timestamp;
    record(
      "timestamp_not_future",
      ageMs >= -MAX_CLOCK_SKEW_MS,
      `${coverageType}: submission is ${Math.max(0, -ageMs)}ms in the future`,
    );
    record(
      "timestamp_fresh",
      ageMs <= maxStalenessMs,
      `${coverageType}: submission is ${ageMs}ms old, limit ${maxStalenessMs}ms`,
    );

    record(
      "signature",
      options.verifySignature(submission),
      `${coverageType}: signature verification`,
    );

    record(
      "replay",
      !seenNonces.has(submission.nonce),
      `${coverageType}: nonce ${submission.nonce} was already used`,
    );
    seenNonces.add(submission.nonce);
  }

  const checks = [...outcomes.values()];
  return {
    reportVersion: CONFORMANCE_REPORT_VERSION,
    specVersion: CONFORMANCE_SPEC_VERSION,
    sourceId,
    generatedAt: options.now,
    passed: checks.length > 0 && checks.every((c) => c.passed),
    checks,
  };
}

/** Multiplier from OracleReading.value to the on-chain integer, derived from the encoder. */
function scaledFactor(coverageType: string): number {
  return Number(scaleOracleValue(coverageType, 1));
}

/** Builds the certification record the admission gate consumes. */
export function buildCertificationRecord(
  report: ConformanceReport,
  now: number,
  ttlMs: number = DEFAULT_CERTIFICATION_TTL_MS,
): CertificationRecord {
  return {
    sourceId: report.sourceId,
    specVersion: report.specVersion,
    reportVersion: report.reportVersion,
    passed: report.passed,
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
}

/**
 * Fails closed: a source is admitted only with a passing, unexpired record
 * issued against the current spec and report versions.
 */
export function assessAdmission(
  record: CertificationRecord | undefined,
  now: number,
): AdmissionDecision {
  if (!record) return { admitted: false, reason: "no certification record" };
  if (!record.passed) return { admitted: false, reason: "certification did not pass" };
  if (record.specVersion !== CONFORMANCE_SPEC_VERSION) {
    return { admitted: false, reason: `certified against spec ${record.specVersion}, current is ${CONFORMANCE_SPEC_VERSION}` };
  }
  if (record.reportVersion !== CONFORMANCE_REPORT_VERSION) {
    return { admitted: false, reason: `report version ${record.reportVersion} is not supported` };
  }
  if (record.issuedAt > now + MAX_CLOCK_SKEW_MS) {
    return { admitted: false, reason: "certification issued in the future" };
  }
  if (now >= record.expiresAt) return { admitted: false, reason: "certification expired" };
  return { admitted: true, reason: "valid certification" };
}
