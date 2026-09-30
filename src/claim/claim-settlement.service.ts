import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Address, BASE_FEE, Contract, Keypair, TransactionBuilder, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { decodeI128ReturnValue, pollForConfirmation } from "../stellar/soroban-confirmation.util";
import { SorobanContractError } from "../stellar/soroban-errors";
import { SorobanRpcService } from "../stellar/soroban-rpc.service";

export interface SettlementResult {
  settled: boolean;
  txHash?: string;
  error?: string;
  /** On-chain payout decoded from process_claim's i128 return; null = unknown. */
  actualPayout?: bigint | null;
}

/** PoolError variants from refract-contracts/pool — surfaced as actionable messages. */
const POOL_ERROR_MESSAGES: Record<number, string> = {
  1: "PoolError::NotInitialized — pool has not been initialized",
  2: "PoolError::AlreadyInitialized — pool is already initialized",
  3: "PoolError::Unauthorized — caller is not authorized for this action",
  4: "PoolError::InsufficientCapacity — pool lacks capacity for this coverage",
  5: "PoolError::InsufficientCollateral — pool lacks collateral for this payout",
  6: "PoolError::PolicyNotFound — on-chain policy id does not exist",
  7: "PoolError::PolicyNotActive — policy is not active or already settled",
  8: "PoolError::TriggerNotMet — on-chain trigger condition was not met",
  9: "PoolError::CapitalLocked — LP capital is still within lockup",
  10: "PoolError::InvalidAmount — amount is zero or out of bounds",
};

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
export class ClaimSettlementService {
  private readonly logger = new Logger(ClaimSettlementService.name);
  private readonly networkPassphrase: string;
  private readonly poolContractId: string;
  private readonly relayerKeypair: Keypair | null;

  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly sorobanRpc: SorobanRpcService
  ) {
    const stellar = this.configService.get("stellar", { infer: true });
    this.networkPassphrase = stellar.networkPassphrase;
    this.poolContractId = stellar.poolContractId;
    this.relayerKeypair = stellar.relayerSecret ? Keypair.fromSecret(stellar.relayerSecret) : null;
  }

  /** True once a pool contract ID and relayer secret are configured. */
  isConfigured(): boolean {
    return Boolean(this.poolContractId && this.relayerKeypair);
  }

  async settleClaim(policyId: string, holder: string, payout: bigint): Promise<SettlementResult> {
    if (!this.relayerKeypair || !this.poolContractId) {
      return {
        settled: false,
        error: "Soroban relayer not configured (missing REFRACT_POOL_CONTRACT_ID or ORACLE_RELAYER_SECRET)",
      };
    }

    try {
      const sourceAccount = await this.sorobanRpc.getAccount(this.relayerKeypair.publicKey());
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

      // Relayer path: restore archived entries automatically, then prepare.
      const preparedTx = await this.sorobanRpc.prepareTransaction(builtTx, {
        autoRestore: true,
        policyId,
        relayerKeypair: this.relayerKeypair,
      });
      preparedTx.sign(this.relayerKeypair);

      const sendResult = await this.sorobanRpc.sendTransaction(preparedTx);
      if (sendResult.status === "ERROR" || sendResult.status === "TRY_AGAIN_LATER") {
        return { settled: false, error: `Submission not accepted: ${sendResult.status}` };
      }

      const confirmation = await pollForConfirmation(this.sorobanRpc, sendResult.hash);
      if (!confirmation.confirmed) {
        return { settled: false, txHash: confirmation.txHash, error: confirmation.error };
      }

      let actualPayout: bigint | null = null;
      try {
        actualPayout = decodeI128ReturnValue(confirmation.returnValue);
      } catch (decodeErr) {
        const message = decodeErr instanceof Error ? decodeErr.message : String(decodeErr);
        const poolMessage = decodePoolErrorMessage(message);
        return { settled: false, txHash: confirmation.txHash, error: poolMessage ?? message };
      }

      return {
        settled: true,
        txHash: confirmation.txHash,
        actualPayout,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const mapped = decodePoolErrorMessage(message) ?? message;
      this.logger.error(`Soroban settlement failed for policy ${policyId}`, mapped);
      return { settled: false, error: mapped };
    }
  }
}

/** Best-effort mapping of stringified PoolError / Result::Err blobs to actionable text. */
export function decodePoolErrorMessage(raw: string): string | undefined {
  const codeMatch = raw.match(/PoolError(?:\s*::|\s+)?(\w+)|error(?:\s+code)?\s*[:=]?\s*#?(\d+)/i);
  if (codeMatch?.[1]) {
    const name = codeMatch[1];
    const byName: Record<string, string> = {
      NotInitialized: POOL_ERROR_MESSAGES[1],
      AlreadyInitialized: POOL_ERROR_MESSAGES[2],
      Unauthorized: POOL_ERROR_MESSAGES[3],
      InsufficientCapacity: POOL_ERROR_MESSAGES[4],
      InsufficientCollateral: POOL_ERROR_MESSAGES[5],
      PolicyNotFound: POOL_ERROR_MESSAGES[6],
      PolicyNotActive: POOL_ERROR_MESSAGES[7],
      TriggerNotMet: POOL_ERROR_MESSAGES[8],
      CapitalLocked: POOL_ERROR_MESSAGES[9],
      InvalidAmount: POOL_ERROR_MESSAGES[10],
    };
    if (byName[name]) return byName[name];
  }
  if (codeMatch?.[2]) {
    const code = parseInt(codeMatch[2], 10);
    if (POOL_ERROR_MESSAGES[code]) return POOL_ERROR_MESSAGES[code];
  }
  // Result::Err JSON from scValToNative
  try {
    const parsed = JSON.parse(raw.replace(/^Contract returned an error result:\s*/, "")) as {
      error?: number | string;
      tag?: string;
    };
    if (typeof parsed.error === "number" && POOL_ERROR_MESSAGES[parsed.error]) {
      return POOL_ERROR_MESSAGES[parsed.error];
    }
    if (typeof parsed.tag === "string") {
      return decodePoolErrorMessage(`PoolError::${parsed.tag}`);
    }
  } catch {
    // not JSON
  }
  if (raw.includes("PoolError") || raw.includes("Contract returned an error result")) {
    return raw;
  }
  return undefined;
}

/** Re-export for callers that need the contract-error type when testing. */
export { SorobanContractError, scValToNative };
