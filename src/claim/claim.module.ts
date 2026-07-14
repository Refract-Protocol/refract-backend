import { Module } from "@nestjs/common";
import { OracleModule } from "../oracle/oracle.module";
import { PolicyModule } from "../policy/policy.module";
import { ClaimController } from "./claim.controller";
import { ClaimScheduler } from "./claim.scheduler";
import { ClaimService } from "./claim.service";

@Module({
  imports: [PolicyModule, OracleModule],
  controllers: [ClaimController],
  providers: [ClaimService, ClaimScheduler],
  exports: [ClaimService],
})
export class ClaimModule {}
