import { Inject, Logger, Module, OnModuleDestroy } from "@nestjs/common";
import { Pool } from "pg";
import { isSandboxMode } from "../../config/configuration";
import { BootstrapStore, InMemoryBootstrapStore, PgBootstrapStore } from "./bootstrap.store";
import {
  CoinGeckoHistoryProvider,
  DefiLlamaHistoryProvider,
  HistoryProviderRegistry,
} from "./history-providers";
import { SourceBootstrapService } from "./source-bootstrap.service";

export const ORACLE_BOOTSTRAP_PG_POOL = Symbol("ORACLE_BOOTSTRAP_PG_POOL");
export const ORACLE_BOOTSTRAP_STORE = Symbol("ORACLE_BOOTSTRAP_STORE");

const logger = new Logger("OracleBootstrap");

/**
 * Provides SourceBootstrapService. Uses Postgres when DATABASE_URL is set
 * (apply src/db/migrations/004_oracle_source_bootstrap.sql first) and an
 * in-memory store in sandbox mode or when no database is configured.
 */
@Module({
  providers: [
    {
      provide: ORACLE_BOOTSTRAP_PG_POOL,
      useFactory: (): Pool | null =>
        !isSandboxMode() && process.env.DATABASE_URL
          ? new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
          : null,
    },
    {
      provide: ORACLE_BOOTSTRAP_STORE,
      inject: [ORACLE_BOOTSTRAP_PG_POOL],
      useFactory: (pool: Pool | null): BootstrapStore => {
        if (pool) return new PgBootstrapStore(pool);
        logger.warn("No DATABASE_URL (or sandbox mode): oracle bootstrap baselines are kept in memory only");
        return new InMemoryBootstrapStore();
      },
    },
    {
      provide: HistoryProviderRegistry,
      useFactory: () =>
        new HistoryProviderRegistry([new CoinGeckoHistoryProvider(), new DefiLlamaHistoryProvider()]),
    },
    {
      provide: SourceBootstrapService,
      inject: [ORACLE_BOOTSTRAP_STORE, HistoryProviderRegistry],
      useFactory: (store: BootstrapStore, providers: HistoryProviderRegistry) =>
        new SourceBootstrapService(store, providers, {
          logger: { log: (m) => logger.log(m), warn: (m) => logger.warn(m) },
        }),
    },
  ],
  exports: [SourceBootstrapService, HistoryProviderRegistry],
})
export class OracleBootstrapModule implements OnModuleDestroy {
  constructor(@Inject(ORACLE_BOOTSTRAP_PG_POOL) private readonly pool: Pool | null) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}
