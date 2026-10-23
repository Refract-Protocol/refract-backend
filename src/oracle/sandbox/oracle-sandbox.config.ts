import { CorroborationPolicy, DEFAULT_CORROBORATION_POLICY } from "./corroboration";

/**
 * Oracle provider sandbox: a deployment mode where outside data providers
 * submit signed readings and watch corroboration work, without reaching
 * production feeds or publishing on-chain.
 *
 * Note: this is separate from SANDBOX_MODE (the contributor mode that swaps
 * Postgres/Redis/RPC for mocks). This flag only controls whether the
 * provider sandbox API is mounted.
 */
export interface OracleSandboxConfig {
  enabled: boolean;
  policy: CorroborationPolicy;
  /** Absolute tolerance per feed, for feeds whose value can sit near zero. */
  feedAbsoluteTolerance: Record<string, number>;
  /** Furthest a reading's observedAt may be ahead of server time. */
  maxFutureSkewMs: number;
  maxProviders: number;
  /** Per-provider submissions allowed in any rolling 60s. */
  maxSubmissionsPerMinute: number;
  /** Decisions and rejections older than this are purged. */
  retentionMs: number;
  maxStoredDecisions: number;
  maxStoredRejections: number;
}

/** Sandbox feeds. Names match production coverage types so payloads carry over unchanged. */
export const SANDBOX_FEEDS = [
  "StablecoinDepeg",
  "MarketCrash",
  "LiquidationShield",
  "SmartContractRisk",
  "FlightDelay",
] as const;

const truthy = (v: string | undefined): boolean =>
  ["true", "1", "yes", "on"].includes((v ?? "").trim().toLowerCase());

function num(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${key} must be a number >= ${min} (received "${raw}")`);
  }
  return parsed;
}

export function isOracleSandboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env.ORACLE_SANDBOX_MODE);
}

export function loadOracleSandboxConfig(env: NodeJS.ProcessEnv = process.env): OracleSandboxConfig {
  return {
    enabled: isOracleSandboxEnabled(env),
    policy: {
      minProviders: num(env, "ORACLE_SANDBOX_MIN_PROVIDERS", DEFAULT_CORROBORATION_POLICY.minProviders, 1),
      maxDeviationRatio: num(
        env,
        "ORACLE_SANDBOX_MAX_DEVIATION_RATIO",
        DEFAULT_CORROBORATION_POLICY.maxDeviationRatio,
        0,
      ),
      absoluteTolerance: 0,
      windowMs: num(env, "ORACLE_SANDBOX_WINDOW_MS", DEFAULT_CORROBORATION_POLICY.windowMs, 1_000),
    },
    feedAbsoluteTolerance: {
      StablecoinDepeg: 0.001,
      MarketCrash: 0.5,
      LiquidationShield: 0.01,
      SmartContractRisk: 0.5,
      FlightDelay: 5,
    },
    maxFutureSkewMs: num(env, "ORACLE_SANDBOX_MAX_FUTURE_SKEW_MS", 30_000, 0),
    maxProviders: num(env, "ORACLE_SANDBOX_MAX_PROVIDERS", 500, 1),
    maxSubmissionsPerMinute: num(env, "ORACLE_SANDBOX_MAX_SUBMISSIONS_PER_MINUTE", 60, 1),
    retentionMs: num(env, "ORACLE_SANDBOX_RETENTION_MS", 24 * 60 * 60_000, 60_000),
    maxStoredDecisions: 500,
    maxStoredRejections: 1_000,
  };
}

/**
 * Boot-time guard. A sandbox deployment must not be able to publish
 * on-chain or touch mainnet, so it refuses to start when a relayer signing
 * key is configured or the network is mainnet.
 */
export function assertOracleSandboxSafety(env: NodeJS.ProcessEnv = process.env): void {
  if (!isOracleSandboxEnabled(env)) return;
  const problems: string[] = [];
  if ((env.ORACLE_RELAYER_SECRET ?? "").trim() || (env.ORACLE_RELAYER_SECRET_ID ?? "").trim()) {
    problems.push(
      "a relayer signing key is configured (ORACLE_RELAYER_SECRET / ORACLE_RELAYER_SECRET_ID); a sandbox deployment must not be able to publish on-chain",
    );
  }
  const network = (env.STELLAR_NETWORK ?? "").trim().toLowerCase();
  if (network === "mainnet" || network === "public") {
    problems.push(`STELLAR_NETWORK=${network}; the provider sandbox only runs against test networks`);
  }
  if (problems.length > 0) {
    throw new Error(`ORACLE_SANDBOX_MODE refused to start: ${problems.join("; ")}`);
  }
}
