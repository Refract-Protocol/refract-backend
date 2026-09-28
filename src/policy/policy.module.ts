import { Module } from "@nestjs/common";
import { PoolModule } from "../pool/pool.module";
import { PolicyController } from "./policy.controller";
import { PolicyService } from "./policy.service";

@Module({
  imports: [PoolModule],
  controllers: [PolicyController],
  providers: [PolicyService],
  exports: [PolicyService],
})
export class PolicyModule {}
