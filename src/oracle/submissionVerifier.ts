import { createPublicKey, verify } from "node:crypto";

export interface RegisteredDataProvider {
  providerId: string;
  publicKeyPem: string;
  enabled: boolean;
  allowedCoverageTypes: string[];
  maxSubmissionsPerMinute?: number;
}

export interface CoverageSubmissionSpec {
  coverageType: string;
  expectedUnit: string;
  minValue: number;
  maxValue: number;
  maxAgeMs: number;
}

export interface SignedSubmissionPayload {
  providerId: string;
  coverageType: string;
  value: number;
  unit: string;
  observedAtMs: number;
  nonce: string;
  signatureBase64: string;
}

export type SubmissionRejectionCode =
  | "MALFORMED_PAYLOAD"
  | "UNKNOWN_PROVIDER"
  | "UNSUPPORTED_COVERAGE_OR_UNIT"
  | "VALUE_OUT_OF_BOUNDS"
  | "STALE_OR_FUTURE_TIMESTAMP"
  | "REPLAYED_NONCE"
  | "RATE_LIMIT_EXCEEDED"
  | "INVALID_SIGNATURE";

export interface VerifiedProviderReading {
  submissionId: string;
  providerId: string;
  coverageType: string;
  value: number;
  unit: string;
  observedAtMs: number;
  receivedAtMs: number;
  nonce: string;
  canonicalPayload: string;
}

export interface SubmissionVerificationResult {
  accepted: boolean;
  statusCode: 201 | 400 | 401 | 403 | 409 | 422 | 429;
  errorCode?: SubmissionRejectionCode;
  message?: string;
  record?: VerifiedProviderReading;
}

export function serializeCanonicalSubmissionPayload(
  payload: Omit<SignedSubmissionPayload, "signatureBase64">
): string {
  const fixedValue = Number(payload.value).toFixed(6);
  return JSON.stringify({
    coverage_type: payload.coverageType,
    nonce: payload.nonce,
    observed_at: payload.observedAtMs,
    provider_id: payload.providerId,
    unit: payload.unit,
    value: fixedValue,
  });
}

export class SignedProviderSubmissionService {
  private readonly providers = new Map<string, RegisteredDataProvider>();
  private readonly coverageSpecs = new Map<string, CoverageSubmissionSpec>();
  private readonly nonceStore = new Map<string, number>();
  private readonly rateBuckets = new Map<string, number[]>();
  private readonly acceptedReadings: VerifiedProviderReading[] = [];
  private readonly nonceTtlMs: number;
  private readonly maxFutureSkewMs: number;
  private seq = 0;

  constructor(options?: {
    providers?: RegisteredDataProvider[];
    coverageSpecs?: CoverageSubmissionSpec[];
    nonceTtlMs?: number;
    maxFutureSkewMs?: number;
  }) {
    this.nonceTtlMs = options?.nonceTtlMs ?? 15 * 60 * 1_000;
    this.maxFutureSkewMs = options?.maxFutureSkewMs ?? 5_000;

    for (const p of options?.providers ?? []) {
      this.providers.set(p.providerId, p);
    }
    for (const c of options?.coverageSpecs ?? []) {
      this.coverageSpecs.set(c.coverageType, c);
    }
  }

  public registerProvider(provider: RegisteredDataProvider): void {
    this.providers.set(provider.providerId, provider);
  }

  public registerCoverageSpec(spec: CoverageSubmissionSpec): void {
    this.coverageSpecs.set(spec.coverageType, spec);
  }

