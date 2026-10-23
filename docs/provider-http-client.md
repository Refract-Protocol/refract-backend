# Oracle provider HTTP client

`src/oracle/httpClient.ts` (`ProviderHttpClient`) is the only way adapters call
CoinGecko, Horizon and DeFiLlama. Never call `fetch` directly from an adapter.

## Usage

```ts
const client = new ProviderHttpClient(PROVIDER_DEFAULTS.coingecko, cacheService);
const data = await client.getJson(url, {
  cacheKey: "simple-price:xlm,usdc", // feeds hitting the same endpoint share this key
  ttlMs: feedFreshnessMs,            // cache never serves older than this
  budgetMs: cycleRemainingMs,        // retries + backoff must fit in this
});
```

## Retry policy

- Total attempts = `maxRetries + 1` (default 3), each bounded by `timeoutMs` (5s).
- Retried: timeout, connection errors, HTTP 5xx. **Never** retried: 4xx, invalid JSON, local rate-limit rejection.
- Backoff: full jitter, `rand() * min(maxBackoffMs, baseBackoffMs * 2^n)`.
- A retry is skipped if its backoff would push past `budgetMs`; pass the remaining time of the
  poll cycle so no work outlives the cycle.

## Rate-limit budgets (process-wide token buckets, per provider)

| Provider  | Burst | Sustained | Concurrency | Public limit (approx.) |
|-----------|-------|-----------|-------------|------------------------|
| CoinGecko | 3     | 5/min     | 2           | 5–15/min free tier     |
| Horizon   | 10    | 30/min    | 4           | 3600/hr per IP         |
| DeFiLlama | 10    | 120/min   | 4           | ~500/min               |

Every attempt (including retries) consumes a token. An empty bucket fails fast with a
`rate_limited` error — no queuing, so no retry storms.

## Caching

Responses are cached in Redis under `provider:<name>:<cacheKey>` with TTL = feed freshness.
Entries carry their write time and are re-checked on read, so a value past the freshness
window is never served. Redis errors are counted in `stats.cacheErrors` and the call goes
upstream. `client.stats` / `client.cacheHitRatio` expose hits, misses, retries, rate-limited
counts and upstream requests for metrics.

## Errors

All failures are `ProviderHttpError` with `provider`, `kind`
(`timeout | network | http_4xx | http_5xx | rate_limited | budget_exceeded | invalid_body`),
`status`, `attempts` and `retryable`, for consumption by health tracking.
