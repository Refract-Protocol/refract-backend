import { rpc } from "@stellar/stellar-sdk";

/**
 * What a Soroban RPC call is for. Selection differs slightly per purpose:
 *
 *  - `read`   — simulations, ledger-entry reads, account loads.
 *  - `events` — `getEvents` polling. Sticks to the last endpoint that served
 *               a page while it stays healthy, because providers retain
 *               different ledger windows and paging cursors are only
 *               meaningful on the node that issued them.
 *  - `submit` — `sendTransaction` / `getTransaction` for oracle publishes and
 *               settlements. Re-sending the same signed envelope to another
 *               endpoint after a transport error is safe: the transaction
 *               hash is identical and the source-account sequence number
 *               guarantees it applies at most once.
 */
export type RpcPurpose = "read" | "events" | "submit";

export type EndpointState = "healthy" | "lagging" | "unhealthy" | "unknown";

/** The subset of `rpc.Server` the pool itself needs for health probes. */
export interface RpcHealthProbe {
  getHealth(): Promise<{ status: string; latestLedger?: number }>;
}

export interface RpcEndpointPoolOptions<TServer extends RpcHealthProbe = rpc.Server> {
  /** Ledgers an endpoint may trail the most advanced endpoint before it is treated as lagging. */
  maxLedgerLag?: number;
  /** Consecutive transient call failures before an endpoint is marked unhealthy. */
  failureThreshold?: number;
  /** How long an unhealthy endpoint is skipped (except as a last resort). */
  cooldownMs?: number;
  /** Interval between background health probes. 0 disables the background loop. */
  healthCheckIntervalMs?: number;
  /** Per-probe timeout. */
  healthCheckTimeoutMs?: number;
  /** Rounds over the candidate list before a call gives up. */
  maxAttempts?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  serverFactory?: (url: string) => TServer;
  now?: () => number;
  logger?: { warn(message: string): void; log?(message: string): void };
}

export interface EndpointHealthSnapshot {
  url: string;
  /** Position in the configured list; lower is preferred when health is equal. */
  priority: number;
  state: EndpointState;
  latestLedger: number | null;
  ledgerLag: number | null;
  latencyMs: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastCheckedAt: string | null;
  cooldownUntil: string | null;
}

export const RPC_POOL_DEFAULTS = {
  maxLedgerLag: 10,
  failureThreshold: 3,
  cooldownMs: 30_000,
  healthCheckIntervalMs: 15_000,
  healthCheckTimeoutMs: 5_000,
  maxAttempts: 3,
  baseRetryDelayMs: 250,
  maxRetryDelayMs: 2_000,
} as const;

interface EndpointEntry<TServer> {
  url: string;
  priority: number;
  server: TServer;
  state: EndpointState;
  latestLedger: number | null;
  latencyMs: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastCheckedAt: number | null;
  cooldownUntil: number | null;
}

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * True for transport and server-throttling failures, which are worth retrying
 * on another endpoint. Contract and request errors are not: every endpoint
 * would return the same answer.
 */
