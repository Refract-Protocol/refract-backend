import { Global, Module } from "@nestjs/common";
import { SorobanRpcService } from "./soroban-rpc.service";
import { RelayerKeyring } from "./relayer-keyring.service";
import { OracleQuorumService } from "../oracle/oracle-quorum.service";
import { OracleQuorumValidator } from "../oracle/oracle-quorum.validator";

/**
 * Global so Policy/Pool/Claim/Tx modules need no import churn — same
 * precedent as ConfigModule.forRoot({ isGlobal: true }).
 */
@Global()
@Module({
  providers: [SorobanRpcService, RelayerKeyring, OracleQuorumService, OracleQuorumValidator],
  exports: [SorobanRpcService, RelayerKeyring, OracleQuorumService],
})
export class StellarModule {}
