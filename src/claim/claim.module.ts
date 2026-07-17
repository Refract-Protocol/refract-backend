import { Module } from "@nestjs/common";
import { OracleModule } from "../oracle/oracle.module";
import { PolicyModule } from "../policy/policy.module";
import { ClaimController } from "./claim.controller";
import { ClaimScheduler } from "./claim.scheduler";
import { ClaimSettlementService } from "./claim-settlement.service";
import { ClaimService } from "./claim.service";

@Module({
  imports: [PolicyModule, OracleModule],
  controllers: [ClaimController],
  providers: [ClaimService, ClaimScheduler, ClaimSettlementService],
  exports: [ClaimService],
})
export class ClaimModule {}
