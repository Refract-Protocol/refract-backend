import { Module } from "@nestjs/common";
import { PoolController } from "./pool.controller";
import { PoolService } from "./pool.service";

@Module({
  controllers: [PoolController],
  providers: [PoolService],
  exports: [PoolService],
})
export class PoolModule {}
