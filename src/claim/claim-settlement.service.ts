import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Address, Contract, Transaction, TransactionBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { RelayerAccountService } from "../stellar/relayer-account.service";
import {
  STELLAR_NOT_CONFIGURED_MESSAGE,
  StellarConfigValidator,
} from "../stellar/stellar-config.validator";
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
 *
 * Relayer sequence/fees/signing go through RelayerAccountService so concurrent
 * settlement and oracle publishes cannot collide on sequence numbers.
 */
@Injectable()
export class ClaimSettlementService {
  private readonly logger = new Logger(ClaimSettlementService.name);
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly poolContractId: string;

  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly relayerAccount: RelayerAccountService,
    private readonly stellarConfig: StellarConfigValidator
  ) {
    const stellar = this.configService.get("stellar", { infer: true });
    this.server = new rpc.Server(stellar.sorobanRpcUrl);
    this.networkPassphrase = stellar.networkPassphrase;
    this.poolContractId = stellar.poolContractId;
  }

  /** True once the Stellar network is fully configured and the relayer can cover fees. */
  isConfigured(): boolean {
    return this.stellarConfig.isNetworkFullyConfigured() && this.relayerAccount.isReady();
  }

  async settleClaim(policyId: string, holder: string, payout: bigint): Promise<SettlementResult> {
    if (!this.isConfigured() || !this.poolContractId) {
      return {
        settled: false,
        error: STELLAR_NOT_CONFIGURED_MESSAGE,
      };
    }

    try {
      const { hash } = await this.relayerAccount.submitRelayerTransaction(async (account, fee) => {
        const contract = new Contract(this.poolContractId);
        const operation = contract.call(
          "process_claim",
          nativeToScVal(policyId, { type: "string" }),
          new Address(holder).toScVal(),
          nativeToScVal(payout, { type: "i128" })
        );

        const builtTx = new TransactionBuilder(account, {
          fee,
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(operation)
          .setTimeout(30)
          .build();

        const prepared = await this.server.prepareTransaction(builtTx);
        return prepared as Transaction;
      });

      const confirmation = await pollForConfirmation(this.server, hash);
      return { settled: confirmation.confirmed, txHash: confirmation.txHash, error: confirmation.error };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Soroban settlement failed for policy ${policyId}`, message);
      return { settled: false, error: message };
    }
  }
}
