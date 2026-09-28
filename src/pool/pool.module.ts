import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { PoolController } from "./pool.controller";
import { PoolService } from "./pool.service";

@Module({
  imports: [DatabaseModule],
  controllers: [PoolController],
  providers: [PoolService],
  exports: [PoolService],
})
export class PoolModule {}
