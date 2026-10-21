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
  /** Directory for the local write-ahead evidence spool. Mount a persistent volume here in production. */
  evidenceSpoolDir: string;
  /** Hard cap on spool size; beyond it evidence is recorded as a gap and settlement fails closed. */
  evidenceSpoolMaxBytes: number;
  /** Minimum agreeing live sources for an actionable consensus decision. */
  consensusMinSources: number;
  /** Source count at which a decision's coverage confidence reaches 1. */
  consensusTargetSources: number;
  /** Minimum confidence (0–1) for a decision to be actionable. */
  consensusMinConfidence: number;
  /** How long a consensus decision is reused within a claim scan. */
  consensusDecisionTtlMs: number;
}

function fractionEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`${key} must be a number between 0 and 1 (got "${raw}")`);
  }
  return n;
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
    evidenceSpoolDir: strEnv(env, "ORACLE_EVIDENCE_SPOOL_DIR", ".data/oracle-evidence"),
    evidenceSpoolMaxBytes: intEnv(env, "ORACLE_EVIDENCE_SPOOL_MAX_BYTES", 256 * 1024 * 1024, 1024),
    // Each production metric has one live source today, so the default
    // quorum is 1. Raise to 2 as soon as a second source is registered.
    consensusMinSources: intEnv(env, "ORACLE_CONSENSUS_MIN_SOURCES", 1, 1),
    consensusTargetSources: intEnv(env, "ORACLE_CONSENSUS_TARGET_SOURCES", 2, 1),
    consensusMinConfidence: fractionEnv(env, "ORACLE_CONSENSUS_MIN_CONFIDENCE", 0.5),
    consensusDecisionTtlMs: intEnv(env, "ORACLE_CONSENSUS_DECISION_TTL_MS", 30_000, 0),
  };
}

export const ORACLE_TRUST_CONFIG = Symbol("ORACLE_TRUST_CONFIG");
