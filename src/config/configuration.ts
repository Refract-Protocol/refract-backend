/**
 * Typed application configuration, loaded once by Nest's ConfigModule.
 *
 * Kept as a single factory function (rather than scattered `process.env`
 * reads) so every consumer gets the same parsed/defaulted values and the
 * shape is documented in one place. See `.env.example` for the full list
 * of variables this reads.
 */

function parseIntStrict(raw: string | undefined, fallback: string, label: string): number {
  const value = parseInt(raw ?? fallback, 10);
  if (Number.isNaN(value)) {
    throw new Error(`Invalid ${label}: expected an integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function parseFloatStrict(raw: string | undefined, fallback: string, label: string): number {
  const value = parseFloat(raw ?? fallback);
  if (Number.isNaN(value)) {
    throw new Error(`Invalid ${label}: expected a number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function parseBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw === "") return defaultValue;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
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
    /** When true, bootstrap probes each configured contract on-chain. Default on outside tests. */
    validateOnChain: boolean;
    /** When true, malformed/incomplete Stellar config aborts startup. */
    requireNetwork: boolean;
    /** Bound (ms) for on-chain liveness probes at bootstrap. */
    validateTimeoutMs: number;
    relayer: {
      feeMultiplier: number;
      feeCeiling: number;
      idleResyncMs: number;
      minBalance: number;
      maxAttempts: number;
    };
    eventIndexer: {
      enabled: boolean;
      pollIntervalMs: number;
      lagAlertLedgers: number;
      pageLimit: number;
    };
  };
  /** Top-level alias used by EventIndexerService (mirrors stellar.eventIndexer). */
  eventIndexer: {
    enabled: boolean;
    pollIntervalMs: number;
    lagAlertLedgers: number;
    pageLimit: number;
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
  port: parseIntStrict(process.env.PORT, "4001", "PORT"),
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
    validateOnChain: parseBool(process.env.STELLAR_VALIDATE_ONCHAIN, process.env.NODE_ENV !== "test"),
    requireNetwork: parseBool(process.env.STELLAR_REQUIRE_NETWORK, false),
    validateTimeoutMs: parseIntStrict(process.env.STELLAR_VALIDATE_TIMEOUT_MS, "5000", "STELLAR_VALIDATE_TIMEOUT_MS"),
    relayer: {
      feeMultiplier: parseFloatStrict(process.env.RELAYER_FEE_MULTIPLIER, "1.2", "RELAYER_FEE_MULTIPLIER"),
      feeCeiling: parseIntStrict(process.env.RELAYER_FEE_CEILING, "1000000", "RELAYER_FEE_CEILING"),
      idleResyncMs: parseIntStrict(process.env.RELAYER_IDLE_RESYNC_MS, "30000", "RELAYER_IDLE_RESYNC_MS"),
      minBalance: parseIntStrict(process.env.RELAYER_MIN_BALANCE, "50000000", "RELAYER_MIN_BALANCE"),
      maxAttempts: parseIntStrict(process.env.RELAYER_MAX_ATTEMPTS, "3", "RELAYER_MAX_ATTEMPTS"),
    },
    eventIndexer: {
      enabled: parseBool(process.env.EVENT_INDEXER_ENABLED, process.env.NODE_ENV !== "test"),
      pollIntervalMs: parseIntStrict(process.env.EVENT_INDEXER_POLL_INTERVAL_MS, "5000", "EVENT_INDEXER_POLL_INTERVAL_MS"),
      lagAlertLedgers: parseIntStrict(process.env.EVENT_INDEXER_LAG_ALERT_LEDGERS, "100", "EVENT_INDEXER_LAG_ALERT_LEDGERS"),
      pageLimit: parseIntStrict(process.env.EVENT_INDEXER_PAGE_LIMIT, "100", "EVENT_INDEXER_PAGE_LIMIT"),
    },
  },
  eventIndexer: {
    enabled: parseBool(process.env.EVENT_INDEXER_ENABLED, process.env.NODE_ENV !== "test"),
    pollIntervalMs: parseIntStrict(process.env.EVENT_INDEXER_POLL_INTERVAL_MS, "5000", "EVENT_INDEXER_POLL_INTERVAL_MS"),
    lagAlertLedgers: parseIntStrict(process.env.EVENT_INDEXER_LAG_ALERT_LEDGERS, "100", "EVENT_INDEXER_LAG_ALERT_LEDGERS"),
    pageLimit: parseIntStrict(process.env.EVENT_INDEXER_PAGE_LIMIT, "100", "EVENT_INDEXER_PAGE_LIMIT"),
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
    httpTimeoutMs: parseIntStrict(process.env.ORACLE_HTTP_TIMEOUT_MS, "5000", "ORACLE_HTTP_TIMEOUT_MS"),
  },
});
