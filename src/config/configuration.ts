export type FeeProfileName = "moderate" | "aggressive";

export interface AppConfig {
  env: string;
  port: number;
  frontendUrl: string;
  sandboxMode: boolean;
  database: { url: string };
  redis: { url: string };
  stellar: {
    network: string;
    sorobanRpcUrl: string;
    networkPassphrase: string;
    poolContractId: string;
    policyContractId: string;
    oracleContractId: string;
    relayerSecret: string;
    validateOnChain: boolean;
    requireNetwork: boolean;
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
  confirmation: {
    initialIntervalMs: number;
    backoffMultiplier: number;
    maxIntervalMs: number;
    deadlineMs: number;
    jitterRatio: number;
    settlementDeadlineMs: number;
    httpDeadlineMs: number;
  };
  oraclePublish: {
    mode: "every_poll" | "on_change";
    minIntervalMs: number;
  };
  oracles: {
    coingeckoBaseUrl: string;
    horizonUrl: string;
    defiLlamaBaseUrl: string;
    defiLlamaProtocolSlug: string;
    httpTimeoutMs: number;
  };
  policyPendingTtlMs: number;
  eventIndexer: {
    enabled: boolean;
    pollIntervalMs: number;
    lagAlertLedgers: number;
    pageLimit: number;
  };
  fees: {
    statsTtlMs: number;
    ceilingStroops: string;
    profiles: Record<FeeProfileName, { percentile: number; multiplier: number }>;
  };
  adminApiKey: string;
  communityApiKeys: Array<{
    key: string;
    scope: "community";
    contact: string;
    rateLimitPerMinute: number;
    createdAt: string;
  }>;
  ops: { apiToken: string; communityApiKeys: string[] };
  throttle: Record<string, { ttl: number; limit: number }>;
}

const passphrases: Record<string, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  public: "Public Global Stellar Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
};

export function isSandboxMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.SANDBOX_MODE ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

export function assertSandboxSafety(env: NodeJS.ProcessEnv = process.env): void {
  if (isSandboxMode(env) && (env.NODE_ENV ?? "").trim().toLowerCase() === "production") {
    throw new Error(
      "SANDBOX_MODE is enabled but NODE_ENV=production. Sandbox mode is a local contributor-onboarding tool.",
    );
  }
}

export function sandboxStartupBanner(): string[] {
  return [
    "============================================================",
    "  SANDBOX MODE ENABLED — NOT A REAL ENVIRONMENT",
    "  Postgres, Redis, and Soroban RPC are replaced with",
    "  in-memory mocks. All data resets on restart.",
    "  Do not use this mode outside local development.",
    "============================================================",
  ];
}

/**
 * Feeds whose readings are validated against the versioned reference data
 * registry. Each feed pins an explicit dataset version so a dataset refresh
 * can never retroactively change how a past reading was interpreted.
 */
export const REFERENCE_DATA_FEEDS = [
  'flightdelay',
  'liquidationshield',
  'price',
  'tvl',
] as const;

export type ReferenceDataFeed = (typeof REFERENCE_DATA_FEEDS)[number];

/**
 * Environment variable name holding the pinned dataset version for a feed,
 * e.g. REFERENCE_DATA_PIN_FLIGHTDELAY=2024-06-01.1.
 */
export function referenceDataPinEnvVar(feed: ReferenceDataFeed): string {
  return `REFERENCE_DATA_PIN_${feed.toUpperCase()}`;
}

/**
 * When true, a feed without an explicit pin may fall back to the latest
 * active dataset version. Off by default: the registry fails closed so an
 * unpinned feed cannot silently start validating against a newer dataset.
 */
