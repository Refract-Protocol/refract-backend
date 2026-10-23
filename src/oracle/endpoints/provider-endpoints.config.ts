import { EndpointDeclaration, ProviderEndpointOptions } from "./provider-endpoints";

export const PROVIDER_ADAPTERS = ["coingecko", "defillama", "horizon"] as const;
export type ProviderAdapter = (typeof PROVIDER_ADAPTERS)[number];

const HORIZON_BY_NETWORK: Record<string, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  futurenet: "https://horizon-futurenet.stellar.org",
  mainnet: "https://horizon.stellar.org",
  public: "https://horizon.stellar.org",
};

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive number (received "${raw}")`);
  return n;
}

/**
 * Parses an endpoint list. Entries are comma-separated, in priority order,
 * either a bare URL or `label=url`:
 *
 *   ORACLE_ENDPOINTS_COINGECKO=primary=https://api.coingecko.com/api/v3,eu=https://eu.example/api/v3
 *
 * Unlabelled entries are named "primary", "fallback-1", "fallback-2", ….
 */
export function parseEndpointList(adapter: string, raw: string): EndpointDeclaration[] {
  const entries = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  return entries.map((entry, i) => {
    const eq = entry.indexOf("=");
    const hasLabel = eq > 0 && !entry.slice(0, eq).includes("://");
    const label = hasLabel ? entry.slice(0, eq).trim() : i === 0 ? "primary" : `fallback-${i}`;
    const url = (hasLabel ? entry.slice(eq + 1) : entry).trim().replace(/\/+$/, "");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`ORACLE_ENDPOINTS_${adapter.toUpperCase()}: "${label}" is not a valid URL`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`ORACLE_ENDPOINTS_${adapter.toUpperCase()}: "${label}" must be http(s)`);
    }
    if (seen.has(label)) {
      throw new Error(`ORACLE_ENDPOINTS_${adapter.toUpperCase()}: duplicate label "${label}"`);
    }
    seen.add(label);
    return { label, url };
  });
}

/**
 * Endpoint declarations per adapter. ORACLE_ENDPOINTS_<ADAPTER> sets the
 * full list. Without it, the adapter's existing single-URL setting
 * (COINGECKO_BASE_URL, DEFILLAMA_BASE_URL, STELLAR_HORIZON_URL) or the
 * built-in default is used as the only endpoint, as before.
 */
export function loadEndpointDeclarations(
  env: NodeJS.ProcessEnv = process.env,
): Record<ProviderAdapter, EndpointDeclaration[]> {
  const network = (env.STELLAR_NETWORK ?? "testnet").trim().toLowerCase();
  const single: Record<ProviderAdapter, string> = {
    coingecko: env.COINGECKO_BASE_URL?.trim() || "https://api.coingecko.com/api/v3",
    defillama: env.DEFILLAMA_BASE_URL?.trim() || "https://api.llama.fi",
    horizon: env.STELLAR_HORIZON_URL?.trim() || HORIZON_BY_NETWORK[network] || HORIZON_BY_NETWORK.testnet,
  };
  const out = {} as Record<ProviderAdapter, EndpointDeclaration[]>;
  for (const adapter of PROVIDER_ADAPTERS) {
    const list = env[`ORACLE_ENDPOINTS_${adapter.toUpperCase()}`]?.trim();
    out[adapter] = list ? parseEndpointList(adapter, list) : parseEndpointList(adapter, single[adapter]);
  }
  return out;
}

export function loadEndpointOptions(env: NodeJS.ProcessEnv = process.env): ProviderEndpointOptions {
  return {
    failureThreshold: num(env, "ORACLE_ENDPOINT_FAILURE_THRESHOLD", 3),
    cooldownMs: num(env, "ORACLE_ENDPOINT_COOLDOWN_MS", 30_000),
    maxCooldownMs: num(env, "ORACLE_ENDPOINT_MAX_COOLDOWN_MS", 300_000),
    slowMs: num(env, "ORACLE_ENDPOINT_SLOW_MS", 2_000),
    attemptTimeoutMs: num(env, "ORACLE_ENDPOINT_ATTEMPT_TIMEOUT_MS", num(env, "ORACLE_HTTP_TIMEOUT_MS", 5_000)),
  };
}
