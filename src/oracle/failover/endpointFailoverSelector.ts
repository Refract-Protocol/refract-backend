export interface ProviderEndpointDescriptor {
  endpointId: string;
  baseUrl: string;
  region: string;
  priority: number; // lower number = higher priority (1 = primary, 2 = mirror)
}

export interface EndpointHealthState {
  endpointId: string;
  baseUrl: string;
  region: string;
  priority: number;
  consecutiveFailures: number;
  demotedUntilMs: number;
  lastLatencyMs: number | null;
  lastSuccessAtMs: number | null;
}

export interface FailoverFetchResult<T> {
  logicalProviderId: string;
  upstreamOrigin: string;
  servedByEndpointId: string;
  servedByRegion: string;
  failoverUsed: boolean;
  data: T;
}

export class ProviderEndpointFailoverClient {
  public readonly logicalProviderId: string;
  public readonly upstreamOrigin: string;
  private readonly maxConsecutiveFailures: number;
  private readonly baseCooldownMs: number;
  private readonly endpoints: EndpointHealthState[];

  private failoverEventsTotal = 0;
  private demotionsTotal = 0;
  private restorationsTotal = 0;

  constructor(options: {
    logicalProviderId: string;
    upstreamOrigin: string;
    endpoints: ProviderEndpointDescriptor[];
    maxConsecutiveFailures?: number;
    baseCooldownMs?: number;
  }) {
    if (!options.endpoints || options.endpoints.length === 0) {
      throw new Error(
        "EMPTY_ENDPOINT_LIST: At least one endpoint must be configured"
      );
    }
    this.logicalProviderId = options.logicalProviderId;
    this.upstreamOrigin = options.upstreamOrigin;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 2;
    this.baseCooldownMs = options.baseCooldownMs ?? 30_000;

    this.endpoints = [...options.endpoints]
      .sort((a, b) => a.priority - b.priority)
      .map((ep) => ({
        ...ep,
        consecutiveFailures: 0,
        demotedUntilMs: 0,
        lastLatencyMs: null,
        lastSuccessAtMs: null,
      }));
  }

  public getOrderedCandidateEndpoints(
    nowMs: number = Date.now()
  ): EndpointHealthState[] {
    const healthy = this.endpoints.filter((e) => e.demotedUntilMs <= nowMs);
    const demoted = this.endpoints
      .filter((e) => e.demotedUntilMs > nowMs)
      .sort((a, b) => a.demotedUntilMs - b.demotedUntilMs);
    return [...healthy, ...demoted];
  }

  public async executeWithFailover<T>(
    requestFn: (
      endpoint: ProviderEndpointDescriptor
    ) => Promise<{ data: T; latencyMs: number }>,
    nowMs: number = Date.now()
  ): Promise<FailoverFetchResult<T>> {
    const candidates = this.getOrderedCandidateEndpoints(nowMs);
    const primaryEndpointId = this.endpoints[0]!.endpointId;
    let lastErr: unknown = null;

    for (const ep of candidates) {
      const wasDemoted = ep.consecutiveFailures >= this.maxConsecutiveFailures;
      try {
        const res = await requestFn(ep);
        if (wasDemoted) {
          this.restorationsTotal += 1;
        }
        ep.consecutiveFailures = 0;
        ep.demotedUntilMs = 0;
        ep.lastLatencyMs = res.latencyMs;
        ep.lastSuccessAtMs = nowMs;

        const failoverUsed = ep.endpointId !== primaryEndpointId;
        if (failoverUsed) {
          this.failoverEventsTotal += 1;
        }

        // Invariant: always attribute to the single logicalProviderId and upstreamOrigin
        return {
          logicalProviderId: this.logicalProviderId,
          upstreamOrigin: this.upstreamOrigin,
          servedByEndpointId: ep.endpointId,
          servedByRegion: ep.region,
          failoverUsed,
          data: res.data,
        };
      } catch (err) {
        lastErr = err;
        ep.consecutiveFailures += 1;
        if (ep.consecutiveFailures >= this.maxConsecutiveFailures) {
          if (!wasDemoted) {
            this.demotionsTotal += 1;
          }
          const exponent = Math.min(
            5,
            ep.consecutiveFailures - this.maxConsecutiveFailures
          );
          ep.demotedUntilMs = nowMs + this.baseCooldownMs * Math.pow(2, exponent);
        }
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error("ALL_ENDPOINTS_FAILED");
  }

  public getMetrics(): {
    failoverEventsTotal: number;
    demotionsTotal: number;
    restorationsTotal: number;
    endpoints: EndpointHealthState[];
  } {
    return {
      failoverEventsTotal: this.failoverEventsTotal,
      demotionsTotal: this.demotionsTotal,
      restorationsTotal: this.restorationsTotal,
      endpoints: this.endpoints.map((e) => ({ ...e })),
    };
  }
}
