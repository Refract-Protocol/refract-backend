import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import configuration from "./config/configuration";
import { HealthModule } from "./health/health.module";
import { QuoteModule } from "./quote/quote.module";
import { PolicyModule } from "./policy/policy.module";
import { PoolModule } from "./pool/pool.module";
import { OracleModule } from "./oracle/oracle.module";
import { ClaimModule } from "./claim/claim.module";
import { TxModule } from "./tx/tx.module";
import { RateLimitGuard } from "./common/rate-limit";
import { AdminApiKeyGuard } from "./common/admin-auth";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    ScheduleModule.forRoot(),
    HealthModule,
    QuoteModule,
    PolicyModule,
    PoolModule,
    OracleModule,
    ClaimModule,
    TxModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AdminApiKeyGuard },
  ],
})
export class AppModule {}
