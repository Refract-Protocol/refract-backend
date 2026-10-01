import { Module, OnApplicationShutdown, OnModuleInit, Logger } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import configuration, { AppConfig } from './config/configuration';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ClaimsModule } from './claims/claims.module';
import { OracleModule } from './oracle/oracle.module';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { CacheModule } from './cache/cache.module';
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
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        throttlers: [
          {
            name: 'upstream',
            ttl: config.get('throttle.upstream.ttl', { infer: true }),
            limit: config.get('throttle.upstream.limit', { infer: true }),
          },
          {
            name: 'chain',
            ttl: config.get('throttle.chain.ttl', { infer: true }),
            limit: config.get('throttle.chain.limit', { infer: true }),
          },
          {
            name: 'default',
            ttl: config.get('throttle.default.ttl', { infer: true }),
            limit: config.get('throttle.default.limit', { infer: true }),
          },
          {
            name: 'catalog',
            ttl: config.get('throttle.catalog.ttl', { infer: true }),
            limit: config.get('throttle.catalog.limit', { infer: true }),
          },
        ],
      }),
    }),
    ScheduleModule.forRoot(),
    // In sandbox mode we skip the real Postgres connection entirely so
    // `npm run dev` works right after `npm install` with no other setup.
    ...(isSandboxMode()
      ? []
      : [
          TypeOrmModule.forRootAsync({
            imports: [DatabaseModule],
            inject: [DatabaseModule],
            useFactory: (databaseModule: DatabaseModule) =>
              databaseModule.getTypeOrmConfig(),
          }),
        ]),
    DatabaseModule,
    IdempotencyModule,
    // CacheModule is @Global — imported once here, available everywhere.
    CacheModule,
    StellarModule,
    DbModule,
    HealthModule,
    AuthModule,
    QuoteModule,
    PolicyModule,
    PoolModule,
    RedisModule,
    ClaimsModule,
    OracleModule,
    ClaimModule,
    TxModule,
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
export class AppModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AppModule.name);

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    if (!isSandboxMode()) {
      return;
    }

    const nodeEnv = (
      this.configService.get<string>('NODE_ENV') ??
      process.env.NODE_ENV ??
      ''
    ).toLowerCase();

    // Boot-time safety check: sandbox mode is a local-only onboarding tool
    // and must never be reachable from a production-configured deployment.
    if (nodeEnv === 'production') {
      throw new Error(
        'SANDBOX_MODE=true is not allowed when NODE_ENV=production. ' +
          'Sandbox mode is a local contributor-onboarding tool only.',
      );
    }

    this.logger.warn(
      '============================================================',
    );
    this.logger.warn(
      '  SANDBOX MODE ENABLED — NOT A REAL ENVIRONMENT',
    );
    this.logger.warn(
      '  Postgres, Redis, and Soroban RPC are replaced with in-memory',
    );
    this.logger.warn(
      '  mocks. All data resets on restart. Do not use outside local dev.',
    );
    this.logger.warn(
      '============================================================',
    );
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(
      `Application shutdown initiated${signal ? ` (signal: ${signal})` : ''} — draining schedulers and connection pools`,
    );
  }
}
