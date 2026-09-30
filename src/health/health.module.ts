import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import { SorobanRpcService } from "../stellar/soroban-rpc.service";
import { OracleService } from "../oracle/oracle.service";
import { ClaimSettlementService } from "../claim/claim-settlement.service";

@Module({
  controllers: [HealthController],
  providers: [
    HealthService,
    SorobanRpcService,
    OracleService,
    ClaimSettlementService,
  ],
  exports: [HealthService],
})
export class HealthModule {}
