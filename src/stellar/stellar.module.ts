import { Global, Module } from "@nestjs/common";
import { SorobanRpcPoolService } from "./soroban-rpc-pool.service";
import { SorobanRpcService } from "./soroban-rpc.service";

/**
 * Global so Policy/Pool/Claim/Tx modules need no import churn — same
 * precedent as ConfigModule.forRoot({ isGlobal: true }).
 */
@Global()
@Module({
  providers: [SorobanRpcService, SorobanRpcPoolService],
  exports: [SorobanRpcService, SorobanRpcPoolService],
})
export class StellarModule {}
