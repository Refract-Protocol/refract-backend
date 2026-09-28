import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FeeBumpTransaction, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import Redis from "ioredis";
import { AppConfig } from "../config/configuration";
import { ConfirmationResult, pollForConfirmation } from "../stellar/soroban-confirmation.util";

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
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly redis: Redis;

  constructor(private readonly configService: ConfigService<AppConfig, true>) {
    const stellar = this.configService.get("stellar", { infer: true });
    this.server = new rpc.Server(stellar.sorobanRpcUrl);
    this.networkPassphrase = stellar.networkPassphrase;
    this.redis = new Redis(this.configService.get("redis", { infer: true }).url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
  }

  async submit(signedXdr: string): Promise<ConfirmationResult> {
    let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
    try {
      tx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    } catch {
      throw new BadRequestException({ error: "Malformed transaction XDR" });
    }

    const txHash = tx.hash().toString("hex");
    const timeBounds = tx instanceof FeeBumpTransaction ? tx.innerTransaction.timeBounds : tx.timeBounds;
    const maxTime = timeBounds?.maxTime ? Number(timeBounds.maxTime) : 0;
    const now = Math.floor(Date.now() / 1000);
    if (!maxTime || maxTime <= now) {
      return { confirmed: false, txHash, error: "Transaction is expired or has no expiration time" };
    }

    const ttlSeconds = maxTime - now + 3600;
    try {
      const reserved = await this.redis.set(
        `stellar:submitted:${txHash}`,
        JSON.stringify({ txHash, submittedAt: now }),
        "EX",
        ttlSeconds,
        "NX"
      );
      if (reserved !== "OK") {
        return { confirmed: false, txHash, error: "Transaction has already been submitted" };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error("Unable to reserve transaction for submission", message);
      return { confirmed: false, txHash, error: "Transaction replay protection is unavailable" };
    }

    try {
      const sendResult = await this.server.sendTransaction(tx);
      if (sendResult.status === "ERROR" || sendResult.status === "TRY_AGAIN_LATER") {
        return { confirmed: false, txHash: sendResult.hash, error: `Submission not accepted: ${sendResult.status}` };
      }
      return await pollForConfirmation(this.server, sendResult.hash);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error("Soroban submission failed", message);
      return { confirmed: false, txHash: "", error: message };
    }
  }
}
