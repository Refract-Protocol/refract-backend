/**
 * Runtime configuration for the oracle trust engine. Read straight from the
 * environment so the oracle module has no dependency on the shared config
 * factory; every value has a safe default.
 */
export interface OracleTrustConfig {
  httpTimeoutMs: number;
  coingeckoBaseUrl: string;
  horizonUrl: string;
  defiLlamaBaseUrl: string;
  defiLlamaProtocolSlug: string;
  /** Consecutive failures before a source is quarantined for a metric. */
  quarantineAfterFailures: number;
  /** How long a quarantined source is skipped before it is probed again. */
  quarantineMs: number;
}

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 0): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${key} must be an integer >= ${min} (got "${raw}")`);
  }
  return n;
}

function strEnv(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key]?.trim();
  return raw ? raw.replace(/\/+$/, "") : fallback;
}

export function loadOracleTrustConfig(env: NodeJS.ProcessEnv = process.env): OracleTrustConfig {
  return {
    httpTimeoutMs: intEnv(env, "ORACLE_HTTP_TIMEOUT_MS", 5_000, 1),
    coingeckoBaseUrl: strEnv(env, "COINGECKO_BASE_URL", "https://api.coingecko.com/api/v3"),
    horizonUrl: strEnv(env, "STELLAR_HORIZON_URL", strEnv(env, "HORIZON_URL", "https://horizon-testnet.stellar.org")),
    defiLlamaBaseUrl: strEnv(env, "DEFILLAMA_BASE_URL", "https://api.llama.fi"),
    defiLlamaProtocolSlug: strEnv(env, "DEFILLAMA_PROTOCOL_SLUG", "aave"),
    quarantineAfterFailures: intEnv(env, "ORACLE_QUARANTINE_AFTER_FAILURES", 3, 1),
    quarantineMs: intEnv(env, "ORACLE_QUARANTINE_MS", 5 * 60_000, 0),
  };
}

export const ORACLE_TRUST_CONFIG = Symbol("ORACLE_TRUST_CONFIG");
