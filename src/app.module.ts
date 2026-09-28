import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
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
import { SecurityAuditInterceptor } from "./common/security-audit.interceptor";
import { SecurityAuditLogger } from "./common/security-audit.logger";

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
    SecurityAuditLogger,
    {
      provide: APP_INTERCEPTOR,
      useClass: SecurityAuditInterceptor,
    },
  ],
})
export class AppModule {}
