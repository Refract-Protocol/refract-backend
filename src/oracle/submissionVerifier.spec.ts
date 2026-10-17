import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { SignedProviderSubmissionService } from "./submissionVerifier.ts";
import { ProviderSubmissionClient } from "./submissionClientSdk.ts";

describe("SignedProviderSubmissionService & SDK (Issue #183)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const privateKeyPem = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();

  const { privateKey: wrongPrivateKey } = generateKeyPairSync("ed25519");
  const wrongPrivateKeyPem = wrongPrivateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();

  it("accepts valid Ed25519 signed provider readings via the client SDK and rejects tampered or wrong-key signatures", async () => {
    const nowMs = 1_700_000_000_000;
    const service = new SignedProviderSubmissionService({
      providers: [
        {
          providerId: "flightaware-partner",
          publicKeyPem,
          enabled: true,
          allowedCoverageTypes: ["flight_delay"],
          maxSubmissionsPerMinute: 10,
        },
      ],
      coverageSpecs: [
        {
          coverageType: "flight_delay",
          expectedUnit: "minutes",
          minValue: 0,
          maxValue: 1_440,
          maxAgeMs: 60_000,
        },
      ],
    });

    const client = new ProviderSubmissionClient({
      providerId: "flightaware-partner",
      privateKeyPem,
      submitTransport: (payload) => service.ingestSignedSubmission(payload, nowMs),
    });

    const okResult = await client.submitReading({
      coverageType: "flight_delay",
      value: 75,
      unit: "minutes",
      observedAtMs: nowMs - 5_000,
      nonce: "nonce-0001",
    });

    assert.equal(okResult.accepted, true);
    assert.equal(okResult.statusCode, 201);
    assert.equal(okResult.record?.providerId, "flightaware-partner");
    assert.equal(service.getAcceptedReadingsForCoverage("flight_delay").length, 1);

    // Tampered value after signing -> 401 INVALID_SIGNATURE
    const signed = client.buildSignedPayload({
      coverageType: "flight_delay",
      value: 75,
      unit: "minutes",
      observedAtMs: nowMs - 5_000,
      nonce: "nonce-0002",
    });
    const tampered = service.ingestSignedSubmission(
      { ...signed, value: 180 },
      nowMs
    );
    assert.equal(tampered.accepted, false);
    assert.equal(tampered.statusCode, 401);
    assert.equal(tampered.errorCode, "INVALID_SIGNATURE");

    // Wrong private key -> 401 INVALID_SIGNATURE
    const wrongClient = new ProviderSubmissionClient({
      providerId: "flightaware-partner",
      privateKeyPem: wrongPrivateKeyPem,
      submitTransport: (payload) => service.ingestSignedSubmission(payload, nowMs),
    });
    const wrongKeyRes = await wrongClient.submitReading({
      coverageType: "flight_delay",
      value: 45,
      unit: "minutes",
      observedAtMs: nowMs - 2_000,
      nonce: "nonce-0003",
    });
    assert.equal(wrongKeyRes.accepted, false);
    assert.equal(wrongKeyRes.errorCode, "INVALID_SIGNATURE");
    assert.equal(service.getAcceptedReadingsForCoverage("flight_delay").length, 1);
  });

  it("rejects replayed nonces, stale timestamps, unsupported units, and out-of-bounds values", async () => {
    const nowMs = 1_700_000_000_000;
    const service = new SignedProviderSubmissionService({
      providers: [
        {
          providerId: "flightaware-partner",
          publicKeyPem,
          enabled: true,
          allowedCoverageTypes: ["flight_delay"],
        },
      ],
      coverageSpecs: [
        {
          coverageType: "flight_delay",
          expectedUnit: "minutes",
          minValue: 0,
          maxValue: 1_440,
          maxAgeMs: 60_000,
        },
      ],
    });

    const client = new ProviderSubmissionClient({
      providerId: "flightaware-partner",
      privateKeyPem,
      submitTransport: (payload) => service.ingestSignedSubmission(payload, nowMs),
    });

    await client.submitReading({
      coverageType: "flight_delay",
      value: 30,
      unit: "minutes",
      observedAtMs: nowMs - 1_000,
      nonce: "replay-nonce-1",
    });

    // Replayed nonce -> 409 REPLAYED_NONCE
    const replayed = await client.submitReading({
      coverageType: "flight_delay",
      value: 30,
      unit: "minutes",
      observedAtMs: nowMs - 1_000,
      nonce: "replay-nonce-1",
    });
    assert.equal(replayed.accepted, false);
    assert.equal(replayed.statusCode, 409);
    assert.equal(replayed.errorCode, "REPLAYED_NONCE");

    // Stale timestamp -> 422 STALE_OR_FUTURE_TIMESTAMP
    const stale = await client.submitReading({
      coverageType: "flight_delay",
      value: 30,
      unit: "minutes",
      observedAtMs: nowMs - 120_000,
      nonce: "nonce-stale",
    });
    assert.equal(stale.accepted, false);
    assert.equal(stale.errorCode, "STALE_OR_FUTURE_TIMESTAMP");

    // Out-of-bounds value -> 422 VALUE_OUT_OF_BOUNDS
    const outOfBounds = await client.submitReading({
      coverageType: "flight_delay",
      value: 9_999,
      unit: "minutes",
      observedAtMs: nowMs - 1_000,
      nonce: "nonce-oob",
    });
    assert.equal(outOfBounds.accepted, false);
    assert.equal(outOfBounds.errorCode, "VALUE_OUT_OF_BOUNDS");
  });
});