export function allowLatestReferenceData(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.REFERENCE_DATA_ALLOW_LATEST ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

/**
 * Reads the pinned dataset version for a feed from the environment.
 * Returns null when no pin is configured (callers must decide whether the
 * latest-active fallback is permitted).
 */
export function pinnedReferenceDataVersion(
  feed: ReferenceDataFeed,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = (env[referenceDataPinEnvVar(feed)] ?? '').trim();
  return raw.length > 0 ? raw : null;
}

/**
 * Resolves the dataset version a feed must validate against.
 *
 * Fails closed: if the feed has no explicit pin and the latest-active
 * fallback has not been explicitly allowed, this throws so the process
 * cannot start (or ingest) with an ambiguous reference dataset.
 */
export function resolveReferenceDataVersion(
  feed: ReferenceDataFeed,
  latestActiveVersion: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const pinned = pinnedReferenceDataVersion(feed, env);
  if (pinned) {
    return pinned;
  }

  if (allowLatestReferenceData(env) && latestActiveVersion) {
    return latestActiveVersion;
  }

  throw new Error(
    `No reference data version pinned for feed "${feed}". Set ` +
      `${referenceDataPinEnvVar(feed)} to an explicit dataset version, or set ` +
      `REFERENCE_DATA_ALLOW_LATEST=true to explicitly allow falling back to the ` +
      `latest active dataset version.`,
  );
}

const integer = (value: string | undefined, fallback: number): number => {
  const parsed = value === undefined ? fallback : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

export default (): AppConfig => {
  const network = process.env.STELLAR_NETWORK ?? "testnet";
  const eventIndexer = {
    enabled: process.env.EVENT_INDEXER_ENABLED === "true",
    pollIntervalMs: integer(process.env.EVENT_INDEXER_POLL_INTERVAL_MS, 5_000),
    lagAlertLedgers: integer(process.env.EVENT_INDEXER_LAG_ALERT_LEDGERS, 100),
    pageLimit: integer(process.env.EVENT_INDEXER_PAGE_LIMIT, 100),
  };
  return {
    env: process.env.NODE_ENV ?? "development",
    port: integer(process.env.PORT, 3000),
    frontendUrl: process.env.FRONTEND_URL ?? "http://localhost:3000",
    sandboxMode: isSandboxMode(),
    database: { url: process.env.DATABASE_URL ?? "postgres://localhost:5432/refract" },
    redis: { url: process.env.REDIS_URL ?? "redis://localhost:6379" },
    stellar: {
      network,
      sorobanRpcUrl: process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
      networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? passphrases[network] ?? "",
      poolContractId: process.env.REFRACT_POOL_CONTRACT_ID ?? "",
      policyContractId: process.env.REFRACT_POLICY_CONTRACT_ID ?? "",
      oracleContractId: process.env.REFRACT_ORACLE_CONTRACT_ID ?? "",
      relayerSecret: process.env.ORACLE_RELAYER_SECRET ?? "",
      validateOnChain: process.env.STELLAR_VALIDATE_ON_CHAIN === "true",
      requireNetwork: process.env.REQUIRE_CHAIN_CONFIG === "true",
      validateTimeoutMs: integer(process.env.STELLAR_VALIDATE_TIMEOUT_MS, 5_000),
      relayer: {
        feeMultiplier: Number(process.env.RELAYER_FEE_MULTIPLIER ?? "1.2"),
        feeCeiling: integer(process.env.RELAYER_FEE_CEILING, 1_000_000),
        idleResyncMs: integer(process.env.RELAYER_IDLE_RESYNC_MS, 30_000),
        minBalance: integer(process.env.RELAYER_MIN_BALANCE, 50_000_000),
        maxAttempts: integer(process.env.RELAYER_MAX_ATTEMPTS, 3),
      },
      eventIndexer,
    },
    confirmation: {
      initialIntervalMs: integer(process.env.CONFIRMATION_INITIAL_INTERVAL_MS, 400),
      backoffMultiplier: Number(process.env.CONFIRMATION_BACKOFF_MULTIPLIER ?? "1.8"),
      maxIntervalMs: integer(process.env.CONFIRMATION_MAX_INTERVAL_MS, 8_000),
      deadlineMs: integer(process.env.CONFIRMATION_DEADLINE_MS, 30_000),
      jitterRatio: Number(process.env.CONFIRMATION_JITTER_RATIO ?? "0.2"),
      settlementDeadlineMs: integer(process.env.CONFIRMATION_SETTLEMENT_DEADLINE_MS, 90_000),
      httpDeadlineMs: integer(process.env.CONFIRMATION_HTTP_DEADLINE_MS, 20_000),
    },
    oraclePublish: {
      mode: process.env.ORACLE_PUBLISH_MODE === "every_poll" ? "every_poll" : "on_change",
      minIntervalMs: integer(process.env.ORACLE_PUBLISH_MIN_INTERVAL_MS, 300_000),
    },
    oracles: {
      coingeckoBaseUrl: process.env.COINGECKO_BASE_URL ?? "https://api.coingecko.com/api/v3",
      horizonUrl: process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org",
      defiLlamaBaseUrl: process.env.DEFILLAMA_BASE_URL ?? "https://api.llama.fi",
      defiLlamaProtocolSlug: process.env.DEFILLAMA_PROTOCOL_SLUG ?? "aave",
      httpTimeoutMs: integer(process.env.ORACLE_HTTP_TIMEOUT_MS, 5_000),
    },
    policyPendingTtlMs: integer(process.env.POLICY_PENDING_TTL_MS, 3_600_000),
    eventIndexer,
    fees: {
      statsTtlMs: integer(process.env.FEE_STATS_TTL_MS, 10_000),
      ceilingStroops: process.env.FEE_CEILING_STROOPS ?? "1000000",
      profiles: {
        moderate: {
          percentile: integer(process.env.FEE_MODERATE_PERCENTILE, 50),
          multiplier: Number(process.env.FEE_MODERATE_MULTIPLIER ?? "1.2"),
        },
        aggressive: {
          percentile: integer(process.env.FEE_AGGRESSIVE_PERCENTILE, 90),
          multiplier: Number(process.env.FEE_AGGRESSIVE_MULTIPLIER ?? "1.5"),
        },
      },
    },
    adminApiKey: process.env.ADMIN_API_KEY ?? "",
    communityApiKeys: [],
    ops: { apiToken: process.env.OPS_API_TOKEN ?? "", communityApiKeys: [] },
    throttle: {
      upstream: { ttl: 60_000, limit: 30 },
      chain: { ttl: 60_000, limit: 30 },
      default: { ttl: 60_000, limit: 60 },
      catalog: { ttl: 60_000, limit: 60 },
    },
  };
};

export const referenceDataConfig = registerAs('referenceData', () => ({
  allowLatest: allowLatestReferenceData(),
  pins: REFERENCE_DATA_FEEDS.reduce<Record<string, string | null>>((acc, feed) => {
    acc[feed] = pinnedReferenceDataVersion(feed);
    return acc;
  }, {}),
}));
