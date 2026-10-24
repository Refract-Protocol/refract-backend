#!/usr/bin/env node
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";

const [tokenPath, publicKeyBase64Url] = process.argv.slice(2);
if (!tokenPath || !publicKeyBase64Url) {
  console.error("Usage: node scripts/verify-oracle-attestation.mjs <attestation.json> <public-key-base64url>");
  process.exit(2);
}

const { attestation } = JSON.parse(await readFile(tokenPath, "utf8"));
const [version, encodedPayload, encodedSignature, extra] = String(attestation).split(".");
if (version !== "oa1" || !encodedPayload || !encodedSignature || extra !== undefined) {
  throw new Error("Invalid compact oracle attestation format");
}

const publicBytes = Buffer.from(publicKeyBase64Url, "base64url");
if (publicBytes.length !== 32) throw new Error("The Ed25519 public key must decode to 32 bytes");
const keyId = createHash("sha256").update(publicKeyBase64Url).digest("hex").slice(0, 16);
const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
if (payload.version !== 1 || payload.keyId !== keyId) {
  throw new Error("Attestation key ID does not match the supplied verification key");
}

const key = createPublicKey({
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicBytes]),
  format: "der",
  type: "spki",
});
if (!verify(null, Buffer.from(encodedPayload), key, Buffer.from(encodedSignature, "base64url"))) {
  throw new Error("Oracle attestation signature is invalid");
}
console.log(JSON.stringify({ verified: true, payload }, null, 2));
