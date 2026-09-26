/**
 * Typed application configuration, loaded once by Nest's ConfigModule.
 *
 * Kept as a single factory function (rather than scattered `process.env`
 * reads) so every consumer gets the same parsed/defaulted values and the
 * shape is documented in one place. See `.env.example` for the full list
 * of variables this reads.
 */
export type FeeProfileName = "moderate" | "aggressive";

export interface FeeProfileConfig {
  /** Percentile of getFeeStats inclusion-fee distribution (e.g. 90, 99). */
  percentile: number;
  /** Multiplier applied after percentile pick (testnet stats ≠ mainnet). */
  multiplier: number;
}

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
  };
  fees: {
    /** Hard ceiling on inclusion+resource fee (stroops). Safety control. */
    ceilingStroops: string;
    /** Short TTL so fee-stats aren't fetched on every build. */
    statsTtlMs: number;
    profiles: Record<FeeProfileName, FeeProfileConfig>;
  };
  settlement: {
    /** Max settlement attempts before dead-lettering. */
    maxAttempts: number;
    /** Max age (ms) from first attempt before dead-lettering. */
    maxAgeMs: number;
    /** Base backoff (ms); actual delay is base * 2^(attempt-1), floored by scan interval. */
    backoffBaseMs: number;
    /** Failure-rate threshold (0-1) over a scan that raises a critical alert. */
    failureRateAlertThreshold: number;
  };
  ops: {
    /** Shared secret for ops endpoints (Authorization: Bearer <token>). */
    apiToken: string;
  };
  oracles: {
    coingeckoBaseUrl: string;
    horizonUrl: string;
    defiLlamaBaseUrl: string;
    defiLlamaProtocolSlug: string;
    httpTimeoutMs: number;
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
  },
  fees: {
    // 10_000_000 stroops = 1 XLM — hard safety ceiling so a fee-market spike
    // cannot drain the relayer account.
    ceilingStroops: process.env.FEE_CEILING_STROOPS || "10000000",
    statsTtlMs: parseInt(process.env.FEE_STATS_TTL_MS || "15000", 10),
    profiles: {
      // User-signed: moderate — the user may resubmit if dropped.
      moderate: {
        percentile: parseInt(process.env.FEE_MODERATE_PERCENTILE || "90", 10),
        multiplier: parseFloat(process.env.FEE_MODERATE_MULTIPLIER || "1.2"),
      },
      // Relayer settlement: aggressive — payouts are time-sensitive and
      // retries are costly (scheduler + backoff).
      aggressive: {
        percentile: parseInt(process.env.FEE_AGGRESSIVE_PERCENTILE || "99", 10),
        multiplier: parseFloat(process.env.FEE_AGGRESSIVE_MULTIPLIER || "1.5"),
      },
    },
  },
  settlement: {
    maxAttempts: parseInt(process.env.SETTLEMENT_MAX_ATTEMPTS || "10", 10),
    maxAgeMs: parseInt(process.env.SETTLEMENT_MAX_AGE_MS || String(24 * 60 * 60 * 1000), 10),
    backoffBaseMs: parseInt(process.env.SETTLEMENT_BACKOFF_BASE_MS || "300000", 10),
    failureRateAlertThreshold: parseFloat(process.env.SETTLEMENT_FAILURE_RATE_ALERT || "0.5"),
  },
  ops: {
    apiToken: process.env.OPS_API_TOKEN || "",
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
});
