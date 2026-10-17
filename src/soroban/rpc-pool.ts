/**
 * Health-Checked Multi-Endpoint Soroban RPC Pool with Automatic Failover & Rotation (Issue #238)
 *
 * Manages a prioritized pool of Soroban RPC endpoints, evaluates reachability,
 * latency, and cross-endpoint ledger lag, routes reads/polls and idempotent
 * publish submissions with sticky selection and bounded failover, refuses to
 * publish from lagging nodes, and preserves single-endpoint compatibility.
 */

export type RpcEndpointHealthStatus = "healthy" | "lagging" | "unhealthy";

export interface SorobanRpcEndpointConfig {
  endpointId: string;
  url: string;
  /** Lower number = higher priority (1 is highest) */
  priority: number;
}

export interface RpcEndpointProbeSample {
  endpointId: string;
  reachable: boolean;
  latencyMs: number;
  latestLedger?: number;
  error?: string;
}

export interface RpcEndpointMetrics {
  endpointId: string;
  url: string;
  priority: number;
  status: RpcEndpointHealthStatus;
  lastLatencyMs: number;
  latestLedger: number;
  ledgerLag: number;
  failureCount: number;
  totalRequests: number;
}

export interface SorobanRpcPoolConfig {
  endpoints: SorobanRpcEndpointConfig[];
  maxAllowedLedgerLag: number;
  maxAllowedLatencyMs: number;
  unhealthyFailureThreshold: number;
}

export class DefinitiveTransactionRejectionError extends Error {
  readonly isDefinitiveRejection = true;
  constructor(message: string) {
    super(message);
    this.name = "DefinitiveTransactionRejectionError";
  }
}

export class SorobanRpcPool {
  private readonly config: SorobanRpcPoolConfig;
  private readonly metricsByEndpoint = new Map<string, RpcEndpointMetrics>();
  private readonly confirmedPublishResults = new Map<
    string,
    { txHash: string; servedByEndpointId: string }
  >();
  private stickyEndpointId?: string;
  private maxObservedLedger = 0;

  constructor(config: Partial<SorobanRpcPoolConfig> & { endpoints: SorobanRpcEndpointConfig[] }) {
    if (!config.endpoints || config.endpoints.length === 0) {
      throw new Error("SorobanRpcPool requires at least one configured endpoint");
    }
    this.config = {
      endpoints: [...config.endpoints].sort((a, b) => a.priority - b.priority),
      maxAllowedLedgerLag: config.maxAllowedLedgerLag ?? 5,
      maxAllowedLatencyMs: config.maxAllowedLatencyMs ?? 3_000,
      unhealthyFailureThreshold: config.unhealthyFailureThreshold ?? 2,
    };

    for (const ep of this.config.endpoints) {
      this.metricsByEndpoint.set(ep.endpointId, {
        endpointId: ep.endpointId,
        url: ep.url,
        priority: ep.priority,
        status: "healthy",
        lastLatencyMs: 0,
        latestLedger: 0,
        ledgerLag: 0,
        failureCount: 0,
        totalRequests: 0,
      });
    }
    this.stickyEndpointId = this.config.endpoints[0].endpointId;
  }

  /**
   * Updates health state across all configured endpoints from probe samples,
   * computing cross-endpoint ledger lag against the highest observed ledger.
   */
  applyHealthProbeSamples(samples: readonly RpcEndpointProbeSample[]): void {
    for (const s of samples) {
      if (s.reachable && typeof s.latestLedger === "number" && s.latestLedger > this.maxObservedLedger) {
        this.maxObservedLedger = s.latestLedger;
      }
    }

    for (const s of samples) {
      const m = this.metricsByEndpoint.get(s.endpointId);
      if (!m) continue;

      if (!s.reachable || s.latencyMs > this.config.maxAllowedLatencyMs) {
        m.failureCount += 1;
        m.lastLatencyMs = s.latencyMs;
        m.status = "unhealthy";
        continue;
      }

      m.lastLatencyMs = s.latencyMs;
      m.failureCount = 0;
      if (typeof s.latestLedger === "number") {
        m.latestLedger = s.latestLedger;
      }
      m.ledgerLag = Math.max(0, this.maxObservedLedger - m.latestLedger);

      if (m.ledgerLag > this.config.maxAllowedLedgerLag) {
        m.status = "lagging";
      } else {
        m.status = "healthy";
      }
    }

    // Rotate sticky endpoint if current sticky endpoint is no longer healthy
    if (this.stickyEndpointId) {
      const currentSticky = this.metricsByEndpoint.get(this.stickyEndpointId);
      if (!currentSticky || currentSticky.status !== "healthy") {
        const nextBest = this.selectHealthyEndpointsInOrder()[0];
        this.stickyEndpointId = nextBest?.endpointId;
      }
    } else {
      this.stickyEndpointId = this.selectHealthyEndpointsInOrder()[0]?.endpointId;
    }
  }

