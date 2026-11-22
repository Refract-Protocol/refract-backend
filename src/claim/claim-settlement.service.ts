import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { BASE_FEE, Contract, Keypair, TransactionBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { decodeSorobanError } from "../common/soroban-error";
import { AppConfig } from "../config/configuration";
import { pollForConfirmation } from "../stellar/soroban-confirmation.util";
import { ClaimSettlementReadError } from "./claim-settlement.repository";

export interface SettlementResult {
  settled: boolean;
  txHash?: string;
  error?: string;
  code?: string;
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
  private readonly relayerSecret: string;
  private readonly relayerSecretId: string;
  private readonly relayerSecretRegion: string;

  constructor(private readonly configService: ConfigService<AppConfig, true>) {
    const stellar = this.configService.get("stellar", { infer: true });
    this.server = new rpc.Server(stellar.sorobanRpcUrl);
    this.networkPassphrase = stellar.networkPassphrase;
    this.poolContractId = stellar.poolContractId;
    this.relayerSecret = (stellar.relayerSecret ?? "").trim();
    this.relayerSecretId = (stellar.relayerSecretId ?? "").trim();
    this.relayerSecretRegion = (stellar.relayerSecretRegion ?? "us-east-1").trim() || "us-east-1";
  }

  isConfigured(): boolean {
    return Boolean(this.poolContractId && (this.relayerSecret || this.relayerSecretId));
  }

  private async resolveRelayerKeypair(): Promise<Keypair | null> {
    const secret = this.relayerSecret || (await this.loadSecretFromAws());
    if (!secret) return null;
    return Keypair.fromSecret(secret);
  }

  private async loadSecretFromAws(): Promise<string> {
    if (!this.relayerSecretId) return "";
    const client = new SecretsManagerClient({ region: this.relayerSecretRegion });
    const response = await client.send(new GetSecretValueCommand({ SecretId: this.relayerSecretId }));
    return response.SecretString ?? "";
  }

  async settleClaim(policyId: string): Promise<SettlementResult> {
    if (!this.poolContractId || !(this.relayerSecret || this.relayerSecretId)) {
      return {
        settled: false,
        error: "Soroban relayer not configured (missing REFRACT_POOL_CONTRACT_ID or ORACLE_RELAYER_SECRET / ORACLE_RELAYER_SECRET_ID)",
      };
    }

    if (!/^\d+$/.test(policyId) || BigInt(policyId) > 18_446_744_073_709_551_615n) {
      return { settled: false, error: "Policy ID must be an on-chain u64" };
    }

    try {
      const keypair = await this.resolveRelayerKeypair();
      if (!keypair) {
        return { settled: false, error: "Soroban relayer not configured (missing relayer secret)" };
      }

      const sourceAccount = await this.server.getAccount(keypair.publicKey());
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
      preparedTx.sign(keypair);

      const sendResult = await this.server.sendTransaction(preparedTx);
      if (sendResult.status === "ERROR" || sendResult.status === "TRY_AGAIN_LATER" || sendResult.status === "FAILED") {
        return {
          settled: false,
          txHash: sendResult.hash,
          ...decodeSorobanError((sendResult as { errorResult?: unknown }).errorResult ?? sendResult),
        };
      }

      const confirmation = await pollForConfirmation(this.server, sendResult.hash);
      return { settled: confirmation.confirmed, txHash: confirmation.txHash, error: confirmation.error };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof ClaimSettlementReadError) {
        // A failed settlement read is a data-layer failure, not a missing row:
        // surface it distinctly so callers do not treat it as "not found".
        this.logger.error(
          `Settlement state read failed for policy ${policyId} (decision ${err.decisionId})`,
          message
        );
        return {
          settled: false,
          code: err.code,
          error: "Could not read settlement state. Please retry later or contact support.",
        };
      }
      this.logger.error(`Soroban settlement failed for policy ${policyId}`, message);
      return {
        settled: false,
        code: "SOROBAN_REQUEST_FAILED",
        error: "The Soroban request failed. Please retry later or contact support.",
      };
    }
  }
}
