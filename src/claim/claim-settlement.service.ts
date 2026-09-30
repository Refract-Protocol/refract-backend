import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BASE_FEE, Contract, Keypair, TransactionBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { FeeCeilingExceededError, FeeStrategyService } from "../stellar/fee-strategy.service";
import { encodeProcessClaimArg } from "../stellar/scval-encoders";
import { SorobanRpcService } from "../stellar/soroban-rpc.service";
import { submitAndConfirm } from "../stellar/transaction-submitter";

export interface SettlementResult {
  settled: boolean;
  txHash?: string;
  error?: string;
  /** True when the failure is a permanent code-level bug (wrong arity/types) — do not retry. */
  permanent?: boolean;
}

/**
 * Optional holder/payout retained for logging and audit only. The on-chain
 * `process_claim(policy_id: u64)` looks up holder, payout, and trigger
 * condition from Policy storage — they are never encoded into the call.
 */
export interface SettlementAudit {
  holder?: string;
  payout?: bigint;
}

/**
 * Builds, signs, and submits the pool.process_claim() Soroban transaction
 * that actually pays out a triggered claim.
 *
 * Contract interface (refract-contracts / RefractPool):
 *
 *   pub fn process_claim(env: Env, policy_id: u64) -> Result<i128, PoolError>
 *
 * Exactly one argument: the on-chain u64 policy id minted by buy_policy().
 * Encoded as `nativeToScVal(policyId, { type: "u64" })` with an explicit
 * bigint — a JS number would pick the wrong ScVal discriminant, and values
 * above Number.MAX_SAFE_INTEGER must survive (see CONTRIBUTING.md BigInt rule).
 *
 * Decoding the returned i128 payout is a separate follow-on; this service
 * only cares that settlement confirms.
 */
