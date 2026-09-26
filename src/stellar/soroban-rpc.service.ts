import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Account,
  BASE_FEE,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { randomUUID } from "crypto";
import { AppConfig } from "../config/configuration";
import {
  SorobanContractError,
  SorobanNotFoundError,
  SorobanRateLimitError,
  SorobanRestoreFeeExceededError,
  SorobanRestoreRequiredError,
  SorobanTransientError,
} from "./soroban-errors";

type RpcMethod =
  | "getAccount"
  | "simulateTransaction"
  | "prepareTransaction"
  | "sendTransaction"
  | "getTransaction"
  | "getEvents";

export interface PrepareTransactionOptions {
  /**
   * When true (relayer paths), automatically submit RestoreFootprint then
   * re-prepare. When false (user-signed paths), throw SorobanRestoreRequiredError
   * with the restore XDR for the client to sign first.
   */
  autoRestore?: boolean;
  /** Used for per-policy restore attempt accounting / audit logs. */
  policyId?: string;
  /** Relayer keypair required when autoRestore is true. */
  relayerKeypair?: Keypair;
  /** Account that will sign the restore when autoRestore is false. */
  restoreSourcePublicKey?: string;
}

export interface SimulateTransactionOptions {
  autoRestore?: boolean;
  policyId?: string;
  relayerKeypair?: Keypair;
  restoreSourcePublicKey?: string;
}

interface RestoreAuditEntry {
  policyId?: string;
  estimatedFee: string;
  txHash?: string;
  outcome: "submitted" | "confirmed" | "failed" | "fee_exceeded" | "cap_exceeded" | "client_restore_required";
  at: number;
  error?: string;
}

/**
 * Single injectable Soroban RPC client shared by Policy, Pool, ClaimSettlement,
 * and Tx. Owns retries/timeouts/error classification and restore-preamble handling
 * so feature services no longer each construct an ad-hoc rpc.Server.
 *
 * sendTransaction is intentionally never retried: a timed-out submission may
 * still have landed on-chain, and re-submitting the same envelope with a new
 * sequence would create a duplicate invoke. Callers that need certainty must
 * poll getTransaction by hash instead.
 */
@Injectable()
export class SorobanRpcService {
  private readonly logger = new Logger(SorobanRpcService.name);
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly restoreFeeCeiling: bigint;
  private readonly restoreMaxAttemptsPerPolicy: number;
  private readonly restoreAttempts = new Map<string, number>();
  private readonly inFlightRestores = new Map<string, Promise<void>>();
  private readonly restoreAudit: RestoreAuditEntry[] = [];

  constructor(private readonly configService: ConfigService<AppConfig, true>) {
    const stellar = this.configService.get("stellar", { infer: true });
    this.server = new rpc.Server(stellar.sorobanRpcUrl);
    this.networkPassphrase = stellar.networkPassphrase;
    this.timeoutMs = stellar.rpcTimeoutMs;
    this.maxRetries = stellar.rpcMaxRetries;
    this.restoreFeeCeiling = BigInt(stellar.restoreFeeCeiling);
    this.restoreMaxAttemptsPerPolicy = stellar.restoreMaxAttemptsPerPolicy;
  }

  getNetworkPassphrase(): string {
    return this.networkPassphrase;
  }

  /** Audit trail of restore attempts (fees + outcomes) for ops review. */
  getRestoreAudit(): readonly RestoreAuditEntry[] {
    return this.restoreAudit;
  }

  getRestoreAttemptCount(policyId: string): number {
    return this.restoreAttempts.get(policyId) ?? 0;
  }

  async getAccount(address: string): Promise<Account> {
    return this.withRetry("getAccount", () => this.server.getAccount(address));
  }

  async getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse> {
    return this.withRetry("getTransaction", () => this.server.getTransaction(hash));
  }

  async getEvents(request: rpc.Server.GetEventsRequest): Promise<rpc.Api.GetEventsResponse> {
    return this.withRetry("getEvents", () => this.server.getEvents(request));
  }

