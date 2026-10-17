import { test } from "node:test";
import assert from "node:assert/strict";
import { EvidenceAtRestEncryptor } from "./evidenceAtRestEncryptor.ts";

test("EvidenceAtRestEncryptor supports AES-256-GCM encryption, key rotation, role separation, and tamper detection", () => {
  const keyV1 = Buffer.alloc(32, 0x11);
  const keyV2 = Buffer.alloc(32, 0x22);
  const encryptor = new EvidenceAtRestEncryptor("v1", keyV1);

  const recV1 = encryptor.encryptRecord({
    role: "writer",
    recordId: "ev-1",
    feedId: "XLM_USD",
    rawPayloadJson: '{"price":0.1234,"account":"secret-ref"}',
  });

  // Rotate to v2 and ensure v1 records still decrypt
  encryptor.rotateKey("v2", keyV2);
  const recV2 = encryptor.encryptRecord({
    role: "writer",
    recordId: "ev-2",
    feedId: "XLM_USD",
    rawPayloadJson: '{"price":0.1250}',
  });
  assert.equal(recV2.keyVersion, "v2");

  // analytics_reader can read metadata/hashes without decrypting raw body
  const meta = encryptor.readMetadata(recV1);
  assert.equal(meta.integrityValid, true);
  assert.throws(() =>
    encryptor.decryptPayload({ role: "analytics_reader", record: recV1 })
  );

  // audited_operator can decrypt both v1 and v2
  assert.equal(
    encryptor.decryptPayload({ role: "audited_operator", record: recV1 }),
    '{"price":0.1234,"account":"secret-ref"}'
  );
  assert.equal(
    encryptor.decryptPayload({ role: "audited_operator", record: recV2 }),
    '{"price":0.1250}'
  );

  // Tampering with ciphertext is detected
  const tampered = { ...recV1, ciphertextHex: "00" + recV1.ciphertextHex.slice(2) };
  assert.equal(encryptor.readMetadata(tampered).integrityValid, false);
  assert.throws(() =>
    encryptor.decryptPayload({ role: "audited_operator", record: tampered })
  );
});
