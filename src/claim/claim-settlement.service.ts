import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BASE_FEE, Contract, Keypair, TransactionBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { pollForConfirmation } from "../stellar/soroban-confirmation.util";

export interface SettlementResult {
  settled: boolean;
  txHash?: string;
  error?: string;
}

/**
 * Builds, signs, and submits the pool.process_claim() Soroban transaction.
 * Its deployed interface accepts only a u64 on-chain policy ID. Policy
 * records currently use off-chain UUIDs until buy_policy is wired to persist
 * its on-chain return value, so those records are rejected before submission.
 */
@Injectable()
export class ClaimSettlementService {
  private readonly logger = new Logger(ClaimSettlementService.name);
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly poolContractId: string;
  private readonly relayerKeypair: Keypair | null;

  constructor(private readonly configService: ConfigService<AppConfig, true>) {
    const stellar = this.configService.get("stellar", { infer: true });
    this.server = new rpc.Server(stellar.sorobanRpcUrl);
    this.networkPassphrase = stellar.networkPassphrase;
    this.poolContractId = stellar.poolContractId;
    this.relayerKeypair = stellar.relayerSecret ? Keypair.fromSecret(stellar.relayerSecret) : null;
  }

  /** True once a pool contract ID and relayer secret are configured. */
  isConfigured(): boolean {
    return Boolean(this.poolContractId && this.relayerKeypair);
  }

  async settleClaim(policyId: string): Promise<SettlementResult> {
    if (!this.relayerKeypair || !this.poolContractId) {
      return {
        settled: false,
        error: "Soroban relayer not configured (missing REFRACT_POOL_CONTRACT_ID or ORACLE_RELAYER_SECRET)",
      };
    }

    if (!/^\d+$/.test(policyId) || BigInt(policyId) > 18_446_744_073_709_551_615n) {
      return { settled: false, error: "Policy ID must be an on-chain u64" };
    }

    try {
      const sourceAccount = await this.server.getAccount(this.relayerKeypair.publicKey());
      const contract = new Contract(this.poolContractId);

      const operation = contract.call("process_claim", nativeToScVal(BigInt(policyId), { type: "u64" }));

      const builtTx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const preparedTx = await this.server.prepareTransaction(builtTx);
      preparedTx.sign(this.relayerKeypair);

      const sendResult = await this.server.sendTransaction(preparedTx);
      if (sendResult.status === "ERROR" || sendResult.status === "TRY_AGAIN_LATER") {
        return { settled: false, error: `Submission not accepted: ${sendResult.status}` };
      }

      const confirmation = await pollForConfirmation(this.server, sendResult.hash);
      return { settled: confirmation.confirmed, txHash: confirmation.txHash, error: confirmation.error };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Soroban settlement failed for policy ${policyId}`, message);
      return { settled: false, error: message };
    }
  }
}
