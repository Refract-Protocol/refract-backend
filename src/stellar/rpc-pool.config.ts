import { RPC_POOL_DEFAULTS, RpcEndpointPoolOptions } from "./rpc-endpoint-pool";

/** Public Soroban RPC endpoints, used only when nothing is configured. */
const NETWORK_DEFAULT_RPC: Record<string, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  futurenet: "https://rpc-futurenet.stellar.org",
};

export interface RpcPoolConfig {
  urls: string[];
  options: Pick<
    RpcEndpointPoolOptions,
    "maxLedgerLag" | "failureThreshold" | "cooldownMs" | "healthCheckIntervalMs" | "healthCheckTimeoutMs"
  >;
}

function splitUrls(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
}

function intOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : fallback;
}

/**
 * Builds the RPC pool settings from the environment.
 *
 * `SOROBAN_RPC_URL` stays the primary endpoint for backwards compatibility.
 * `SOROBAN_RPC_URLS` adds more, in preference order. Duplicates are dropped.
 * Mainnet has no public default, so an empty mainnet config yields no URLs
 * and the pool constructor fails fast.
 *
 * Values are range-checked by `envSchema`; this only converts them.
 */
export function resolveRpcPoolConfig(env: NodeJS.ProcessEnv = process.env): RpcPoolConfig {
  const configured = [...splitUrls(env.SOROBAN_RPC_URL), ...splitUrls(env.SOROBAN_RPC_URLS)];
  const network = (env.STELLAR_NETWORK ?? "testnet").trim().toLowerCase();
  const urls = configured.length > 0 ? configured : [NETWORK_DEFAULT_RPC[network]].filter(Boolean);

  return {
    urls: [...new Set(urls)],
    options: {
      maxLedgerLag: intOr(env.SOROBAN_RPC_MAX_LEDGER_LAG, RPC_POOL_DEFAULTS.maxLedgerLag),
      failureThreshold: intOr(env.SOROBAN_RPC_FAILURE_THRESHOLD, RPC_POOL_DEFAULTS.failureThreshold),
      cooldownMs: intOr(env.SOROBAN_RPC_COOLDOWN_MS, RPC_POOL_DEFAULTS.cooldownMs),
      healthCheckIntervalMs: intOr(
        env.SOROBAN_RPC_HEALTH_INTERVAL_MS,
        RPC_POOL_DEFAULTS.healthCheckIntervalMs
      ),
      healthCheckTimeoutMs: intOr(
        env.SOROBAN_RPC_HEALTH_TIMEOUT_MS,
        RPC_POOL_DEFAULTS.healthCheckTimeoutMs
      ),
    },
  };
}
