import { Module } from "@nestjs/common";
import { AlertingModule } from "../alerting/alerting.module";
import { OracleModule } from "../oracle/oracle.module";
import { PolicyModule } from "../policy/policy.module";
import { StellarModule } from "../stellar/stellar.module";
import { ClaimController } from "./claim.controller";
import { ClaimScheduler } from "./claim.scheduler";
import { ClaimSettlementService } from "./claim-settlement.service";
import { ClaimService } from "./claim.service";
import { OpsAuthGuard } from "../common/guards/ops-auth.guard";

@Module({
  imports: [PolicyModule, OracleModule, StellarModule, AlertingModule],
  controllers: [ClaimController],
  providers: [ClaimService, ClaimScheduler, ClaimSettlementService, OpsAuthGuard],
  exports: [ClaimService],
})
export class ClaimModule {}
