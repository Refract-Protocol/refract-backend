import { Module } from "@nestjs/common";
import { LpPositionRepository } from "./lp-position.repository";
import { PoolController } from "./pool.controller";
import { PoolSnapshotRepository } from "./pool-snapshot.repository";
import { PoolService } from "./pool.service";
import { PremiumRevenueRepository } from "./premium-revenue.repository";

@Module({
  controllers: [PoolController],
  providers: [PoolService, PoolSnapshotRepository, LpPositionRepository, PremiumRevenueRepository],
  exports: [PoolService, PoolSnapshotRepository, LpPositionRepository, PremiumRevenueRepository],
})
export class PoolModule {}
