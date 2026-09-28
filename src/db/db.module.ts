import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Pool } from "pg";
import { AppConfig } from "../config/configuration";

/**
 * Provides a single `pg.Pool` instance to any module that imports DbModule.
 * Marked @Global so every feature module can inject PG_POOL without
 * explicitly importing DbModule themselves — it's registered once in
 * AppModule and that's it.
 */
export const PG_POOL = Symbol("PG_POOL");

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const db = config.get("database", { infer: true });
        return new Pool({ connectionString: db.url });
      },
    },
  ],
  exports: [PG_POOL],
})
export class DbModule {}
