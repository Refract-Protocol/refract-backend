import { EndpointHealth, EndpointHealthOptions, EndpointStatus } from "./endpoint-health";

export interface EndpointDeclaration {
  /** Short name, e.g. "primary", "mirror-1", "eu-west". */
  label: string;
  /** Base URL that the adapter's request paths are appended to. */
  url: string;
}

export interface ProviderEndpointOptions extends EndpointHealthOptions {
  /** Per-attempt timeout. The adapter receives an AbortSignal for it. */
  attemptTimeoutMs: number;
}

export interface EndpointAttempt {
  label: string;
  url: string;
  ok: boolean;
  error?: string;
  latencyMs: number;
}

export class AllEndpointsFailedError extends Error {
  constructor(
    readonly adapter: string,
    readonly attempts: EndpointAttempt[],
  ) {
    super(
      `All ${adapter} endpoints failed: ` +
        attempts.map((a) => `${a.label} (${a.error ?? "unknown error"})`).join("; "),
    );
    this.name = "AllEndpointsFailedError";
  }
}

export interface EndpointTransition {
  adapter: string;
  label: string;
  from: EndpointStatus;
  to: EndpointStatus;
  error?: string;
}

export interface ExecuteOptions {
  /**
   * Return false for errors that every endpoint would give (for example a
   * 400 for a bad request). They are re-thrown without failover and don't
   * count against the endpoint's health. Default: every error fails over.
   */
  shouldFailover?: (err: unknown) => boolean;
}

// Probing ranks with healthy so a recovered primary gets its trial call. If
// the trial fails, the same call fails over to the next endpoint.
const STATUS_RANK: Record<EndpointStatus, number> = { healthy: 0, probing: 0, degraded: 1, down: 2 };

/** Removes credentials and query strings so health output never leaks API keys. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    u.search = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return "<invalid url>";
  }
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200);

/**
 * An adapter's ordered endpoints (primary, mirrors, other regions) and the
 * logic to choose between them.
 *
 * Endpoints are tried in health order: healthy and probing first, then
 * degraded. Ties keep the declared order, so the primary is used whenever
 * it is healthy. Down
 * endpoints are skipped. When every endpoint is down, the one whose cooldown
 * ends first is tried anyway, so the feed keeps trying instead of stalling.
 *
 * This covers off-chain data sources (CoinGecko, DeFiLlama, Horizon). It is
 * separate from the Soroban RPC failover used for on-chain calls.
 *
 * Rule: every endpoint in a set belongs to the same provider. A reading
 * served by a mirror is still that provider's reading. Mirrors must never be
 * counted as independent sources in corroboration, so declare a separate
 * provider as its own adapter, never as an endpoint here.
 */
export class ProviderEndpointSet {
  private readonly health: EndpointHealth[];

  constructor(
    readonly adapter: string,
    readonly endpoints: readonly EndpointDeclaration[],
    private readonly options: ProviderEndpointOptions,
    private readonly now: () => number = Date.now,
    private readonly onTransition?: (t: EndpointTransition) => void,
  ) {
    if (endpoints.length === 0) throw new Error(`${adapter}: at least one endpoint is required`);
    this.health = endpoints.map(() => new EndpointHealth(options));
  }

  /** Endpoints in the order the next call will try them. */
  order(): EndpointDeclaration[] {
    const now = this.now();
    const ranked = this.endpoints
      .map((endpoint, index) => ({ endpoint, index, status: this.health[index].status(now) }))
      .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.index - b.index);

    const usable = ranked.filter((r) => r.status !== "down");
    if (usable.length > 0) return usable.map((r) => r.endpoint);

    const soonest = [...ranked].sort(
      (a, b) => this.health[a.index].retryAt() - this.health[b.index].retryAt() || a.index - b.index,
    )[0];
    return [soonest.endpoint];
  }

  /** Runs `call` against one endpoint at a time until one succeeds. */
  async execute<T>(
    call: (baseUrl: string, signal: AbortSignal, endpoint: EndpointDeclaration) => Promise<T>,
    opts: ExecuteOptions = {},
  ): Promise<T> {
    const attempts: EndpointAttempt[] = [];
    for (const endpoint of this.order()) {
      const health = this.health[this.endpoints.indexOf(endpoint)];
      const before = health.status(this.now());
      const controller = new AbortController();
      const started = this.now();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`timed out after ${this.options.attemptTimeoutMs}ms`));
        }, this.options.attemptTimeoutMs);
      });
      try {
        const result = await Promise.race([call(endpoint.url, controller.signal, endpoint), timeout]);
        health.recordSuccess(this.now() - started, this.now());
        this.emit(endpoint, before, health.status(this.now()));
        return result;
      } catch (err) {
        if (opts.shouldFailover && !opts.shouldFailover(err)) throw err;
        const latencyMs = this.now() - started;
        health.recordFailure(errorMessage(err), this.now());
        this.emit(endpoint, before, health.status(this.now()), errorMessage(err));
        attempts.push({ label: endpoint.label, url: redactUrl(endpoint.url), ok: false, error: errorMessage(err), latencyMs });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw new AllEndpointsFailedError(this.adapter, attempts);
  }

  private emit(endpoint: EndpointDeclaration, from: EndpointStatus, to: EndpointStatus, error?: string): void {
    if (from === to || !this.onTransition) return;
    this.onTransition({ adapter: this.adapter, label: endpoint.label, from, to, error });
  }

  snapshot() {
    const now = this.now();
    const active = this.order()[0];
    return {
      adapter: this.adapter,
      active: active.label,
      endpoints: this.endpoints.map((e, i) => ({
        label: e.label,
        url: redactUrl(e.url),
        ...this.health[i].snapshot(now),
      })),
    };
  }
}
