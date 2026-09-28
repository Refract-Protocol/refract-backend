import { Module } from "@nestjs/common";
import { PolicyController } from "./policy.controller";
import { PolicyRepository } from "./policy.repository";
import { PolicyService } from "./policy.service";

@Module({
  controllers: [PolicyController],
  providers: [PolicyRepository, PolicyService],
  exports: [PolicyService],
})
export class PolicyModule {}
