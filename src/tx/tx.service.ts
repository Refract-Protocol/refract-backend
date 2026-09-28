import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { scValToNative, TransactionBuilder } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { pollForConfirmation } from "../stellar/soroban-confirmation.util";
import { SorobanRpcClient } from "../stellar/soroban-rpc.client";
import { PolicyService, StoredPolicy } from "../policy/policy.service";

export interface TransactionSubmissionResult {
  confirmed: boolean;
  txHash: string;
  error?: string;
  policyId?: string;
  policy?: StoredPolicy;
}

/**
 * Submits a transaction the caller already signed in their own wallet
 * (buy_policy/provide_capital/withdraw_capital all call `require_auth()` on
 * the caller, so the backend only ever hands back unsigned XDR for those —
 * see PolicyService/PoolService) and waits for it to land on-chain. Kept as
 * a single generic endpoint rather than one per action since submission and
 * confirmation are identical regardless of which contract method was
 * invoked.
 */
@Injectable()
export class TxService {
  private readonly logger = new Logger(TxService.name);
  private readonly rpcClient: SorobanRpcClient;
  private readonly networkPassphrase: string;

  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly policyService: PolicyService
  ) {
    const stellar = this.configService.get("stellar", { infer: true });
    this.rpcClient = new SorobanRpcClient(stellar.sorobanRpcUrls);
    this.networkPassphrase = stellar.networkPassphrase;
  }

  async submit(signedXdr: string): Promise<TransactionSubmissionResult> {
    let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
    try {
      tx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    } catch {
      throw new BadRequestException({ error: "Malformed transaction XDR" });
    }

    try {
      const sendResult = await this.rpcClient.call((server) => server.sendTransaction(tx));
      if (sendResult.status === "ERROR" || sendResult.status === "TRY_AGAIN_LATER") {
        return { confirmed: false, txHash: sendResult.hash, error: `Submission not accepted: ${sendResult.status}` };
      }
      const confirmation = await pollForConfirmation(this.rpcClient, sendResult.hash);
      const result: TransactionSubmissionResult = {
        confirmed: confirmation.confirmed,
        txHash: confirmation.txHash,
        ...(confirmation.error ? { error: confirmation.error } : {}),
      };
      if (!confirmation.confirmed || !this.isBuyPolicyTransaction(tx)) return result;

      const returnValue = confirmation.returnValue === undefined ? undefined : scValToNative(confirmation.returnValue);
      if (typeof returnValue !== "bigint" || returnValue < 0n || returnValue > (1n << 64n) - 1n) {
        return { ...result, error: "Confirmed buy_policy transaction did not return a valid u64 policy id" };
      }

      const policyId = returnValue.toString();
      try {
        const policy = this.policyService.confirmPurchase(tx.hash().toString("hex"), policyId);
        return { ...result, policyId, ...(policy ? { policy } : {}) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Confirmed buy_policy transaction ${sendResult.hash} could not be registered`, message);
        return { ...result, policyId, error: `Transaction confirmed but policy registration failed: ${message}` };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error("Soroban submission failed", message);
      return { confirmed: false, txHash: "", error: message };
    }
  }

  private isBuyPolicyTransaction(tx: ReturnType<typeof TransactionBuilder.fromXDR>): boolean {
    return tx.operations.some(
      (operation) =>
        operation.type === "invokeHostFunction" &&
        operation.func.switch().name === "hostFunctionTypeInvokeContract" &&
        operation.func.invokeContract().functionName().toString() === "buy_policy"
    );
  }
}
