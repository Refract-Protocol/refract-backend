import { Global, Inject, Injectable, Logger, Module, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Pool } from "pg";
import { AppConfig } from "../config/configuration";

/** Injection token used by every repository to receive the shared Pool. */
export const DATABASE_POOL = "DATABASE_POOL";

/**
 * Drains the pool on application shutdown so sockets are not leaked when
 * the process receives SIGTERM.  Relies on app.enableShutdownHooks() in
 * main.ts (added alongside this module).
 */
@Injectable()
class DatabaseShutdownHook implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseShutdownHook.name);

  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`Draining pg Pool (signal: ${signal ?? "unknown"})`);
    await this.pool.end();
  }
}

/**
 * Global DatabaseModule — creates a single pg.Pool bound to DATABASE_URL
 * and destroys it cleanly on SIGTERM / SIGINT (requires
 * app.enableShutdownHooks() in main.ts).
 *
 * Exporting the Pool token as a constant keeps repositories independent
 * of any NestJS lifecycle helper; they just @Inject(DATABASE_POOL) and
 * call pool.query() directly.
 */
@Global()
@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>): Pool => {
        const connectionString = config.get("database", { infer: true }).url;
        return new Pool({
          connectionString,
          max: 10,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        });
      },
    },
    DatabaseShutdownHook,
  ],
  exports: [DATABASE_POOL],
})
export class DatabaseModule {}
