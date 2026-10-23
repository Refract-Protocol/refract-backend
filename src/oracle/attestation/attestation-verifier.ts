/**
 * TEE attestation verifier module.
 *
 * Provides a pluggable, independently testable verification step for hardware
 * attestations (e.g. AWS Nitro Enclave, Intel SGX) bound to a provider reading.
 *
 * Verification checks, in order:
 *   1. Structural validation of the attestation object (never silently downgrade).
 *   2. Quote size limits (oversized quotes are rejected).
 *   3. Quote signature validated against a pinned vendor root.
 *   4. Quote validity window (clock-dependent).
 *   5. Nonce binding to the request (replay protection).
 *   6. Payload hash matched against the canonicalized reading.
 *   7. Measurement compared against the allowlisted set.
 *
 * The result is a structured object carrying the attestation tier and, on
 * failure, a specific failure reason. A failed attestation is NEVER reported as
 * "unsigned ok" — it is reported as a failure with evidence.
 */

import { createHash, timingSafeEqual } from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TeeType = 'aws-nitro' | 'sgx';

export const SUPPORTED_TEE_TYPES: readonly TeeType[] = ['aws-nitro', 'sgx'] as const;

/**
 * Attestation tier assigned to a reading.
 *   - `attested`: hardware attestation verified successfully.
 *   - `base`: no attestation supplied; reading remains valid at the base tier.
 *   - `failed`: attestation was supplied but failed verification. This is NOT
 *     equivalent to `base` — it is recorded as evidence and must not be
 *     silently downgraded to "unsigned ok".
 */
export type AttestationTier = 'attested' | 'base' | 'failed';

/** The optional attestation object attached to a provider submission. */
export interface AttestationSubmission {
  /** TEE type that produced the quote. */
  teeType: TeeType;
  /** Base64 (or hex) encoded hardware quote. */
  quote: string;
  /** Nonce bound to the request; must match the expected request nonce. */
  nonce: string;
  /** Hash of the canonicalized reading, as claimed by the provider. */
  payloadHash: string;
}

/** Context required to verify an attestation against a request. */
export interface AttestationVerificationContext {
  /** Nonce that was issued for this request. */
  expectedNonce: string;
  /** The raw reading payload that was submitted (pre-canonicalization). */
  reading: unknown;
  /** Canonicalization function; must be deterministic. */
  canonicalize: (reading: unknown) => string;
  /** Hash algorithm used for payload hashing. Defaults to sha256. */
  hashAlgorithm?: 'sha256' | 'sha384' | 'sha512';
  /** Current time (ms since epoch). Injectable for clock-dependent tests. */
  now?: number;
  /** Maximum allowed quote size in bytes. Defaults to 64 KiB. */
  maxQuoteBytes?: number;
}

/** Specific failure reasons. Each maps to a distinct piece of evidence. */
export type AttestationFailureReason =
  | 'missing-quote'
  | 'unsupported-tee-type'
  | 'malformed-quote'
  | 'oversized-quote'
  | 'invalid-quote-signature'
  | 'quote-not-yet-valid'
  | 'quote-expired'
  | 'vendor-root-unavailable'
  | 'crl-unavailable'
  | 'nonce-mismatch'
  | 'nonce-replayed'
  | 'payload-hash-mismatch'
  | 'unknown-measurement'
  | 'verifier-error';

/** Structured verification result. */
export interface AttestationVerificationResult {
  /** Tier to persist / emit in metrics / feed to consensus weighting. */
  tier: AttestationTier;
  /** True only when tier === 'attested'. */
  attested: boolean;
  /** Specific failure reason when tier === 'failed'. */
  failureReason?: AttestationFailureReason;
  /** Human-readable detail for evidence / logs. */
  detail?: string;
  /** Measurement extracted from the quote, when available. */
  measurement?: string;
  /** TEE type that was verified, when available. */
  teeType?: TeeType;
  /** Policy version recorded with the decision. */
  policyVersion: string;
}

