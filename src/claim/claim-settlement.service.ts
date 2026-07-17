import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Address, BASE_FEE, Contract, Keypair, TransactionBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";

const CONFIRMATION_POLL_INTERVAL_MS = 2000;
const CONFIRMATION_MAX_ATTEMPTS = 15; // ~30s at the interval above

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
 * ASSUMED CONTRACT INTERFACE — UNVERIFIED AGAINST refract-contracts:
 * This repo only has the backend; the pool contract's real source/ABI
 * lives in the separate refract-contracts repo, which isn't available
 * here. The signature below —
 *
 *   process_claim(policy_id: String, holder: Address, payout: i128) -> bool
 *
 * — is a best-effort guess based on the fields ClaimService already has on
 * hand (StoredPolicy.id, StoredPolicy.holder, the payout amount in 1e7
 * base units). Soroban validates arguments against the contract's on-chain
 * spec during simulation, before any state changes or fees are spent, so a
 * wrong function name/argument order/type fails loudly at
 * prepareTransaction() rather than silently misbehaving — but this still
 * needs to be confirmed against the real deployed contract before it's
 * trusted to pay out real claims.
 */
@Injectable()
export class ClaimSettlementService {
  private readonly logger = new Logger(ClaimSettlementService.name);
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly poolContractId: string;
  private readonly relayerKeypair: Keypair | null;

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

      return await this.pollForConfirmation(sendResult.hash);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Soroban settlement failed for policy ${policyId}`, message);
      return { settled: false, error: message };
    }
  }

  private async pollForConfirmation(hash: string): Promise<SettlementResult> {
    for (let attempt = 0; attempt < CONFIRMATION_MAX_ATTEMPTS; attempt++) {
      const result = await this.server.getTransaction(hash);
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return { settled: true, txHash: hash };
      }
      if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
        return { settled: false, txHash: hash, error: "Transaction failed on-chain" };
      }
      await new Promise((resolve) => setTimeout(resolve, CONFIRMATION_POLL_INTERVAL_MS));
    }
    return { settled: false, txHash: hash, error: "Timed out waiting for confirmation" };
  }
}
