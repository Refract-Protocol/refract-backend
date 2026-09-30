import { Module, OnApplicationShutdown, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ClaimsModule } from './claims/claims.module';
import { OracleModule } from './oracle/oracle.module';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';

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
    ConfigModule.forRoot({ isGlobal: true }),
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
    RedisModule,
    ClaimsModule,
    OracleModule,
  ],
  controllers: [AppController],
  providers: [AppService],
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
