export interface EndpointHealthOptions {
  /** Consecutive failures that take an endpoint out of rotation. */
  failureThreshold: number;
  /** First cooldown once out of rotation. Doubles on each trip up to maxCooldownMs. */
  cooldownMs: number;
  maxCooldownMs: number;
  /** Latency (EWMA) above which a working endpoint counts as degraded. */
  slowMs: number;
}

export type EndpointStatus = "healthy" | "degraded" | "probing" | "down";

const EWMA_ALPHA = 0.3;

/**
 * Live health of one endpoint, built from the outcomes of real calls (no
 * background pinging). It works like a circuit breaker:
 *  - healthy:  working and fast
 *  - degraded: a failure or a slow response in the last `cooldownMs`. It
 *              ranks behind healthy endpoints, then returns to healthy
 *              rank once the window passes. Without that, a primary
 *              that stopped getting traffic would never get a chance to
 *              recover.
 *  - down:     too many consecutive failures; skipped until cooldown ends
 *  - probing:  cooldown ended; the next call is a trial. Success makes it
 *              healthy again, failure takes it down for a longer cooldown.
 */
export class EndpointHealth {
  private consecutiveFailures = 0;
  private trips = 0;
  private openUntil = 0;
  private latencyEwmaMs: number | null = null;
  private successes = 0;
  private failures = 0;
  private lastError: string | null = null;
  private lastSuccessAt: number | null = null;
  private lastFailureAt: number | null = null;

  constructor(private readonly options: EndpointHealthOptions) {}

  recordSuccess(latencyMs: number, now: number): void {
    this.successes++;
    this.consecutiveFailures = 0;
    this.trips = 0;
    this.openUntil = 0;
    this.lastSuccessAt = now;
    this.latencyEwmaMs =
      this.latencyEwmaMs === null ? latencyMs : EWMA_ALPHA * latencyMs + (1 - EWMA_ALPHA) * this.latencyEwmaMs;
  }

  recordFailure(error: string, now: number): void {
    this.failures++;
    this.consecutiveFailures++;
    this.lastError = error;
    this.lastFailureAt = now;
    const wasProbing = this.openUntil !== 0 && now >= this.openUntil;
    if (wasProbing || this.consecutiveFailures >= this.options.failureThreshold) {
      this.trips++;
      const cooldown = Math.min(this.options.cooldownMs * 2 ** (this.trips - 1), this.options.maxCooldownMs);
      this.openUntil = now + cooldown;
    }
  }

  status(now: number): EndpointStatus {
    if (this.openUntil !== 0) return now < this.openUntil ? "down" : "probing";
    const recent = (at: number | null) => at !== null && now - at < this.options.cooldownMs;
    if (this.consecutiveFailures > 0 && recent(this.lastFailureAt)) return "degraded";
    const slow = this.latencyEwmaMs !== null && this.latencyEwmaMs > this.options.slowMs;
    if (slow && recent(this.lastSuccessAt)) return "degraded";
    return "healthy";
  }

  /** When a down endpoint can next be tried (0 when it isn't down). */
  retryAt(): number {
    return this.openUntil;
  }

  snapshot(now: number) {
    return {
      status: this.status(now),
      consecutiveFailures: this.consecutiveFailures,
      latencyEwmaMs: this.latencyEwmaMs === null ? null : Math.round(this.latencyEwmaMs),
      successes: this.successes,
      failures: this.failures,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
      lastFailureAt: this.lastFailureAt ? new Date(this.lastFailureAt).toISOString() : null,
      retryAt: this.openUntil && now < this.openUntil ? new Date(this.openUntil).toISOString() : null,
    };
  }
}
