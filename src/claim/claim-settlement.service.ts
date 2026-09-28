import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Address, BASE_FEE, Contract, Keypair, TransactionBuilder, nativeToScVal } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { pollForConfirmation } from "../stellar/soroban-confirmation.util";
import { SorobanRpcClient } from "../stellar/soroban-rpc.client";

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
export class ClaimSettlementService {
  private readonly logger = new Logger(ClaimSettlementService.name);
  private readonly rpcClient: SorobanRpcClient;
  private readonly networkPassphrase: string;
  private readonly poolContractId: string;
  private readonly configuredRelayerSecret: string;
  private settlementQueue: Promise<void> = Promise.resolve();

  constructor(private readonly configService: ConfigService<AppConfig, true>) {
    const stellar = this.configService.get("stellar", { infer: true });
    this.rpcClient = new SorobanRpcClient(stellar.sorobanRpcUrls);
    this.networkPassphrase = stellar.networkPassphrase;
    this.poolContractId = stellar.poolContractId;
    this.configuredRelayerSecret = stellar.relayerSecret;
  }

  /** True once a pool contract ID and relayer secret are configured. */
  isConfigured(): boolean {
    return Boolean(this.poolContractId && this.getRelayerKeypair());
  }

  private getRelayerKeypair(): Keypair | null {
    // Read the environment on each operation so a secret rotation can take
    // effect without rebuilding this service or restarting the application.
    const secret = process.env.ORACLE_RELAYER_SECRET ?? this.configuredRelayerSecret;
    if (!secret) return null;
    try {
      return Keypair.fromSecret(secret);
    } catch {
      return null;
    }
  }

  private async withSettlementLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.settlementQueue.then(operation, operation);
    this.settlementQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async settleClaim(policyId: string, holder: string, payout: bigint): Promise<SettlementResult> {
    if (!this.poolContractId) {
      return {
        settled: false,
        error: "Soroban relayer not configured (missing REFRACT_POOL_CONTRACT_ID or ORACLE_RELAYER_SECRET)",
      };
    }

    return this.withSettlementLock(async () => {
      const relayerKeypair = this.getRelayerKeypair();
      if (!relayerKeypair) {
        return {
          settled: false,
          error: "Soroban relayer not configured (missing or invalid ORACLE_RELAYER_SECRET)",
        };
      }

      try {
        // Keep sequence lookup, submission, and confirmation serialized.
        // This ensures concurrent claim scans don't build two transactions
        // from the same account sequence; refetching after confirmation also
        // reconciles the local sequence with the network after key rotation.
        const sourceAccount = await this.rpcClient.call((server) => server.getAccount(relayerKeypair.publicKey()));
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
        const preparedTx = await this.rpcClient.call((server) => server.prepareTransaction(builtTx));
        preparedTx.sign(relayerKeypair);

        const sendResult = await this.rpcClient.call((server) => server.sendTransaction(preparedTx));
        if (sendResult.status === "ERROR" || sendResult.status === "TRY_AGAIN_LATER") {
          return { settled: false, error: `Submission not accepted: ${sendResult.status}` };
        }

        const confirmation = await pollForConfirmation(this.rpcClient, sendResult.hash);
        return { settled: confirmation.confirmed, txHash: confirmation.txHash, error: confirmation.error };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Soroban settlement failed for policy ${policyId}`, message);
        return { settled: false, error: message };
      }
    });
  }
}
