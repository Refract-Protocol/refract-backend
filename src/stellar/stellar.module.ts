import { Module } from "@nestjs/common";
import { FeeStrategyService } from "./fee-strategy.service";
import { SorobanRpcService } from "./soroban-rpc.service";

@Module({
  providers: [SorobanRpcService, FeeStrategyService],
  exports: [SorobanRpcService, FeeStrategyService],
})
export class StellarModule {}
