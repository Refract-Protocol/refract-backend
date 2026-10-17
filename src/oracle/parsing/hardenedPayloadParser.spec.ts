import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HardenedProviderPayloadParser,
  CoinGeckoSpotPayloadValidator,
} from "./hardenedPayloadParser.ts";

describe("Harden Provider Payload Parsing Against Malformed and Adversarial Responses (#246)", () => {
  it("accepts well-formed payloads and rejects 10+ adversarial/malformed fixtures with typed errors naming provider, schemaVersion, and failedPath", () => {
    const validator = new CoinGeckoSpotPayloadValidator("usd-coin");

    const okRes = HardenedProviderPayloadParser.parseProviderResponse({
      validator,
      contentTypeHeader: "application/json; charset=utf-8",
      rawBody: JSON.stringify({
        "usd-coin": { usd: 0.9999, last_updated_at: 1_700_000_000 },
      }),
    });
    assert.equal(okRes.ok, true);
    if (okRes.ok) {
      assert.equal(okRes.data.usdPrice, 0.9999);
    }

    const adversarialFixtures: Array<{
      name: string;
      contentType: string;
      rawBody: string;
      expectedCode: string;
    }> = [
      {
        name: "1. non-JSON content-type (HTML error page)",
        contentType: "text/html",
        rawBody: "<html>502 Bad Gateway</html>",
        expectedCode: "INVALID_CONTENT_TYPE",
      },
      {
        name: "2. oversized payload exceeding maxPayloadBytes",
        contentType: "application/json",
        rawBody: JSON.stringify({ pad: "x".repeat(2_000) }),
        expectedCode: "PAYLOAD_TOO_LARGE",
      },
      {
        name: "3. truncated / malformed JSON",
        contentType: "application/json",
        rawBody: '{"usd-coin":{"usd":0.999',
        expectedCode: "MALFORMED_JSON",
      },
      {
        name: "4. deeply nested object exceeding maxNestingDepth",
        contentType: "application/json",
        rawBody: '{"a":{"b":{"c":{"d":{"e":{"f":1}}}}}}',
        expectedCode: "MAX_NESTING_DEPTH_EXCEEDED",
      },
      {
        name: "5. huge array exceeding maxArrayLength",
        contentType: "application/json",
        rawBody: JSON.stringify({ items: new Array(25).fill(1) }),
        expectedCode: "MAX_ARRAY_LENGTH_EXCEEDED",
      },
      {
        name: "6. HTTP 200 with embedded error envelope",
        contentType: "application/json",
        rawBody: JSON.stringify({
          status: { error_code: 429, error_message: "Rate limit" },
        }),
        expectedCode: "UPSTREAM_ERROR_ENVELOPE",
      },
      {
        name: "7. negative USD price",
        contentType: "application/json",
        rawBody: JSON.stringify({
          "usd-coin": { usd: -1.0, last_updated_at: 1_700_000_000 },
        }),
        expectedCode: "SCHEMA_FIELD_VALIDATION_FAILED",
      },
      {
        name: "8. zero USD price",
        contentType: "application/json",
        rawBody: JSON.stringify({
          "usd-coin": { usd: 0, last_updated_at: 1_700_000_000 },
        }),
        expectedCode: "SCHEMA_FIELD_VALIDATION_FAILED",
      },
      {
        name: "9. string-encoded number (no silent coercion)",
        contentType: "application/json",
        rawBody: JSON.stringify({
          "usd-coin": { usd: "0.9999", last_updated_at: 1_700_000_000 },
        }),
        expectedCode: "SCHEMA_FIELD_VALIDATION_FAILED",
      },
      {
        name: "10. locale comma decimal string",
        contentType: "application/json",
        rawBody: JSON.stringify({
          "usd-coin": { usd: "0,9999", last_updated_at: 1_700_000_000 },
        }),
        expectedCode: "SCHEMA_FIELD_VALIDATION_FAILED",
      },
      {
        name: "11. missing timestamp field",
        contentType: "application/json",
        rawBody: JSON.stringify({
          "usd-coin": { usd: 1.0 },
        }),
        expectedCode: "SCHEMA_FIELD_VALIDATION_FAILED",
      },
    ];

    for (const fixture of adversarialFixtures) {
      const res = HardenedProviderPayloadParser.parseProviderResponse({
        validator,
        contentTypeHeader: fixture.contentType,
        rawBody: fixture.rawBody,
        limits: {
          maxPayloadBytes: 1_024,
          maxNestingDepth: 4,
          maxArrayLength: 10,
        },
      });
      assert.equal(res.ok, false, `Expected failure for ${fixture.name}`);
      if (!res.ok) {
        assert.equal(res.error.providerId, "coingecko-spot");
        assert.equal(res.error.schemaVersion, "coingecko-simple-price-v1");
        assert.equal(res.error.code, fixture.expectedCode);
        assert.ok(res.error.failedPath.length > 0);
      }
    }
  });
});
