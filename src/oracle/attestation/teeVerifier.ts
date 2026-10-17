/**
 * TEE-Attested Provider Readings Verifier for Hardware-Backed Data Provenance (Issue #293)
 *
 * Verifies hardware enclave attestation quotes (AWS Nitro, Intel SGX, AMD SEV-SNP)
 * against pinned vendor roots, allowlisted enclave measurements, anti-replay nonces,
 * and canonical reading payload hashes. Prevents silent downgrade to unattested tier.
 */

import { createHash } from "node:crypto";

export type TeeType = "aws_nitro" | "intel_sgx" | "amd_sev_snp";

export type AttestationTier =
  | "tee_hardware_attested"
  | "unattested_base"
  | "attestation_failed";

export type AttestationFailureReason =
  | "attestation_downgrade_attempt"
  | "oversized_quote"
  | "untrusted_vendor_root"
  | "invalid_quote_signature"
  | "quote_expired_or_not_yet_valid"
  | "nonce_replayed"
  | "nonce_mismatch"
  | "payload_hash_mismatch"
  | "unknown_enclave_measurement";

export interface TeeAttestationBundle {
  teeType: TeeType;
  vendorRootId: string;
  enclaveMeasurement: string;
  nonce: string;
  payloadHash: string;
  issuedAtMs: number;
  expiresAtMs: number;
  /** Cryptographic quote signature / token bound to vendorRootId + enclaveMeasurement + nonce + payloadHash */
  quote: string;
}

export interface ProviderReadingSubmission {
  providerId: string;
  feedId: string;
  valueScaled: bigint;
  observedAtMs: number;
  /** Expected challenge nonce issued by backend for attested requests */
  expectedNonce?: string;
  /** True when the provider/source is configured or declared as sending an attested payload */
  claimsAttestation?: boolean;
  attestation?: Partial<TeeAttestationBundle>;
}

export interface TeeVerifierPolicyConfig {
  policyVersion: number;
  maxQuoteBytes: number;
  maxClockSkewMs: number;
  /** Consensus weight multiplier in basis points for tee_hardware_attested readings (e.g. 15000 = 1.5x) */
  attestedWeightMultiplierBps: number;
  /** Base weight multiplier in basis points for unattested readings (10000 = 1.0x) */
  unattestedWeightMultiplierBps: number;
  maxTrackedNonces: number;
}

export const DEFAULT_TEE_VERIFIER_POLICY: TeeVerifierPolicyConfig = {
  policyVersion: 1,
  maxQuoteBytes: 16_384,
  maxClockSkewMs: 30_000,
  attestedWeightMultiplierBps: 15_000,
  unattestedWeightMultiplierBps: 10_000,
  maxTrackedNonces: 5_000,
};

export interface AttestationVerificationOutcome {
  acceptedForConsensus: boolean;
  tier: AttestationTier;
  weightMultiplierBps: number;
  policyVersion: number;
  canonicalPayloadHash: string;
  failureReason?: AttestationFailureReason;
  evidenceDetail: string;
}

