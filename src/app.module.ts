import { Module, OnApplicationShutdown, OnModuleInit, Logger, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { jsonBodyDepthLimit } from './common/request-body-limits.middleware';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import configuration, { AppConfig } from './config/configuration';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ClaimsModule } from './claims/claims.module';
import { OracleModule } from './oracle/oracle.module';
import { OracleBootstrapModule } from './oracle/bootstrap/oracle-bootstrap.module';
import { OracleAdminModule } from './oracle/admin/oracle-admin.module';
import { ConsensusModule } from './oracle/consensus/consensus.module';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { CacheModule } from './cache/cache.module';
import { LeaderModule } from './leader/leader.module';
import { ClaimModule } from './claim/claim.module';
import { DbModule } from './db/db.module';
import { IdempotencyModule } from './common/idempotency.module';
import { HealthModule } from './health/health.module';
import { PolicyModule } from './policy/policy.module';
import { PoolModule } from './pool/pool.module';
import { QuoteModule } from './quote/quote.module';
import { StellarModule } from './stellar/stellar.module';
import { TxModule } from './tx/tx.module';
import { AuthModule } from './auth/auth.module';
import { ApiKeyGuard } from './auth/api-key.guard';
import { SecurityReportsModule } from './security-reports/security-reports.module';
import { DigestModule } from './digest/digest.module';
import { ReadingBusModule } from './oracle/reading-bus.module';
import { OracleFeedModule } from './oracle/oracle-feed.module';
import { OracleIngestionModule } from './oracle/sources/oracle-ingestion.module';
import { OracleRegionsModule } from './oracle/regions/oracle-regions.module';
import { ReevaluationModule } from './claim/reevaluation/reevaluation.module';
import { OraclePipelineModule } from './oracle/shutdown/oracle-pipeline.module';
import { ProviderEndpointsModule } from './oracle/endpoints/provider-endpoints.module';
import { OracleSandboxModule } from './oracle/sandbox/oracle-sandbox.module';
import { isOracleSandboxEnabled } from './oracle/sandbox/oracle-sandbox.config';
import { FeedsModule } from './feeds/feeds.module';
import { OperatorsModule } from './routes/operators';
import { StakingModule } from './routes/staking';
import { EventsModule } from './events/events.module';
import { MetricsModule } from './metrics/metrics.module';

/**
 * Sandbox mode lets the full API run with zero external dependencies
 * (no Postgres, Redis, or Soroban RPC) using in-memory/mocked backing
 * services. It is a contributor-onboarding tool only and must never be
 * used in a deployed environment.
 */
export const isSandboxMode = (): boolean =>
  (process.env.SANDBOX_MODE ?? '').toLowerCase() === 'true';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        throttlers: [
          { name: "upstream", ...config.get("throttle.upstream", { infer: true }) },
          { name: "chain", ...config.get("throttle.chain", { infer: true }) },
          { name: "default", ...config.get("throttle.default", { infer: true }) },
          { name: "catalog", ...config.get("throttle.catalog", { infer: true }) },
        ],
      }),
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    IdempotencyModule,
    // CacheModule is @Global — imported once here, available everywhere.
    CacheModule,
    // LeaderModule gates oracle polling and claim settlement on the Redis lease.
    LeaderModule,
    StellarModule,
    DbModule,
    HealthModule,
    MetricsModule,
    EventsModule,
    QuoteModule,
    PolicyModule,
    PoolModule,
    RedisModule,
    ClaimsModule,
    // Global: in-flight tracking, leader lock, and bounded shutdown drain.
    OraclePipelineModule,
    // Global: per-adapter endpoint lists with health-based failover.
    ProviderEndpointsModule,
    OracleModule,
    // Read side of the oracle: relays readings the worker publishes.
    ReadingBusModule,
    OracleFeedModule,
    OracleBootstrapModule,
    OracleAdminModule,
    ConsensusModule,
    ClaimModule,
    TxModule,
    SecurityReportsModule,
    DigestModule,
    OracleIngestionModule,
    OracleRegionsModule,
    ReevaluationModule,
    FeedsModule,
    OperatorsModule,
    StakingModule,
    // Provider sandbox API (signed readings → corroboration, never on-chain).
    ...(isOracleSandboxEnabled() ? [OracleSandboxModule] : []),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(jsonBodyDepthLimit).forRoutes('*');
  }
}