  public ingestSignedSubmission(
    payload: SignedSubmissionPayload,
    nowMs: number = Date.now()
  ): SubmissionVerificationResult {
    if (
      !payload ||
      typeof payload.providerId !== "string" ||
      typeof payload.coverageType !== "string" ||
      typeof payload.unit !== "string" ||
      typeof payload.nonce !== "string" ||
      payload.nonce.trim().length < 4 ||
      typeof payload.signatureBase64 !== "string" ||
      typeof payload.value !== "number" ||
      !Number.isFinite(payload.value) ||
      typeof payload.observedAtMs !== "number" ||
      !Number.isFinite(payload.observedAtMs)
    ) {
      return {
        accepted: false,
        statusCode: 400,
        errorCode: "MALFORMED_PAYLOAD",
        message: "Submission payload failed schema validation",
      };
    }

    const provider = this.providers.get(payload.providerId);
    if (!provider || !provider.enabled) {
      return {
        accepted: false,
        statusCode: 403,
        errorCode: "UNKNOWN_PROVIDER",
        message: "Provider is unknown or disabled",
      };
    }

    const maxPerMin = provider.maxSubmissionsPerMinute ?? 60;
    if (!this.consumeRateLimit(provider.providerId, maxPerMin, nowMs)) {
      return {
        accepted: false,
        statusCode: 429,
        errorCode: "RATE_LIMIT_EXCEEDED",
        message: "Provider submission rate limit exceeded",
      };
    }

    const spec = this.coverageSpecs.get(payload.coverageType);
    if (
      !spec ||
      !provider.allowedCoverageTypes.includes(payload.coverageType) ||
      spec.expectedUnit !== payload.unit
    ) {
      return {
        accepted: false,
        statusCode: 422,
        errorCode: "UNSUPPORTED_COVERAGE_OR_UNIT",
        message: "Coverage type or unit is not supported for this provider",
      };
    }

    if (payload.value < spec.minValue || payload.value > spec.maxValue) {
      return {
        accepted: false,
        statusCode: 422,
        errorCode: "VALUE_OUT_OF_BOUNDS",
        message: `Value ${payload.value} is outside bounds [${spec.minValue}, ${spec.maxValue}]`,
      };
    }

    const ageMs = nowMs - payload.observedAtMs;
    if (ageMs > spec.maxAgeMs || ageMs < -this.maxFutureSkewMs) {
      return {
        accepted: false,
        statusCode: 422,
        errorCode: "STALE_OR_FUTURE_TIMESTAMP",
        message: "Reading observed_at timestamp is stale or future-dated",
      };
    }

    this.evictExpiredNonces(nowMs);
    const nonceKey = `${provider.providerId}:${payload.nonce}`;
    if (this.nonceStore.has(nonceKey)) {
      return {
        accepted: false,
        statusCode: 409,
        errorCode: "REPLAYED_NONCE",
        message: "Duplicate nonce detected within replay window",
      };
    }

    const canonicalPayload = serializeCanonicalSubmissionPayload(payload);
    const sigValid = this.verifyDetachedSignature(
      canonicalPayload,
      payload.signatureBase64,
      provider.publicKeyPem
    );

    if (!sigValid) {
      return {
        accepted: false,
        statusCode: 401,
        errorCode: "INVALID_SIGNATURE",
        message: "Detached cryptographic signature verification failed",
      };
    }

    this.nonceStore.set(nonceKey, nowMs + this.nonceTtlMs);
    this.seq += 1;
    const record: VerifiedProviderReading = {
      submissionId: `sub-${this.seq}`,
      providerId: payload.providerId,
      coverageType: payload.coverageType,
      value: payload.value,
      unit: payload.unit,
      observedAtMs: payload.observedAtMs,
      receivedAtMs: nowMs,
      nonce: payload.nonce,
      canonicalPayload,
    };
    this.acceptedReadings.push(record);

    return {
      accepted: true,
      statusCode: 201,
      record,
    };
  }

  public getAcceptedReadingsForCoverage(
    coverageType: string
  ): VerifiedProviderReading[] {
    return this.acceptedReadings.filter((r) => r.coverageType === coverageType);
  }

  private verifyDetachedSignature(
    canonicalPayload: string,
    signatureBase64: string,
    publicKeyPem: string
  ): boolean {
    try {
      const pubKey = createPublicKey(publicKeyPem);
      const sigBuf = Buffer.from(signatureBase64, "base64");
      return verify(
        null,
        Buffer.from(canonicalPayload, "utf8"),
        pubKey,
        sigBuf
      );
    } catch {
      return false;
    }
  }

  private evictExpiredNonces(nowMs: number): void {
    for (const [key, expiresAt] of this.nonceStore.entries()) {
      if (expiresAt <= nowMs) {
        this.nonceStore.delete(key);
      }
    }
  }

  private consumeRateLimit(
    providerId: string,
    maxPerMin: number,
    nowMs: number
  ): boolean {
    const windowStart = nowMs - 60_000;
    const active = (this.rateBuckets.get(providerId) ?? []).filter(
      (ts) => ts > windowStart
    );
    if (active.length >= maxPerMin) {
      this.rateBuckets.set(providerId, active);
      return false;
    }
    active.push(nowMs);
    this.rateBuckets.set(providerId, active);
    return true;
  }
}
