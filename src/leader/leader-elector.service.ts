import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { AlertingService } from '../alerting/alerting.service';
import { MetricsService } from '../metrics/metrics.service';

const LEASE_KEY = 'refract:oracle:leader';
const FENCING_EPOCH_KEY = 'refract:oracle:leader:epoch';
const DEFAULT_LEASE_TTL_MS = 15_000;
const DEFAULT_LEASE_RENEW_MS = 5_000;

/** Extend the lease only if this instance still owns it. */
const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

/** Delete the lease only if this instance still owns it. */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * Redis-backed lease guarding the oracle poll → publish → settle pipeline so
 * only one replica at a time polls providers, publishes to RefractOracle, or
 * settles claims.
 *
 * - Acquire: `SET NX PX` on a single key; the holder's fencing token is the
 *   `INCR` of a monotonic epoch counter taken right after acquisition.
 * - Renew: compare-and-extend via Lua, so a stale holder cannot extend a lease
 *   it no longer owns.
 * - Fail-safe: leadership is only trusted until a local deadline derived from
 *   the lease TTL. If Redis is unreachable or renewals stop, the instance steps
 *   down and `isLeader()` turns false before any other replica can acquire.
 *
 * With ORACLE_LEADER_ELECTION=false the elector is a no-op and this instance
 * always reports leadership (single-replica deployments).
 */
@Injectable()
export class LeaderElector implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(LeaderElector.name);
  private readonly instanceId = randomUUID();
  private readonly enabled: boolean;
  private readonly leaseTtlMs: number;
  private readonly renewMs: number;
  private readonly client: Redis | null;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private fencingToken: number | null = null;
  private leaseDeadline = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly metrics: MetricsService,
    private readonly alerting: AlertingService,
  ) {
    this.enabled =
      (this.configService.get<string>('ORACLE_LEADER_ELECTION') ?? 'true').trim().toLowerCase() !== 'false';
    this.leaseTtlMs = this.intFromEnv('ORACLE_LEASE_TTL_MS', DEFAULT_LEASE_TTL_MS);
    this.renewMs = this.intFromEnv('ORACLE_LEASE_RENEW_MS', DEFAULT_LEASE_RENEW_MS);

    if (this.renewMs >= this.leaseTtlMs) {
      throw new Error('ORACLE_LEASE_RENEW_MS must be less than ORACLE_LEASE_TTL_MS');
    }

    this.client = this.enabled
      ? new Redis(this.configService.get<string>('REDIS_URL', 'redis://localhost:6379'), {
          lazyConnect: false,
        })
      : null;
    this.client?.on('error', (err) => {
      this.logger.error(`Leader election Redis client error: ${err.message}`);
    });
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.metrics.setOracleLeader(true);
      this.logger.warn('Oracle leader election disabled (ORACLE_LEADER_ELECTION=false); running as sole leader.');
      return;
    }

    this.timer = setInterval(() => void this.tick(), this.renewMs);
    void this.tick();
    this.logger.log(
      `Oracle leader election started (lease ttl=${this.leaseTtlMs}ms, renew=${this.renewMs}ms, instance=${this.instanceId})`,
    );
  }

  /** True only while this instance holds an unexpired lease. */
  isLeader(): boolean {
    if (!this.enabled) {
      return true;
    }
    return this.fencingToken !== null && Date.now() < this.leaseDeadline;
  }

  /**
   * Call immediately before each side-effecting step (provider write, on-chain
   * publish, claim settlement). Throws if leadership is lost; otherwise returns
   * the fencing token the write must carry. Returns 0 when election is disabled.
   */
  assertLeadership(): number {
    if (!this.enabled) {
      return 0;
    }
    if (!this.isLeader() || this.fencingToken === null) {
      throw new Error('Oracle leadership not held; refusing side-effecting step');
    }
    return this.fencingToken;
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.release(signal);
    await this.client?.quit().catch(() => this.client?.disconnect());
  }

  private async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      if (this.fencingToken === null) {
        await this.acquire();
      } else {
        await this.renew();
      }
    } catch (error) {
      this.handleRedisError(error);
    } finally {
      this.ticking = false;
    }
  }

  private async acquire(): Promise<void> {
    const startedAt = Date.now();
    const result = await this.redis().set(LEASE_KEY, this.instanceId, 'PX', this.leaseTtlMs, 'NX');
    if (result !== 'OK') {
      this.metrics.setOracleLeader(false);
      return;
    }

    this.fencingToken = await this.redis().incr(FENCING_EPOCH_KEY);
    this.leaseDeadline = startedAt + this.leaseTtlMs;
    this.metrics.setOracleLeader(true);
    this.logger.log(`Acquired oracle leadership (fencing token ${this.fencingToken})`);
  }

  private async renew(): Promise<void> {
    const startedAt = Date.now();
    const renewed = await this.redis().eval(RENEW_SCRIPT, 1, LEASE_KEY, this.instanceId, this.leaseTtlMs);
    if (Number(renewed) !== 1) {
      this.stepDown('lease was taken over by another instance');
      return;
    }
    this.leaseDeadline = startedAt + this.leaseTtlMs;
  }

  private async release(signal?: string): Promise<void> {
    if (this.client === null || this.fencingToken === null) {
      return;
    }
    try {
      await this.client.eval(RELEASE_SCRIPT, 1, LEASE_KEY, this.instanceId);
      this.logger.log(`Released oracle leadership on shutdown${signal ? ` (signal: ${signal})` : ''}`);
    } catch (error) {
      this.logger.error(`Failed to release oracle lease: ${(error as Error).message}`);
    } finally {
      this.stepDown('shutdown');
    }
  }

  private handleRedisError(error: unknown): void {
    const message = (error as Error).message;
    if (this.fencingToken !== null) {
      this.stepDown(`Redis unavailable: ${message}`);
    }
    this.alerting.emit('critical', 'Oracle leader election Redis failure', message, {
      instanceId: this.instanceId,
    });
  }

  private stepDown(reason: string): void {
    this.fencingToken = null;
    this.leaseDeadline = 0;
    this.metrics.setOracleLeader(false);
    this.logger.warn(`Stepped down from oracle leadership: ${reason}. Publishing is suspended.`);
  }

  private redis(): Redis {
    if (this.client === null) {
      throw new Error('Leader election Redis client is not initialized');
    }
    return this.client;
  }

  private intFromEnv(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    if (raw === undefined || raw.trim() === '') {
      return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`${key} must be a positive integer`);
    }
    return parsed;
  }
}
