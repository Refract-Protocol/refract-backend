import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { AppConfig } from "../config/configuration";

/**
 * Thin `pg` Pool wrapper. Construction is graceful when `DATABASE_URL` is
 * missing or empty so unit tests can boot Nest modules without Postgres.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  private readonly pool: Pool | null;

  constructor(configService: ConfigService<AppConfig, true>) {
    // Prefer the raw env var so tests can unset DATABASE_URL even when the
    // typed config factory still supplies a localhost default.
    const fromEnv = process.env.DATABASE_URL?.trim();
    const fromConfig = configService.get("database", { infer: true })?.url?.trim();
    const url = fromEnv === "" ? "" : fromEnv || fromConfig;
    if (!url) {
      this.logger.warn("DATABASE_URL unset — DbService running without a pool");
      this.pool = null;
      return;
    }
    this.pool = new Pool({ connectionString: url });
    this.pool.on("error", (err) => {
      this.logger.error("Unexpected Postgres pool error", err.stack);
    });
  }

  /** True when a live Pool was created from DATABASE_URL. */
  isAvailable(): boolean {
    return this.pool !== null;
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    if (!this.pool) {
      throw new Error("Database pool unavailable (DATABASE_URL not configured)");
    }
    return this.pool.query<T>(text, params);
  }

  async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!this.pool) {
      throw new Error("Database pool unavailable (DATABASE_URL not configured)");
    }
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }
}
