import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OracleTrustStatusService,
  stripSecretFields,
} from "./oracleTrustStatusService.ts";

test("OracleTrustStatusService distinguishes unknown, degraded_settled, and paused_no_authoritative_value states and invalidates cache on new decisions", () => {
  const service = new OracleTrustStatusService({
    cacheTtlMs: 5_000,
    maxPageLimit: 2,
  });

  // 1. Feed with no data returns unknown state
  const unknownRes = service.getFeedTrustStatus({
    feedId: "UNCONFIGURED-FEED",
    nowMs: 1_000,
  });
  assert.equal(unknownRes.operationalState, "unknown");
  assert.equal(unknownRes.authoritativeValue, null);

  // 2. Configure feed with 1 degraded source -> degraded_settled when decision exists
  service.configureFeed({
    feedId: "USDC-DEPEG",
    trustMode: "corroborated",
    paused: false,
    sources: [
      {
        sourceId: "coingecko",
        independenceGroup: "aggregator-a",
        healthy: true,
        quarantined: false,
        lastObservedAtMs: 1_000,
      },
      {
        sourceId: "defillama",
        independenceGroup: "aggregator-b",
        healthy: false,
        quarantined: true,
        lastObservedAtMs: 900,
      },
    ],
  });

  service.recordDecisionAndInvalidate({
    decisionId: "dec-1",
    feedId: "USDC-DEPEG",
    authoritativeValue: 0.9997,
    quorumAchieved: 2,
    quorumRequired: 2,
    participatingSources: ["coingecko", "horizon"],
    decidedAtMs: 1_050,
  });

  const firstFetch = service.getFeedTrustStatus({
    feedId: "USDC-DEPEG",
    nowMs: 1_100,
  });
  assert.equal(firstFetch.operationalState, "degraded_settled");
  assert.equal(firstFetch.authoritativeValue, 0.9997);
  assert.equal(firstFetch.fromCache, false);

  // Cache hit within TTL
  const cachedFetch = service.getFeedTrustStatus({
    feedId: "USDC-DEPEG",
    nowMs: 1_200,
  });
  assert.equal(cachedFetch.fromCache, true);

  // New decision invalidates cache immediately
  service.recordDecisionAndInvalidate({
    decisionId: "dec-2",
    feedId: "USDC-DEPEG",
    authoritativeValue: 0.9999,
    quorumAchieved: 2,
    quorumRequired: 2,
    participatingSources: ["coingecko", "horizon"],
    decidedAtMs: 1_300,
  });
  const afterNewDecision = service.getFeedTrustStatus({
    feedId: "USDC-DEPEG",
    nowMs: 1_350,
  });
  assert.equal(afterNewDecision.fromCache, false);
  assert.equal(afterNewDecision.authoritativeValue, 0.9999);

  // 3. Paused feed returns paused_no_authoritative_value and null authoritativeValue
  service.configureFeed({
    feedId: "USDC-DEPEG",
    trustMode: "corroborated",
    paused: true,
    sources: [],
  });
  const pausedRes = service.getFeedTrustStatus({
    feedId: "USDC-DEPEG",
    nowMs: 1_400,
  });
  assert.equal(pausedRes.operationalState, "paused_no_authoritative_value");
  assert.equal(pausedRes.authoritativeValue, null);
});

test("stripSecretFields removes relayer keys, API keys, and private operator notes", () => {
  const sanitized = stripSecretFields({
    feedId: "USDC-DEPEG",
    relayerKey: "S_SECRET_STELLAR_SEED",
    apiKey: "cg-secret",
    nested: {
      operatorPrivateNote: "internal investigation",
      publicStatus: "ok",
    },
  });

  assert.equal("relayerKey" in sanitized, false);
  assert.equal("apiKey" in sanitized, false);
  assert.deepEqual(sanitized.nested, { publicStatus: "ok" });
});