  /**
   * Submits a signed transaction. Retries are disabled — see class doc.
   * Transient transport failures are still classified for the caller.
   */
  async sendTransaction(
    tx: Transaction | Parameters<rpc.Server["sendTransaction"]>[0]
  ): Promise<rpc.Api.SendTransactionResponse> {
    return this.withRetry("sendTransaction", () => this.server.sendTransaction(tx as never), {
      retries: 0,
    });
  }

  async simulateTransaction(
    tx: Transaction,
    options: SimulateTransactionOptions = {}
  ): Promise<rpc.Api.SimulateTransactionResponse> {
    const sim = await this.withRetry("simulateTransaction", () => this.server.simulateTransaction(tx));
    if (rpc.Api.isSimulationError(sim)) {
      throw new SorobanContractError(sim.error);
    }
    if (this.isRestorePreamble(sim)) {
      await this.handleRestorePreamble(
        sim,
        options.autoRestore ?? false,
        options.policyId,
        options.relayerKeypair,
        options.restoreSourcePublicKey ?? tx.source
      );
      return this.simulateTransaction(tx, { ...options, autoRestore: options.autoRestore ?? false });
    }
    return sim;
  }

  async prepareTransaction(tx: Transaction, options: PrepareTransactionOptions = {}): Promise<Transaction> {
    try {
      return await this.withRetry("prepareTransaction", () => this.server.prepareTransaction(tx));
    } catch (err) {
      // prepareTransaction internally simulates; when the SDK surfaces a
      // restore preamble as an error string we re-simulate to inspect it.
      const sim = await this.withRetry("simulateTransaction", () => this.server.simulateTransaction(tx));
      if (this.isRestorePreamble(sim)) {
        await this.handleRestorePreamble(
          sim,
          options.autoRestore ?? false,
          options.policyId,
          options.relayerKeypair,
          options.restoreSourcePublicKey ?? tx.source
        );
        return this.prepareTransaction(tx, options);
      }
      if (rpc.Api.isSimulationError(sim)) {
        throw new SorobanContractError(sim.error);
      }
      throw this.classifyError(err);
    }
  }

  /**
   * Proactively extends persistent entry TTLs for footprints that would
   * otherwise archive before a long-lived policy expires. Thresholds are
   * config-driven because testnet and mainnet use different ledger TTLs.
   *
   * Strategy: when a policy's remaining duration (days) is within
   * `stellar.proactiveTtlExtendWithinDays` of expiry, submit an
   * ExtendFootprintTTL op keyed off the last simulation footprint, extending
   * by `stellar.ttlExtensionLedgers` ledgers. Relayer-signed only.
   */
  async extendFootprintTtl(
    footprint: xdr.LedgerFootprint,
    relayerKeypair: Keypair,
    extendToLedgers?: number
  ): Promise<string> {
    const stellar = this.configService.get("stellar", { infer: true });
    const extendTo = extendToLedgers ?? stellar.ttlExtensionLedgers;
    const sourceAccount = await this.getAccount(relayerKeypair.publicKey());
    const built = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.extendFootprintTtl({
          extendTo,
          source: relayerKeypair.publicKey(),
        })
      )
      .setSorobanData(
        new xdr.SorobanTransactionData({
          resources: new xdr.SorobanResources({
            footprint,
            instructions: 0,
            readBytes: 0,
            writeBytes: 0,
          }),
          resourceFee: xdr.Int64.fromString("0"),
          ext: new xdr.ExtensionPoint(),
        })
      )
      .setTimeout(30)
      .build();

