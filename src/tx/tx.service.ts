import { BadRequestException, HttpException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import { ConfirmationResult } from "../stellar/soroban-confirmation.util";
import { SorobanRpcService } from "../stellar/soroban-rpc.service";
import { submitAndConfirm } from "../stellar/transaction-submitter";

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

  constructor(private readonly rpcService: SorobanRpcService) {}

  async submit(signedXdr: string): Promise<ConfirmationResult & { resultCode?: string }> {
    let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
    try {
      tx = TransactionBuilder.fromXDR(signedXdr, this.rpcService.networkPassphrase);
    } catch {
      throw new BadRequestException({ error: "Malformed transaction XDR" });
    }

    try {
      // Validity derived from the envelope's time bounds when present;
      // otherwise the 30s setTimeout used at build time.
      let validityWindowMs = 30_000;
      const tb = (tx as { timeBounds?: { maxTime?: string } }).timeBounds;
      if (tb?.maxTime && tb.maxTime !== "0") {
        const remaining = Number(tb.maxTime) * 1000 - Date.now();
        validityWindowMs = Math.max(0, remaining);
      }

      const result = await submitAndConfirm(this.rpcService.server, tx, { validityWindowMs });

      if (result.httpStatus === 503) {
        throw new ServiceUnavailableException({
          error: result.error,
          txHash: result.txHash,
          retryAfter: result.retryAfterSeconds,
        });
      }
      if (result.httpStatus === 400) {
        throw new BadRequestException({
          error: result.error,
          txHash: result.txHash,
          resultCode: result.resultCode,
        });
      }

      return result;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error("Soroban submission failed", message);
      return { confirmed: false, txHash: "", error: message };
    }
  }
}
