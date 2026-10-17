export interface ProviderCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
}

export interface ProviderTransportResponse {
  status: number;
  body: string;
}

export class ProviderClientError extends Error {
  public readonly providerId: string;
  public readonly code:
    | "RATE_LIMITED"
    | "REQUEST_TIMEOUT"
    | "CYCLE_BUDGET_EXCEEDED"
    | "UPSTREAM_4XX"
    | "UPSTREAM_5XX"
    | "NETWORK_ERROR";
  public readonly attempts: number;

  constructor(params: {
    providerId: string;
    code:
      | "RATE_LIMITED"
      | "REQUEST_TIMEOUT"
      | "CYCLE_BUDGET_EXCEEDED"
      | "UPSTREAM_4XX"
      | "UPSTREAM_5XX"
      | "NETWORK_ERROR";
    attempts: number;
    message: string;
  }) {
    super(params.message);
    this.providerId = params.providerId;
    this.code = params.code;
    this.attempts = params.attempts;
  }
}

interface TokenBucketState {
  tokens: number;
  lastRefillAtMs: number;
}

export class HardenedProviderHttpClient {
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxTokensPerProvider: number;
  private readonly refillIntervalMs: number;
  private readonly cacheStore?: ProviderCacheStore;
  private readonly buckets = new Map<string, TokenBucketState>();

  private cacheHits = 0;
  private cacheMisses = 0;
  private redisFallbacks = 0;

  constructor(options?: {
    requestTimeoutMs?: number;
    maxRetries?: number;
    baseBackoffMs?: number;
    maxTokensPerProvider?: number;
    refillIntervalMs?: number;
    cacheStore?: ProviderCacheStore;
  }) {
    this.requestTimeoutMs = options?.requestTimeoutMs ?? 3_000;
    this.maxRetries = options?.maxRetries ?? 2;
    this.baseBackoffMs = options?.baseBackoffMs ?? 100;
    this.maxTokensPerProvider = options?.maxTokensPerProvider ?? 10;
    this.refillIntervalMs = options?.refillIntervalMs ?? 60_000;
    this.cacheStore = options?.cacheStore;
  }

  public computeBackoffWithJitter(
    attemptIndex: number,
    jitterRatio: number = 0.5
  ): number {
    const exp = this.baseBackoffMs * Math.pow(2, attemptIndex);
    const boundedJitter = Math.max(0, Math.min(1, jitterRatio));
    return Math.round(exp * (0.75 + 0.5 * boundedJitter));
  }

  private consumeRateLimitToken(providerId: string, nowMs: number): boolean {
    let bucket = this.buckets.get(providerId);
    if (!bucket) {
      bucket = { tokens: this.maxTokensPerProvider, lastRefillAtMs: nowMs };
      this.buckets.set(providerId, bucket);
    } else if (nowMs - bucket.lastRefillAtMs >= this.refillIntervalMs) {
      bucket.tokens = this.maxTokensPerProvider;
      bucket.lastRefillAtMs = nowMs;
    }

    if (bucket.tokens <= 0) {
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }

  public async fetchFeedPayload(params: {
    providerId: string;
    cacheKey: string;
    cacheTtlMs: number;
    freshnessWindowMs: number;
    cycleDeadlineAtMs: number;
    nowFn?: () => number;
    sleepFn?: (ms: number) => Promise<void>;
    transport: (timeoutMs: number) => Promise<ProviderTransportResponse>;
  }): Promise<{ body: string; fromCache: boolean; attempts: number }> {
    const nowFn = params.nowFn ?? (() => Date.now());
    const sleepFn = params.sleepFn ?? (async () => {});

    // 1. Check Redis response cache first (degrading gracefully if Redis fails)
    if (this.cacheStore) {
      try {
        const cached = await this.cacheStore.get(params.cacheKey);
        if (cached !== null) {
          this.cacheHits += 1;
          return { body: cached, fromCache: true, attempts: 0 };
        }
        this.cacheMisses += 1;
      } catch {
        this.redisFallbacks += 1;
      }
    }

    // 2. Enforce per-provider token-bucket rate limit
    if (!this.consumeRateLimitToken(params.providerId, nowFn())) {
      throw new ProviderClientError({
        providerId: params.providerId,
        code: "RATE_LIMITED",
        attempts: 0,
        message: `Rate limit budget exhausted for provider '${params.providerId}'`,
      });
    }

    let attempts = 0;
    const maxAttempts = this.maxRetries + 1;

    while (attempts < maxAttempts) {
      const currentNow = nowFn();
      if (currentNow >= params.cycleDeadlineAtMs) {
        throw new ProviderClientError({
          providerId: params.providerId,
          code: "CYCLE_BUDGET_EXCEEDED",
          attempts,
          message: `Poll cycle freshness deadline exceeded for '${params.providerId}'`,
        });
      }

      attempts += 1;
      const effectiveTimeoutMs = Math.min(
        this.requestTimeoutMs,
        params.cycleDeadlineAtMs - currentNow
      );

      try {
        const res = await params.transport(effectiveTimeoutMs);

        if (res.status >= 200 && res.status < 300) {
          const boundedTtlMs = Math.min(
            params.cacheTtlMs,
            params.freshnessWindowMs
          );
          if (this.cacheStore && boundedTtlMs > 0) {
            try {
              await this.cacheStore.set(
                params.cacheKey,
                res.body,
                boundedTtlMs
              );
            } catch {
              this.redisFallbacks += 1;
            }
          }
          return { body: res.body, fromCache: false, attempts };
        }

        // Never retry on 4xx client/validation errors
        if (res.status >= 400 && res.status < 500) {
          throw new ProviderClientError({
            providerId: params.providerId,
            code: "UPSTREAM_4XX",
            attempts,
            message: `Upstream 4xx (${res.status}) from '${params.providerId}'`,
          });
        }

        // Retry on 5xx if attempts remain and within cycle deadline
        if (attempts >= maxAttempts) {
          throw new ProviderClientError({
            providerId: params.providerId,
            code: "UPSTREAM_5XX",
            attempts,
            message: `Upstream 5xx (${res.status}) after ${attempts} attempts`,
          });
        }
      } catch (err) {
        if (err instanceof ProviderClientError) {
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        const isTimeout = msg.toLowerCase().includes("timeout");

        if (attempts >= maxAttempts) {
          throw new ProviderClientError({
            providerId: params.providerId,
            code: isTimeout ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
            attempts,
            message: msg,
          });
        }
      }

      const backoffMs = this.computeBackoffWithJitter(attempts - 1);
      if (nowFn() + backoffMs >= params.cycleDeadlineAtMs) {
        throw new ProviderClientError({
          providerId: params.providerId,
          code: "CYCLE_BUDGET_EXCEEDED",
          attempts,
          message: `Retry backoff (${backoffMs}ms) would exceed poll cycle deadline`,
        });
      }
      await sleepFn(backoffMs);
    }

    throw new ProviderClientError({
      providerId: params.providerId,
      code: "NETWORK_ERROR",
      attempts,
      message: "Exhausted retry attempts",
    });
  }

  public getCacheStats(): {
    hits: number;
    misses: number;
    redisFallbacks: number;
  } {
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      redisFallbacks: this.redisFallbacks,
    };
  }
}
