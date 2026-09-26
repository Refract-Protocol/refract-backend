import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { PolicyService } from "../policy/policy.service";
import { ConfirmationResult, pollForConfirmation } from "../stellar/soroban-confirmation.util";

/**
 * Submits a transaction the caller already signed in their own wallet
 * (buy_policy/provide_capital/withdraw_capital all call `require_auth()` on
 * the caller, so the backend only ever hands back unsigned XDR for those —
 * see PolicyService/PoolService) and waits for it to land on-chain. Kept as
 * a single generic endpoint rather than one per action since submission and
 * confirmation are identical regardless of which contract method was
 * invoked.
 *
 * On success, the Soroban return value is exposed to callers and — when the
 * envelope hash matches a pending buy_policy — forwarded to PolicyService
 * so the on-chain u64 policy id is persisted.
 */
@Injectable()
export class TxService {
  private readonly logger = new Logger(TxService.name);
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly confirmationDefaults: AppConfig["confirmation"];

  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly policyService: PolicyService
  ) {
    const stellar = this.configService.get("stellar", { infer: true });
    this.server = new rpc.Server(stellar.sorobanRpcUrl);
    this.networkPassphrase = stellar.networkPassphrase;
    this.confirmationDefaults = this.configService.get("confirmation", { infer: true });
  }

  async submit(signedXdr: string): Promise<ConfirmationResult & { onChainPolicyId?: string }> {
    let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
    try {
      tx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    } catch {
      throw new BadRequestException({ error: "Malformed transaction XDR" });
    }

    try {
      const sendResult = await this.server.sendTransaction(tx);
      if (sendResult.status === "ERROR" || sendResult.status === "TRY_AGAIN_LATER") {
        return {
          confirmed: false,
          outcome: "failed_on_chain",
          txHash: sendResult.hash,
          error: `Submission not accepted: ${sendResult.status}`,
        };
      }

      const confirmation = await pollForConfirmation(this.server, sendResult.hash, {
        initialIntervalMs: this.confirmationDefaults.initialIntervalMs,
        backoffMultiplier: this.confirmationDefaults.backoffMultiplier,
        maxIntervalMs: this.confirmationDefaults.maxIntervalMs,
        jitterRatio: this.confirmationDefaults.jitterRatio,
        deadlineMs: this.confirmationDefaults.httpDeadlineMs,
      });

      if (confirmation.outcome === "success") {
        const activated = this.policyService.activateFromBuyConfirmation(
          confirmation.txHash,
          confirmation.returnValue
        );
        if (activated?.onChainPolicyId) {
          return { ...confirmation, onChainPolicyId: activated.onChainPolicyId };
        }
      }

      return confirmation;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error("Soroban submission failed", message);
      return {
        confirmed: false,
        outcome: "failed_on_chain",
        txHash: "",
        error: message,
      };
    }
  }
}
