/**
 * Shared, hardened HTTP client for outbound oracle data-provider calls
 * (CoinGecko, Horizon, DeFiLlama, ...). Adapters must go through this client
 * rather than calling `fetch` directly so that timeout, retry, rate-limit and
 * cache behaviour is uniform. See docs/provider-http-client.md.
 */

export type ProviderErrorKind =
  | "timeout"
  | "network"
  | "http_4xx"
  | "http_5xx"
  | "rate_limited"
  | "budget_exceeded"
  | "invalid_body";

function isRetryableKind(kind: ProviderErrorKind): boolean {
  return kind === "timeout" || kind === "network" || kind === "http_5xx";
}

/** Structured failure the health-tracking layer can consume. */
export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: ProviderErrorKind,
    message: string,
    readonly attempts: number,
    readonly status?: number
  ) {
    super(`[${provider}] ${kind}: ${message}`);
    this.name = "ProviderHttpError";
  }

  get retryable(): boolean {
    return isRetryableKind(this.kind);
  }
}

export interface ProviderConfig {
  name: string;
  /** Per-attempt timeout. */
  timeoutMs: number;
  /** Retries after the first attempt (total attempts = maxRetries + 1). */
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Max simultaneous in-flight requests to this provider. */
  maxConcurrency: number;
  /** Token bucket: burst size and sustained refill rate. */
  rateLimit: { capacity: number; refillPerSec: number };
}

/**
 * Default budgets, comfortably under each provider's public limit
 * (CoinGecko free ≈ 5–15 req/min, Horizon public ≈ 3600 req/hr per IP,
 * DeFiLlama ≈ 500 req/min).
 */
export const PROVIDER_DEFAULTS: Record<string, ProviderConfig> = {
  coingecko: {
    name: "coingecko",
    timeoutMs: 5000,
    maxRetries: 2,
    baseBackoffMs: 500,
    maxBackoffMs: 4000,
    maxConcurrency: 2,
    rateLimit: { capacity: 3, refillPerSec: 5 / 60 },
  },
  horizon: {
    name: "horizon",
    timeoutMs: 5000,
    maxRetries: 2,
    baseBackoffMs: 250,
    maxBackoffMs: 2000,
    maxConcurrency: 4,
    rateLimit: { capacity: 10, refillPerSec: 0.5 },
  },
  defillama: {
    name: "defillama",
    timeoutMs: 5000,
    maxRetries: 2,
    baseBackoffMs: 250,
    maxBackoffMs: 2000,
    maxConcurrency: 4,
    rateLimit: { capacity: 10, refillPerSec: 2 },
  },
};

/** Minimal cache surface; CacheService satisfies it. */
export interface ProviderCache {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
}

export type Transport = (
  url: string,
  init: { signal: AbortSignal; headers?: Record<string, string> }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface RequestOptions {
  /** Cache key; requests sharing a key (and TTL window) share one upstream call. */
  cacheKey?: string;
  /** Feed freshness window. Cached values older than this are never served. */
  ttlMs?: number;
  /**
   * Overall time budget for this call including retries and backoff
   * (typically the remainder of the poll cycle).
   */
  budgetMs: number;
  headers?: Record<string, string>;
}

export interface ClientStats {
  cacheHits: number;
  cacheMisses: number;
  cacheErrors: number;
  upstreamRequests: number;
  retries: number;
  rateLimited: number;
}

class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number
  ) {
    this.tokens = capacity;
  }
  tryTake(): boolean {
    const now = Date.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.last) / 1000) * this.refillPerSec
    );
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async acquire(deadline: number): Promise<boolean> {
    if (this.active < this.max) {
      this.active++;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const grant = () => {
        clearTimeout(timer);
        this.active++;
        resolve(true);
      };
      const timer = setTimeout(
        () => {
          this.waiters = this.waiters.filter((w) => w !== grant);
          resolve(false);
        },
        Math.max(0, deadline - Date.now())
      );
      this.waiters.push(grant);
    });
  }
  release(): void {
    this.active--;
    this.waiters.shift()?.();
  }
}

// Process-wide limiter state, shared by every client instance per provider.
const buckets = new Map<string, TokenBucket>();
const semaphores = new Map<string, Semaphore>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Full-jitter exponential backoff: uniform in [0, min(max, base * 2^attempt)). */
export function backoffDelayMs(
  cfg: ProviderConfig,
  attempt: number,
  rand: () => number = Math.random
): number {
  return Math.floor(rand() * Math.min(cfg.maxBackoffMs, cfg.baseBackoffMs * 2 ** attempt));
}