  /**
   * Executes an oracle publish transaction with idempotency protection, refusing
   * to publish from lagging endpoints and failing over on transport errors while
   * never retrying definitive on-chain transaction rejections.
   */
  async executePublishTransaction(
    idempotencyKey: string,
    operation: (endpoint: SorobanRpcEndpointConfig) => Promise<{ txHash: string }>
  ): Promise<{ txHash: string; servedByEndpointId: string }> {
    const existing = this.confirmedPublishResults.get(idempotencyKey);
    if (existing) {
      return existing;
    }

    const candidates = this.selectHealthyEndpointsInOrder();
    if (candidates.length === 0) {
      throw new Error(
        "[SOROBAN_RPC_NO_HEALTHY_ENDPOINT] Refusing to publish: all Soroban RPC endpoints are unhealthy or lagging behind maximum observed ledger"
      );
    }

    let lastTransportError: Error | undefined;

    for (const candidate of candidates) {
      const epConfig = this.config.endpoints.find(
        (e) => e.endpointId === candidate.endpointId
      )!;
      candidate.totalRequests += 1;

      try {
        const { txHash } = await operation(epConfig);
        candidate.failureCount = 0;
        this.stickyEndpointId = candidate.endpointId;
        const result = { txHash, servedByEndpointId: candidate.endpointId };
        this.confirmedPublishResults.set(idempotencyKey, result);
        return result;
      } catch (err) {
        if (
          err instanceof DefinitiveTransactionRejectionError ||
          (err instanceof Error &&
            (err as { isDefinitiveRejection?: boolean }).isDefinitiveRejection === true)
        ) {
          // Definitive contract/tx rejection must NOT be retried on another endpoint
          throw err;
        }

        candidate.failureCount += 1;
        if (candidate.failureCount >= this.config.unhealthyFailureThreshold) {
          candidate.status = "unhealthy";
        }
        lastTransportError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw new Error(
      `[SOROBAN_RPC_FAILOVER_EXHAUSTED] Publish failed across all healthy endpoints: ${lastTransportError?.message ?? "unknown error"}`
    );
  }

  /**
   * Executes a read or event-polling request with automatic failover across healthy endpoints.
   */
  async executeReadOrPoll<T>(
    operation: (endpoint: SorobanRpcEndpointConfig) => Promise<T>
  ): Promise<{ data: T; servedByEndpointId: string }> {
    const candidates = this.selectHealthyEndpointsInOrder();
    if (candidates.length === 0) {
      throw new Error("[SOROBAN_RPC_NO_HEALTHY_ENDPOINT] No healthy RPC endpoints available for read/poll");
    }

    let lastError: Error | undefined;
    for (const candidate of candidates) {
      const epConfig = this.config.endpoints.find(
        (e) => e.endpointId === candidate.endpointId
      )!;
      candidate.totalRequests += 1;

      try {
        const data = await operation(epConfig);
        candidate.failureCount = 0;
        this.stickyEndpointId = candidate.endpointId;
        return { data, servedByEndpointId: candidate.endpointId };
      } catch (err) {
        candidate.failureCount += 1;
        if (candidate.failureCount >= this.config.unhealthyFailureThreshold) {
          candidate.status = "unhealthy";
        }
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw new Error(
      `[SOROBAN_RPC_FAILOVER_EXHAUSTED] Read/poll failed across all healthy endpoints: ${lastError?.message ?? "unknown error"}`
    );
  }

  getEndpointMetrics(): RpcEndpointMetrics[] {
    return Array.from(this.metricsByEndpoint.values()).map((m) => ({ ...m }));
  }

  private selectHealthyEndpointsInOrder(): RpcEndpointMetrics[] {
    const healthy = Array.from(this.metricsByEndpoint.values()).filter(
      (m) => m.status === "healthy"
    );
    healthy.sort((a, b) => {
      if (a.endpointId === this.stickyEndpointId) return -1;
      if (b.endpointId === this.stickyEndpointId) return 1;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.lastLatencyMs - b.lastLatencyMs;
    });
    return healthy;
  }
}
