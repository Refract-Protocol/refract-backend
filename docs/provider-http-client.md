# Oracle provider HTTP client

This page describes what the code does today. Two modules make outbound calls to
CoinGecko, Horizon and DeFiLlama:

| Module | Status | Behaviour |
|--------|--------|-----------|
| `src/oracle/adapters/http-json.ts` (`getJsonWithEvidence`) | **Used by all three adapters.** | Single GET. No retry, no rate limit, no cache. |
| `src/oracle/httpClient.ts` (`ProviderHttpClient`) | **Implemented, not yet used by any adapter.** | Retry, time budgets, rate limits, cache. |

Adapters should not call `fetch` directly. Until adapters move to `ProviderHttpClient`,
the retry, rate-limit and cache sections below do **not** apply to live adapter traffic.

## Adapter helper: `getJsonWithEvidence` (http-json.ts)

```ts
const { data, evidence } = await getJsonWithEvidence<T>(url, params, timeoutMs, http?);
```

- Sends one GET through axios with `timeout: timeoutMs`. Adapters pass `ctx.timeoutMs`.
- Resolves only for 2xx responses. Any other status rejects with axios's own error.
- Reads the body as text, then records evidence: `url` (full URL including params), `status`,
  `bodySha256`, `bytes`, `excerpt` (first 512 characters) and `capturedAt`.
- Parses the body with `JSON.parse`. Invalid JSON throws a `SyntaxError`.
- **No retry** on timeout, network error or 5xx. **No `Retry-After` handling.**
- **Errors are not normalised.** Callers receive raw axios errors or `SyntaxError`, not
  `ProviderHttpError`.

## ProviderHttpClient (httpClient.ts)

```ts
const client = new ProviderHttpClient(PROVIDER_DEFAULTS.coingecko, cacheService);
const data = await client.getJson(url, {
  cacheKey: "simple-price:xlm,usdc", // optional; requests sharing a key share one upstream call
  ttlMs: feedFreshnessMs,            // optional; enables caching, never serves older than this
  budgetMs: cycleRemainingMs,        // required; retries + backoff must fit in this
  headers: { ... },                  // optional
});
```

`getJson<T>` resolves to the parsed JSON body. It does not return evidence.

### Retry

- Attempts = `maxRetries + 1`. Defaults: `maxRetries: 2`, so 3 attempts.
- Each attempt's timeout is `min(timeoutMs, remaining budget)`. Defaults: `timeoutMs: 5000`.
- Retried: `timeout`, `network`, `http_5xx`.
- Not retried: `http_4xx` (including upstream HTTP 429), `invalid_body`, `rate_limited`,
  `budget_exceeded`.
- Backoff is full jitter: `rand() * min(maxBackoffMs, baseBackoffMs * 2^k)`, where `k = 0` for the
  first retry.
- A retry is skipped if its backoff would reach the budget deadline. In that case the last
  retryable error is thrown, not `budget_exceeded`. `budget_exceeded` is thrown only when the
  budget runs out before any attempt has failed.
- **Not implemented:** `Retry-After` is ignored on every status code. An upstream 429 is an
  `http_4xx` and is not retried. Tracking issue: not yet filed.

### Rate limits (process-wide, per provider)

- **Token bucket.** Every attempt, including retries, takes one token. An empty bucket throws
  `rate_limited` immediately. It does not wait.
- **Concurrency semaphore.** At most `maxConcurrency` requests are in flight per provider. A caller
  over the limit waits for a slot until its budget deadline. This is the only queuing.

| Provider  | Burst | Sustained | Concurrency | Public limit (approx.) |
|-----------|-------|-----------|-------------|------------------------|
| CoinGecko | 3     | 5/min     | 2           | 5–15/min free tier     |
| Horizon   | 10    | 30/min    | 4           | 3600/hr per IP         |
| DeFiLlama | 10    | 120/min   | 4           | ~500/min               |

`rate_limited` is a local bucket rejection only. It is not an upstream 429.

### Caching

- Caching applies only when `cacheKey` and `ttlMs > 0` are set and a cache was passed to the
  constructor.
- Key: `provider:<name>:<cacheKey>`. The stored value is the parsed JSON plus its write time.
- A stored value is served only if its age is below `ttlMs`, re-checked on every read.
- Stored TTL is `ceil(ttlMs / 1000)` seconds, minimum 1.
- Cache read or write errors increment `stats.cacheErrors`. A read error falls through to upstream.
- `stats` exposes `cacheHits`, `cacheMisses`, `cacheErrors`, `upstreamRequests`, `retries` and
  `rateLimited`. `cacheHitRatio` is `cacheHits / (cacheHits + cacheMisses)`.

### Errors

Every failure from `getJson` is a `ProviderHttpError`:

- `provider`: provider name.
- `kind`: one of `timeout | network | http_4xx | http_5xx | rate_limited | budget_exceeded | invalid_body`.
- `status`: HTTP status, when a response was received.
- `attempts`: attempts actually sent.
- `retryable`: getter; `true` for `timeout`, `network` and `http_5xx`.

Message format: `[provider] kind: message`.

## Public surface

- `ProviderHttpClient(config, cache?, transport?, rand?)`. `transport` and `rand` are test seams.
- `getJson<T>(url, { cacheKey?, ttlMs?, budgetMs, headers? })`.
- `stats`, `cacheHitRatio`.
- `PROVIDER_DEFAULTS`: keys `coingecko`, `horizon`, `defillama`.
- `ProviderConfig`, `ProviderErrorKind`, `ProviderHttpError`, `backoffDelayMs`.
