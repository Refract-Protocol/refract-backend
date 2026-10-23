import { createPublicKey, KeyObject, verify } from "node:crypto";
import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { z } from "zod";
import { CoverageTypeName } from "../common/coverage-type.map";
import {
  canonicalizeSubmission,
  DECIMAL_VALUE_PATTERN,
  NONCE_PATTERN,
  OBSERVATION_RULES,
  OBSERVED_AT_PATTERN,
} from "./submission-canonical";

/** Oldest `observed_at` accepted. Also bounds how long a nonce must be remembered. */
export const SUBMISSION_MAX_AGE_MS = 5 * 60_000;
/** How far `observed_at` may sit in the future to absorb provider clock skew. */
export const SUBMISSION_MAX_CLOCK_SKEW_MS = 30_000;
/** Fixed-window budget per provider, counted before signature verification. */
export const PROVIDER_RATE_LIMIT_PER_MINUTE = 60;

/** DER SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type SubmissionErrorCode =
  | "INVALID_SUBMISSION"
  | "UNKNOWN_PROVIDER"
  | "RATE_LIMITED"
  | "INVALID_SIGNATURE"
  | "STALE_OBSERVED_AT"
  | "UNSUPPORTED_COVERAGE_TYPE"
  | "UNIT_MISMATCH"
  | "VALUE_OUT_OF_BOUNDS"
  | "REPLAYED_NONCE";

export interface SubmissionProvider {
  id: string;
  publicKey: KeyObject;
  coverageTypes: ReadonlySet<string>;
}

export interface VerifiedSubmission {
  providerId: string;
  coverageType: CoverageTypeName;
  value: string;
  unit: string;
  observedAt: Date;
  nonce: string;
  signature: string;
}

const COVERAGE_TYPE_KEYS = Object.keys(OBSERVATION_RULES) as [CoverageTypeName, ...CoverageTypeName[]];

/** Wire format of POST /api/v1/oracle/submissions. */
export const submissionBodySchema = z
  .object({
    provider_id: z.string().min(1).max(64),
    coverage_type: z.string().min(1).max(40),
    value: z.string().max(24).regex(DECIMAL_VALUE_PATTERN, "must be a canonical decimal string"),
    unit: z.string().min(1).max(16),
    observed_at: z.string().regex(OBSERVED_AT_PATTERN, "must be an RFC 3339 UTC timestamp ending in Z"),
    nonce: z.string().regex(NONCE_PATTERN, "must be 16-64 base64url characters"),
    signature: z.string().min(1).max(128),
  })
  .strict();

/** Operator-managed provider registry, read from ORACLE_SUBMISSION_PROVIDERS. */
const providerConfigSchema = z.array(
  z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "must be lowercase alphanumeric with hyphens"),
    publicKey: z.string().min(1),
    coverageTypes: z.array(z.enum(COVERAGE_TYPE_KEYS)).min(1),
  }),
);

/**
 * Parses the provider registry. Throws at boot on any malformed entry so a
 * typo fails fast instead of silently rejecting a real provider later.
 */
export function loadSubmissionProviders(
  raw: string | undefined = process.env.ORACLE_SUBMISSION_PROVIDERS,
): Map<string, SubmissionProvider> {
  const providers = new Map<string, SubmissionProvider>();
  if (!raw || raw.trim() === "") {
    return providers;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("ORACLE_SUBMISSION_PROVIDERS must be a JSON array");
  }

  const parsed = providerConfigSchema.safeParse(json);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`ORACLE_SUBMISSION_PROVIDERS is invalid: ${details}`);
  }

  for (const entry of parsed.data) {
    if (providers.has(entry.id)) {
      throw new Error(`ORACLE_SUBMISSION_PROVIDERS contains duplicate provider id "${entry.id}"`);
    }
    const rawKey = Buffer.from(entry.publicKey, "base64");
    if (rawKey.length !== 32) {
      throw new Error(`Provider "${entry.id}" publicKey must be a base64-encoded 32-byte Ed25519 key`);
    }
    providers.set(entry.id, {
      id: entry.id,
      publicKey: createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
        format: "der",
        type: "spki",
      }),
      coverageTypes: new Set(entry.coverageTypes),
    });
  }
  return providers;
}

