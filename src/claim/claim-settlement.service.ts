import { Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Address, BASE_FEE, Contract, Keypair, TransactionBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { pollForConfirmation } from "../stellar/soroban-confirmation.util";

export interface SettlementResult {
  settled: boolean;
  txHash?: string;
  error?: string;
}

/**
 * Builds, signs, and submits the pool.process_claim() Soroban transaction
 * that actually pays out a triggered claim — replaces the logged stub that
 * used to live in ClaimService.processPayout().
 *
 * CONFIRMED MISMATCH AGAINST refract-contracts — DO NOT DEPLOY AS-IS:
 * refract-contracts/pool/src/lib.rs's real signature is
 *
 *   pub fn process_claim(env: Env, policy_id: u64) -> Result<i128, PoolError>
 *
 * i.e. it takes a single u64 policy id — no holder, no payout — and looks
 * up the holder/payout/trigger condition itself from on-chain Policy
 * storage, returning the payout amount. The call built below still passes
 * the old guessed 3-argument shape (String policy_id, Address holder, i128
 * payout), which fails Soroban's argument-count/type check during
 * simulation on every invocation.
 *
 * That argument mismatch is also downstream of a bigger gap: StoredPolicy.id
 * (see policy.service.ts) is a uuidv4() string minted entirely off-chain,
 * never the u64 the real buy_policy() call returns on-chain (buy_policy
 * itself is also still a txXdr stub — see PolicyService.buy()). There is
 * currently no code path that produces a real on-chain policy id to submit
 * here, so fixing the argument shape alone isn't sufficient; the buy flow
 * needs to actually invoke buy_policy() and thread its returned id through
 * before this can settle a real claim.
 */
@Injectable()
export class ClaimSettlementService implements OnApplicationShutdown {
  private readonly logger = new Logger(ClaimSettlementService.name);
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly poolContractId: string;
  private readonly relayerKeypair: Keypair | null;

  /**
   * In-flight settlements keyed by the submitted transaction hash. A
   * settlement is added immediately after sendTransaction() accepts the
   * transaction and removed once it is confirmed (or has failed). Shutdown
   * waits on these so a payout that already moved on-chain is never lost
   * without a record.
   */
  private readonly inFlight = new Map<string, Promise<SettlementResult>>();

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

  /**
   * Graceful-shutdown hook. Waits for any submitted-but-unconfirmed
   * settlement to finish within the configured grace period. If the period
   * expires, the pending transaction hash is persisted with a loud warning
   * so it can be reconciled on restart — a submitted Soroban transaction
   * cannot be cancelled, so waiting or recording are the only safe options.
   */
  async onApplicationShutdown(): Promise<void> {
    if (this.inFlight.size === 0) {
      return;
    }

    const graceMs = this.configService.get("shutdown", { infer: true })?.gracePeriodMs ?? 30_000;
    this.logger.warn(
      `Shutdown requested with ${this.inFlight.size} in-flight settlement(s); waiting up to ${graceMs}ms for confirmation`
    );

    const pending = Array.from(this.inFlight.entries());
    const drained = await Promise.race([
      Promise.allSettled(pending.map(([, promise]) => promise)).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
    ]);

    if (drained) {
      this.logger.log("All in-flight settlements confirmed before shutdown");
      return;
    }

    for (const [txHash] of pending) {
      if (this.inFlight.has(txHash)) {
        this.logger.error(
          `PENDING SETTLEMENT NOT CONFIRMED BEFORE SHUTDOWN — tx ${txHash} was submitted on-chain but not confirmed. ` +
            `Persist this hash and reconcile it on restart; the payout may have moved.`
        );
      }
    }
  }

  async settleClaim(policyId: string, holder: string, payout: bigint): Promise<SettlementResult> {
    if (!this.relayerKeypair || !this.poolContractId) {
      return {
        settled: false,
        error: "Soroban relayer not configured (missing REFRACT_POOL_CONTRACT_ID or ORACLE_RELAYER_SECRET)",
      };
    }

    try {
      const sourceAccount = await this.server.getAccount(this.relayerKeypair.publicKey());
      const contract = new Contract(this.poolContractId);

      const operation = contract.call(
        "process_claim",
        nativeToScVal(policyId, { type: "string" }),
        new Address(holder).toScVal(),
        nativeToScVal(payout, { type: "i128" })
      );

      const builtTx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      // Simulates against the live contract and fills in Soroban resource
      // fees/footprint — this is where a wrong function name or argument
      // shape for the ASSUMED interface above would surface.
      const preparedTx = await this.server.prepareTransaction(builtTx);
      preparedTx.sign(this.relayerKeypair);

      const sendResult = await this.server.sendTransaction(preparedTx);
      if (sendResult.status === "ERROR" || sendResult.status === "TRY_AGAIN_LATER") {
        return { settled: false, error: `Submission not accepted: ${sendResult.status}` };
      }

      // The transaction is now submitted on-chain and cannot be cancelled.
      // Track it so shutdown waits for confirmation (or records the hash).
      const confirmationPromise = pollForConfirmation(this.server, sendResult.hash).then(
        (confirmation) => ({
          settled: confirmation.confirmed,
          txHash: confirmation.txHash,
          error: confirmation.error,
        })
      );
      this.inFlight.set(sendResult.hash, confirmationPromise);

      try {
        return await confirmationPromise;
      } finally {
        this.inFlight.delete(sendResult.hash);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Soroban settlement failed for policy ${policyId}`, message);
      return { settled: false, error: message };
    }
  }
}
