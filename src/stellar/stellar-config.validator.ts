import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Contract, Keypair, StrKey, rpc } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";

/** Known network → passphrase pairs. Aliases (public/mainnet) share one passphrase. */
export const NETWORK_PASSPHRASES: Record<string, string> = {
  testnet: "Test SDF Network ; September 2015",
  public: "Public Global Stellar Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
};

export const STELLAR_NOT_CONFIGURED_MESSAGE = "Stellar network is not fully configured";

export interface ContractHealthEntry {
  configured: boolean;
  valid: boolean;
  reachable: boolean | null;
  id: string | null;
}

export interface StellarValidationHealth {
  fullyConfigured: boolean;
  requireNetwork: boolean;
  network: string;
  networkPassphraseOk: boolean;
  errors: string[];
  relayerPublicKey: string | null;
  contracts: {
    pool: ContractHealthEntry;
    policy: ContractHealthEntry;
    oracle: ContractHealthEntry;
  };
}

interface ContractSlot {
  name: "pool" | "policy" | "oracle";
  id: string;
}

/**
 * Bootstrap-time checks for Stellar/Soroban configuration: StrKey shapes,
 * network/passphrase consistency, optional on-chain contract liveness, and a
 * single `isNetworkFullyConfigured()` flag consumed by write/read paths that
 * previously ad-hoc-checked poolContractId / relayerSecret.
 */
@Injectable()
export class StellarConfigValidator implements OnModuleInit {
  private readonly logger = new Logger(StellarConfigValidator.name);
  private readonly server: rpc.Server;
  private health: StellarValidationHealth;

  constructor(private readonly configService: ConfigService<AppConfig, true>) {
    const stellar = this.configService.get("stellar", { infer: true });
    this.server = new rpc.Server(stellar.sorobanRpcUrl);
    this.health = this.emptyHealth(stellar);
  }

  async onModuleInit(): Promise<void> {
    await this.validate();
  }

  /** True when pool contract + relayer are present, valid, and passphrase matches. */
  isNetworkFullyConfigured(): boolean {
    return this.health.fullyConfigured;
  }

  getHealthStatus(): StellarValidationHealth {
    return this.health;
  }

  /**
   * Runs (or re-runs) validation. Exposed for tests so they can drive the
   * same path without spinning up a Nest module.
   */
  async validate(): Promise<StellarValidationHealth> {
    const stellar = this.configService.get("stellar", { infer: true });
    const errors: string[] = [];
    const networkKey = stellar.network.trim().toLowerCase();
    const expectedPassphrase = NETWORK_PASSPHRASES[networkKey];
    const networkPassphraseOk = expectedPassphrase !== undefined && stellar.networkPassphrase === expectedPassphrase;

    if (!expectedPassphrase) {
      errors.push(
        `Unknown STELLAR_NETWORK "${stellar.network}" (expected one of: ${Object.keys(NETWORK_PASSPHRASES).join(", ")})`
      );
    } else if (!networkPassphraseOk) {
      errors.push(
        `STELLAR_NETWORK_PASSPHRASE does not match STELLAR_NETWORK="${stellar.network}" (expected "${expectedPassphrase}")`
      );
    }

    const slots: ContractSlot[] = [
      { name: "pool", id: stellar.poolContractId },
      { name: "policy", id: stellar.policyContractId },
      { name: "oracle", id: stellar.oracleContractId },
    ];

    const contractHealth: StellarValidationHealth["contracts"] = {
      pool: this.contractEntry(""),
      policy: this.contractEntry(""),
      oracle: this.contractEntry(""),
    };

    for (const slot of slots) {
      const id = slot.id.trim();
      if (!id) {
        contractHealth[slot.name] = this.contractEntry("");
        continue;
      }
      const valid = StrKey.isValidContract(id);
      if (!valid) {
        // Name the slot only — never echo a value that might be a mistaken secret.
        errors.push(`Invalid ${slot.name} contract ID (expected a StrKey contract address C…)`);
        contractHealth[slot.name] = { configured: true, valid: false, reachable: null, id: null };
      } else {
        contractHealth[slot.name] = { configured: true, valid: true, reachable: null, id };
      }
    }

    let relayerPublicKey: string | null = null;
    const relayerSecret = stellar.relayerSecret.trim();
    if (relayerSecret) {
      if (!StrKey.isValidEd25519SecretSeed(relayerSecret)) {
        errors.push("Invalid ORACLE_RELAYER_SECRET (expected an ed25519 secret seed S…)");
      } else {
        // Derive the public key only — never log or store the secret itself.
        relayerPublicKey = Keypair.fromSecret(relayerSecret).publicKey();
        this.logger.log(`Relayer identity: ${relayerPublicKey}`);
      }
    }

    if (stellar.validateOnChain) {
      for (const slot of slots) {
        const entry = contractHealth[slot.name];
        if (!entry.valid || !entry.id) continue;
        entry.reachable = await this.probeContract(entry.id, stellar.validateTimeoutMs);
        if (!entry.reachable) {
          errors.push(
            `Configured ${slot.name} contract is not reachable on-chain within ${stellar.validateTimeoutMs}ms`
          );
        }
      }
    }

    const poolOk = contractHealth.pool.configured && contractHealth.pool.valid;
    const relayerOk = relayerPublicKey !== null;
    const fullyConfigured = poolOk && relayerOk && networkPassphraseOk && errors.length === 0;

    const shapeErrors = errors.filter((e) => !e.includes("not reachable"));
    const hasHardFailure = shapeErrors.length > 0 || (stellar.requireNetwork && !fullyConfigured);

    this.health = {
      fullyConfigured,
      requireNetwork: stellar.requireNetwork,
      network: stellar.network,
      networkPassphraseOk,
      errors,
      relayerPublicKey,
      contracts: contractHealth,
    };

    if (hasHardFailure) {
      const message = `Stellar configuration validation failed: ${errors.join("; ") || STELLAR_NOT_CONFIGURED_MESSAGE}`;
      this.logger.error(message);
      throw new Error(message);
    }

    if (!fullyConfigured) {
      this.logger.warn(
        errors.length > 0
          ? `Stellar config incomplete: ${errors.join("; ")}`
          : "Stellar network is not fully configured — starting in degraded mode"
      );
    } else {
      this.logger.log("Stellar configuration validated");
    }

    return this.health;
  }

  private emptyHealth(stellar: AppConfig["stellar"]): StellarValidationHealth {
    return {
      fullyConfigured: false,
      requireNetwork: stellar.requireNetwork,
      network: stellar.network,
      networkPassphraseOk: false,
      errors: [],
      relayerPublicKey: null,
      contracts: {
        pool: this.contractEntry(""),
        policy: this.contractEntry(""),
        oracle: this.contractEntry(""),
      },
    };
  }

  private contractEntry(id: string): ContractHealthEntry {
    const trimmed = id.trim();
    return {
      configured: Boolean(trimmed),
      valid: false,
      reachable: null,
      id: trimmed || null,
    };
  }

  /**
   * Confirms a contract instance ledger entry exists. Bounded by `timeoutMs`
   * so a slow/public RPC cannot hang bootstrap.
   */
  private async probeContract(contractId: string, timeoutMs: number): Promise<boolean> {
    try {
      const footprint = new Contract(contractId).getFootprint();
      const result = await Promise.race([
        this.server.getLedgerEntries(footprint),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      if (result === null) {
        this.logger.warn(`On-chain liveness probe timed out for contract ${contractId.slice(0, 8)}…`);
        return false;
      }
      return (result.entries?.length ?? 0) > 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`On-chain liveness probe failed: ${message}`);
      return false;
    }
  }
}
