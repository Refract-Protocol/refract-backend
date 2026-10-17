import { test } from "node:test";
import assert from "node:assert/strict";
import { VersionedAdapterSchemaRegistry } from "./versionedSchemas.ts";

test("Issue #241: supports concurrent adapter versions, applies compatibility shims, rate-limits deprecation warnings, and rejects malformed or unknown versions", () => {
  const registry = new VersionedAdapterSchemaRegistry({
    warningWindowMs: 60_000,
    maxWarningsPerWindow: 1,
  });
  const now = 1_750_000_000_000;

  // Register deprecated v1 schema for coingecko
  registry.registerSchemaVersion({
    descriptor: {
      adapterId: "coingecko",
      adapterVersion: "1.2.0",
      payloadSchemaVersion: 1,
      deprecated: true,
      removalAtMs: now + 86_400_000,
      deprecationNotice: "Migrate to v2 nested market_data schema",
    },
    strictValidateAndExtract(payload) {
      if (typeof payload.usdPriceBps !== "number" || typeof payload.timestampMs !== "number") {
        throw new Error("Expected numeric usdPriceBps and timestampMs");
      }
      return {
        metricValueBps: payload.usdPriceBps,
        observedTimestampMs: payload.timestampMs,
      };
    },
  });

  // Register v2 schema with compatibility shim for legacy v1 shape
  registry.registerSchemaVersion({
    descriptor: {
      adapterId: "coingecko",
      adapterVersion: "2.0.0",
      payloadSchemaVersion: 2,
      deprecated: false,
    },
    compatibilityShim(raw) {
      if (typeof raw.usdPriceBps === "number" && !raw.market_data) {
        return {
          shimApplied: true,
          shimmedPayload: {
            market_data: { currentPriceBps: raw.usdPriceBps },
            updatedAtMs: raw.timestampMs,
          },
        };
      }
      return { shimApplied: false, shimmedPayload: raw };
    },
    strictValidateAndExtract(payload) {
      const md = payload.market_data as Record<string, unknown> | undefined;
      if (
        !md ||
        typeof md.currentPriceBps !== "number" ||
        typeof payload.updatedAtMs !== "number"
      ) {
        throw new Error("Expected market_data.currentPriceBps and updatedAtMs");
      }
      return {
        metricValueBps: md.currentPriceBps,
        observedTimestampMs: payload.updatedAtMs,
      };
    },
  });

  // Switch live serving version to v2
  registry.setLiveServingSchemaVersion("coingecko", 2);

  // 1. Parse via live v2 using compatibility shim on legacy payload shape
  const shimmedReading = registry.parseAndStampReading({
    adapterId: "coingecko",
    rawPayload: { usdPriceBps: 9992, timestampMs: now },
    nowMs: now,
  });
  assert.equal(shimmedReading.adapterId, "coingecko");
  assert.equal(shimmedReading.adapterVersion, "2.0.0");
  assert.equal(shimmedReading.payloadSchemaVersion, 2);
  assert.equal(shimmedReading.shimApplied, true);
  assert.equal(shimmedReading.metricValueBps, 9992);

  // 2. Explicit v1 call emits deprecation warning on first call, and rate-limits second call
  const dep1 = registry.parseAndStampReading({
    adapterId: "coingecko",
    requestedSchemaVersion: 1,
    rawPayload: { usdPriceBps: 9990, timestampMs: now },
    nowMs: now,
  });
  const dep2 = registry.parseAndStampReading({
    adapterId: "coingecko",
    requestedSchemaVersion: 1,
    rawPayload: { usdPriceBps: 9990, timestampMs: now + 1_000 },
    nowMs: now + 1_000,
  });
  assert.equal(dep1.deprecationWarningEmitted, true);
  assert.equal(dep2.deprecationWarningEmitted, false);

  // 3. Rejects unknown future schema version (v99) and malformed payload shapes
  assert.throws(
    () =>
      registry.parseAndStampReading({
        adapterId: "coingecko",
        requestedSchemaVersion: 99,
        rawPayload: {},
        nowMs: now,
      }),
    /UNKNOWN_SCHEMA_VERSION/
  );

  assert.throws(
    () =>
      registry.parseAndStampReading({
        adapterId: "coingecko",
        rawPayload: { error: "rate_limited_html_body" },
        nowMs: now,
      }),
    /STRICT_SCHEMA_VALIDATION_FAILED/
  );
});

test("Issue #241: backfills legacy unversioned reading rows without altering deterministic evidence fields", () => {
  const legacyRow = {
    evidenceId: "ev_legacy_1234",
    feedId: "StablecoinDepeg",
    valueBps: 9985,
  };

  const backfilled = VersionedAdapterSchemaRegistry.backfillLegacyReadingRow(
    legacyRow,
    "coingecko"
  );
  assert.equal(backfilled.evidenceId, "ev_legacy_1234");
  assert.equal(backfilled.adapterId, "coingecko");
  assert.equal(backfilled.adapterVersion, "1.0.0-legacy");
  assert.equal(backfilled.payloadSchemaVersion, 1);
});
