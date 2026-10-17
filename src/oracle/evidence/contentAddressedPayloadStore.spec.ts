import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ContentAddressedRawPayloadStore } from "./contentAddressedPayloadStore.ts";

describe("Capture and Content-Address Raw Provider Payloads for Evidence Reproducibility (#225)", () => {
  it("deduplicates identical payloads by SHA-256 digest, redacts secrets, and resolves claims to raw provider bytes", async () => {
    const store = new ContentAddressedRawPayloadStore({
      maxPayloadBytes: 1_024,
    });

    const rawBody = '{"usd-coin":{"usd":0.9412,"last_updated_at":1700000000}}';

    const cap1 = await store.captureProviderPayload({
      readingId: "reading-101",
      providerId: "coingecko-spot",
      requestUrl:
        "https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&api_key=cg_secret_999",
      httpStatus: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": "header-secret-key",
        "Content-Encoding": "gzip",
      },
      rawBody,
      fetchedAtMs: 1_700_000_001_000,
    });

    assert.equal(cap1.stored, true);
    assert.equal(cap1.deduplicated, false);
    assert.ok(cap1.payloadDigest.startsWith("sha256:"));

    // Second reading with identical payload bytes is deduplicated
    const cap2 = await store.captureProviderPayload({
      readingId: "reading-102",
      providerId: "coingecko-spot",
      requestUrl:
        "https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&api_key=cg_secret_999",
      httpStatus: 200,
      headers: { "Content-Type": "application/json" },
      rawBody,
      fetchedAtMs: 1_700_000_002_000,
    });

    assert.equal(cap2.payloadDigest, cap1.payloadDigest);
    assert.equal(cap2.deduplicated, true);

    // Link claim to readings and resolve stored bytes
    store.linkClaimToReadings("claim-77", ["reading-101"]);
    const resolved = store.resolveClaimToRawPayloads("claim-77");
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.rawBody, rawBody);
    assert.equal(resolved[0]?.deduplicatedCount, 2);
    assert.equal(resolved[0]?.contentEncoding, "gzip");
    // Secrets redacted in URL and headers
    assert.ok(!resolved[0]?.redactedRequestUrl.includes("cg_secret_999"));
    assert.equal(resolved[0]?.redactedHeaders["x-api-key"], "[REDACTED]");
  });

  it("fails open with a recorded warning on oversized payloads or storage errors without throwing", async () => {
    const failingStore = new ContentAddressedRawPayloadStore({
      maxPayloadBytes: 32,
      externalPersistHook: async () => {
        throw new Error("DISK_FULL");
      },
    });

    // 1. Oversized payload returns stored=false with warning
    const oversized = await failingStore.captureProviderPayload({
      readingId: "r-big",
      providerId: "defillama",
      requestUrl: "https://api.llama.fi/protocol/blend",
      httpStatus: 200,
      headers: {},
      rawBody: "x".repeat(64),
    });
    assert.equal(oversized.stored, false);
    assert.ok(oversized.warning?.includes("PAYLOAD_SIZE_CAP_EXCEEDED"));

    // 2. Storage error fails open with warning instead of throwing
    const diskFail = await failingStore.captureProviderPayload({
      readingId: "r-small",
      providerId: "defillama",
      requestUrl: "https://api.llama.fi/protocol/blend",
      httpStatus: 200,
      headers: {},
      rawBody: '{"tvl":100}',
    });
    assert.equal(diskFail.stored, false);
    assert.ok(diskFail.warning?.includes("PAYLOAD_STORE_WRITE_FAILED"));
  });
});