export function computeCanonicalReadingPayloadHash(submission: {
  providerId: string;
  feedId: string;
  valueScaled: bigint;
  observedAtMs: number;
}): string {
  const canonical = JSON.stringify({
    providerId: submission.providerId,
    feedId: submission.feedId,
    valueScaled: submission.valueScaled.toString(),
    observedAtMs: submission.observedAtMs,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function computeExpectedQuoteSignature(params: {
  teeType: TeeType;
  vendorRootSecret: string;
  enclaveMeasurement: string;
  nonce: string;
  payloadHash: string;
  issuedAtMs: number;
  expiresAtMs: number;
}): string {
  return createHash("sha256")
    .update(
      `tee_quote:${params.teeType}:${params.vendorRootSecret}:${params.enclaveMeasurement}:${params.nonce}:${params.payloadHash}:${params.issuedAtMs}:${params.expiresAtMs}`
    )
    .digest("hex");
}

export class TeeAttestationVerifier {
  private readonly policy: TeeVerifierPolicyConfig;
  private readonly pinnedVendorRoots = new Map<string, { teeType: TeeType; rootSecret: string }>();
  private readonly allowlistedMeasurements = new Map<string, Set<string>>();
  private readonly consumedNonces = new Set<string>();
  private readonly nonceQueue: string[] = [];

  constructor(policy: Partial<TeeVerifierPolicyConfig> = {}) {
    this.policy = {
      ...DEFAULT_TEE_VERIFIER_POLICY,
      ...policy,
    };
  }

  /**
   * Pins a trusted hardware vendor root certificate/key for a given TEE type.
   */
  pinVendorRoot(vendorRootId: string, teeType: TeeType, rootSecret: string): void {
    this.pinnedVendorRoots.set(vendorRootId, { teeType, rootSecret });
  }

  /**
   * Admin path to allowlist or rotate enclave measurements (PCR0 / MRENCLAVE / Launch Digest)
   * for a provider without requiring a code change.
   */
  allowlistEnclaveMeasurement(providerId: string, measurement: string): void {
    const set = this.allowlistedMeasurements.get(providerId) ?? new Set<string>();
    set.add(measurement);
    this.allowlistedMeasurements.set(providerId, set);
  }

  revokeEnclaveMeasurement(providerId: string, measurement: string): void {
    this.allowlistedMeasurements.get(providerId)?.delete(measurement);
  }

  /**
   * Verifies a provider reading submission and assigns its attestation tier and consensus weight.
   * Never silently downgrades a failed or partial attestation to `unattested_base`.
   */
  verifySubmission(
    submission: ProviderReadingSubmission,
    nowMs: number
  ): AttestationVerificationOutcome {
    const canonicalPayloadHash = computeCanonicalReadingPayloadHash(submission);

    // 1. Check if submission is genuinely unattested
    if (!submission.attestation && !submission.claimsAttestation) {
      return {
        acceptedForConsensus: true,
        tier: "unattested_base",
        weightMultiplierBps: this.policy.unattestedWeightMultiplierBps,
        policyVersion: this.policy.policyVersion,
        canonicalPayloadHash,
        evidenceDetail: "Unattested submission accepted at base tier",
      };
    }

    // 2. Guard against downgrade-shaped payloads claiming attestation without a complete quote bundle
    const att = submission.attestation;
    if (
      !att ||
      !att.teeType ||
      !att.vendorRootId ||
      !att.enclaveMeasurement ||
      !att.nonce ||
      !att.payloadHash ||
      !att.quote ||
      typeof att.issuedAtMs !== "number" ||
      typeof att.expiresAtMs !== "number"
    ) {
      return this.failAttestation(
        canonicalPayloadHash,
        "attestation_downgrade_attempt",
        "Submission claimed TEE attestation or included partial fields without a complete quote bundle"
      );
    }

    // 3. Guard against oversized quotes
    if (Buffer.byteLength(att.quote, "utf8") > this.policy.maxQuoteBytes) {
      return this.failAttestation(
        canonicalPayloadHash,
        "oversized_quote",
        `TEE quote size exceeds maxQuoteBytes (${this.policy.maxQuoteBytes})`
      );
    }

    // 4. Verify pinned vendor root
    const vendorRoot = this.pinnedVendorRoots.get(att.vendorRootId);
    if (!vendorRoot || vendorRoot.teeType !== att.teeType) {
      return this.failAttestation(
        canonicalPayloadHash,
        "untrusted_vendor_root",
        `Untrusted or mismatched vendorRootId "${att.vendorRootId}" for TEE type "${att.teeType}"`
      );
    }

    // 5. Verify quote time bounds
    if (
      nowMs + this.policy.maxClockSkewMs < att.issuedAtMs ||
      nowMs - this.policy.maxClockSkewMs > att.expiresAtMs ||
      att.expiresAtMs <= att.issuedAtMs
    ) {
      return this.failAttestation(
        canonicalPayloadHash,
        "quote_expired_or_not_yet_valid",
        `TEE quote validity window [${att.issuedAtMs}, ${att.expiresAtMs}] invalid at nowMs=${nowMs}`
      );
    }

    // 6. Verify nonce binding and anti-replay
    if (submission.expectedNonce && att.nonce !== submission.expectedNonce) {
      return this.failAttestation(
        canonicalPayloadHash,
        "nonce_mismatch",
        `Attestation nonce "${att.nonce}" does not match expected challenge nonce`
      );
    }
    const nonceKey = `${submission.providerId}:${att.nonce}`;
    if (this.consumedNonces.has(nonceKey)) {
      return this.failAttestation(
        canonicalPayloadHash,
        "nonce_replayed",
        `Replayed attestation nonce "${att.nonce}" from provider "${submission.providerId}"`
      );
    }

    // 7. Verify canonical payload hash matches attested payloadHash
    if (att.payloadHash !== canonicalPayloadHash) {
      return this.failAttestation(
        canonicalPayloadHash,
        "payload_hash_mismatch",
        `Attested payloadHash "${att.payloadHash}" does not match canonical reading hash "${canonicalPayloadHash}"`
      );
    }

    // 8. Verify enclave measurement against allowlist
    const allowlisted = this.allowlistedMeasurements.get(submission.providerId);
    if (!allowlisted || !allowlisted.has(att.enclaveMeasurement)) {
      return this.failAttestation(
        canonicalPayloadHash,
        "unknown_enclave_measurement",
        `Enclave measurement "${att.enclaveMeasurement}" is not allowlisted for provider "${submission.providerId}"`
      );
    }

    // 9. Verify cryptographic quote signature against pinned vendor root
    const expectedSig = computeExpectedQuoteSignature({
      teeType: att.teeType,
      vendorRootSecret: vendorRoot.rootSecret,
      enclaveMeasurement: att.enclaveMeasurement,
      nonce: att.nonce,
      payloadHash: att.payloadHash,
      issuedAtMs: att.issuedAtMs,
      expiresAtMs: att.expiresAtMs,
    });
    if (att.quote !== expectedSig) {
      return this.failAttestation(
        canonicalPayloadHash,
        "invalid_quote_signature",
        "TEE quote cryptographic verification failed against pinned vendor root"
      );
    }

    // Record consumed nonce only after full verification
    this.recordNonce(nonceKey);

    return {
      acceptedForConsensus: true,
      tier: "tee_hardware_attested",
      weightMultiplierBps: this.policy.attestedWeightMultiplierBps,
      policyVersion: this.policy.policyVersion,
      canonicalPayloadHash,
      evidenceDetail: `Verified ${att.teeType} quote under root ${att.vendorRootId} (measurement=${att.enclaveMeasurement})`,
    };
  }

  private failAttestation(
    canonicalPayloadHash: string,
    failureReason: AttestationFailureReason,
    evidenceDetail: string
  ): AttestationVerificationOutcome {
    return {
      acceptedForConsensus: false,
      tier: "attestation_failed",
      weightMultiplierBps: 0,
      policyVersion: this.policy.policyVersion,
      canonicalPayloadHash,
      failureReason,
      evidenceDetail,
    };
  }

  private recordNonce(nonceKey: string): void {
    this.consumedNonces.add(nonceKey);
    this.nonceQueue.push(nonceKey);
    while (this.nonceQueue.length > this.policy.maxTrackedNonces) {
      const oldest = this.nonceQueue.shift();
      if (oldest) {
        this.consumedNonces.delete(oldest);
      }
    }
  }
}
