export type Severity = "low" | "medium" | "high" | "triggered";

/**
 * Attestation tier for a reading.
 *
 * - `base`: no hardware attestation was provided (or it was not required).
 * - `attested`: a valid TEE attestation (quote, nonce, payload hash, and
 *   measurement) was verified for this reading.
 *
 * Unattested readings remain valid at the base tier. Consensus may weight
 * attested readings higher, subject to policy.
 */
export type AttestationTier = "base" | "attested";

export interface OracleReading {
  coverageType: string;
  type: "oracle_update";
  value: number;
  threshold: number;
  severity: Severity;
  message: string;
  /**
   * True when this reading came from the fail-safe fallback (upstream outage).
   * OraclePublisherService must never publish degraded readings on-chain.
   */
  degraded?: boolean;
  /**
   * Attestation tier for this reading. Defaults to `"base"` when omitted so
   * unattested readings remain valid. Attested readings are tagged
   * `"attested"` after a TEE quote has been verified against the pinned
   * vendor root, the request nonce, the canonicalized payload hash, and an
   * allowlisted enclave measurement.
   */
  attestationTier?: AttestationTier;
  /**
   * Optional provenance metadata describing the attestation that backs this
   * reading. Present only when `attestationTier === "attested"`. This is
   * surfaced for contract tests and consensus weighting; it must never be
   * used to silently upgrade a reading that failed verification.
   */
  attestation?: OracleReadingAttestation;
}

/**
 * Provenance metadata for an attested reading. Mirrors the verified fields of
 * the provider submission attestation object so consumers (frontend,
 * contracts) can pin the shape.
 */
export interface OracleReadingAttestation {
  /** TEE type that produced the quote, e.g. "aws-nitro" or "sgx". */
  teeType: string;
  /** Enclave measurement that was matched against the allowlist. */
  measurement: string;
  /** Hash of the canonicalized reading that the quote is bound to. */
  payloadHash: string;
  /** Nonce bound to the originating request (replay protection). */
  nonce: string;
  /** Policy version under which the attestation was evaluated. */
  policyVersion: string;
}