function reject(status: HttpStatus, code: SubmissionErrorCode, error: string): HttpException {
  return new HttpException({ code, error }, status);
}

/**
 * Verifies a signed third-party submission. Every check runs before the
 * caller writes anything: schema, provider identity, rate budget, signature,
 * freshness, then coverage/unit/bounds. Nonce replay is checked by the
 * repository, atomically with the write.
 */
@Injectable()
export class SubmissionVerifier {
  private readonly providers = loadSubmissionProviders();
  private readonly rateBuckets = new Map<string, { count: number; resetAt: number }>();

  verify(body: unknown, now: number = Date.now()): VerifiedSubmission {
    const parsed = submissionBodySchema.safeParse(body);
    if (!parsed.success) {
      const details = parsed.error.issues.map((i) => `${i.path.join(".") || "body"} ${i.message}`).join("; ");
      throw reject(HttpStatus.BAD_REQUEST, "INVALID_SUBMISSION", `Invalid submission: ${details}`);
    }
    const submission = parsed.data;

    const provider = this.providers.get(submission.provider_id);
    if (!provider) {
      throw reject(HttpStatus.UNAUTHORIZED, "UNKNOWN_PROVIDER", "Provider is not registered");
    }
    this.consumeRateBudget(provider.id, now);

    const canonical = canonicalizeSubmission({
      provider_id: submission.provider_id,
      coverage_type: submission.coverage_type,
      value: submission.value,
      unit: submission.unit,
      observed_at: submission.observed_at,
      nonce: submission.nonce,
    });
    const signature = Buffer.from(submission.signature, "base64");
    if (signature.length !== 64 || !verify(null, Buffer.from(canonical, "utf8"), provider.publicKey, signature)) {
      throw reject(HttpStatus.UNAUTHORIZED, "INVALID_SIGNATURE", "Signature does not verify against the provider key");
    }

    const observedMs = Date.parse(submission.observed_at);
    if (Number.isNaN(observedMs)) {
      throw reject(HttpStatus.BAD_REQUEST, "INVALID_SUBMISSION", "observed_at is not a valid calendar date");
    }
    if (now - observedMs > SUBMISSION_MAX_AGE_MS || observedMs - now > SUBMISSION_MAX_CLOCK_SKEW_MS) {
      throw reject(HttpStatus.UNPROCESSABLE_ENTITY, "STALE_OBSERVED_AT", "observed_at is outside the freshness window");
    }

    const rule = Object.prototype.hasOwnProperty.call(OBSERVATION_RULES, submission.coverage_type)
      ? OBSERVATION_RULES[submission.coverage_type as CoverageTypeName]
      : undefined;
    if (!rule || !provider.coverageTypes.has(submission.coverage_type)) {
      throw reject(
        HttpStatus.UNPROCESSABLE_ENTITY,
        "UNSUPPORTED_COVERAGE_TYPE",
        "Coverage type is not supported for this provider",
      );
    }
    if (submission.unit !== rule.unit) {
      throw reject(HttpStatus.UNPROCESSABLE_ENTITY, "UNIT_MISMATCH", `Unit must be "${rule.unit}"`);
    }
    const numeric = Number(submission.value);
    if (numeric < rule.min || numeric > rule.max) {
      throw reject(
        HttpStatus.UNPROCESSABLE_ENTITY,
        "VALUE_OUT_OF_BOUNDS",
        `Value must be between ${rule.min} and ${rule.max} for this coverage type`,
      );
    }

    return {
      providerId: provider.id,
      coverageType: submission.coverage_type as CoverageTypeName,
      value: submission.value,
      unit: submission.unit,
      observedAt: new Date(observedMs),
      nonce: submission.nonce,
      signature: submission.signature,
    };
  }

  /** Fixed-window per-provider budget. Only registered ids reach this map, so it stays bounded. */
  private consumeRateBudget(providerId: string, now: number): void {
    let bucket = this.rateBuckets.get(providerId);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + 60_000 };
      this.rateBuckets.set(providerId, bucket);
    }
    bucket.count += 1;
    if (bucket.count > PROVIDER_RATE_LIMIT_PER_MINUTE) {
      throw reject(HttpStatus.TOO_MANY_REQUESTS, "RATE_LIMITED", "Provider submission rate limit exceeded");
    }
  }
}
