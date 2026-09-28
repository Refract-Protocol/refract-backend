import { Inject, Injectable, Module, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Pool as PostgresPool } from "pg";
import { AppConfig } from "../config/configuration";

export const DATABASE_POOL = Symbol("DATABASE_POOL");

@Injectable()
class DatabaseShutdown implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_POOL) private readonly pool: PostgresPool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      useFactory: (configService: ConfigService<AppConfig, true>) =>
        new PostgresPool({ connectionString: configService.get("database.url", { infer: true }) }),
      inject: [ConfigService],
    },
    DatabaseShutdown,
  ],
  exports: [DATABASE_POOL],
})
export class DatabaseModule {}
