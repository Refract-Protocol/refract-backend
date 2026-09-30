import { Module } from "@nestjs/common";
import { StellarModule } from "../stellar/stellar.module";
import { PoolController } from "./pool.controller";
import { PoolService } from "./pool.service";

@Module({
  imports: [StellarModule],
  controllers: [PoolController],
  providers: [PoolService],
  exports: [PoolService],
})
export class PoolModule {}
