import { Global, Module } from "@nestjs/common";
import { SorobanRpcService } from "./soroban-rpc.service";

/**
 * Global so Policy/Pool/Claim/Tx modules need no import churn — same
 * precedent as ConfigModule.forRoot({ isGlobal: true }).
 */
@Global()
@Module({
  providers: [SorobanRpcService],
  exports: [SorobanRpcService],
})
export class StellarModule {}
