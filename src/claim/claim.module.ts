import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { OracleModule } from "../oracle/oracle.module";
import { PolicyModule } from "../policy/policy.module";
import { ClaimController } from "./claim.controller";
import { ClaimScheduler } from "./claim.scheduler";
import { ClaimSettlementService } from "./claim-settlement.service";
import { ClaimService } from "./claim.service";
import { RelayerAuditService } from "./relayer-audit.service";

@Module({
  imports: [PolicyModule, OracleModule, DatabaseModule],
  controllers: [ClaimController],
  providers: [ClaimService, ClaimScheduler, ClaimSettlementService, RelayerAuditService],
  exports: [ClaimService],
})
export class ClaimModule {}
