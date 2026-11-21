export type FeeProfileName = "moderate" | "aggressive";

/**
 * Typed application configuration, loaded once by Nest's ConfigModule.
 *
 * Kept as a single factory function (rather than scattered `process.env`
 * reads) so every consumer gets the same parsed/defaulted values and the
 * shape is documented in one place. See `.env.example` for the full list
 * of variables this reads.
 *
 * `AppConfig` is inferred from the Zod schema in `./env.schema` so the
 * TypeScript type and the runtime validation cannot drift.
 */
import { z } from "zod";
import { validateEnv } from "./env.schema";

/** Fee-estimation profiles exposed by FeeStrategyService. */
export type FeeProfileName = "moderate" | "aggressive";

export interface AppConfig {
  port: number;
  frontendUrl: string;
  database: {
    url: string;
    poolMax: number;
    poolMin: number;
    poolIdleTimeoutMs: number;
    poolAcquireTimeoutMs: number;
    statementTimeoutMs: number;
    connectRetries: number;
    connectRetryDelayMs: number;
  };
  redis: {
    url: string;
  };
  stellar: {
    network: string;
    sorobanRpcUrl: string;
    sorobanRpcUrls: string[];
    eventStartLedger: number;
    horizonUrl: string;
    networkPassphrase: string;
    poolContractId: string;
    policyContractId: string;
    oracleContractId: string;
    relayerSecret: string;
    relayerSecretId?: string;
    relayerSecretRegion?: string;
    validateOnChain?: boolean;
    requireNetwork?: boolean;
    validateTimeoutMs?: number;
    relayer?: {
      feeMultiplier: number;
      feeCeiling: number;
      idleResyncMs: number;
      minBalance: number;
      maxAttempts: number;
    };
    eventIndexer?: {
      enabled: boolean;
      pollIntervalMs: number;
      lagAlertLedgers: number;
      pageLimit: number;
    };
  };
  /**
   * Shared Soroban confirmation poller defaults (see
   * `pollForConfirmation`). Per-call overrides let the HTTP submit path
   * use a short deadline while settlement/oracle publish use a longer one.
   */
  confirmation: {
    initialIntervalMs: number;
    backoffMultiplier: number;
    maxIntervalMs: number;
    deadlineMs: number;
    jitterRatio: number;
    /** Longer deadline for relayer-signed settlement / oracle publishes. */
    settlementDeadlineMs: number;
    /** Shorter deadline so HTTP handlers don't block for a full minute. */
    httpDeadlineMs: number;
  };
  oraclePublish: {
    /**
     * `every_poll` — publish on every scheduler tick (subject to min interval).
     * `on_change` — publish only when the scaled fixed-point value changes
     * (default; bounds fee spend).
     */
    mode: "every_poll" | "on_change";
    /** Floor between publishes for the same coverage type (ms). */
    minIntervalMs: number;
  };
  oracles: {
    coingeckoBaseUrl: string;
    horizonUrl: string;
    defiLlamaBaseUrl: string;
    defiLlamaProtocolSlug: string;
    httpTimeoutMs: number;
    feedLatencyBudgetsMs?: Record<string, number>;
  };
  /** Soroban inclusion-fee estimation strategy. */
  fees: {
    /** Hard ceiling (stroops) above which FeeCeilingExceededError is thrown. */
    ceilingStroops: string;
    /** TTL for the cached getFeeStats response (ms). */
    statsTtlMs: number;
    /** Per-profile percentile + multiplier used to derive an inclusion fee. */
    profiles: Record<FeeProfileName, { percentile: number; multiplier: number }>;
  };
  /** Background Soroban event indexer settings. */
  eventIndexer: {
    enabled: boolean;
    pollIntervalMs: number;
    lagAlertLedgers: number;
    pageLimit: number;
    contractId: string;
  };
  /** Ops-facing auth (bearer token + read-only community keys). */
  ops: {
    apiToken: string;
    communityApiKeys: string[];
  };
  /** Admin-only API key (x-api-key header). */
  adminApiKey: string;
  /** Community-scoped API key records accepted on read-only endpoints. */
  communityApiKeys: Array<{
    key: string;
    scope: "community";
    contact: string;
    rateLimitPerMinute: number;
    createdAt: string;
  }>;
  /** Named throttling tiers consumed by ThrottlerModule. */
  throttle: {
    upstream: { ttl: number; limit: number };
    chain: { ttl: number; limit: number };
    default: { ttl: number; limit: number };
    catalog: { ttl: number; limit: number };
  };
  oracleTrustMode: "strict" | "quorum" | "development";
  /** Pending off-chain policies that never get submitted expire after this many ms. */
  policyPendingTtlMs: number;
  /** TTL (ms) for the cached rendered Prometheus payload served by /metrics. */
  metricsCacheTtlMs: number;
}