export class ProviderHttpClient {
  readonly stats: ClientStats = {
    cacheHits: 0,
    cacheMisses: 0,
    cacheErrors: 0,
    upstreamRequests: 0,
    retries: 0,
    rateLimited: 0,
  };

  constructor(
    private readonly config: ProviderConfig,
    private readonly cache?: ProviderCache,
    private readonly transport: Transport = (url, init) =>
      fetch(url, init) as ReturnType<Transport>,
    private readonly rand: () => number = Math.random
  ) {
    if (!buckets.has(config.name)) {
      buckets.set(
        config.name,
        new TokenBucket(config.rateLimit.capacity, config.rateLimit.refillPerSec)
      );
      semaphores.set(config.name, new Semaphore(config.maxConcurrency));
    }
  }

  get cacheHitRatio(): number {
    const total = this.stats.cacheHits + this.stats.cacheMisses;
    return total === 0 ? 0 : this.stats.cacheHits / total;
  }

  async getJson<T = unknown>(url: string, opts: RequestOptions): Promise<T> {
    const key = opts.cacheKey ? `provider:${this.config.name}:${opts.cacheKey}` : undefined;
    const ttlMs = opts.ttlMs ?? 0;
    const useCache = !!key && ttlMs > 0 && !!this.cache;

    if (useCache) {
      try {
        const hit = await this.cache!.get<{ at: number; v: T }>(key!);
        // Re-check age ourselves: never serve past the feed's freshness window.
        if (hit && Date.now() - hit.at < ttlMs) {
          this.stats.cacheHits++;
          return hit.v;
        }
      } catch {
        this.stats.cacheErrors++; // Redis down: degrade to a direct call.
      }
      this.stats.cacheMisses++;
    }

    const value = await this.fetchWithRetry<T>(url, opts);

    if (useCache) {
      try {
        await this.cache!.set(
          key!,
          { at: Date.now(), v: value },
          Math.max(1, Math.ceil(ttlMs / 1000))
        );
      } catch {
        this.stats.cacheErrors++;
      }
    }
    return value;
  }

  private async fetchWithRetry<T>(url: string, opts: RequestOptions): Promise<T> {
    const cfg = this.config;
    const deadline = Date.now() + opts.budgetMs;
    let attempts = 0;
    let last: ProviderHttpError | undefined;

    for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = backoffDelayMs(cfg, attempt - 1, this.rand);
        // A retry that cannot finish inside the budget is wasted work.
        if (Date.now() + delay + 1 >= deadline) break;
        this.stats.retries++;
        await sleep(delay);
      }
      if (deadline - Date.now() <= 0) break;

      if (!buckets.get(cfg.name)!.tryTake()) {
        this.stats.rateLimited++;
        throw new ProviderHttpError(cfg.name, "rate_limited", "local token bucket exhausted", attempts);
      }
      const sem = semaphores.get(cfg.name)!;
      if (!(await sem.acquire(deadline))) break;
      try {
        attempts++;
        const timeoutMs = Math.min(cfg.timeoutMs, deadline - Date.now());
        return await this.attemptOnce<T>(url, opts, timeoutMs, attempts);
      } catch (err) {
        last = err as ProviderHttpError;
        if (!last.retryable) throw last;
      } finally {
        sem.release();
      }
    }
    throw (
      last ??
      new ProviderHttpError(
        cfg.name,
        "budget_exceeded",
        `no time left in ${opts.budgetMs}ms budget`,
        attempts
      )
    );
  }

  private async attemptOnce<T>(
    url: string,
    opts: RequestOptions,
    timeoutMs: number,
    attempts: number
  ): Promise<T> {
    const name = this.config.name;
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, Math.max(1, timeoutMs));
    this.stats.upstreamRequests++;
    try {
      const res = await this.transport(url, { signal: ctrl.signal, headers: opts.headers });
      if (!res.ok) {
        const kind: ProviderErrorKind = res.status >= 500 ? "http_5xx" : "http_4xx";
        throw new ProviderHttpError(name, kind, `HTTP ${res.status}`, attempts, res.status);
      }
      try {
        return (await res.json()) as T;
      } catch (e) {
        if (timedOut) throw e;
        throw new ProviderHttpError(name, "invalid_body", "response is not valid JSON", attempts, res.status);
      }
    } catch (err) {
      if (err instanceof ProviderHttpError) throw err;
      if (timedOut) {
        throw new ProviderHttpError(name, "timeout", `no response in ${timeoutMs}ms`, attempts);
      }
      throw new ProviderHttpError(name, "network", (err as Error).message, attempts);
    } finally {
      clearTimeout(timer);
    }
  }
}
