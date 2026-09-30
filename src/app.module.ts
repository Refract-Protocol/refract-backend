import { Module, OnApplicationShutdown, Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ClaimsModule } from './claims/claims.module';
import { OracleModule } from './oracle/oracle.module';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      imports: [DatabaseModule],
      inject: [DatabaseModule],
      useFactory: (databaseModule: DatabaseModule) => databaseModule.getTypeOrmConfig(),
    }),
    DatabaseModule,
    RedisModule,
    ClaimsModule,
    OracleModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements OnApplicationShutdown {
  private readonly logger = new Logger(AppModule.name);

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(
      `Application shutdown initiated${signal ? ` (signal: ${signal})` : ''} — draining schedulers and connection pools`,
    );
  }
}
