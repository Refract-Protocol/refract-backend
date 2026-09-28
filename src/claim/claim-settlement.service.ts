import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BASE_FEE, Contract, Keypair, TransactionBuilder, nativeToScVal } from "@stellar/stellar-sdk";
import { Pool } from "pg";
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
 * Calls the pool's real process_claim(policy_id: u64) entrypoint. The
 * contract looks up the holder and payout from its own policy storage, so
 * callers must pass the on-chain policy ID rather than off-chain claim data.
 *
 */
@Injectable()
export class ClaimSettlementService implements OnModuleDestroy {
  private readonly logger = new Logger(ClaimSettlementService.name);
  private readonly databasePool: Pool;
  private readonly rpcClient: SorobanRpcClient;
  private readonly networkPassphrase: string;
  private readonly poolContractId: string;
  private readonly configuredRelayerSecret: string;
  private settlementQueue: Promise<void> = Promise.resolve();

  constructor(private readonly configService: ConfigService<AppConfig, true>) {
    const stellar = this.configService.get("stellar", { infer: true });
    this.databasePool = new Pool({ connectionString: this.configService.get("database.url", { infer: true }) });
    this.rpcClient = new SorobanRpcClient(stellar.sorobanRpcUrls);
    this.networkPassphrase = stellar.networkPassphrase;
    this.poolContractId = stellar.poolContractId;
    this.configuredRelayerSecret = stellar.relayerSecret;
  }

  async onModuleDestroy(): Promise<void> {
    await this.databasePool.end();
  }

  /** True once a pool contract ID and relayer secret are configured. */
  isConfigured(): boolean {
    return Boolean(this.poolContractId && this.getRelayerKeypair());
  }

  private getRelayerKeypair(): Keypair | null {
    // Resolve the active environment value per settlement rather than
    // retaining a Keypair, allowing runtime secret providers to rotate it.
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

  async settleClaim(policyId: string): Promise<SettlementResult> {
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
        return await this.withAccountSequenceLock(relayerKeypair.publicKey(), async () => {
          try {
            // The PostgreSQL advisory lock serializes this account across
            // application replicas. Refresh the sequence only after the prior
            // transaction has reached a terminal confirmation state.
            const sourceAccount = await this.rpcClient.call((server) => server.getAccount(relayerKeypair.publicKey()));
            const contract = new Contract(this.poolContractId);
            const operation = contract.call("process_claim", nativeToScVal(BigInt(policyId), { type: "u64" }));
            const builtTx = new TransactionBuilder(sourceAccount, {
              fee: BASE_FEE,
              networkPassphrase: this.networkPassphrase,
            })
              .addOperation(operation)
              .setTimeout(30)
              .build();

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
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to acquire relayer sequence lock for policy ${policyId}`, message);
        return { settled: false, error: message };
      }
    });
  }

  private async withAccountSequenceLock<T>(publicKey: string, operation: () => Promise<T>): Promise<T> {
    const client = await this.databasePool.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [publicKey]);
      const result = await operation();
      await client.query("COMMIT");
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          this.logger.error(
            "Failed to roll back relayer sequence lock transaction",
            rollbackError instanceof Error ? rollbackError.stack : String(rollbackError)
          );
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
