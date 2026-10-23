import { Global, Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { SorobanRpcService } from "./soroban-rpc.service";
import { ContractSpecRevalidator } from "./contract-spec-revalidator";
import { OpsContractSpecController } from "./ops-contract-spec.controller";
import { AlertingModule } from "../alerting/alerting.module";
import { DbModule } from "../db/db.module";

/**
 * Global so Policy/Pool/Claim/Tx modules need no import churn — same
 * precedent as ConfigModule.forRoot({ isGlobal: true }).
 */
@Global()
@Module({
  imports: [ScheduleModule, AlertingModule, DbModule],
  providers: [SorobanRpcService, ContractSpecRevalidator],
  controllers: [OpsContractSpecController],
  exports: [SorobanRpcService, ContractSpecRevalidator],
})
export class StellarModule {}
