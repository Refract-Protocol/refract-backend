import { Module } from "@nestjs/common";
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
import { PoolContractInterfaceService } from "./stellar/pool-contract-interface.service";

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
  providers: [PoolContractInterfaceService],
})
export class AppModule {}
