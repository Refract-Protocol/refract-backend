import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BASE_FEE, Contract, Keypair, TransactionBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { pollForConfirmation } from "../stellar/soroban-confirmation.util";
import { RelayerAuditService, RelayerTransactionStatus } from "./relayer-audit.service";

export interface SettlementResult {
  settled: boolean;
  txHash?: string;
  error?: string;
}

/**
 * Builds, signs, and submits the pool.process_claim() Soroban transaction
 * that pays out a triggered claim. The deployed contract accepts one u64
 * policy id and reads the holder and payout from on-chain policy storage.
 */
@Injectable()
export class ClaimSettlementService {
  private readonly logger = new Logger(ClaimSettlementService.name);
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly poolContractId: string;
  private readonly relayerKeypair: Keypair | null;

  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly relayerAuditService: RelayerAuditService
  ) {
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

    let transactionHash: string | undefined;
    let auditStatus: RelayerTransactionStatus = "signed";
    let auditRecorded = false;
    try {
      if (!/^\d+$/.test(policyId)) {
        throw new Error("On-chain policy ID must be an unsigned integer");
      }
      const onChainPolicyId = BigInt(policyId);
      if (onChainPolicyId > 18_446_744_073_709_551_615n) {
        throw new Error("On-chain policy ID exceeds the u64 range");
      }

      const sourceAccount = await this.server.getAccount(this.relayerKeypair.publicKey());
      const contract = new Contract(this.poolContractId);

      const operation = contract.call("process_claim", nativeToScVal(onChainPolicyId, { type: "u64" }));

      const builtTx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      // Simulates against the live contract and fills in Soroban resource
      // fees/footprint — this is where a wrong function name or argument
      // argument type/shape for the deployed contract would surface.
      const preparedTx = await this.server.prepareTransaction(builtTx);
      preparedTx.sign(this.relayerKeypair);

      transactionHash = preparedTx.hash().toString("hex");
      await this.relayerAuditService.recordSignedTransaction(
        policyId,
        this.relayerKeypair.publicKey(),
        transactionHash
      );
      auditRecorded = true;

      const sendResult = await this.server.sendTransaction(preparedTx);
      if (sendResult.status === "ERROR" || sendResult.status === "TRY_AGAIN_LATER") {
        await this.relayerAuditService.recordOutcome(
          transactionHash,
          "rejected",
          sendResult.status,
          `Submission not accepted: ${sendResult.status}`
        );
        auditStatus = "rejected";
        return { settled: false, error: `Submission not accepted: ${sendResult.status}` };
      }

      await this.relayerAuditService.recordOutcome(transactionHash, "submitted", sendResult.status);
      auditStatus = "submitted";
      const confirmation = await pollForConfirmation(this.server, sendResult.hash);
      const outcome = confirmation.confirmed ? "confirmed" : "failed";
      await this.relayerAuditService.recordOutcome(transactionHash, outcome, sendResult.status, confirmation.error);
      auditStatus = outcome;
      return { settled: confirmation.confirmed, txHash: confirmation.txHash, error: confirmation.error };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (auditRecorded && transactionHash && auditStatus !== "rejected" && auditStatus !== "confirmed") {
        try {
          await this.relayerAuditService.recordOutcome(transactionHash, "failed", undefined, message);
        } catch (auditErr) {
          const auditMessage = auditErr instanceof Error ? auditErr.message : String(auditErr);
          this.logger.error(`Failed to update relayer audit record for transaction ${transactionHash}`, auditMessage);
          return { settled: false, error: `${message}; audit update failed: ${auditMessage}` };
        }
      }
      this.logger.error(`Soroban settlement failed for policy ${policyId}`, message);
      return { settled: false, error: message };
    }
  }
}
