import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VersionedReferenceDataRegistry,
  type ReferenceDatasetSnapshot,
} from "./registry.ts";

function buildDatasetV1(): ReferenceDatasetSnapshot {
  return {
    datasetVersion: "2026.01",
    createdAtMs: 1_700_000_000_000,
    entities: [
      {
        canonicalId: "airport:KJFK",
        kind: "airport",
        displayName: "John F. Kennedy International Airport",
        code: "JFK",
        effectiveFromMs: 1_000_000_000_000,
        aliases: [
          { providerId: "flightaware", nativeId: "KJFK" },
          { providerId: "aviationstack", nativeId: "JFK_INTL" },
        ],
      },
      {
        canonicalId: "airport:EDDT",
        kind: "airport",
        displayName: "Berlin Tegel Airport",
        code: "TXL",
        effectiveFromMs: 1_000_000_000_000,
        effectiveToMs: 1_604_880_000_000, // Retired Nov 2020
        renamedToCanonicalId: "airport:EDDB",
        aliases: [{ providerId: "*", nativeId: "TXL" }],
      },
      {
        canonicalId: "airport:EDDB",
        kind: "airport",
        displayName: "Berlin Brandenburg Airport",
        code: "BER",
        effectiveFromMs: 1_604_880_000_001,
        aliases: [{ providerId: "*", nativeId: "BER" }],
      },
      {
        canonicalId: "asset:stellar:USDC",
        kind: "asset",
        displayName: "USD Coin (Stellar)",
        code: "USDC",
        chain: "stellar",
        contractAddress: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        effectiveFromMs: 1_600_000_000_000,
        aliases: [],
      },
      {
        canonicalId: "asset:ethereum:USDC",
        kind: "asset",
        displayName: "USD Coin (Ethereum)",
        code: "USDC",
        chain: "ethereum",
        contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        effectiveFromMs: 1_600_000_000_000,
        aliases: [],
      },
    ],
  };
}

test("Issue #287: resolves aliases, rejects unknown/retired entities to dead-letter, and disambiguates multi-chain tickers", () => {
  const registry = new VersionedReferenceDataRegistry({
    alertWindowMs: 60_000,
    maxAlertsPerWindow: 2,
  });
  const v1 = buildDatasetV1();
  registry.registerDatasetVersion(v1);
  registry.pinFeedToDatasetVersion("FlightDelay", "2026.01");
  registry.pinFeedToDatasetVersion("StablecoinDepeg", "2026.01");

  // 1. Provider alias resolution
  const jfk = registry.validateAndResolveEntity({
    feedId: "FlightDelay",
    providerId: "aviationstack",
    kind: "airport",
    rawIdentifier: "JFK_INTL",
    eventTimestampMs: 1_750_000_000_000,
  });
  assert.equal(jfk.valid, true);
  assert.equal(jfk.canonicalId, "airport:KJFK");

  // 2. Ambiguous ticker collision ("USDC" without chain/contract matches both Stellar and Ethereum)
  const ambiguousUsdc = registry.validateAndResolveEntity({
    feedId: "StablecoinDepeg",
    providerId: "coingecko",
    kind: "asset",
    rawIdentifier: "USDC",
    eventTimestampMs: 1_750_000_000_000,
  });
  assert.equal(ambiguousUsdc.valid, false);
  assert.equal(ambiguousUsdc.deadLetter?.reason, "ambiguous_entity_collision");

  // Disambiguated by chain + contractAddress
  const stellarUsdc = registry.validateAndResolveEntity({
    feedId: "StablecoinDepeg",
    providerId: "coingecko",
    kind: "asset",
    rawIdentifier: "USDC",
    chain: "stellar",
    contractAddress: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    eventTimestampMs: 1_750_000_000_000,
  });
  assert.equal(stellarUsdc.valid, true);
  assert.equal(stellarUsdc.canonicalId, "asset:stellar:USDC");

  // 3. Unknown entity storm rate-limits alerts to maxAlertsPerWindow (2)
  const unk1 = registry.validateAndResolveEntity({
    feedId: "FlightDelay",
    providerId: "flightaware",
    kind: "airport",
    rawIdentifier: "ZZZZ_1",
    eventTimestampMs: 1_750_000_000_000,
  });
  const unk2 = registry.validateAndResolveEntity({
    feedId: "FlightDelay",
    providerId: "flightaware",
    kind: "airport",
    rawIdentifier: "ZZZZ_2",
    eventTimestampMs: 1_750_000_001_000,
  });
  const unk3 = registry.validateAndResolveEntity({
    feedId: "FlightDelay",
    providerId: "flightaware",
    kind: "airport",
    rawIdentifier: "ZZZZ_3",
    eventTimestampMs: 1_750_000_002_000,
  });
  assert.equal(unk1.alertEmitted, true);
  assert.equal(unk2.alertEmitted, true);
  assert.equal(unk3.alertEmitted, false); // Rate-limited!
});

test("Issue #287: enforces version pinning immutability and computes dry-run dataset diffs", () => {
  const registry = new VersionedReferenceDataRegistry();
  const v1 = buildDatasetV1();
  const v2: ReferenceDatasetSnapshot = {
    datasetVersion: "2026.02",
    createdAtMs: 1_710_000_000_000,
    entities: [
      {
        ...v1.entities[0],
        effectiveToMs: 1_720_000_000_000, // KJFK retired in v2 for test
      },
      {
        canonicalId: "airport:EGLL",
        kind: "airport",
        displayName: "London Heathrow Airport",
        code: "LHR",
        effectiveFromMs: 1_000_000_000_000,
        aliases: [],
      },
    ],
  };

  registry.registerDatasetVersion(v1);
  registry.registerDatasetVersion(v2);
  registry.pinFeedToDatasetVersion("FlightDelay", "2026.01");

  // Even though v2 retired KJFK at 1_720_000_000_000, FlightDelay is pinned to 2026.01 so KJFK remains valid at 1_750_000_000_000
  const pinnedRes = registry.validateAndResolveEntity({
    feedId: "FlightDelay",
    providerId: "flightaware",
    kind: "airport",
    rawIdentifier: "KJFK",
    eventTimestampMs: 1_750_000_000_000,
  });
  assert.equal(pinnedRes.valid, true);

  // Explicit query against 2026.02 sees KJFK as retired
  const v2Res = registry.validateAndResolveEntity({
    feedId: "FlightDelay",
    pinnedDatasetVersion: "2026.02",
    providerId: "flightaware",
    kind: "airport",
    rawIdentifier: "KJFK",
    eventTimestampMs: 1_750_000_000_000,
  });
  assert.equal(v2Res.valid, false);
  assert.equal(v2Res.deadLetter?.reason, "retired_entity");

  const diff = VersionedReferenceDataRegistry.diffDatasets(v1, v2);
  assert.deepEqual(diff.addedCanonicalIds, ["airport:EGLL"]);
  assert.deepEqual(diff.retiredCanonicalIds, ["airport:KJFK"]);
});
