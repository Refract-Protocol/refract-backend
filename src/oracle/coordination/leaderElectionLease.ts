export interface LeaseAcquisitionRecord {
  ownerId: string;
  fencingToken: number;
  expiresAtMs: number;
}

export interface RedisLeaseBackingStore {
  tryAcquireLease(params: {
    lockKey: string;
    ownerId: string;
    ttlMs: number;
    nowMs: number;
  }): Promise<LeaseAcquisitionRecord | null>;

  renewLeaseIfOwner(params: {
    lockKey: string;
    ownerId: string;
    fencingToken: number;
    ttlMs: number;
    nowMs: number;
  }): Promise<LeaseAcquisitionRecord | null>;

  releaseLeaseIfOwner(params: {
    lockKey: string;
    ownerId: string;
  }): Promise<boolean>;
}

export class InMemoryRedisLeaseStore implements RedisLeaseBackingStore {
  private readonly leases = new Map<string, LeaseAcquisitionRecord>();
  private readonly fencingCounters = new Map<string, number>();
  private reachable = true;

  public setReachable(reachable: boolean): void {
    this.reachable = reachable;
  }

  public async tryAcquireLease(params: {
    lockKey: string;
    ownerId: string;
    ttlMs: number;
    nowMs: number;
  }): Promise<LeaseAcquisitionRecord | null> {
    if (!this.reachable) {
      throw new Error("REDIS_UNREACHABLE");
    }

    const current = this.leases.get(params.lockKey);
    if (current && current.expiresAtMs > params.nowMs) {
      if (current.ownerId === params.ownerId) {
        return current;
      }
      return null;
    }

    const nextToken = (this.fencingCounters.get(params.lockKey) ?? 0) + 1;
    this.fencingCounters.set(params.lockKey, nextToken);

    const record: LeaseAcquisitionRecord = {
      ownerId: params.ownerId,
      fencingToken: nextToken,
      expiresAtMs: params.nowMs + params.ttlMs,
    };
    this.leases.set(params.lockKey, record);
    return record;
  }

  public async renewLeaseIfOwner(params: {
    lockKey: string;
    ownerId: string;
    fencingToken: number;
    ttlMs: number;
    nowMs: number;
  }): Promise<LeaseAcquisitionRecord | null> {
    if (!this.reachable) {
      throw new Error("REDIS_UNREACHABLE");
    }

    const current = this.leases.get(params.lockKey);
    if (
      !current ||
      current.ownerId !== params.ownerId ||
      current.fencingToken !== params.fencingToken ||
      current.expiresAtMs <= params.nowMs
    ) {
      return null;
    }

    const renewed: LeaseAcquisitionRecord = {
      ...current,
      expiresAtMs: params.nowMs + params.ttlMs,
    };
    this.leases.set(params.lockKey, renewed);
    return renewed;
  }

  public async releaseLeaseIfOwner(params: {
    lockKey: string;
    ownerId: string;
  }): Promise<boolean> {
    if (!this.reachable) {
      throw new Error("REDIS_UNREACHABLE");
    }

    const current = this.leases.get(params.lockKey);
    if (!current || current.ownerId !== params.ownerId) {
      return false;
    }
    this.leases.delete(params.lockKey);
    return true;
  }
}

export class OracleLeaderElector {
  private readonly store: RedisLeaseBackingStore;
  private readonly lockKey: string;
  public readonly instanceId: string;
  private readonly leaseTtlMs: number;

  private activeLease: LeaseAcquisitionRecord | null = null;
  private lastError: string | null = null;

  constructor(options: {
    store: RedisLeaseBackingStore;
    instanceId: string;
    lockKey?: string;
    leaseTtlMs?: number;
  }) {
    this.store = options.store;
    this.instanceId = options.instanceId;
    this.lockKey = options.lockKey ?? "refract:oracle:leader_lock";
    this.leaseTtlMs = options.leaseTtlMs ?? 15_000;
  }

  public async acquire(nowMs: number = Date.now()): Promise<boolean> {
    try {
      const lease = await this.store.tryAcquireLease({
        lockKey: this.lockKey,
        ownerId: this.instanceId,
        ttlMs: this.leaseTtlMs,
        nowMs,
      });
      this.activeLease = lease;
      this.lastError = null;
      return lease !== null;
    } catch (err) {
      // Fail-safe on Redis outage: immediately step down so we never double-publish
      this.activeLease = null;
      this.lastError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  public async renew(nowMs: number = Date.now()): Promise<boolean> {
    if (!this.activeLease) {
      return this.acquire(nowMs);
    }

    try {
      const renewed = await this.store.renewLeaseIfOwner({
        lockKey: this.lockKey,
        ownerId: this.instanceId,
        fencingToken: this.activeLease.fencingToken,
        ttlMs: this.leaseTtlMs,
        nowMs,
      });
      this.activeLease = renewed;
      this.lastError = null;
      return renewed !== null;
    } catch (err) {
      this.activeLease = null;
      this.lastError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  public async release(): Promise<boolean> {
    if (!this.activeLease) return false;
    try {
      const released = await this.store.releaseLeaseIfOwner({
        lockKey: this.lockKey,
        ownerId: this.instanceId,
      });
      this.activeLease = null;
      return released;
    } catch {
      this.activeLease = null;
      return false;
    }
  }

  public isLeader(nowMs: number = Date.now()): boolean {
    return (
      this.activeLease !== null && this.activeLease.expiresAtMs > nowMs
    );
  }

  public getFencingToken(nowMs: number = Date.now()): number | null {
    if (!this.isLeader(nowMs)) return null;
    return this.activeLease!.fencingToken;
  }

  public getHealthSnapshot(nowMs: number = Date.now()): {
    instanceId: string;
    isLeader: boolean;
    fencingToken: number | null;
    leaderGaugeMetric: 0 | 1;
    lastError: string | null;
  } {
    const leader = this.isLeader(nowMs);
    return {
      instanceId: this.instanceId,
      isLeader: leader,
      fencingToken: leader ? this.activeLease!.fencingToken : null,
      leaderGaugeMetric: leader ? 1 : 0,
      lastError: this.lastError,
    };
  }
}

export class FencedSingleFlightPublisherGuard {
  private highestFencingToken = 0;

  public validateAndAdvanceFencingToken(fencingToken: number | null): void {
    if (fencingToken === null || !Number.isFinite(fencingToken)) {
      throw new Error(
        "MISSING_LEADER_LEASE: Caller does not hold an active leader fencing token"
      );
    }
    if (fencingToken < this.highestFencingToken) {
      throw new Error(
        `STALE_FENCING_TOKEN_REJECTED: Token ${fencingToken} is older than current fencing watermark ${this.highestFencingToken}`
      );
    }
    this.highestFencingToken = fencingToken;
  }
}
