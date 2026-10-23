import { randomUUID } from "crypto";

/**
 * Lock that makes one replica the oracle pipeline's leader (the one that
 * polls and publishes). Releasing it on shutdown lets another replica take
 * over right away, instead of waiting for the TTL to run out.
 */
export interface LeaderLock {
  /** Acquires the lock, or renews it if held. Returns true if this replica leads. */
  acquire(): Promise<boolean>;
  release(): Promise<void>;
  isHeld(): boolean;
  /** Closes any connection the lock owns. */
  close(): Promise<void>;
}

/** Single-replica deployments: this process is always the leader. */
export class LocalLeaderLock implements LeaderLock {
  private held = false;
  async acquire(): Promise<boolean> {
    this.held = true;
    return true;
  }
  async release(): Promise<void> {
    this.held = false;
  }
  isHeld(): boolean {
    return this.held;
  }
  async close(): Promise<void> {}
}

/** The subset of an ioredis client the lock uses. */
export interface RedisLockClient {
  set(key: string, value: string, px: "PX", ttlMs: number, nx: "NX"): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  quit(): Promise<unknown>;
}

// Renew and release only if we still own the key. Without the token check, a
// replica whose lock expired could extend or delete the new leader's lock.
const RENEW_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export class RedisLeaderLock implements LeaderLock {
  private held = false;

  constructor(
    private readonly client: RedisLockClient,
    private readonly key: string,
    private readonly ttlMs: number,
    private readonly token: string = randomUUID(),
  ) {}

  async acquire(): Promise<boolean> {
    if (this.held) {
      const renewed = await this.client.eval(RENEW_SCRIPT, 1, this.key, this.token, this.ttlMs);
      if (Number(renewed) === 1) return true;
      this.held = false;
    }
    const ok = await this.client.set(this.key, this.token, "PX", this.ttlMs, "NX");
    this.held = ok === "OK";
    return this.held;
  }

  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    await this.client.eval(RELEASE_SCRIPT, 1, this.key, this.token);
  }

  isHeld(): boolean {
    return this.held;
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}
