import { Module } from "@nestjs/common";
import { DisputeController } from "./dispute.controller";
import { DisputeService } from "./dispute.service";

@Module({
  controllers: [DisputeController],
  providers: [DisputeService],
  exports: [DisputeService],
})
export class DisputeModule {}