const NETWORK_CONFIG: Record<
  string,
  { sorobanRpcUrl: string; horizonUrl: string; networkPassphrase: string }
> = {
  testnet: {
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  },
  futurenet: {
    sorobanRpcUrl: "https://soroban-futurenet.stellar.org",
    horizonUrl: "https://horizon-futurenet.stellar.org",
    networkPassphrase: "Test SDF Future Network ; October 2022",
  },
  mainnet: {
    sorobanRpcUrl: "https://soroban-rpc.mainnet.stellar.org",
    horizonUrl: "https://horizon.stellar.org",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
  },
};

const appConfigSchema = z.object({
  port: z.number().int().min(1).max(65535),
  frontendUrl: z.string().url(),
  database: z.object({
    url: z.string().url(),
    poolMax: z.number().int(),
    poolMin: z.number().int(),
    poolIdleTimeoutMs: z.number().int(),
    poolAcquireTimeoutMs: z.number().int(),
    statementTimeoutMs: z.number().int(),
    connectRetries: z.number().int(),
    connectRetryDelayMs: z.number().int(),
  }),
  redis: z.object({ url: z.string().url() }),
  stellar: z.object({
    network: z.string(),
    sorobanRpcUrl: z.string().url(),
    sorobanRpcUrls: z.array(z.string().url()),
    eventStartLedger: z.number().int(),
    horizonUrl: z.string().url(),
    networkPassphrase: z.string(),
    poolContractId: z.string(),
    policyContractId: z.string(),
    oracleContractId: z.string(),
    relayerSecret: z.string(),
    relayerSecretId: z.string(),
    relayerSecretRegion: z.string(),
    validateOnChain: z.boolean(),
    requireNetwork: z.boolean(),
    validateTimeoutMs: z.number().int(),
    relayer: z.object({
      feeMultiplier: z.number(),
      feeCeiling: z.number().int(),
      idleResyncMs: z.number().int(),
      minBalance: z.number().int(),
      maxAttempts: z.number().int(),
    }),
    eventIndexer: z.object({
      enabled: z.boolean(),
      pollIntervalMs: z.number().int(),
      lagAlertLedgers: z.number().int(),
      pageLimit: z.number().int(),
    }),
  }),
  oracles: z.object({
    coingeckoBaseUrl: z.string().url(),
    horizonUrl: z.string().url(),
    defiLlamaBaseUrl: z.string().url(),
    defiLlamaProtocolSlug: z.string(),
    httpTimeoutMs: z.number().int().min(100).max(120_000),
  }),
  confirmation: z.object({
    initialIntervalMs: z.number().int(),
    backoffMultiplier: z.number(),
    maxIntervalMs: z.number().int(),
    deadlineMs: z.number().int(),
    jitterRatio: z.number(),
    settlementDeadlineMs: z.number().int(),
    httpDeadlineMs: z.number().int(),
  }),
  oraclePublish: z.object({
    mode: z.enum(["every_poll", "on_change"]),
    minIntervalMs: z.number().int(),
  }),
  fees: z.object({
    ceilingStroops: z.string(),
    statsTtlMs: z.number().int(),
    profiles: z.record(
      z.enum(["moderate", "aggressive"]),
      z.object({ percentile: z.number().int(), multiplier: z.number() }),
    ),
  }),
  eventIndexer: z.object({
    enabled: z.boolean(),
    pollIntervalMs: z.number().int(),
    lagAlertLedgers: z.number().int(),
    pageLimit: z.number().int(),
  }),
  ops: z.object({
    apiToken: z.string(),
    communityApiKeys: z.array(z.string()),
  }),
  adminApiKey: z.string(),
  communityApiKeys: z.array(
    z.object({
      key: z.string(),
      scope: z.literal("community"),
      contact: z.string(),
      rateLimitPerMinute: z.number().int(),
      createdAt: z.string(),
    }),
  ),
  throttle: z.object({
    /**
     * Named throttling tiers, each expressed as `{ limit, ttl }` where
     * `limit` is the max number of requests allowed per `ttl` window
     * (milliseconds). Consumed by `ThrottlerModule.forRootAsync` and
     * referenced by name from `@Throttle({ ... })` route overrides.
     */
    tiers: z.object({
      /** Upstream-proxying reads (e.g. GET /oracle/status). */
      strict: z.object({ limit: z.number().int(), ttl: z.number().int() }),
      /** Chain-writing posts (e.g. /tx/submit, /policies/buy). */
      chainWrite: z.object({ limit: z.number().int(), ttl: z.number().int() }),
      /** Ordinary database-backed reads. */
      moderate: z.object({ limit: z.number().int(), ttl: z.number().int() }),
      /** Static catalog routes (e.g. /quotes/coverage-types). */
      generous: z.object({ limit: z.number().int(), ttl: z.number().int() }),
    }),
    /**
     * Whether to trust `X-Forwarded-For` from a fronting proxy. Must be
     * set deliberately (never implicitly) so IP-based limiting does not
     * collapse every caller onto the load balancer's address.
     */
    trustProxy: z.boolean(),
    upstream: z.object({ ttl: z.number().int(), limit: z.number().int() }),
    chain: z.object({ ttl: z.number().int(), limit: z.number().int() }),
    default: z.object({ ttl: z.number().int(), limit: z.number().int() }),
    catalog: z.object({ ttl: z.number().int(), limit: z.number().int() }),
  }),
  policyPendingTtlMs: z.number().int(),
  metricsCacheTtlMs: z.number().int().min(0),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export default (): AppConfig => {
  const env = validateEnv(process.env);

  const requireChainConfig = env.REQUIRE_CHAIN_CONFIG === true;
  const chainKeys = [
    "REFRACT_POOL_CONTRACT_ID",
    "REFRACT_POLICY_CONTRACT_ID",
    "REFRACT_ORACLE_CONTRACT_ID",
    "ORACLE_RELAYER_SECRET",
  ] as const;

  if (requireChainConfig) {
    const missing = chainKeys.filter((key) => !env[key]);
    if (missing.length > 0) {
      throw new Error(
        `Invalid environment configuration:\n${missing
          .map((key) => `  - ${key}: required when REQUIRE_CHAIN_CONFIG is set`)
          .join("\n")}`,
      );
    }
  }

  const network = (env.STELLAR_NETWORK ?? "testnet").toLowerCase();
  const selected = NETWORK_CONFIG[network];
  if (!selected) {
    throw new Error("expected testnet, futurenet, or mainnet");
  }
  const selectedNetwork = NETWORK_CONFIG[network];
  const suffix = network.toUpperCase();
  const networkSpecificPoolId = env[`REFRACT_POOL_CONTRACT_ID_${suffix}`];
  const networkSpecificPolicyId = env[`REFRACT_POLICY_CONTRACT_ID_${suffix}`];
  const networkSpecificOracleId = env[`REFRACT_ORACLE_CONTRACT_ID_${suffix}`];

  return {
    port: env.PORT ?? 4001,
    frontendUrl: env.FRONTEND_URL ?? "http://localhost:3000",
    database: {
      url:
        env.DATABASE_URL ??
        "postgres://refract:refract@localhost:5432/refract",
      poolMax: env.DB_POOL_MAX ?? 10,
      poolMin: env.DB_POOL_MIN ?? 2,
      poolIdleTimeoutMs: env.DB_POOL_IDLE_TIMEOUT_MS ?? 30000,
      poolAcquireTimeoutMs: env.DB_POOL_ACQUIRE_TIMEOUT_MS ?? 5000,
      statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS ?? 30000,
      connectRetries: env.DB_CONNECT_RETRIES ?? 5,
      connectRetryDelayMs: env.DB_CONNECT_RETRY_DELAY_MS ?? 1000,
    },
    redis: { url: env.REDIS_URL ?? "redis://localhost:6379" },
    stellar: {
      network,
      sorobanRpcUrl: env.SOROBAN_RPC_URL || selectedNetwork.sorobanRpcUrl,
      sorobanRpcUrls: (env.SOROBAN_RPC_URLS ?? env.SOROBAN_RPC_URL ?? selectedNetwork.sorobanRpcUrl)
        .split(",")
        .map((url) => url.trim())
        .filter(Boolean),
      eventStartLedger: numberFromEnv("EVENT_START_LEDGER", 1),
      horizonUrl: env.STELLAR_HORIZON_URL || selectedNetwork.horizonUrl,
      networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE || selectedNetwork.networkPassphrase,
      poolContractId: networkSpecificPoolId ?? env.REFRACT_POOL_CONTRACT_ID ?? "",
      policyContractId: networkSpecificPolicyId ?? env.REFRACT_POLICY_CONTRACT_ID ?? "",
      oracleContractId: networkSpecificOracleId ?? env.REFRACT_ORACLE_CONTRACT_ID ?? "",
      relayerSecret: env.ORACLE_RELAYER_SECRET ?? "",
      relayerSecretId: env.ORACLE_RELAYER_SECRET_ID ?? "",
      relayerSecretRegion: env.ORACLE_RELAYER_SECRET_REGION ?? "us-east-1",
      validateOnChain: env.VALIDATE_ON_CHAIN === true,
      requireNetwork: env.REQUIRE_NETWORK === true,
      validateTimeoutMs: env.VALIDATE_TIMEOUT_MS ?? 5000,
      relayer: {
        feeMultiplier: env.RELAYER_FEE_MULTIPLIER ?? 1.2,
        feeCeiling: env.RELAYER_FEE_CEILING ?? 1000000,
        idleResyncMs: env.RELAYER_IDLE_RESYNC_MS ?? 30000,
        minBalance: env.RELAYER_MIN_BALANCE ?? 50000000,
        maxAttempts: env.RELAYER_MAX_ATTEMPTS ?? 3,
      },
      eventIndexer: {
        enabled: env.EVENT_INDEXER_ENABLED === true,
        pollIntervalMs: env.EVENT_INDEXER_POLL_INTERVAL_MS ?? 5000,
        lagAlertLedgers: env.EVENT_INDEXER_LAG_ALERT_LEDGERS ?? 100,
        pageLimit: env.EVENT_INDEXER_PAGE_LIMIT ?? 100,
      },
    },
    confirmation: {
      initialIntervalMs: env.CONFIRMATION_INITIAL_INTERVAL_MS ?? 10,
      backoffMultiplier: env.CONFIRMATION_BACKOFF_MULTIPLIER ?? 1.5,
      maxIntervalMs: env.CONFIRMATION_MAX_INTERVAL_MS ?? 50,
      deadlineMs: env.CONFIRMATION_DEADLINE_MS ?? 200,
      jitterRatio: env.CONFIRMATION_JITTER_RATIO ?? 0,
      settlementDeadlineMs: env.CONFIRMATION_SETTLEMENT_DEADLINE_MS ?? 200,
      httpDeadlineMs: env.CONFIRMATION_HTTP_DEADLINE_MS ?? 100,
    },
    oraclePublish: {
      mode: env.ORACLE_PUBLISH_MODE ?? "every_poll",
      minIntervalMs: env.ORACLE_PUBLISH_MIN_INTERVAL_MS ?? 0,
    },
    oracles: {
      coingeckoBaseUrl: env.COINGECKO_BASE_URL || "https://api.coingecko.com/api/v3",
      horizonUrl: env.STELLAR_HORIZON_URL || selectedNetwork.horizonUrl,
      defiLlamaBaseUrl: env.DEFILLAMA_BASE_URL || "https://api.llama.fi",
      // Placeholder "covered protocol" for the SmartContractRisk TVL-drop
      // check until Refract defines a real list of covered Soroban
      // protocols. Defaults to a large, consistently-tracked protocol so
      // the drop-detection logic has real data to run against.
      defiLlamaProtocolSlug: env.DEFILLAMA_PROTOCOL_SLUG || "aave",
      httpTimeoutMs: numberFromEnv("ORACLE_HTTP_TIMEOUT_MS", 5_000),
      feedLatencyBudgetsMs: parseFeedBudgets(env.ORACLE_FEED_LATENCY_BUDGETS_MS),
    },
    fees: {
      statsTtlMs: numberFromEnv("FEE_STATS_TTL_MS", 15_000),
      ceilingStroops: env.FEE_CEILING_STROOPS || String(numberFromEnv("FEE_CEILING_STROOPS", 10_000_000)),
      profiles: {
        moderate: {
          percentile: numberFromEnv("FEE_MODERATE_PERCENTILE", 90),
          multiplier: numberFromEnv("FEE_MODERATE_MULTIPLIER", 1.2),
        },
        aggressive: {
          percentile: numberFromEnv("FEE_AGGRESSIVE_PERCENTILE", 99),
          multiplier: numberFromEnv("FEE_AGGRESSIVE_MULTIPLIER", 1.5),
        },
      },
    },
    eventIndexer: {
      enabled: readBool(env.EVENT_INDEXER_ENABLED, false),
      pollIntervalMs: numberFromEnv("EVENT_INDEXER_POLL_INTERVAL_MS", 5_000),
      lagAlertLedgers: numberFromEnv("EVENT_INDEXER_LAG_ALERT_LEDGERS", 100),
      pageLimit: numberFromEnv("EVENT_INDEXER_PAGE_LIMIT", 100),
      contractId: env.REFRACT_POOL_CONTRACT_ID || "",
    },
    ops: {
      apiToken: env.OPS_API_TOKEN || "",
      communityApiKeys: parseCsv(env.COMMUNITY_API_KEYS),
    },
    adminApiKey: env.ADMIN_API_KEY ?? "",
    communityApiKeys: [],
    throttle: {
      tiers: {
        strict: {
          limit: env.THROTTLE_STRICT_LIMIT ?? 10,
          ttl: env.THROTTLE_STRICT_TTL_MS ?? 60_000,
        },
        chainWrite: {
          limit: env.THROTTLE_CHAIN_WRITE_LIMIT ?? 5,
          ttl: env.THROTTLE_CHAIN_WRITE_TTL_MS ?? 60_000,
        },
        moderate: {
          limit: env.THROTTLE_MODERATE_LIMIT ?? 60,
          ttl: env.THROTTLE_MODERATE_TTL_MS ?? 60_000,
        },
        generous: {
          limit: env.THROTTLE_GENEROUS_LIMIT ?? 120,
          ttl: env.THROTTLE_GENEROUS_TTL_MS ?? 60_000,
        },
      },
      trustProxy: env.TRUST_PROXY === true,
      upstream: {
        ttl: parseInt(process.env.THROTTLE_UPSTREAM_TTL_MS || "60000", 10),
        limit: parseInt(process.env.THROTTLE_UPSTREAM_LIMIT || "60", 10),
      },
      chain: {
        ttl: parseInt(process.env.THROTTLE_CHAIN_TTL_MS || "60000", 10),
        limit: parseInt(process.env.THROTTLE_CHAIN_LIMIT || "20", 10),
      },
      default: {
        ttl: parseInt(process.env.THROTTLE_DEFAULT_TTL_MS || "60000", 10),
        limit: parseInt(process.env.THROTTLE_DEFAULT_LIMIT || "600", 10),
      },
      catalog: {
        ttl: parseInt(process.env.THROTTLE_CATALOG_TTL_MS || "60000", 10),
        limit: parseInt(process.env.THROTTLE_CATALOG_LIMIT || "300", 10),
      },
    },
    oracleTrustMode: parseTrustMode(env.ORACLE_TRUST_MODE),
    policyPendingTtlMs: numberFromEnv("POLICY_PENDING_TTL_MS", 3_600_000),
    metricsCacheTtlMs: numberFromEnv("METRICS_CACHE_TTL_MS", 5_000),
  };
};

export function isSandboxMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.SANDBOX_MODE ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

export function assertSandboxSafety(env: NodeJS.ProcessEnv = process.env): void {
  if (isSandboxMode(env) && (env.NODE_ENV ?? "").trim().toLowerCase() === "production") {
    throw new Error("SANDBOX_MODE is not allowed when NODE_ENV=production");
  }
}

function parseCsv(value?: string): string[] {
  return (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseFeedBudgets(value?: string): Record<string, number> | undefined {
  if (!value) return undefined;
  let result: unknown;
  try {
    result = JSON.parse(value);
  } catch {
    throw new Error("ORACLE_FEED_LATENCY_BUDGETS_MS must be valid JSON");
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("ORACLE_FEED_LATENCY_BUDGETS_MS must be a JSON object");
  }
  for (const [feed, budget] of Object.entries(result)) {
    if (!Number.isInteger(budget) || Number(budget) <= 0) {
      throw new Error(`Latency budget for ${feed} must be a positive integer`);
    }
  }
  return result as Record<string, number>;
}

function parseTrustMode(value?: string): AppConfig["oracleTrustMode"] {
  if (value === undefined || value === "") return "strict";
  if (value === "strict" || value === "quorum" || value === "development") return value;
  throw new Error("ORACLE_TRUST_MODE must be strict, quorum, or development");
}