/** Pinned vendor root material for a TEE type. */
export interface VendorRoot {
  /** Identifier of the pinned root (e.g. certificate fingerprint). */
  id: string;
  /** PEM-encoded root certificate or public key. */
  pem: string;
}

/** Allowlisted enclave measurements for a TEE type. */
export interface MeasurementAllowlist {
  /** Set of allowed measurement values (hex, lowercase). */
  allowed: ReadonlySet<string>;
}

/** Parsed quote contents produced by a verifier. */
export interface ParsedQuote {
  /** Measurement (e.g. PCRs / enclave image hash), lowercase hex. */
  measurement: string;
  /** Nonce embedded in the quote, if present. */
  nonce?: string;
  /** Payload hash embedded in the quote, if present. */
  payloadHash?: string;
  /** Quote validity start (ms since epoch), if present. */
  notBefore?: number;
  /** Quote validity end (ms since epoch), if present. */
  notAfter?: number;
}

/** Pluggable verifier for a single TEE type. */
export interface TeeVerifier {
  readonly teeType: TeeType;
  /**
   * Parse the raw quote into structured contents. Throws on malformed input.
   * Implementations must be pure and independently testable.
   */
  parseQuote(rawQuote: Buffer): ParsedQuote;
  /**
   * Validate the quote signature against the pinned vendor root.
   * Returns true when the signature is valid.
   */
  verifySignature(rawQuote: Buffer, root: VendorRoot): boolean;
}

/** Dependencies injected into the verifier module. */
export interface AttestationVerifierDeps {
  /** Pinned vendor roots keyed by TEE type. */
  vendorRoots: Partial<Record<TeeType, VendorRoot>>;
  /** Measurement allowlists keyed by TEE type. */
  measurementAllowlists: Partial<Record<TeeType, MeasurementAllowlist>>;
  /** Pluggable per-TEE verifiers. */
  verifiers: Partial<Record<TeeType, TeeVerifier>>;
  /** Optional CRL availability probe; returns true when CRL is reachable. */
  isCrlAvailable?: (teeType: TeeType) => boolean | Promise<boolean>;
  /** Optional nonce replay store. Returns true if the nonce was already used. */
  isNonceReplayed?: (nonce: string) => boolean | Promise<boolean>;
  /** Policy version recorded with every decision. */
  policyVersion?: string;
  /** Default max quote size in bytes. */
  defaultMaxQuoteBytes?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_QUOTE_BYTES = 64 * 1024; // 64 KiB
const DEFAULT_POLICY_VERSION = 'attestation-policy-v1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSupportedTeeType(value: unknown): value is TeeType {
  return typeof value === 'string' && (SUPPORTED_TEE_TYPES as readonly string[]).includes(value);
}

function decodeQuote(quote: string): Buffer {
  // Accept hex or base64. Hex is detected by an even-length all-hex string.
  const trimmed = quote.trim();
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    return Buffer.from(trimmed, 'hex');
  }
  return Buffer.from(trimmed, 'base64');
}

function hashPayload(
  reading: unknown,
  canonicalize: (reading: unknown) => string,
  algorithm: 'sha256' | 'sha384' | 'sha512',
): string {
  const canonical = canonicalize(reading);
  return createHash(algorithm).update(canonical, 'utf8').digest('hex');
}

function constantTimeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a.toLowerCase(), 'utf8');
  const bufB = Buffer.from(b.toLowerCase(), 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function failure(
  reason: AttestationFailureReason,
  detail: string,
  policyVersion: string,
  extra?: Partial<AttestationVerificationResult>,
): AttestationVerificationResult {
  return {
    tier: 'failed',
    attested: false,
    failureReason: reason,
    detail,
    policyVersion,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Core verification
// ---------------------------------------------------------------------------

/**
 * Verify a provider submission's attestation.
 *
 * Returns a structured result. When no attestation is supplied the reading is
 * valid at the `base` tier. When an attestation is supplied but fails any check
 * the result is `failed` with a specific reason — it is never downgraded to
 * "unsigned ok".
 */
export async function verifyAttestation(
  submission: AttestationSubmission | undefined | null,
  context: AttestationVerificationContext,
  deps: AttestationVerifierDeps,
): Promise<AttestationVerificationResult> {
  const policyVersion = deps.policyVersion ?? DEFAULT_POLICY_VERSION;
  const maxQuoteBytes = context.maxQuoteBytes ?? deps.defaultMaxQuoteBytes ?? DEFAULT_MAX_QUOTE_BYTES;
  const now = context.now ?? Date.now();
  const hashAlgorithm = context.hashAlgorithm ?? 'sha256';

  // No attestation supplied: valid at base tier.
  if (submission === undefined || submission === null) {
    return {
      tier: 'base',
      attested: false,
      policyVersion,
    };
  }

  // --- Structural validation (never silently downgrade) -------------------
  if (typeof submission !== 'object') {
    return failure('malformed-quote', 'attestation object is not an object', policyVersion);
  }

  if (!isSupportedTeeType(submission.teeType)) {
    return failure(
      'unsupported-tee-type',
      `unsupported tee type: ${String(submission.teeType)}`,
      policyVersion,
    );
  }
  const teeType = submission.teeType;

  if (typeof submission.quote !== 'string' || submission.quote.trim().length === 0) {
    return failure(
      'missing-quote',
      'attestation claims a TEE type but supplies no quote',
      policyVersion,
      { teeType },
    );
  }

  if (typeof submission.nonce !== 'string' || submission.nonce.length === 0) {
    return failure('nonce-mismatch', 'attestation is missing a nonce', policyVersion, { teeType });
  }

  if (typeof submission.payloadHash !== 'string' || submission.payloadHash.length === 0) {
    return failure(
      'payload-hash-mismatch',
      'attestation is missing a payload hash',
      policyVersion,
      { teeType },
    );
  }

  // --- Decode & size check ------------------------------------------------
  let rawQuote: Buffer;
  try {
    rawQuote = decodeQuote(submission.quote);
  } catch (err) {
    return failure(
      'malformed-quote',
      `failed to decode quote: ${(err as Error).message}`,
      policyVersion,
      { teeType },
    );
  }

  if (rawQuote.length === 0) {
    return failure('malformed-quote', 'decoded quote is empty', policyVersion, { teeType });
  }

  if (rawQuote.length > maxQuoteBytes) {
    return failure(
      'oversized-quote',
      `quote size ${rawQuote.length} exceeds limit ${maxQuoteBytes}`,
      policyVersion,
      { teeType },
    );
  }

  // --- Resolve verifier & pinned root -------------------------------------
  const verifier = deps.verifiers[teeType];
  if (!verifier) {
    return failure(
      'unsupported-tee-type',
      `no verifier registered for tee type: ${teeType}`,
      policyVersion,
      { teeType },
    );
  }

  const root = deps.vendorRoots[teeType];
  if (!root || !root.pem) {
    return failure(
      'vendor-root-unavailable',
      `no pinned vendor root configured for tee type: ${teeType}`,
      policyVersion,
      { teeType },
    );
  }

  // --- CRL availability (fail closed, do not downgrade) -------------------
  if (deps.isCrlAvailable) {
    let crlAvailable: boolean;
    try {
      crlAvailable = await deps.isCrlAvailable(teeType);
    } catch (err) {
      return failure(
        'crl-unavailable',
        `CRL availability probe failed: ${(err as Error).message}`,
        policyVersion,
        { teeType },
      );
    }
    if (!crlAvailable) {
      return failure(
        'crl-unavailable',
        `vendor CRL endpoint unavailable for tee type: ${teeType}`,
        policyVersion,
        { teeType },
      );
    }
  }

  // --- Parse quote --------------------------------------------------------
  let parsed: ParsedQuote;
  try {
    parsed = verifier.parseQuote(rawQuote);
  } catch (err) {
    return failure(
      'malformed-quote',
      `failed to parse quote: ${(err as Error).message}`,
      policyVersion,
      { teeType },
    );
  }

  if (!parsed || typeof parsed.measurement !== 'string' || parsed.measurement.length === 0) {
    return failure(
      'malformed-quote',
      'quote did not contain a measurement',
      policyVersion,
      { teeType },
    );
  }

  const measurement = parsed.measurement.toLowerCase();

  // --- Signature against pinned vendor root -------------------------------
  let signatureValid: boolean;
  try {
    signatureValid = verifier.verifySignature(rawQuote, root);
  } catch (err) {
    return failure(
      'verifier-error',
      `signature verification threw: ${(err as Error).message}`,
      policyVersion,
      { teeType, measurement },
    );
  }
  if (!signatureValid) {
    return failure(
      'invalid-quote-signature',
      `quote signature did not validate against pinned root ${root.id}`,
      policyVersion,
      { teeType, measurement },
    );
  }

  // --- Clock-dependent validity -------------------------------------------
  if (typeof parsed.notBefore === 'number' && now < parsed.notBefore) {
    return failure(
      'quote-not-yet-valid',
      `quote not valid until ${new Date(parsed.notBefore).toISOString()}`,
      policyVersion,
      { teeType, measurement },
    );
  }
  if (typeof parsed.notAfter === 'number' && now > parsed.notAfter) {
    return failure(
      'quote-expired',
      `quote expired at ${new Date(parsed.notAfter).toISOString()}`,
      policyVersion,
      { teeType, measurement },
    );
  }

  // --- Nonce binding & replay protection ----------------------------------
  if (!constantTimeEqualHex(parsed.nonce ?? submission.nonce, context.expectedNonce)) {
    return failure(
      'nonce-mismatch',
      'attestation nonce does not match the request nonce',
      policyVersion,
      { teeType, measurement },
    );
  }

  if (deps.isNonceReplayed) {
    let replayed: boolean;
    try {
      replayed = await deps.isNonceReplayed(context.expectedNonce);
    } catch (err) {
      return failure(
        'verifier-error',
        `nonce replay check failed: ${(err as Error).message}`,
        policyVersion,
        { teeType, measurement },
      );
    }
    if (replayed) {
      return failure(
        'nonce-replayed',
        'attestation nonce has already been used',
        policyVersion,
        { teeType, measurement },
      );
    }
  }

  // --- Payload hash against canonicalized reading -------------------------
  const expectedPayloadHash = hashPayload(context.reading, context.canonicalize, hashAlgorithm);
  const claimedPayloadHash = (parsed.payloadHash ?? submission.payloadHash).toLowerCase();
  if (!constantTimeEqualHex(claimedPayloadHash, expectedPayloadHash)) {
    return failure(
      'payload-hash-mismatch',
      'attestation payload hash does not match the canonicalized reading',
      policyVersion,
      { teeType, measurement },
    );
  }

  // --- Measurement allowlist ----------------------------------------------
  const allowlist = deps.measurementAllowlists[teeType];
  if (!allowlist || allowlist.allowed.size === 0) {
    return failure(
      'unknown-measurement',
      `no measurement allowlist configured for tee type: ${teeType}`,
      policyVersion,
      { teeType, measurement },
    );
  }
  if (!allowlist.allowed.has(measurement)) {
    return failure(
      'unknown-measurement',
      `measurement ${measurement} is not in the allowlist`,
      policyVersion,
      { teeType, measurement },
    );
  }

  // --- Success ------------------------------------------------------------
  return {
    tier: 'attested',
    attested: true,
    teeType,
    measurement,
    policyVersion,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a bound verifier with injected dependencies. Useful for wiring into
 * the provider submission API and for independent unit testing.
 */
export function createAttestationVerifier(deps: AttestationVerifierDeps) {
  return {
    verify: (
      submission: AttestationSubmission | undefined | null,
      context: AttestationVerificationContext,
    ) => verifyAttestation(submission, context, deps),
  };
}

export type AttestationVerifier = ReturnType<typeof createAttestationVerifier>;