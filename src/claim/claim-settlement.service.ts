import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Contract, Keypair, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { FeeCeilingExceededError, FeeStrategyService } from "../stellar/fee-strategy.service";
import { encodeProcessClaimArg } from "../stellar/scval-encoders";
import { SorobanRpcService } from "../stellar/soroban-rpc.service";
import { submitAndConfirm } from "../stellar/transaction-submitter";

export interface SettlementResult {
  settled: boolean;
  txHash?: string;
  error?: string;
  resultCode?: string;
}

/**
 * Builds, signs, and submits the pool.process_claim(policy_id: u64) Soroban
 * transaction that pays out a triggered claim.
 *
 * Encoding comes from scval-encoders.encodeProcessClaimArg — a single u64
 * matching refract-contracts/pool/src/lib.rs. The on-chain policy id must be
 * threaded from buy_policy()'s return value (StoredPolicy.onChainPolicyId);
 * without it settlement is a permanent failure, not a retryable one.
 */
@Injectable()
export class ClaimSettlementService {
  private readonly logger = new Logger(ClaimSettlementService.name);
  private readonly poolContractId: string;
  private readonly relayerKeypair: Keypair | null;

  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly rpcService: SorobanRpcService,
    private readonly feeStrategy: FeeStrategyService
  ) {
    const stellar = this.configService.get("stellar", { infer: true });
    this.poolContractId = stellar.poolContractId;
    this.relayerKeypair = stellar.relayerSecret ? Keypair.fromSecret(stellar.relayerSecret) : null;
  }

  private get server(): rpc.Server {
    return this.rpcService.server;
  }

  private get networkPassphrase(): string {
    return this.rpcService.networkPassphrase;
  }

  /** True once a pool contract ID and relayer secret are configured. */
  isConfigured(): boolean {
    return Boolean(this.poolContractId && this.relayerKeypair);
  }

  /**
   * Settles using the on-chain u64 policy id. `holder`/`payout` are retained
   * for logging/audit only — the contract looks them up from storage.
   */
  async settleClaim(onChainPolicyId: bigint, _holder: string, _payout: bigint): Promise<SettlementResult> {
    if (!this.relayerKeypair || !this.poolContractId) {
      return {
        settled: false,
        error: "Soroban relayer not configured (missing REFRACT_POOL_CONTRACT_ID or ORACLE_RELAYER_SECRET)",
      };
    }

    try {
      const inclusionFee = await this.feeStrategy.estimateInclusionFee("aggressive");
      const sourceAccount = await this.server.getAccount(this.relayerKeypair.publicKey());
      const contract = new Contract(this.poolContractId);

      const operation = contract.call("process_claim", encodeProcessClaimArg(onChainPolicyId));

      const builtTx = new TransactionBuilder(sourceAccount, {
        fee: inclusionFee,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      // Simulates against the live contract and fills in Soroban resource
      // fees/footprint — this is where a wrong function name or argument
      // shape would surface.
      const preparedTx = await this.server.prepareTransaction(builtTx);
      const preparedFee = (preparedTx as { fee?: string }).fee;
      this.feeStrategy.assertTotalUnderCeiling(
        inclusionFee,
        preparedFee ? BigInt(preparedFee) - BigInt(inclusionFee) : 0n
      );

      preparedTx.sign(this.relayerKeypair);

      // Validity window matches setTimeout(30). TRY_AGAIN_LATER retries reuse
      // this identical signed envelope — never rebuild inside the submitter.
      const confirmation = await submitAndConfirm(this.server, preparedTx, {
        validityWindowMs: 30_000,
      });

      return {
        settled: confirmation.confirmed,
        txHash: confirmation.txHash,
        error: confirmation.error,
        resultCode: confirmation.resultCode,
      };
    } catch (err) {
      if (err instanceof FeeCeilingExceededError) {
        this.logger.error(`Settlement fee ceiling exceeded for policy ${onChainPolicyId}: ${err.message}`);
        return { settled: false, error: err.message, resultCode: "txINSUFFICIENT_FEE" };
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Soroban settlement failed for policy ${onChainPolicyId}`, message);
      return { settled: false, error: message };
    }
  }
}
