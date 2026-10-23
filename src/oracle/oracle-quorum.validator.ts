import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Account, Contract, Keypair, TransactionBuilder, rpc, scValToNative } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { RelayerKeyring } from "../stellar/relayer-keyring.service";

const FEEDS = ["StablecoinDepeg", "MarketCrash", "LiquidationShield", "SmartContractRisk", "FlightDelay"];

/**
 * Startup check, in the spirit of the pool WASM spec check: the configured
 * quorum must be satisfiable by the keyring AND not be lower than what the
 * deployed RefractOracle enforces (its `required_signers()` view). A
 * misconfigured threshold throws at boot instead of silently degrading to
 * single-signer.
 */
@Injectable()
export class OracleQuorumValidator implements OnModuleInit {
  private readonly logger = new Logger(OracleQuorumValidator.name);

  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly keyring: RelayerKeyring
  ) {}

  async onModuleInit(): Promise<void> {
    await this.validate();
  }

  async validate(): Promise<void> {
    const stellar = this.configService.get("stellar", { infer: true });
    const contractId = stellar.oracleContractId?.trim();
    if (!contractId) return; // oracle publishing disabled

    this.keyring.assertThresholds(FEEDS, stellar.network);

    const minRequired = Math.min(...FEEDS.map((f) => this.keyring.requiredSignatures(f)));
    const maxRequired = Math.max(...FEEDS.map((f) => this.keyring.requiredSignatures(f)));
    const onChain = await this.readOnChainThreshold(contractId, stellar.sorobanRpcUrl, stellar.networkPassphrase);
    if (onChain === null) {
      if (maxRequired > 1) {
        throw new Error(
          "Deployed RefractOracle does not expose required_signers(); cannot enforce a multi-signer quorum"
        );
      }
      return;
    }
    if (onChain > maxRequired) {
      throw new Error(
        `Deployed RefractOracle requires ${onChain} signers but backend max threshold is ${maxRequired}; publishes would be rejected`
      );
    }
    if (onChain > minRequired) {
      this.logger.warn(
        `Some feeds use a backend threshold (${minRequired}) below the on-chain requirement (${onChain}); those publishes will be rejected on-chain`
      );
    }
    this.logger.log(`Oracle quorum validated (backend ${minRequired}-${maxRequired}, on-chain ${onChain})`);
  }

  private async readOnChainThreshold(contractId: string, rpcUrl: string, passphrase: string): Promise<number | null> {
    const server = new rpc.Server(rpcUrl);
    const source = new Account(Keypair.random().publicKey(), "0");
    const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: passphrase })
      .addOperation(new Contract(contractId).call("required_signers"))
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) return null;
    return Number(scValToNative(sim.result.retval));
  }
}
