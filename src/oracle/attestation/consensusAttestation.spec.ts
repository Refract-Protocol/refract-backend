import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AttestationKeyRegistry,
  serializeCanonicalAttestationPayload,
  verifyConsensusAttestationOffline,
} from "./consensusAttestation.ts";

test("Issue #242: signs consensus attestations with Ed25519, verifies offline against evidence Merkle root, and detects field or evidence tampering", () => {
  const registry = new AttestationKeyRegistry();
  const now = 1_750_000_000_000;
  registry.generateAndActivateKey("att_key_v1", now);

  const evidenceItems = [
    "coingecko:9985000:1750000000000",
    "defillama:9984000:1750000000000",
    "horizon:9986000:1750000000000",
  ];

  const signed = registry.signDecisionAttestation({
    decisionId: "dec_501",
    feedId: "StablecoinDepeg",
    consensusValueStroops: 9_985_000n,
    participatingSources: ["horizon", "coingecko", "defillama"],
    quorumResult: "satisfied",
    evidenceItems,
    createdAtMs: now,
  });

  const pubKeys = registry.exportPublicVerificationKeys();
  const validCheck = verifyConsensusAttestationOffline(
    signed,
    pubKeys,
    evidenceItems
  );
  assert.equal(validCheck.valid, true);
  assert.equal(validCheck.verifiedKeyId, "att_key_v1");

  // Tamper with consensusValueStroops in payload and canonicalBytesUtf8 -> invalid_ed25519_signature
  const tamperedPayload = {
    ...signed.payload,
    consensusValueStroops: "10000000",
  };
  const tamperedAttestation = {
    ...signed,
    payload: tamperedPayload,
    canonicalBytesUtf8: serializeCanonicalAttestationPayload(tamperedPayload),
  };
  const sigFail = verifyConsensusAttestationOffline(
    tamperedAttestation,
    pubKeys,
    evidenceItems
  );
  assert.equal(sigFail.valid, false);
  assert.equal(sigFail.reason, "invalid_ed25519_signature");

  // Tamper with raw evidence items -> evidence_merkle_root_mismatch
  const merkleFail = verifyConsensusAttestationOffline(signed, pubKeys, [
    "coingecko:1111111:1750000000000",
    "defillama:9984000:1750000000000",
    "horizon:9986000:1750000000000",
  ]);
  assert.equal(merkleFail.valid, false);
  assert.equal(merkleFail.reason, "evidence_merkle_root_mismatch");
});

test("Issue #242: key rotation signs new attestations with active key while retaining retired public keys for historical verification", () => {
  const registry = new AttestationKeyRegistry();
  const t0 = 1_750_000_000_000;

  registry.generateAndActivateKey("att_key_v1", t0);
  const oldAttestation = registry.signDecisionAttestation({
    decisionId: "dec_old",
    feedId: "MarketCrash",
    consensusValueStroops: 1_500n,
    participatingSources: ["coingecko", "defillama"],
    quorumResult: "satisfied",
    evidenceItems: ["ev_1", "ev_2"],
    createdAtMs: t0 + 1_000,
  });

  // Rotate to att_key_v2
  registry.generateAndActivateKey("att_key_v2", t0 + 60_000);
  const newAttestation = registry.signDecisionAttestation({
    decisionId: "dec_new",
    feedId: "MarketCrash",
    consensusValueStroops: 1_800n,
    participatingSources: ["coingecko", "defillama"],
    quorumResult: "satisfied",
    evidenceItems: ["ev_3", "ev_4"],
    createdAtMs: t0 + 65_000,
  });

  assert.equal(oldAttestation.payload.signingKeyId, "att_key_v1");
  assert.equal(newAttestation.payload.signingKeyId, "att_key_v2");

  const exportedKeys = registry.exportPublicVerificationKeys();
  assert.equal(exportedKeys.length, 2);
  assert.equal(
    exportedKeys.find((k) => k.keyId === "att_key_v1")?.status,
    "retired"
  );
  assert.equal(
    exportedKeys.find((k) => k.keyId === "att_key_v2")?.status,
    "active"
  );

  // Both historical and new attestations verify offline against the exported key bundle
  assert.equal(
    verifyConsensusAttestationOffline(oldAttestation, exportedKeys, [
      "ev_1",
      "ev_2",
    ]).valid,
    true
  );
  assert.equal(
    verifyConsensusAttestationOffline(newAttestation, exportedKeys, [
      "ev_3",
      "ev_4",
    ]).valid,
    true
  );
});
