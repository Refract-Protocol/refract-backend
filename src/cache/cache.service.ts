import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { AppConfig } from "../config/configuration";

/**
 * CacheService — thin, typed wrapper around ioredis.
 *
 * Design goals
 * ------------
 * - Single Redis connection per process, shared across all consumers.
 * - Fail-open: every public method swallows Redis errors and falls back
 *   to the non-cached path so a Redis outage never brings down the API.
 * - `wrap<T>()` is the primary interface: "return cached value or run
 *   the loader, cache the result, return it."
 *
 * TTL conventions (seconds)
 * -------------------------
 * ORACLE_TTL   55 s — just under the 60 s scheduler interval so the
 *              HTTP endpoint always returns data that is at most one
 *              cycle stale without issuing a redundant upstream call.
 */
export const ORACLE_TTL = 55;

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private client!: Redis;

  constructor(private readonly configService: ConfigService<AppConfig, true>) {}

  onModuleInit(): void {
    const { url } = this.configService.get("redis", { infer: true });
    this.client = new Redis(url, {
      // Don't retry indefinitely — give up after 3 reconnection attempts
      // so a missing Redis doesn't stall startup.
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: false,
    });

    this.client.on("connect", () => this.logger.log("Redis connected"));
    this.client.on("error", (err: Error) =>
      this.logger.warn(`Redis error (cache degraded): ${err.message}`)
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }

  /** Returns the parsed JSON value for `key`, or `null` on miss or error. */
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      this.logger.warn(`cache.get("${key}") failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Serialises `value` to JSON and stores it under `key` for `ttlSeconds`. */
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, JSON.stringify(value), "EX", ttlSeconds);
    } catch (err) {
      this.logger.warn(`cache.set("${key}") failed: ${(err as Error).message}`);
    }
  }

  /** Deletes one or more keys (best-effort). */
  async del(...keys: string[]): Promise<void> {
    try {
      if (keys.length > 0) await this.client.del(...keys);
    } catch (err) {
      this.logger.warn(`cache.del(${keys.join(",")}) failed: ${(err as Error).message}`);
    }
  }

  /**
   * Cache-aside helper.
   *
   * Returns the cached value for `key` when present.  Otherwise calls
   * `loader`, stores the result for `ttlSeconds`, and returns it.
   * If either the cache read or write throws, the loader result is
   * returned without caching (fail-open).
   *
   * @example
   * const readings = await this.cacheService.wrap(
   *   "oracle:checkAll",
   *   ORACLE_TTL,
   *   () => this.runAllChecks()
   * );
   */
  async wrap<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const fresh = await loader();
    await this.set(key, fresh, ttlSeconds);
    return fresh;
  }
}
