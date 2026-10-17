import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HardenedProviderHttpClient,
  ProviderClientError,
} from "./hardenedProviderClient.ts";

test("HardenedProviderHttpClient caches responses, retries transient 5xx, and never retries 4xx", async () => {
  const memoryCache = new Map<string, string>();
  const client = new HardenedProviderHttpClient({
    requestTimeoutMs: 1_000,
    maxRetries: 2,
    baseBackoffMs: 50,
    maxTokensPerProvider: 5,
    cacheStore: {
      get: async (key) => memoryCache.get(key) ?? null,
      set: async (key, val) => {
        memoryCache.set(key, val);
      },
    },
  });

  // 1. Transient 503 followed by 200 succeeds on attempt 2 and populates cache
  let calls = 0;
  const firstRes = await client.fetchFeedPayload({
    providerId: "coingecko",
    cacheKey: "cg:usdc-usd",
    cacheTtlMs: 5_000,
    freshnessWindowMs: 10_000,
    cycleDeadlineAtMs: 10_000,
    nowFn: () => 1_000,
    transport: async () => {
      calls += 1;
      if (calls === 1) return { status: 503, body: "Service Unavailable" };
      return { status: 200, body: '{"usd":1.0}' };
    },
  });
  assert.equal(firstRes.fromCache, false);
  assert.equal(firstRes.attempts, 2);

  // 2. Subsequent call hits Redis cache without invoking transport
  const secondRes = await client.fetchFeedPayload({
    providerId: "coingecko",
    cacheKey: "cg:usdc-usd",
    cacheTtlMs: 5_000,
    freshnessWindowMs: 10_000,
    cycleDeadlineAtMs: 10_000,
    nowFn: () => 1_500,
    transport: async () => {
      throw new Error("Should not be called on cache hit");
    },
  });
  assert.equal(secondRes.fromCache, true);
  assert.equal(client.getCacheStats().hits, 1);

  // 3. 4xx response fails immediately on attempt 1 without retry
  let fourXxCalls = 0;
  await assert.rejects(
    () =>
      client.fetchFeedPayload({
        providerId: "coingecko",
        cacheKey: "cg:invalid-feed",
        cacheTtlMs: 5_000,
        freshnessWindowMs: 10_000,
        cycleDeadlineAtMs: 10_000,
        nowFn: () => 2_000,
        transport: async () => {
          fourXxCalls += 1;
          return { status: 400, body: "Bad Request" };
        },
      }),
    (err: unknown) =>
      err instanceof ProviderClientError &&
      err.code === "UPSTREAM_4XX" &&
      err.attempts === 1
  );
  assert.equal(fourXxCalls, 1);
});

test("HardenedProviderHttpClient falls back when Redis is down, enforces rate limits, and respects cycle budget", async () => {
  const client = new HardenedProviderHttpClient({
    requestTimeoutMs: 500,
    maxRetries: 3,
    baseBackoffMs: 200,
    maxTokensPerProvider: 2,
    refillIntervalMs: 60_000,
    cacheStore: {
      get: async () => {
        throw new Error("Redis connection refused");
      },
      set: async () => {
        throw new Error("Redis connection refused");
      },
    },
  });

  // 1. Redis failure degrades gracefully to direct call
  const fallbackRes = await client.fetchFeedPayload({
    providerId: "defillama",
    cacheKey: "dl:tvl",
    cacheTtlMs: 5_000,
    freshnessWindowMs: 10_000,
    cycleDeadlineAtMs: 5_000,
    nowFn: () => 1_000,
    transport: async () => ({ status: 200, body: '{"tvl":5000000}' }),
  });
  assert.equal(fallbackRes.body, '{"tvl":5000000}');
  assert.ok(client.getCacheStats().redisFallbacks >= 1);

  // 2. Retry aborts with CYCLE_BUDGET_EXCEEDED if backoff would pass cycleDeadlineAtMs
  await assert.rejects(
    () =>
      client.fetchFeedPayload({
        providerId: "defillama",
        cacheKey: "dl:tvl-2",
        cacheTtlMs: 5_000,
        freshnessWindowMs: 10_000,
        cycleDeadlineAtMs: 1_100, // Only 100ms remaining, less than 200ms base backoff
        nowFn: () => 1_000,
        transport: async () => ({ status: 502, body: "Bad Gateway" }),
      }),
    (err: unknown) =>
      err instanceof ProviderClientError &&
      err.code === "CYCLE_BUDGET_EXCEEDED"
  );

  // 3. Third request within refill window hits RATE_LIMITED (maxTokensPerProvider = 2)
  await assert.rejects(
    () =>
      client.fetchFeedPayload({
        providerId: "defillama",
        cacheKey: "dl:tvl-3",
        cacheTtlMs: 5_000,
        freshnessWindowMs: 10_000,
        cycleDeadlineAtMs: 5_000,
        nowFn: () => 1_050,
        transport: async () => ({ status: 200, body: "{}" }),
      }),
    (err: unknown) =>
      err instanceof ProviderClientError && err.code === "RATE_LIMITED"
  );
});