    const prepared = await this.withRetry("prepareTransaction", () => this.server.prepareTransaction(built));
    prepared.sign(relayerKeypair);
    const sendResult = await this.sendTransaction(prepared);
    if (sendResult.status === "ERROR" || sendResult.status === "TRY_AGAIN_LATER") {
      throw new SorobanTransientError(`TTL extension submission not accepted: ${sendResult.status}`);
    }
    return sendResult.hash;
  }

  shouldProactivelyExtendTtl(expiresAtUnixSeconds: number): boolean {
    const stellar = this.configService.get("stellar", { infer: true });
    const withinSeconds = stellar.proactiveTtlExtendWithinDays * 86_400;
    const remaining = expiresAtUnixSeconds - Math.floor(Date.now() / 1000);
    return remaining > 0 && remaining <= withinSeconds;
  }

  private isRestorePreamble(sim: rpc.Api.SimulateTransactionResponse): boolean {
    if (typeof rpc.Api.isSimulationRestore === "function" && rpc.Api.isSimulationRestore(sim)) {
      return true;
    }
    return Boolean((sim as { restorePreamble?: unknown }).restorePreamble);
  }

  private async handleRestorePreamble(
    sim: rpc.Api.SimulateTransactionResponse,
    autoRestore: boolean,
    policyId: string | undefined,
    relayerKeypair: Keypair | undefined,
    restoreSourcePublicKey?: string
  ): Promise<void> {
    const preamble = (sim as rpc.Api.SimulateTransactionRestoreResponse).restorePreamble;
    const estimatedFee = BigInt(preamble.minResourceFee);

    if (policyId) {
      const attempts = this.restoreAttempts.get(policyId) ?? 0;
      if (attempts >= this.restoreMaxAttemptsPerPolicy) {
        this.recordRestoreAudit({
          policyId,
          estimatedFee: estimatedFee.toString(),
          outcome: "cap_exceeded",
          at: Date.now(),
          error: `Restore attempt cap (${this.restoreMaxAttemptsPerPolicy}) reached`,
        });
        throw new SorobanContractError(
          `Restore attempt cap (${this.restoreMaxAttemptsPerPolicy}) reached for policy ${policyId}`
        );
      }
    }

    if (estimatedFee > this.restoreFeeCeiling) {
      this.recordRestoreAudit({
        policyId,
        estimatedFee: estimatedFee.toString(),
        outcome: "fee_exceeded",
        at: Date.now(),
        error: `Restore fee ${estimatedFee} exceeds ceiling ${this.restoreFeeCeiling}`,
      });
      this.logger.error(
        `Restore fee ceiling exceeded: fee=${estimatedFee} ceiling=${this.restoreFeeCeiling} policy=${policyId ?? "n/a"}`
      );
      throw new SorobanRestoreFeeExceededError(
        `Restore fee ${estimatedFee} exceeds ceiling ${this.restoreFeeCeiling}`,
        estimatedFee.toString(),
        this.restoreFeeCeiling.toString()
      );
    }

    if (!autoRestore) {
      const sourceKey = restoreSourcePublicKey ?? relayerKeypair?.publicKey();
      if (!sourceKey) {
        throw new SorobanContractError("Restore required but no source account available to build restore XDR");
      }
      const signer = relayerKeypair ?? Keypair.random();
      const restoreXdr = await this.buildRestoreXdr(preamble, signer, estimatedFee, false, sourceKey);
      this.recordRestoreAudit({
        policyId,
        estimatedFee: estimatedFee.toString(),
        outcome: "client_restore_required",
        at: Date.now(),
      });
      throw new SorobanRestoreRequiredError(
        "Archived ledger entries must be restored before this transaction can proceed",
        restoreXdr,
        estimatedFee.toString()
      );
    }

    if (!relayerKeypair) {
      throw new SorobanContractError("autoRestore requested but no relayer keypair provided");
    }

    const dedupeKey = policyId ?? `fee:${estimatedFee}:${JSON.stringify(preamble.transactionData)}`;
    const existing = this.inFlightRestores.get(dedupeKey);
    if (existing) {
      await existing;
      return;
    }

    const restorePromise = this.submitRestore(preamble, relayerKeypair, estimatedFee, policyId);
    this.inFlightRestores.set(dedupeKey, restorePromise);
    try {
      await restorePromise;
    } finally {
      this.inFlightRestores.delete(dedupeKey);
    }
  }

  private async submitRestore(
    preamble: rpc.Api.SimulateTransactionRestoreResponse["restorePreamble"],
    relayerKeypair: Keypair,
    estimatedFee: bigint,
    policyId?: string
  ): Promise<void> {
    if (policyId) {
      this.restoreAttempts.set(policyId, (this.restoreAttempts.get(policyId) ?? 0) + 1);
    }

    try {
      const prepared = await this.buildRestoreTransaction(preamble, relayerKeypair, estimatedFee);
      prepared.sign(relayerKeypair);
      const sendResult = await this.sendTransaction(prepared);
      if (sendResult.status === "ERROR" || sendResult.status === "TRY_AGAIN_LATER") {
        this.recordRestoreAudit({
          policyId,
          estimatedFee: estimatedFee.toString(),
          outcome: "failed",
          at: Date.now(),
          error: `Submission not accepted: ${sendResult.status}`,
        });
        throw new SorobanTransientError(`Restore submission not accepted: ${sendResult.status}`);
      }

      this.recordRestoreAudit({
        policyId,
        estimatedFee: estimatedFee.toString(),
        txHash: sendResult.hash,
        outcome: "submitted",
        at: Date.now(),
      });
      this.logger.log(
        `Restore submitted policy=${policyId ?? "n/a"} fee=${estimatedFee} tx=${sendResult.hash}`
      );

      // Confirm before the caller re-simulates the real invoke — Soroban
      // forbids combining restore with the application invoke.
      for (let attempt = 0; attempt < 15; attempt++) {
        const result = await this.getTransaction(sendResult.hash);
        if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          this.recordRestoreAudit({
            policyId,
            estimatedFee: estimatedFee.toString(),
            txHash: sendResult.hash,
            outcome: "confirmed",
            at: Date.now(),
          });
          return;
        }
        if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
          this.recordRestoreAudit({
            policyId,
            estimatedFee: estimatedFee.toString(),
            txHash: sendResult.hash,
            outcome: "failed",
            at: Date.now(),
            error: "Restore transaction failed on-chain",
          });
          throw new SorobanContractError("Restore transaction failed on-chain");
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      throw new SorobanTransientError("Timed out waiting for restore confirmation");
    } catch (err) {
      if (
        err instanceof SorobanContractError ||
        err instanceof SorobanTransientError ||
        err instanceof SorobanRestoreFeeExceededError
      ) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.recordRestoreAudit({
        policyId,
        estimatedFee: estimatedFee.toString(),
        outcome: "failed",
        at: Date.now(),
        error: message,
      });
      throw err;
    }
  }

  private async buildRestoreXdr(
    preamble: rpc.Api.SimulateTransactionRestoreResponse["restorePreamble"],
    keypair: Keypair,
    estimatedFee: bigint,
    sign: boolean,
    sourcePublicKey?: string
  ): Promise<string> {
    const tx = await this.buildRestoreTransaction(preamble, keypair, estimatedFee, sourcePublicKey);
    if (sign) tx.sign(keypair);
    return tx.toXDR();
  }

  private async buildRestoreTransaction(
    preamble: rpc.Api.SimulateTransactionRestoreResponse["restorePreamble"],
    keypair: Keypair,
    estimatedFee: bigint,
    sourcePublicKey?: string
  ): Promise<Transaction> {
    const sourceAccount = await this.getAccount(sourcePublicKey ?? keypair.publicKey());
    // Fee = base + restore resource fee from the preamble.
    const fee = (BigInt(BASE_FEE) + estimatedFee).toString();
    const sorobanData =
      typeof (preamble.transactionData as { build?: () => xdr.SorobanTransactionData }).build ===
      "function"
        ? (preamble.transactionData as { build: () => xdr.SorobanTransactionData }).build()
        : (preamble.transactionData as unknown as xdr.SorobanTransactionData);
    const built = new TransactionBuilder(sourceAccount, {
      fee,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(Operation.restoreFootprint({}))
      .setSorobanData(sorobanData)
      .setTimeout(30)
      .build();

    return this.withRetry("prepareTransaction", () => this.server.prepareTransaction(built));
  }

  private recordRestoreAudit(entry: RestoreAuditEntry): void {
    this.restoreAudit.push(entry);
    if (this.restoreAudit.length > 500) this.restoreAudit.shift();
  }

  private async withRetry<T>(
    method: RpcMethod,
    fn: () => Promise<T>,
    opts: { retries?: number } = {}
  ): Promise<T> {
    const retries = opts.retries ?? (method === "sendTransaction" ? 0 : this.maxRetries);
    const correlationId = randomUUID();
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= retries) {
      const started = Date.now();
      try {
        const result = await this.withTimeout(fn(), method);
        this.logger.debug(
          JSON.stringify({
            msg: "soroban_rpc",
            method,
            correlationId,
            attempt,
            durationMs: Date.now() - started,
            ok: true,
          })
        );
        return result;
      } catch (err) {
        const classified = this.classifyError(err);
        this.logger.debug(
          JSON.stringify({
            msg: "soroban_rpc",
            method,
            correlationId,
            attempt,
            durationMs: Date.now() - started,
            ok: false,
            error: classified.message,
            errorType: classified.name,
          })
        );
        lastError = classified;
        const retryable =
          classified instanceof SorobanTransientError || classified instanceof SorobanRateLimitError;
        if (!retryable || attempt >= retries) {
          throw classified;
        }
        const delayMs = this.backoffMs(attempt, classified instanceof SorobanRateLimitError
          ? classified.retryAfterSeconds
          : undefined);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        attempt++;
      }
    }
    throw lastError;
  }

  private withTimeout<T>(promise: Promise<T>, method: RpcMethod): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SorobanTransientError(`Soroban RPC ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  private backoffMs(attempt: number, retryAfterSeconds?: number): number {
    if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
      return retryAfterSeconds * 1000;
    }
    const base = Math.min(1_000 * 2 ** attempt, 8_000);
    const jitter = Math.floor(Math.random() * 250);
    return base + jitter;
  }

  classifyError(err: unknown): Error {
    if (
      err instanceof SorobanTransientError ||
      err instanceof SorobanContractError ||
      err instanceof SorobanRateLimitError ||
      err instanceof SorobanNotFoundError ||
      err instanceof SorobanRestoreRequiredError ||
      err instanceof SorobanRestoreFeeExceededError
    ) {
      return err;
    }

    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();
    const status = this.extractHttpStatus(err);

    if (status === 429 || lower.includes("rate limit") || lower.includes("too many requests")) {
      return new SorobanRateLimitError(message, this.extractRetryAfter(err));
    }
    if (status !== undefined && status >= 500) {
      return new SorobanTransientError(message);
    }
    if (
      lower.includes("timeout") ||
      lower.includes("timed out") ||
      lower.includes("econnreset") ||
      lower.includes("econnrefused") ||
      lower.includes("network") ||
      lower.includes("fetch failed") ||
      lower.includes("socket hang up")
    ) {
      return new SorobanTransientError(message);
    }
    if (lower.includes("not found") || lower.includes("missing") && lower.includes("account")) {
      return new SorobanNotFoundError(message);
    }
    // Simulation / host errors that aren't restore preambles are contract-side.
    if (
      lower.includes("simulation failed") ||
      lower.includes("hosterror") ||
      lower.includes("contract") ||
      lower.includes("unreachablecode") ||
      lower.includes("invalidaction")
    ) {
      return new SorobanContractError(message);
    }
    // Default: treat unknown as transient so a dropped packet doesn't become a
    // permanent 400 — callers that know better can catch and reclassify.
    return new SorobanTransientError(message);
  }

  private extractHttpStatus(err: unknown): number | undefined {
    if (!err || typeof err !== "object") return undefined;
    const record = err as { status?: number; response?: { status?: number }; code?: number };
    return record.status ?? record.response?.status ?? (typeof record.code === "number" && record.code >= 400
      ? record.code
      : undefined);
  }

  private extractRetryAfter(err: unknown): number | undefined {
    if (!err || typeof err !== "object") return undefined;
    const record = err as {
      retryAfter?: number | string;
      response?: { headers?: Record<string, string> };
    };
    if (typeof record.retryAfter === "number") return record.retryAfter;
    if (typeof record.retryAfter === "string") {
      const parsed = parseInt(record.retryAfter, 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    const header = record.response?.headers?.["retry-after"] ?? record.response?.headers?.["Retry-After"];
    if (header) {
      const parsed = parseInt(header, 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }
}
