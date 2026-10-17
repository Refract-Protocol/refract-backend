import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderSignatureVerifier } from "./providerSignatureVerifier.ts";

test("ProviderSignatureVerifier validates inbound HMAC signatures, key rotation windows, revocation, and outbound headers", () => {
  const verifier = new ProviderSignatureVerifier(30_000);

  verifier.registerKey("noaa-signed", {
    keyId: "k1",
    secret: "secret-one",
    validFromMs: 1_000,
    validUntilMs: 50_000,
    revoked: false,
  });
  verifier.registerKey("noaa-signed", {
    keyId: "k2",
    secret: "secret-two",
    validFromMs: 40_000,
    validUntilMs: 100_000,
    revoked: false,
  });

  const body = '{"windSpeedKph":145}';
  const sigK1 = verifier.computeSignature("secret-one", 45_000, body);
  const sigK2 = verifier.computeSignature("secret-two", 45_000, body);

  // Overlap window supports both k1 and k2 at t=45_000
  assert.equal(
    verifier.verifyInboundResponse(
      { sourceId: "noaa-signed", keyId: "k1", timestampMs: 45_000, rawBody: body, signatureHex: sigK1 },
      45_500
    ).verified,
    true
  );
  assert.equal(
    verifier.verifyInboundResponse(
      { sourceId: "noaa-signed", keyId: "k2", timestampMs: 45_000, rawBody: body, signatureHex: sigK2 },
      45_500
    ).verified,
    true
  );

  // Replay outside clock skew fails
  assert.equal(
    verifier.verifyInboundResponse(
      { sourceId: "noaa-signed", keyId: "k2", timestampMs: 45_000, rawBody: body, signatureHex: sigK2 },
      90_000
    ).reason,
    "timestamp_out_of_window"
  );

  // Revoking k1 immediately rejects it
  verifier.revokeKey("noaa-signed", "k1");
  assert.equal(
    verifier.verifyInboundResponse(
      { sourceId: "noaa-signed", keyId: "k1", timestampMs: 45_000, rawBody: body, signatureHex: sigK1 },
      45_500
    ).reason,
    "key_revoked"
  );

  const headers = verifier.signOutboundRequest({
    sourceId: "noaa-signed",
    keyId: "k2",
    method: "GET",
    path: "/v1/observations",
    timestampMs: 46_000,
  });
  assert.equal(headers["X-Oracle-Key-Id"], "k2");
  assert.ok(headers["X-Oracle-Signature"].length === 64);
});
