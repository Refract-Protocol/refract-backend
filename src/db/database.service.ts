import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow } from "pg";
import { AppConfig } from "../config/configuration";

/**
 * Thin wrapper around `pg.Pool` that adds:
 *
 *  • Pool sizing pulled from env (DB_POOL_MAX, DB_POOL_MIN,
 *    DB_POOL_IDLE_TIMEOUT_MS, DB_POOL_ACQUIRE_TIMEOUT_MS)
 *  • Per-statement timeout injected as a `SET statement_timeout` default
 *    (DB_STATEMENT_TIMEOUT_MS, default 30 s)
 *  • Bounded retry-with-exponential-backoff on startup so a slow Postgres
 *    readiness probe doesn't crash the app immediately
 *    (DB_CONNECT_RETRIES, DB_CONNECT_RETRY_DELAY_MS)
 *  • Pool telemetry (total/idle/waiting) exposed via getPoolStats() for the
 *    health endpoint
 *  • Clean drain on process shutdown via OnApplicationShutdown
 */
@Injectable()
export class DatabaseService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  private pool!: Pool;

  /** Set to true once the startup probe confirms at least one connection. */
  private _ready = false;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async onApplicationBootstrap(): Promise<void> {
    const db = this.config.get("database", { infer: true });

    const poolConfig: PoolConfig = {
      connectionString: db.url,
      max: db.poolMax,
      min: db.poolMin,
      idleTimeoutMillis: db.poolIdleTimeoutMs,
      connectionTimeoutMillis: db.poolAcquireTimeoutMs,
      // Per-connection statement_timeout so slow queries cannot pin a
      // connection indefinitely — every client in the pool inherits this.
      // `statement_timeout` is a Postgres session-level GUC; setting it
      // here means every statement issued through this pool is subject to
      // the cap without callers having to SET it themselves.
      options: `--statement_timeout=${db.statementTimeoutMs}`,
    };

    this.pool = new Pool(poolConfig);

    // Surface pg's internal error events (e.g. idle-client errors after a
    // Postgres restart) to the logger rather than crashing the process.
    this.pool.on("error", (err) => {
      this.logger.error("pg pool background error", err.message);
    });

    await this.probeWithRetry(db.connectRetries, db.connectRetryDelayMs);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.pool) {
      this.logger.log("Draining pg pool…");
      await this.pool.end();
      this.logger.log("pg pool closed");
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /** True once the startup probe confirmed a live connection. */
  get isReady(): boolean {
    return this._ready;
  }

  /** Execute a parameterized query. Throws on database error. */
  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[]
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(sql, values);
  }

  /** Acquire a client for multi-statement transactions. Caller must release. */
  async getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  /** Pool saturation telemetry for the health endpoint. */
  getPoolStats(): { total: number; idle: number; waiting: number } {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  // ─── Startup probe ────────────────────────────────────────────────────────

  private async probeWithRetry(maxRetries: number, delayMs: number): Promise<void> {
    let attempt = 0;
    while (true) {
      try {
        const client = await this.pool.connect();
        try {
          await client.query("SELECT 1");
        } finally {
          client.release();
        }
        this._ready = true;
        this.logger.log(
          `Database connection established (pool max=${this.pool.totalCount}, attempt ${attempt + 1})`
        );
        return;
      } catch (err) {
        attempt++;
        const message = err instanceof Error ? err.message : String(err);
        if (attempt >= maxRetries) {
          this.logger.error(
            `Database unreachable after ${maxRetries} attempt(s). Last error: ${message}`
          );
          // Don't crash the process — let the health endpoint report
          // degraded and allow Kubernetes/ECS to restart the pod if
          // needed, rather than looping forever or exiting silently.
          return;
        }
        const backoff = Math.min(delayMs * 2 ** (attempt - 1), 30_000);
        this.logger.warn(
          `Database probe attempt ${attempt}/${maxRetries} failed: ${message}. Retrying in ${backoff} ms…`
        );
        await sleep(backoff);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
