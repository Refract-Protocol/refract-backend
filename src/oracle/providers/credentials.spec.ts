import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderCredentialManager } from "./credentials.ts";

test("Issue #283: revokes compromised key, rejects future submissions and mid-round inclusion, and generates accurate forensic report", () => {
  const mgr = new ProviderCredentialManager();
  const t0 = 1_750_000_000_000;

  mgr.registerProviderKey({
    providerId: "coingecko",
    keyId: "cg_key_v1",
    publicKeyFingerprint: "ed25519:aa11",
    actorId: "admin_1",
    nowMs: t0,
    sequenceNumber: 1,
  });
  mgr.registerProviderKey({
    providerId: "defillama",
    keyId: "dl_key_v1",
    publicKeyFingerprint: "ed25519:bb22",
    actorId: "admin_1",
    nowMs: t0,
    sequenceNumber: 2,
  });

  mgr.recordReading({
    readingId: "read_cg_10",
    providerId: "coingecko",
    keyId: "cg_key_v1",
    feedId: "StablecoinDepeg",
    sequenceNumber: 10,
    observedAtMs: t0 + 10_000,
  });
  mgr.recordReading({
    readingId: "read_dl_11",
    providerId: "defillama",
    keyId: "dl_key_v1",
    feedId: "StablecoinDepeg",
    sequenceNumber: 11,
    observedAtMs: t0 + 10_000,
  });

  mgr.recordConsensusDecision({
    decisionId: "dec_100",
    feedId: "StablecoinDepeg",
    decidedAtMs: t0 + 15_000,
    sequenceNumber: 12,
    includedReadingIds: ["read_cg_10", "read_dl_11"],
    linkedClaimIds: ["claim_alpha", "claim_beta"],
  });

  // In-flight reading submitted right before revocation
  mgr.recordReading({
    readingId: "read_cg_inflight",
    providerId: "coingecko",
    keyId: "cg_key_v1",
    feedId: "StablecoinDepeg",
    sequenceNumber: 13,
    observedAtMs: t0 + 18_000,
  });

  // Revoke cg_key_v1
  const report = mgr.revokeKeyAndRespond({
    providerId: "coingecko",
    keyId: "cg_key_v1",
    actorId: "sec_ops",
    reason: "Leaked API signing key in upstream CI logs",
    nowMs: t0 + 20_000,
    effectiveFromSequence: 10,
    lookbackWindowMs: 60_000,
  });

  assert.deepEqual(report.quarantinedReadingIds, ["read_cg_10", "read_cg_inflight"]);
  assert.deepEqual(report.affectedDecisionIds, ["dec_100"]);
  assert.deepEqual(report.remediationClaimIds, ["claim_alpha", "claim_beta"]);

  // Future submission with revoked key is rejected at submission boundary
  assert.throws(
    () =>
      mgr.recordReading({
        readingId: "read_cg_after",
        providerId: "coingecko",
        keyId: "cg_key_v1",
        feedId: "StablecoinDepeg",
        sequenceNumber: 14,
        observedAtMs: t0 + 25_000,
      }),
    /key_revoked/
  );

  // Mid-round consensus inclusion of in-flight reading signed by now-revoked key is rejected
  assert.throws(
    () =>
      mgr.recordConsensusDecision({
        decisionId: "dec_101",
        feedId: "StablecoinDepeg",
        decidedAtMs: t0 + 25_000,
        sequenceNumber: 15,
        includedReadingIds: ["read_cg_inflight", "read_dl_11"],
        linkedClaimIds: [],
      }),
    /key_revoked/
  );
});

test("Issue #283: supports overlap-window key rotation and append-only reversal of accidental revocation", () => {
  const mgr = new ProviderCredentialManager();
  const t0 = 1_750_000_000_000;

  mgr.registerProviderKey({
    providerId: "horizon",
    keyId: "hz_v1",
    publicKeyFingerprint: "ed25519:1111",
    actorId: "admin",
    nowMs: t0,
  });

  // Rotate to hz_v2 with 30s overlap window
  mgr.rotateProviderKey({
    providerId: "horizon",
    newKeyId: "hz_v2",
    newPublicKeyFingerprint: "ed25519:2222",
    overlapWindowMs: 30_000,
    actorId: "admin",
    nowMs: t0 + 10_000,
  });

  // Inside overlap window (t0 + 25_000): both hz_v1 and hz_v2 are accepted
  assert.equal(mgr.verifyCredentialAt("horizon", "hz_v1", t0 + 25_000).accepted, true);
  assert.equal(mgr.verifyCredentialAt("horizon", "hz_v2", t0 + 25_000).accepted, true);

  // After overlap window expires (t0 + 45_000): hz_v1 is rejected, hz_v2 remains accepted
  const expiredCheck = mgr.verifyCredentialAt("horizon", "hz_v1", t0 + 45_000);
  assert.equal(expiredCheck.accepted, false);
  assert.equal(expiredCheck.rejectionReason, "rotation_overlap_expired");
  assert.equal(mgr.verifyCredentialAt("horizon", "hz_v2", t0 + 45_000).accepted, true);

  // Accidental revocation of hz_v2 and reversal via superseding record
  const revReport = mgr.revokeKeyAndRespond({
    providerId: "horizon",
    keyId: "hz_v2",
    actorId: "admin",
    reason: "Accidental revoke during drill",
    nowMs: t0 + 50_000,
    effectiveFromSequence: 100,
    lookbackWindowMs: 10_000,
  });
  assert.equal(mgr.verifyCredentialAt("horizon", "hz_v2", t0 + 51_000).accepted, false);

  mgr.supersedeAccidentalRevocation({
    providerId: "horizon",
    keyId: "hz_v2",
    supersedesEventId: revReport.revocationEventId,
    actorId: "admin_lead",
    reason: "Reversing drill revocation",
    nowMs: t0 + 55_000,
    effectiveFromSequence: 101,
  });
  assert.equal(mgr.verifyCredentialAt("horizon", "hz_v2", t0 + 56_000).accepted, true);

  // Both key_revoked and revocation_superseded remain in the append-only ledger
  const eventTypes = mgr.getLedgerEvents().map((e) => e.eventType);
  assert.equal(eventTypes.includes("key_revoked"), true);
  assert.equal(eventTypes.includes("revocation_superseded"), true);
});
