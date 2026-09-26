/**
 * Typed application configuration, loaded once by Nest's ConfigModule.
 *
 * Kept as a single factory function (rather than scattered `process.env`
 * reads) so every consumer gets the same parsed/defaulted values and the
 * shape is documented in one place. See `.env.example` for the full list
 * of variables this reads.
 */
export interface AppConfig {
  port: number;
  frontendUrl: string;
  database: {
    url: string;
  };
  redis: {
    url: string;
  };
  stellar: {
    network: string;
    sorobanRpcUrl: string;
    networkPassphrase: string;
    poolContractId: string;
    policyContractId: string;
    oracleContractId: string;
    relayerSecret: string;
    /** Per-RPC-call timeout (ms). */
    rpcTimeoutMs: number;
    /** Max retries for transient RPC failures (sendTransaction always 0). */
    rpcMaxRetries: number;
    /** Max stroops the relayer will pay for a single RestoreFootprint. */
    restoreFeeCeiling: string;
    /** Cap automatic restores per policy across scheduler scans. */
    restoreMaxAttemptsPerPolicy: number;
    /** Ledgers to extend when proactively bumping TTL. */
    ttlExtensionLedgers: number;
    /**
     * When a policy's remaining life is within this many days, the relayer
     * may submit ExtendFootprintTTL so archival can't race settlement.
     * Testnet vs mainnet TTL windows differ — keep this config-driven.
     */
    proactiveTtlExtendWithinDays: number;
  };
  oracles: {
    coingeckoBaseUrl: string;
    horizonUrl: string;
    defiLlamaBaseUrl: string;
    defiLlamaProtocolSlug: string;
    httpTimeoutMs: number;
  };
  claims: {
    /** Max parallel oracle/evaluate workers in a claim scan. */
    scanConcurrency: number;
    /**
     * Allowed |actual - expected| payout delta before logging a discrepancy.
     * Default "0" = exact equality.
     */
    payoutMismatchTolerance: string;
  };
}

export default (): AppConfig => ({
  port: parseInt(process.env.PORT || "4001", 10),
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",
  database: {
    url: process.env.DATABASE_URL || "postgres://refract:refract@localhost:5432/refract",
  },
  redis: {
    url: process.env.REDIS_URL || "redis://localhost:6379",
  },
  stellar: {
    network: process.env.STELLAR_NETWORK || "testnet",
    sorobanRpcUrl: process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org",
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015",
    poolContractId: process.env.REFRACT_POOL_CONTRACT_ID || "",
    policyContractId: process.env.REFRACT_POLICY_CONTRACT_ID || "",
    oracleContractId: process.env.REFRACT_ORACLE_CONTRACT_ID || "",
    relayerSecret: process.env.ORACLE_RELAYER_SECRET || "",
    rpcTimeoutMs: parseInt(process.env.SOROBAN_RPC_TIMEOUT_MS || "10000", 10),
    rpcMaxRetries: parseInt(process.env.SOROBAN_RPC_MAX_RETRIES || "3", 10),
    // ~0.5 XLM in stroops — restore fees above this are rejected and alerted.
    restoreFeeCeiling: process.env.SOROBAN_RESTORE_FEE_CEILING || "5000000",
    restoreMaxAttemptsPerPolicy: parseInt(process.env.SOROBAN_RESTORE_MAX_ATTEMPTS || "3", 10),
    ttlExtensionLedgers: parseInt(process.env.SOROBAN_TTL_EXTENSION_LEDGERS || "17280", 10),
    proactiveTtlExtendWithinDays: parseInt(process.env.SOROBAN_PROACTIVE_TTL_EXTEND_DAYS || "30", 10),
  },
  oracles: {
    coingeckoBaseUrl: process.env.COINGECKO_BASE_URL || "https://api.coingecko.com/api/v3",
    horizonUrl: process.env.STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org",
    defiLlamaBaseUrl: process.env.DEFILLAMA_BASE_URL || "https://api.llama.fi",
    // Placeholder "covered protocol" for the SmartContractRisk TVL-drop
    // check until Refract defines a real list of covered Soroban
    // protocols. Defaults to a large, consistently-tracked protocol so
    // the drop-detection logic has real data to run against.
    defiLlamaProtocolSlug: process.env.DEFILLAMA_PROTOCOL_SLUG || "aave",
    httpTimeoutMs: parseInt(process.env.ORACLE_HTTP_TIMEOUT_MS || "5000", 10),
  },
  claims: {
    scanConcurrency: parseInt(process.env.CLAIM_SCAN_CONCURRENCY || "8", 10),
    payoutMismatchTolerance: process.env.CLAIM_PAYOUT_MISMATCH_TOLERANCE || "0",
  },
});