export function isTransientRpcError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const details = error as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
  const status = Number(details.status ?? details.statusCode);
  if (status === 408 || status === 425 || status === 429 || status >= 500) return true;

  if (typeof details.code === "string" && TRANSIENT_CODES.has(details.code)) return true;

  return (
    typeof details.message === "string" &&
    /\b(timeout|timed out|network|connection reset|connection refused|fetch failed|temporarily unavailable|rate limit|too many requests|bad gateway|service unavailable|gateway timeout|408|425|429|500|502|503|504)\b/i.test(
      details.message
    )
  );
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`health check timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Lower rank is tried first. */
const STATE_RANK: Record<EndpointState, number> = {
  healthy: 0,
  unknown: 1,
  lagging: 2,
  unhealthy: 3,
};

/**
 * A health-checked pool of Soroban RPC endpoints.
 *
 * Health comes from two signals:
 *  - Active: a background `getHealth` probe of every endpoint. It records
 *    latency and latest ledger, and marks an endpoint `lagging` when it trails
 *    the most advanced endpoint by more than `maxLedgerLag` ledgers.
 *  - Passive: every call's outcome. `failureThreshold` consecutive transient
 *    failures mark an endpoint `unhealthy` for `cooldownMs`.
 *
 * Calls try endpoints best-first (healthy → unknown → lagging → unhealthy).
 * Unhealthy endpoints are kept at the end of the list as a last resort, so a
 * pool where every provider is degraded still makes progress instead of
 * stalling the publish path.
 */
export class RpcEndpointPool<TServer extends RpcHealthProbe = rpc.Server> {
  private readonly endpoints: EndpointEntry<TServer>[];
  private readonly options: Required<Omit<RpcEndpointPoolOptions<TServer>, "serverFactory" | "logger">>;
  private readonly logger?: RpcEndpointPoolOptions<TServer>["logger"];
  /** Last endpoint that served each purpose; preferred while it stays in the best health tier. */
  private readonly active = new Map<RpcPurpose, number>();
  private timer: NodeJS.Timeout | undefined;
  private probing: Promise<void> | undefined;

  constructor(urls: string[], options: RpcEndpointPoolOptions<TServer> = {}) {
    const uniqueUrls = [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
    if (uniqueUrls.length === 0) {
      throw new Error("At least one Soroban RPC URL must be configured");
    }

    const factory =
      options.serverFactory ?? ((url: string) => new rpc.Server(url) as unknown as TServer);

    this.options = {
      maxLedgerLag: options.maxLedgerLag ?? RPC_POOL_DEFAULTS.maxLedgerLag,
      failureThreshold: options.failureThreshold ?? RPC_POOL_DEFAULTS.failureThreshold,
      cooldownMs: options.cooldownMs ?? RPC_POOL_DEFAULTS.cooldownMs,
      healthCheckIntervalMs: options.healthCheckIntervalMs ?? RPC_POOL_DEFAULTS.healthCheckIntervalMs,
      healthCheckTimeoutMs: options.healthCheckTimeoutMs ?? RPC_POOL_DEFAULTS.healthCheckTimeoutMs,
      maxAttempts: options.maxAttempts ?? RPC_POOL_DEFAULTS.maxAttempts,
      baseRetryDelayMs: options.baseRetryDelayMs ?? RPC_POOL_DEFAULTS.baseRetryDelayMs,
      maxRetryDelayMs: options.maxRetryDelayMs ?? RPC_POOL_DEFAULTS.maxRetryDelayMs,
      now: options.now ?? Date.now,
    };
    this.logger = options.logger;

    this.endpoints = uniqueUrls.map((url, priority) => ({
      url,
      priority,
      server: factory(url),
      state: "unknown",
      latestLedger: null,
      latencyMs: null,
      consecutiveFailures: 0,
      lastError: null,
      lastCheckedAt: null,
      cooldownUntil: null,
    }));
  }

  get size(): number {
    return this.endpoints.length;
  }

  /** Starts background probing. Runs one probe immediately. Safe to call twice. */
  start(): void {
    if (this.timer || this.options.healthCheckIntervalMs <= 0) return;
    void this.checkHealth();
    this.timer = setInterval(() => void this.checkHealth(), this.options.healthCheckIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Probes every endpoint once, in parallel. Concurrent callers share the
   * in-flight probe rather than stacking requests on a slow provider.
   */
  checkHealth(): Promise<void> {
    if (!this.probing) {
      this.probing = this.probeAll().finally(() => {
        this.probing = undefined;
      });
    }
    return this.probing;
  }

  /**
   * Runs `operation` against the best available endpoint, rotating to the
   * next candidate on transient failures. Non-transient errors are thrown at
   * once because every endpoint would return the same answer.
   */
  async call<T>(operation: (server: TServer) => Promise<T>, purpose: RpcPurpose = "read"): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < this.options.maxAttempts; attempt++) {
      for (const index of this.candidateOrder(purpose)) {
        const endpoint = this.endpoints[index];
        try {
          const result = await operation(endpoint.server);
          this.recordSuccess(endpoint);
          this.active.set(purpose, index);
          return result;
        } catch (error) {
          if (!isTransientRpcError(error)) throw error;
          lastError = error;
          this.recordFailure(endpoint, error);
        }
      }

      if (attempt < this.options.maxAttempts - 1) {
        const delay = Math.min(
          this.options.baseRetryDelayMs * 2 ** attempt,
          this.options.maxRetryDelayMs
        );
        await wait(delay);
      }
    }

    throw lastError;
  }

  /** Endpoint URLs in the order the next call for `purpose` would try them. */
  rankedUrls(purpose: RpcPurpose = "read"): string[] {
    return this.candidateOrder(purpose).map((index) => this.endpoints[index].url);
  }

  snapshot(): EndpointHealthSnapshot[] {
    const head = this.headLedger();
    return this.endpoints.map((endpoint) => ({
      url: endpoint.url,
      priority: endpoint.priority,
      state: this.effectiveState(endpoint),
      latestLedger: endpoint.latestLedger,
      ledgerLag:
        head !== null && endpoint.latestLedger !== null ? head - endpoint.latestLedger : null,
      latencyMs: endpoint.latencyMs,
      consecutiveFailures: endpoint.consecutiveFailures,
      lastError: endpoint.lastError,
      lastCheckedAt: endpoint.lastCheckedAt !== null ? new Date(endpoint.lastCheckedAt).toISOString() : null,
      cooldownUntil: endpoint.cooldownUntil !== null ? new Date(endpoint.cooldownUntil).toISOString() : null,
    }));
  }

  /** True when at least one endpoint is healthy (or not yet probed). */
  isServiceable(): boolean {
    return this.endpoints.some((endpoint) => {
      const state = this.effectiveState(endpoint);
      return state === "healthy" || state === "unknown";
    });
  }

  private candidateOrder(purpose: RpcPurpose): number[] {
    const sticky = this.active.get(purpose);
    const rank = (index: number): number => STATE_RANK[this.effectiveState(this.endpoints[index])];

    return this.endpoints
      .map((_, index) => index)
      .sort((a, b) => {
        const byState = rank(a) - rank(b);
        if (byState !== 0) return byState;
        if (sticky !== undefined) {
          if (a === sticky) return -1;
          if (b === sticky) return 1;
        }
        return this.endpoints[a].priority - this.endpoints[b].priority;
      });
  }

  /** An unhealthy endpoint whose cooldown has expired is retried as `unknown`. */
  private effectiveState(endpoint: EndpointEntry<TServer>): EndpointState {
    if (
      endpoint.state === "unhealthy" &&
      endpoint.cooldownUntil !== null &&
      this.options.now() >= endpoint.cooldownUntil
    ) {
      return "unknown";
    }
    return endpoint.state;
  }

  private recordSuccess(endpoint: EndpointEntry<TServer>): void {
    endpoint.consecutiveFailures = 0;
    endpoint.lastError = null;
    if (endpoint.state === "unhealthy") {
      endpoint.state = "unknown";
      endpoint.cooldownUntil = null;
      this.logger?.log?.(`Soroban RPC endpoint ${endpoint.url} recovered`);
    }
  }

  private recordFailure(endpoint: EndpointEntry<TServer>, error: unknown): void {
    endpoint.consecutiveFailures += 1;
    endpoint.lastError = errorMessage(error);
    if (endpoint.consecutiveFailures >= this.options.failureThreshold) {
      this.markUnhealthy(endpoint, `${endpoint.consecutiveFailures} consecutive failures: ${endpoint.lastError}`);
    }
  }

  private markUnhealthy(endpoint: EndpointEntry<TServer>, reason: string): void {
    const wasUnhealthy = endpoint.state === "unhealthy";
    endpoint.state = "unhealthy";
    endpoint.cooldownUntil = this.options.now() + this.options.cooldownMs;
    if (!wasUnhealthy) {
      this.logger?.warn(`Soroban RPC endpoint ${endpoint.url} marked unhealthy (${reason})`);
    }
  }

  private headLedger(): number | null {
    let head: number | null = null;
    for (const endpoint of this.endpoints) {
      if (endpoint.state === "unhealthy" || endpoint.latestLedger === null) continue;
      if (head === null || endpoint.latestLedger > head) head = endpoint.latestLedger;
    }
    return head;
  }

  private async probeAll(): Promise<void> {
    await Promise.all(this.endpoints.map((endpoint) => this.probe(endpoint)));

    const head = this.headLedger();
    for (const endpoint of this.endpoints) {
      if (endpoint.state === "unhealthy" || endpoint.latestLedger === null || head === null) continue;
      const lag = head - endpoint.latestLedger;
      const next: EndpointState = lag > this.options.maxLedgerLag ? "lagging" : "healthy";
      if (next !== endpoint.state && next === "lagging") {
        this.logger?.warn(
          `Soroban RPC endpoint ${endpoint.url} is ${lag} ledgers behind (max ${this.options.maxLedgerLag})`
        );
      }
      endpoint.state = next;
    }
  }

  private async probe(endpoint: EndpointEntry<TServer>): Promise<void> {
    const startedAt = this.options.now();
    try {
      const health = await withTimeout(endpoint.server.getHealth(), this.options.healthCheckTimeoutMs);
      endpoint.lastCheckedAt = this.options.now();
      endpoint.latencyMs = endpoint.lastCheckedAt - startedAt;
      if (health.status !== "healthy") {
        endpoint.latestLedger = health.latestLedger ?? endpoint.latestLedger;
        endpoint.lastError = `reported status "${health.status}"`;
        this.markUnhealthy(endpoint, endpoint.lastError);
        return;
      }
      endpoint.latestLedger = typeof health.latestLedger === "number" ? health.latestLedger : null;
      endpoint.consecutiveFailures = 0;
      endpoint.lastError = null;
      endpoint.cooldownUntil = null;
      // Lag is resolved in probeAll once every endpoint has reported.
      endpoint.state = "healthy";
    } catch (error) {
      endpoint.lastCheckedAt = this.options.now();
      endpoint.latencyMs = null;
      endpoint.lastError = errorMessage(error);
      this.markUnhealthy(endpoint, `health probe failed: ${endpoint.lastError}`);
    }
  }
}
