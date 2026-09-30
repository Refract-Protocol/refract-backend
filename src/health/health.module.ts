import { Module } from "@nestjs/common";
import { StellarModule } from "../stellar/stellar.module";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import { SorobanRpcService } from "../stellar/soroban-rpc.service";
import { OracleService } from "../oracle/oracle.service";
import { ClaimSettlementService } from "../claim/claim-settlement.service";

// DatabaseModule is @Global(), so DatabaseService is available here
// without a local import — the controller receives it via DI automatically.
@Module({
  imports: [StellarModule],
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