@Injectable()
export class ClaimSettlementService {
  private readonly logger = new Logger(ClaimSettlementService.name);
  private readonly poolContractId: string;
  private readonly relayerKeypair: Keypair | null;
  private readonly confirmationDefaults: AppConfig["confirmation"];

  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly rpcService: SorobanRpcService,
    private readonly feeStrategy: FeeStrategyService
  ) {
    const stellar = this.configService.get("stellar", { infer: true });
    this.poolContractId = stellar.poolContractId;
    this.relayerKeypair = stellar.relayerSecret ? Keypair.fromSecret(stellar.relayerSecret) : null;
    this.confirmationDefaults = this.configService.get("confirmation", { infer: true });
  }

  private get server(): rpc.Server {
    return this.rpcService.server;
  }

  private get networkPassphrase(): string {
    return this.rpcService.networkPassphrase;
  }

  /** True once a pool contract ID and relayer secret are configured. */
  isConfigured(): boolean {
    return Boolean(this.poolContractId && this.relayerKeypair);
  }

  /**
   * @param onChainPolicyId - u64 minted by buy_policy(), carried as bigint end-to-end.
   * @param audit - holder/payout for logs only; not sent to the contract.
   */
  async settleClaim(onChainPolicyId: bigint, audit: SettlementAudit = {}): Promise<SettlementResult> {
    if (!this.relayerKeypair || !this.poolContractId) {
      return {
        settled: false,
        error: "Soroban relayer not configured (missing REFRACT_POOL_CONTRACT_ID or ORACLE_RELAYER_SECRET)",
        permanent: true,
      };
    }

    const auditSuffix =
      audit.holder !== undefined || audit.payout !== undefined
        ? ` holder=${audit.holder ?? "?"} payout=${audit.payout?.toString() ?? "?"}`
        : "";

    try {
      const inclusionFee = await this.feeStrategy.estimateInclusionFee("aggressive");
      const sourceAccount = await this.server.getAccount(this.relayerKeypair.publicKey());
      const contract = new Contract(this.poolContractId);

      // Single u64 arg — must be bigint + explicit { type: "u64" } so the
      // XDR discriminant is scvU64 (not scvString / scvI128 / scvU32).
      const operation = contract.call("process_claim", nativeToScVal(onChainPolicyId, { type: "u64" }));

      const builtTx = new TransactionBuilder(sourceAccount, {
        fee: inclusionFee,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      // Simulates against the live contract and fills in Soroban resource
      // fees/footprint — argument/arity mismatches surface here as a
      // permanent code-level bug (distinct from transient RPC failures).
      const preparedTx = await this.server.prepareTransaction(builtTx);
      const preparedFee = (preparedTx as { fee?: string }).fee;
      this.feeStrategy.assertTotalUnderCeiling(
        inclusionFee,
        preparedFee ? BigInt(preparedFee) - BigInt(inclusionFee) : 0n
      );

      preparedTx.sign(this.relayerKeypair);

      // Validity window matches setTimeout(30). TRY_AGAIN_LATER retries reuse
      // this identical signed envelope — never rebuild inside the submitter.
      const confirmation = await submitAndConfirm(this.server, preparedTx, {
        validityWindowMs: 30_000,
      });

      const confirmation = await pollForConfirmation(this.server, sendResult.hash, {
        initialIntervalMs: this.confirmationDefaults.initialIntervalMs,
        backoffMultiplier: this.confirmationDefaults.backoffMultiplier,
        maxIntervalMs: this.confirmationDefaults.maxIntervalMs,
        jitterRatio: this.confirmationDefaults.jitterRatio,
        deadlineMs: this.confirmationDefaults.settlementDeadlineMs,
      });

      if (confirmation.outcome === "success") {
        this.logger.log(
          `Settlement confirmed for on-chain policy ${onChainPolicyId}${auditSuffix}: tx=${confirmation.txHash}`
        );
        return { settled: true, txHash: confirmation.txHash };
      }

      return {
        settled: false,
        txHash: confirmation.txHash,
        error: confirmation.error,
        // Deadline exceeded is indeterminate — caller may retry. On-chain
        // failure is definite; still leave retry policy to ClaimService.
        permanent: confirmation.outcome === "failed_on_chain",
        resultCode: confirmation.resultCode,
      };
    } catch (err) {
      if (err instanceof FeeCeilingExceededError) {
        this.logger.error(`Settlement fee ceiling exceeded for policy ${onChainPolicyId}: ${err.message}`);
        return { settled: false, error: err.message, resultCode: "txINSUFFICIENT_FEE" };
      }
      const message = err instanceof Error ? err.message : String(err);
      if (isArgumentArityMismatch(message)) {
        // Greppable permanent marker — do not treat as a transient RPC blip.
        this.logger.error(
          `CLAIM_SETTLEMENT_SIGNATURE_MISMATCH policy=${onChainPolicyId}${auditSuffix}: ${message}`
        );
        return {
          settled: false,
          error: message,
          permanent: true,
        };
      }
      this.logger.error(`Soroban settlement failed for on-chain policy ${onChainPolicyId}${auditSuffix}`, message);
      return { settled: false, error: message };
    }
  }
}

/**
 * Heuristic for Soroban simulation / prepareTransaction failures that
 * indicate a wrong function arity or ScVal type — a permanent code bug —
 * vs. timeouts / 5xx / connection errors that should stay retryable.
 */
export function isArgumentArityMismatch(message: string): boolean {
  const lower = message.toLowerCase();
  // Timeouts and transport failures must not be classified as signature bugs.
  if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("network") ||
    lower.includes("503") ||
    lower.includes("429")
  ) {
    return false;
  }
  return (
    lower.includes("argument") ||
    lower.includes("arity") ||
    lower.includes("unexpected type") ||
    lower.includes("invalid type") ||
    lower.includes("wrong type") ||
    lower.includes("type mismatch") ||
    lower.includes("missingargument") ||
    lower.includes("extraneousargument") ||
    lower.includes("invalidinput")
  );
}
