import { Module } from "@nestjs/common";
import { ConsensusModule } from "../oracle/consensus/consensus.module";
import { OracleModule } from "../oracle/oracle.module";
import { PolicyModule } from "../policy/policy.module";
import { ClaimController } from "./claim.controller";
import { ClaimRepository } from "./claim.repository";
import { ClaimScheduler } from "./claim.scheduler";
import { ClaimSettlementService } from "./claim-settlement.service";
import { ClaimService } from "./claim.service";
import { DisputeModule } from "./dispute/dispute.module";
import { ReconciliationService } from "./reconciliation.service";

@Module({
  imports: [PolicyModule, OracleModule, ConsensusModule, DisputeModule],
  controllers: [ClaimController],
  providers: [
    ClaimRepository,
    ClaimService,
    ClaimScheduler,
    ClaimSettlementService,
    ReconciliationService,
  ],
  exports: [ClaimService, ReconciliationService],
})
export class ClaimModule {}
