import { Module } from "@nestjs/common";
import { StellarModule } from "../stellar/stellar.module";
import { PolicyController } from "./policy.controller";
import { PolicyService } from "./policy.service";

@Module({
  imports: [StellarModule],
  controllers: [PolicyController],
  providers: [PolicyService],
  exports: [PolicyService],
})
export class PolicyModule {}
