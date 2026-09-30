import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Account,
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  StrKey,
  Transaction,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";

export class RelayerNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayerNotReadyError";
  }
}

export class RelayerInsufficientBalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayerInsufficientBalanceError";
  }
}

export class RelayerSequenceExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayerSequenceExhaustedError";
  }
}

export interface RelayerHealthStatus {
  configured: boolean;
  balanceReady: boolean;
  publicKey: string | null;
  balance: string | null;
  sequence: string | null;
}

/**
 * Owns the relayer account's sequence number, dynamic fee selection, and a
 * serialized submission queue shared by claim settlement and oracle publishing.
 *
 * ASSUMPTION — single active submitter: this process must be the only writer
 * using ORACLE_RELAYER_SECRET. Multi-replica deployments need leader election
 * or a distinct relayer key per replica; two processes sharing one key will
 * race on sequence numbers with no recoverable fix inside this service.
 *
 * NEVER logs the relayer secret — only the derived public key.
 */
@Injectable()
export class RelayerAccountService {
  private readonly logger = new Logger(RelayerAccountService.name);
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly keypair: Keypair | null;
  private readonly feeMultiplier: number;
  private readonly feeCeiling: number;
  private readonly idleResyncMs: number;
  private readonly minBalance: number;
  private readonly maxAttempts: number;

  /** Promise chain that serializes all submissions (exactly one claims each sequence). */
  private queueTail: Promise<unknown> = Promise.resolve();

  private cachedSequence: string | null = null;
  private lastSyncedAt = 0;
  private cachedBalanceStroops: bigint | null = null;

  constructor(private readonly configService: ConfigService<AppConfig, true>) {
    const stellar = this.configService.get("stellar", { infer: true });
    this.server = new rpc.Server(stellar.sorobanRpcUrl);
    this.networkPassphrase = stellar.networkPassphrase;
    this.feeMultiplier = stellar.relayer.feeMultiplier;
    this.feeCeiling = stellar.relayer.feeCeiling;
    this.idleResyncMs = stellar.relayer.idleResyncMs;
    this.minBalance = stellar.relayer.minBalance;
    this.maxAttempts = stellar.relayer.maxAttempts;

    const secret = stellar.relayerSecret?.trim() ?? "";
    // Only construct a keypair from a shape-valid seed — never log the secret.
    // Malformed seeds are owned by StellarConfigValidator's fail-fast path.
    this.keypair =
      secret && StrKey.isValidEd25519SecretSeed(secret) ? Keypair.fromSecret(secret) : null;
    if (this.keypair) {
      this.logger.log(`RelayerAccountService ready for ${this.keypair.publicKey()}`);
    }
  }

  isConfigured(): boolean {
    return this.keypair !== null;
  }

  /** Configured and able to cover the fee floor (balance known and sufficient). */
  isReady(): boolean {
    if (!this.keypair) return false;
    if (this.cachedBalanceStroops === null) return true; // optimistic until first balance fetch
    return this.cachedBalanceStroops >= BigInt(BASE_FEE);
  }

  getHealthStatus(): RelayerHealthStatus {
    const balanceReady =
      this.keypair !== null &&
      this.cachedBalanceStroops !== null &&
      this.cachedBalanceStroops >= BigInt(this.minBalance);
    return {
      configured: this.keypair !== null,
      balanceReady,
      publicKey: this.keypair?.publicKey() ?? null,
      balance: this.cachedBalanceStroops?.toString() ?? null,
      sequence: this.cachedSequence,
    };
  }

  /**
   * Enqueues a relayer-sourced submission. `buildFn` receives an Account whose
   * sequence this service owns and a fee string already clamped to
   * [BASE_FEE, feeCeiling]. On txBAD_SEQ the account is re-synced and buildFn
   * is invoked again (rebuild, not resubmit) until maxAttempts.
   */
  submitRelayerTransaction(
    buildFn: (account: Account, fee: string) => Promise<Transaction>
  ): Promise<{ hash: string }> {
    return this.enqueue(() => this.submitWithRetries(buildFn));
  }

