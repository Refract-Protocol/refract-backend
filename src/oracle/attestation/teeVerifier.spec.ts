import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TeeAttestationVerifier,
  computeCanonicalReadingPayloadHash,
  computeExpectedQuoteSignature,
  type ProviderReadingSubmission,
} from "./teeVerifier.ts";

test("Issue #293: verifies valid TEE attestation quotes, elevates weight tier, and rejects replayed nonces or tampered payload hashes", () => {
  const now = 1_750_000_000_000;
  const verifier = new TeeAttestationVerifier({
    policyVersion: 3,
    attestedWeightMultiplierBps: 15_000,
    unattestedWeightMultiplierBps: 10_000,
  });

  verifier.pinVendorRoot("aws_nitro_root_2026", "aws_nitro", "nitro_root_secret_key");
  verifier.allowlistEnclaveMeasurement("nexus_provider", "pcr0:99aa88bb77cc");

  // 1. Genuinely unattested submission -> unattested_base at 10,000 bps
  const unattested = verifier.verifySubmission(
    {
      providerId: "coingecko",
      feedId: "StablecoinDepeg",
      valueScaled: 100n,
      observedAtMs: now,
    },
    now
  );
  assert.equal(unattested.acceptedForConsensus, true);
  assert.equal(unattested.tier, "unattested_base");
  assert.equal(unattested.weightMultiplierBps, 10_000);

  // 2. Valid AWS Nitro attested submission -> tee_hardware_attested at 15,000 bps
  const baseSub = {
    providerId: "nexus_provider",
    feedId: "LiquidationShield",
    valueScaled: 7_500n,
    observedAtMs: now,
  };
  const payloadHash = computeCanonicalReadingPayloadHash(baseSub);
  const quote = computeExpectedQuoteSignature({
    teeType: "aws_nitro",
    vendorRootSecret: "nitro_root_secret_key",
    enclaveMeasurement: "pcr0:99aa88bb77cc",
    nonce: "nonce_001",
    payloadHash,
    issuedAtMs: now - 5_000,
    expiresAtMs: now + 60_000,
  });

  const validAttested: ProviderReadingSubmission = {
    ...baseSub,
    expectedNonce: "nonce_001",
    claimsAttestation: true,
    attestation: {
      teeType: "aws_nitro",
      vendorRootId: "aws_nitro_root_2026",
      enclaveMeasurement: "pcr0:99aa88bb77cc",
      nonce: "nonce_001",
      payloadHash,
      issuedAtMs: now - 5_000,
      expiresAtMs: now + 60_000,
      quote,
    },
  };

  const verified = verifier.verifySubmission(validAttested, now);
  assert.equal(verified.acceptedForConsensus, true);
  assert.equal(verified.tier, "tee_hardware_attested");
  assert.equal(verified.weightMultiplierBps, 15_000);
  assert.equal(verified.policyVersion, 3);

  // 3. Replayed nonce is rejected
  const replayed = verifier.verifySubmission(validAttested, now + 1_000);
  assert.equal(replayed.acceptedForConsensus, false);
  assert.equal(replayed.tier, "attestation_failed");
  assert.equal(replayed.failureReason, "nonce_replayed");

  // 4. Tampered reading value (payloadHash mismatch) is rejected
  const tampered = verifier.verifySubmission(
    {
      ...validAttested,
      valueScaled: 9_999n,
      expectedNonce: "nonce_002",
      attestation: {
        ...validAttested.attestation!,
        nonce: "nonce_002",
      },
    },
    now + 1_000
  );
  assert.equal(tampered.acceptedForConsensus, false);
  assert.equal(tampered.failureReason, "payload_hash_mismatch");
});

test("Issue #293: rejects unknown enclave measurements, supports admin measurement rotation, and prevents downgrade attacks", () => {
  const now = 1_750_000_000_000;
  const verifier = new TeeAttestationVerifier();
  verifier.pinVendorRoot("sgx_root_v1", "intel_sgx", "sgx_secret");

  // Downgrade-shaped payload claiming attestation without a quote is rejected, never silently downgraded
  const downgradeAttempt = verifier.verifySubmission(
    {
      providerId: "sgx_provider",
      feedId: "MarketCrash",
      valueScaled: 500n,
      observedAtMs: now,
      claimsAttestation: true,
      attestation: {
        teeType: "intel_sgx",
      },
    },
    now
  );
  assert.equal(downgradeAttempt.acceptedForConsensus, false);
  assert.equal(downgradeAttempt.tier, "attestation_failed");
  assert.equal(downgradeAttempt.failureReason, "attestation_downgrade_attempt");

  // Unknown enclave measurement is rejected until allowlisted by admin
  const baseSub = {
    providerId: "sgx_provider",
    feedId: "MarketCrash",
    valueScaled: 500n,
    observedAtMs: now,
  };
  const payloadHash = computeCanonicalReadingPayloadHash(baseSub);
  const newMeasurement = "mrenclave:v2_upgraded_binary";
  const quote = computeExpectedQuoteSignature({
    teeType: "intel_sgx",
    vendorRootSecret: "sgx_secret",
    enclaveMeasurement: newMeasurement,
    nonce: "nonce_sgx_1",
    payloadHash,
    issuedAtMs: now - 1_000,
    expiresAtMs: now + 60_000,
  });

  const subWithNewMeasurement: ProviderReadingSubmission = {
    ...baseSub,
    attestation: {
      teeType: "intel_sgx",
      vendorRootId: "sgx_root_v1",
      enclaveMeasurement: newMeasurement,
      nonce: "nonce_sgx_1",
      payloadHash,
      issuedAtMs: now - 1_000,
      expiresAtMs: now + 60_000,
      quote,
    },
  };

  const beforeAllowlist = verifier.verifySubmission(subWithNewMeasurement, now);
  assert.equal(beforeAllowlist.acceptedForConsensus, false);
  assert.equal(beforeAllowlist.failureReason, "unknown_enclave_measurement");

  // Admin rotates measurement allowlist -> now accepted
  verifier.allowlistEnclaveMeasurement("sgx_provider", newMeasurement);
  const afterAllowlist = verifier.verifySubmission(subWithNewMeasurement, now);
  assert.equal(afterAllowlist.acceptedForConsensus, true);
  assert.equal(afterAllowlist.tier, "tee_hardware_attested");
});
