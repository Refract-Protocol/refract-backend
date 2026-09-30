import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { ScheduleModule } from "@nestjs/schedule";
import configuration from "./config/configuration";
import { CacheModule } from "./cache/cache.module";
import { ClaimModule } from "./claim/claim.module";
import { DbModule } from "./db/db.module";
import { DatabaseModule } from "./db/database.module";
import { IdempotencyModule } from "./common/idempotency.module";
import { HealthModule } from "./health/health.module";
import { OracleModule } from "./oracle/oracle.module";
import { PolicyModule } from "./policy/policy.module";
import { PoolModule } from "./pool/pool.module";
import { QuoteModule } from "./quote/quote.module";
import { StellarModule } from "./stellar/stellar.module";
import { TxModule } from "./tx/tx.module";
import { HealthModule } from "./health/health.module";
import { AuthModule } from "./auth/auth.module";
import { ApiKeyGuard } from "./auth/api-key.guard";
import configuration, { AppConfig } from "./config/configuration";
import { StellarModule } from "./stellar/stellar.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        throttlers: [
          {
            name: "upstream",
            ttl: config.get("throttle.upstream.ttl", { infer: true }),
            limit: config.get("throttle.upstream.limit", { infer: true }),
          },
          {
            name: "chain",
            ttl: config.get("throttle.chain.ttl", { infer: true }),
            limit: config.get("throttle.chain.limit", { infer: true }),
          },
          {
            name: "default",
            ttl: config.get("throttle.default.ttl", { infer: true }),
            limit: config.get("throttle.default.limit", { infer: true }),
          },
          {
            name: "catalog",
            ttl: config.get("throttle.catalog.ttl", { infer: true }),
            limit: config.get("throttle.catalog.limit", { infer: true }),
          },
        ],
      }),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        type: "postgres",
        url: config.get("databaseUrl", { infer: true }),
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    IdempotencyModule,
    // CacheModule is @Global — imported once here, available everywhere.
    CacheModule,
    StellarModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
    HealthModule,
    AuthModule,
    QuoteModule,
    PolicyModule,
    PoolModule,
    OracleModule,
    ClaimModule,
    TxModule,
    DbModule,
    // CacheModule is @Global — imported once here, available everywhere.
    CacheModule,
    HealthModule,
    AuthModule,
    QuoteModule,
    PolicyModule,
    PoolModule,
    OracleModule,
    ClaimModule,
    TxModule,
    StellarModule,
  ],
})
export class AppModule {}