  /**
   * Wraps an already-signed inner transaction in a fee-bump at `newFee` so a
   * stuck submission can be re-priced without invalidating the original.
   */
  feeBump(innerTx: Transaction, newFee: string): Promise<{ hash: string }> {
    return this.enqueue(async () => {
      if (!this.keypair) {
        throw new RelayerNotReadyError("Relayer is not configured");
      }
      await this.ensureBalanceCovers(BigInt(newFee));
      const bump = TransactionBuilder.buildFeeBumpTransaction(
        this.keypair,
        newFee,
        innerTx,
        this.networkPassphrase
      );
      bump.sign(this.keypair);
      return this.sendSigned(bump);
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queueTail.then(fn, fn);
    this.queueTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async submitWithRetries(
    buildFn: (account: Account, fee: string) => Promise<Transaction>
  ): Promise<{ hash: string }> {
    if (!this.keypair) {
      throw new RelayerNotReadyError("Relayer is not configured");
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const forceResync = attempt > 1;
        const account = await this.checkoutAccount(forceResync);
        const fee = await this.selectFee();
        await this.ensureBalanceCovers(BigInt(fee));

        const built = await buildFn(account, fee);
        // Sign here so callers never touch the secret; sequence is claimed
        // only after a successful send (or advanced after BAD_SEQ resync).
        built.sign(this.keypair);

        const result = await this.sendSigned(built);
        this.advanceSequenceAfterSuccess(account);
        return result;
      } catch (err) {
        lastError = err;
        if (err instanceof RelayerInsufficientBalanceError || err instanceof RelayerNotReadyError) {
          throw err;
        }
        if (this.isBadSeq(err) && attempt < this.maxAttempts) {
          this.logger.warn(`txBAD_SEQ on attempt ${attempt}; re-syncing sequence and rebuilding`);
          this.cachedSequence = null;
          continue;
        }
        if (attempt >= this.maxAttempts) {
          break;
        }
        throw err;
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new RelayerSequenceExhaustedError(
      `Relayer submission failed after ${this.maxAttempts} attempts: ${message}`
    );
  }

  private async checkoutAccount(forceResync: boolean): Promise<Account> {
    if (!this.keypair) {
      throw new RelayerNotReadyError("Relayer is not configured");
    }
    const idleExpired = Date.now() - this.lastSyncedAt > this.idleResyncMs;
    if (forceResync || this.cachedSequence === null || idleExpired) {
      await this.resyncFromNetwork();
    }
    return new Account(this.keypair.publicKey(), this.cachedSequence!);
  }

  private async resyncFromNetwork(): Promise<void> {
    if (!this.keypair) return;
    const account = await this.server.getAccount(this.keypair.publicKey());
    this.cachedSequence = account.sequenceNumber();
    this.lastSyncedAt = Date.now();
    await this.refreshBalance(account);
  }

  private async refreshBalance(_account?: Account): Promise<void> {
    if (!this.keypair) return;
    // rpc.Server.getAccount returns a stellar-base Account (sequence only).
    // Balance comes from Horizon-shaped account details via a typed cast of
    // the raw load — when unavailable, treat as unknown (null) rather than 0
    // so we don't falsely block submissions before the first real probe.
    try {
      const loaded = (await this.server.getAccount(this.keypair.publicKey())) as Account & {
        balances?: Array<{ asset_type: string; balance: string }>;
      };
      const native = loaded.balances?.find((b) => b.asset_type === "native");
      if (!native) {
        // No balance field on this RPC response — leave cache unchanged / optimistic.
        if (this.cachedBalanceStroops === null) {
          this.cachedBalanceStroops = BigInt(this.minBalance);
        }
        return;
      }
      const stroops = BigInt(Math.floor(parseFloat(native.balance) * 1e7));
      this.cachedBalanceStroops = stroops;
      if (stroops < BigInt(this.minBalance)) {
        this.logger.warn(
          `Relayer balance ${stroops} stroops is below minBalance ${this.minBalance} (publicKey=${this.keypair.publicKey()})`
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to refresh relayer balance: ${message}`);
    }
  }

  private advanceSequenceAfterSuccess(account: Account): void {
    // Account.incrementSequenceNumber() mutates; mirror into our cache so the
    // next queued submission does not re-fetch unless idle/BAD_SEQ forces it.
    account.incrementSequenceNumber();
    this.cachedSequence = account.sequenceNumber();
    this.lastSyncedAt = Date.now();
  }

  private async selectFee(): Promise<string> {
    const floor = Number(BASE_FEE);
    let raw = floor;
    try {
      const stats = await this.server.getFeeStats();
      const inclusion =
        Number(stats.sorobanInclusionFee?.p50 ?? stats.sorobanInclusionFee?.mode ?? 0) ||
        Number(stats.inclusionFee?.p50 ?? stats.inclusionFee?.mode ?? 0) ||
        floor;
      raw = Math.ceil(inclusion * this.feeMultiplier);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`getFeeStats failed, falling back to BASE_FEE: ${message}`);
    }
    const clamped = Math.min(Math.max(raw, floor), this.feeCeiling);
    return String(clamped);
  }

  private async ensureBalanceCovers(feeStroops: bigint): Promise<void> {
    if (this.cachedBalanceStroops === null) {
      await this.refreshBalance();
    }
    const balance = this.cachedBalanceStroops ?? 0n;
    if (balance < feeStroops) {
      throw new RelayerInsufficientBalanceError(
        `Relayer balance ${balance} stroops cannot cover fee ${feeStroops}`
      );
    }
  }

  private async sendSigned(tx: Transaction | FeeBumpTransaction): Promise<{ hash: string }> {
    const sendResult = await this.server.sendTransaction(tx);
    if (sendResult.status === "ERROR" || sendResult.status === "TRY_AGAIN_LATER") {
      const raw = "errorResult" in sendResult ? sendResult.errorResult : undefined;
      let detail = "";
      if (typeof raw === "string") {
        detail = raw;
      } else if (raw != null) {
        try {
          const xdrFn = (raw as unknown as { toXDR?: () => Buffer | string }).toXDR;
          if (typeof xdrFn === "function") {
            const out = xdrFn.call(raw);
            detail = Buffer.isBuffer(out) ? out.toString("base64") : String(out);
          } else {
            detail = String(raw);
          }
        } catch {
          detail = String(raw);
        }
      }
      const err = new Error(`Submission not accepted: ${sendResult.status}${detail ? ` ${detail}` : ""}`);
      if (/txBAD_SEQ|BAD_SEQ/i.test(detail) || /txBAD_SEQ|BAD_SEQ/i.test(err.message)) {
        (err as Error & { badSeq?: boolean }).badSeq = true;
      }
      throw err;
    }
    return { hash: sendResult.hash };
  }

  private isBadSeq(err: unknown): boolean {
    if (!err) return false;
    if (typeof err === "object" && err !== null && "badSeq" in err && (err as { badSeq?: boolean }).badSeq) {
      return true;
    }
    const message = err instanceof Error ? err.message : String(err);
    return /txBAD_SEQ|BAD_SEQ/i.test(message);
  }
}
