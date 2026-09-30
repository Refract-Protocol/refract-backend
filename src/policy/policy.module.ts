import { Module } from "@nestjs/common";
import { StellarModule } from "../stellar/stellar.module";
import { PolicyController } from "./policy.controller";
import { PolicyRepository } from "./policy.repository";
import { PolicyService } from "./policy.service";

@Module({
  imports: [StellarModule],
  controllers: [PolicyController],
  providers: [PolicyRepository, PolicyService],
  exports: [PolicyService],
})
export class PolicyModule {}
