/**
 * Makes sure the environment targets exactly one Stellar network, and that
 * every network-specific value belongs to it: RPC URL(s), Horizon URL,
 * passphrase, and the pool/oracle/policy contract IDs.
 *
 * A mixed configuration (a testnet RPC with a mainnet passphrase, or a
 * futurenet contract ID left in a testnet deployment) used to fail only at
 * the first publish. Worse, it could succeed against the wrong deployment.
 * This runs before Nest boots and fails with every problem listed at once.
 *
 * Static checks can't prove that a custom RPC/Horizon host or a contract ID
 * is on the right network. `verifyNetworkLive` covers that by asking the
 * RPC (`getNetwork`) and Horizon (`GET /`) which passphrase they serve.
 */

export type StellarNetworkName = "testnet" | "futurenet" | "mainnet";

export interface NetworkProfile {
  passphrase: string;
  rpcHosts: string[];
  horizonHosts: string[];
  /** Words in a hostname or path that point to this network. */
  tokens: string[];
}

export const STELLAR_NETWORKS: Record<StellarNetworkName, NetworkProfile> = {
  testnet: {
    passphrase: "Test SDF Network ; September 2015",
    rpcHosts: ["soroban-testnet.stellar.org"],
    horizonHosts: ["horizon-testnet.stellar.org"],
    tokens: ["testnet"],
  },
  futurenet: {
    passphrase: "Test SDF Future Network ; October 2022",
    rpcHosts: ["rpc-futurenet.stellar.org"],
    horizonHosts: ["horizon-futurenet.stellar.org"],
    tokens: ["futurenet"],
  },
  mainnet: {
    passphrase: "Public Global Stellar Network ; September 2015",
    rpcHosts: [],
    horizonHosts: ["horizon.stellar.org"],
    tokens: ["mainnet", "pubnet"],
  },
};

const NETWORK_ALIASES: Record<string, StellarNetworkName> = {
  testnet: "testnet",
  futurenet: "futurenet",
  mainnet: "mainnet",
  public: "mainnet",
  pubnet: "mainnet",
};

/** Suffix → network. Both _MAINNET and _PUBLIC are accepted for mainnet. */
const SUFFIXES: Record<string, StellarNetworkName> = {
  TESTNET: "testnet",
  FUTURENET: "futurenet",
  MAINNET: "mainnet",
  PUBLIC: "mainnet",
};

type SettingKey = "rpcUrl" | "horizonUrl" | "passphrase" | "poolContractId" | "oracleContractId" | "policyContractId";

/** Base variable names. Each may also appear with a network suffix (e.g. _TESTNET). */
const SETTINGS: Record<SettingKey, { base: string; legacy?: string }> = {
  rpcUrl: { base: "SOROBAN_RPC_URL" },
  horizonUrl: { base: "STELLAR_HORIZON_URL" },
  passphrase: { base: "STELLAR_NETWORK_PASSPHRASE" },
  poolContractId: { base: "REFRACT_POOL_CONTRACT_ID", legacy: "POOL_CONTRACT_ID" },
  oracleContractId: { base: "REFRACT_ORACLE_CONTRACT_ID", legacy: "ORACLE_CONTRACT_ID" },
  policyContractId: { base: "REFRACT_POLICY_CONTRACT_ID", legacy: "POLICY_CONTRACT_ID" },
};

export interface ResolvedNetworkConfig {
  network: StellarNetworkName;
  passphrase: string;
  rpcUrls: string[];
  horizonUrl?: string;
  poolContractId?: string;
  oracleContractId?: string;
  policyContractId?: string;
}

export interface NetworkConsistencyReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  resolved?: ResolvedNetworkConfig;
}

const CONTRACT_RE = /^C[A-Z2-7]{55}$/;
/** Every coverage type settles through an on-chain oracle reading. */
const PAYOUT_COVERAGE_TYPES = ["StablecoinDepeg", "MarketCrash", "LiquidationShield", "SmartContractRisk", "FlightDelay"];
const val = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const v = env[key]?.trim();
  return v ? v : undefined;
};

export function normalizeNetwork(raw: string | undefined): StellarNetworkName | undefined {
  return raw ? NETWORK_ALIASES[raw.trim().toLowerCase()] : undefined;
}

/** Which network a URL points to, if it can be told from the host or path. */
export function classifyUrl(raw: string): { network?: StellarNetworkName; known: boolean } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { known: false };
  }
  const host = url.hostname.toLowerCase();
  for (const [name, profile] of Object.entries(STELLAR_NETWORKS) as Array<[StellarNetworkName, NetworkProfile]>) {
    if (profile.rpcHosts.includes(host) || profile.horizonHosts.includes(host)) {
      return { network: name, known: true };
    }
  }
  const haystack = `${host}${url.pathname}`.toLowerCase();
  const matches = (Object.entries(STELLAR_NETWORKS) as Array<[StellarNetworkName, NetworkProfile]>).filter(([, p]) =>
    p.tokens.some((t) => haystack.includes(t)),
  );
  return matches.length === 1 ? { network: matches[0][0], known: false } : { known: false };
}

export function validateNetworkConsistency(env: NodeJS.ProcessEnv = process.env): NetworkConsistencyReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Exactly one, explicitly selected network.
  const rawNetwork = val(env, "STELLAR_NETWORK");
  const suffixedPresent = Object.values(SETTINGS).flatMap(({ base }) =>
    Object.keys(SUFFIXES)
      .map((s) => `${base}_${s}`)
      .filter((k) => val(env, k) !== undefined),
  );
  let network = normalizeNetwork(rawNetwork);
  if (rawNetwork && !network) {
    errors.push(`STELLAR_NETWORK="${rawNetwork}" is not a known network (use testnet, futurenet or mainnet)`);
    return { ok: false, errors, warnings };
  }
  if (!network) {
    if (suffixedPresent.length > 0) {
      errors.push(
        `STELLAR_NETWORK is not set, but network-specific values are (${suffixedPresent.join(", ")}). Set STELLAR_NETWORK explicitly`,
      );
      return { ok: false, errors, warnings };
    }
    warnings.push("STELLAR_NETWORK is not set; defaulting to testnet");
    network = "testnet";
  }
  const profile = STELLAR_NETWORKS[network];

  // 2. Nothing configured for any other network.
  for (const key of suffixedPresent) {
    const suffix = key.slice(key.lastIndexOf("_") + 1);
    if (SUFFIXES[suffix] !== network) {
      errors.push(
        `${key} is set for ${SUFFIXES[suffix]} but STELLAR_NETWORK=${network}; remove it so only one network is configured`,
      );
    }
  }

  // 3. Resolve each setting: <BASE>_<NETWORK> wins; unsuffixed (and legacy)
  //    names must agree with it if also set.
  const ownSuffixes = Object.keys(SUFFIXES).filter((s) => SUFFIXES[s] === network);
  const resolved: Partial<Record<SettingKey, string>> = {};
  for (const [key, { base, legacy }] of Object.entries(SETTINGS) as Array<[SettingKey, { base: string; legacy?: string }]>) {
    const candidates: Array<[string, string]> = [];
    for (const name of [...ownSuffixes.map((s) => `${base}_${s}`), base, ...(legacy ? [legacy] : [])]) {
      const v = val(env, name);
      if (v !== undefined) candidates.push([name, v]);
    }
    const distinct = new Set(candidates.map(([, v]) => v));
    if (distinct.size > 1) {
      errors.push(`Conflicting values for the ${network} ${key}: ${candidates.map(([n]) => n).join(", ")} differ`);
    }
    if (candidates.length > 0) resolved[key] = candidates[0][1];
  }

  // 4. Passphrase.
  if (resolved.passphrase && resolved.passphrase !== profile.passphrase) {
    const other = (Object.keys(STELLAR_NETWORKS) as StellarNetworkName[]).find(
      (n) => STELLAR_NETWORKS[n].passphrase === resolved.passphrase,
    );
    errors.push(
      `STELLAR_NETWORK_PASSPHRASE is ${other ? `the ${other} passphrase` : "not a known passphrase"} but STELLAR_NETWORK=${network} (expected "${profile.passphrase}")`,
    );
  }

  // 5. URLs.
  const rpcUrls = [
    ...(resolved.rpcUrl ? [resolved.rpcUrl] : []),
    ...(val(env, "SOROBAN_RPC_URLS") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ];
  const checkUrl = (label: string, url: string) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      errors.push(`${label} is not a valid URL`);
      return;
    }
    if (network === "mainnet" && parsed.protocol !== "https:") {
      errors.push(`${label} must use https on mainnet`);
    }
    const { network: pointsTo, known } = classifyUrl(url);
    if (pointsTo && pointsTo !== network) {
      errors.push(`${label} (${parsed.host}) points to ${pointsTo} but STELLAR_NETWORK=${network}`);
    } else if (!known && !pointsTo) {
      warnings.push(
        `${label} (${parsed.host}) can't be matched to a network from its name; set STELLAR_VALIDATE_ONCHAIN=true to confirm it with the live passphrase check`,
      );
    }
  };
  rpcUrls.forEach((u, i) => checkUrl(i === 0 && resolved.rpcUrl ? "SOROBAN_RPC_URL" : "SOROBAN_RPC_URLS entry", u));
  if (resolved.horizonUrl) checkUrl("STELLAR_HORIZON_URL", resolved.horizonUrl);

  // 6. Contract IDs: valid shape, no ID reused across roles or networks.
  const contractKeys: SettingKey[] = ["poolContractId", "oracleContractId", "policyContractId"];
  const seen = new Map<string, string>();
  for (const key of contractKeys) {
    const id = resolved[key];
    if (!id) continue;
    if (!CONTRACT_RE.test(id)) {
      errors.push(`${key} is not a valid Stellar contract ID (C…)`);
      continue;
    }
    const prior = seen.get(id);
    if (prior) errors.push(`${key} and ${prior} are the same contract ID; one of them was copied from the wrong place`);
    seen.set(id, key);
  }

  // 7. Payout readiness. Warn only: read-only and local setups are valid.
  //    Only presence is checked; secret values are never read or echoed.
  const hasRelayer = Boolean(val(env, "ORACLE_RELAYER_SECRET") || val(env, "ORACLE_RELAYER_SECRET_ID"));
  const missing = [
    !resolved.oracleContractId && "oracle contract ID",
    !resolved.poolContractId && "pool contract ID",
    !hasRelayer && "relayer key (ORACLE_RELAYER_SECRET / ORACLE_RELAYER_SECRET_ID)",
  ].filter(Boolean);
  if (missing.length > 0) {
    warnings.push(
      `Payout-triggering configuration is incomplete for ${network}: missing ${missing.join(", ")}. ` +
        `Oracle readings can't be published or claims settled on-chain, so these coverage types can't pay out: ${PAYOUT_COVERAGE_TYPES.join(", ")}`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    resolved: {
      network,
      passphrase: profile.passphrase,
      rpcUrls,
      horizonUrl: resolved.horizonUrl,
      poolContractId: resolved.poolContractId,
      oracleContractId: resolved.oracleContractId,
      policyContractId: resolved.policyContractId,
    },
  };
}

export class NetworkConsistencyError extends Error {
  constructor(readonly errors: string[]) {
    super(`Stellar network configuration is inconsistent:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    this.name = "NetworkConsistencyError";
  }
}

/** Throws a NetworkConsistencyError listing every problem; otherwise returns the report. */
export function assertNetworkConsistency(env: NodeJS.ProcessEnv = process.env): NetworkConsistencyReport {
  const report = validateNetworkConsistency(env);
  if (!report.ok) throw new NetworkConsistencyError(report.errors);
  return report;
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface LiveCheckResult {
  /** Endpoint answered with a different network's passphrase. Fatal. */
  mismatches: string[];
  /** Endpoint could not be reached. Reported, not fatal. */
  unreachable: string[];
}

/**
 * Asks each RPC (`getNetwork`) and Horizon (`GET /`) which passphrase it
 * serves and compares it with the configured network. This catches custom
 * hosts that the name check in validateNetworkConsistency can't classify.
 */
export async function verifyNetworkLive(
  cfg: { network: StellarNetworkName; rpcUrls: string[]; horizonUrl?: string },
  opts: { timeoutMs?: number; fetch?: FetchLike } = {},
): Promise<LiveCheckResult> {
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const expected = STELLAR_NETWORKS[cfg.network].passphrase;
  const result: LiveCheckResult = { mismatches: [], unreachable: [] };

  const probe = async (label: string, url: string, init: Parameters<FetchLike>[1], pick: (body: any) => unknown) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { ...init, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const passphrase = pick(await res.json());
      if (typeof passphrase !== "string") throw new Error("response has no network passphrase");
      if (passphrase !== expected) {
        result.mismatches.push(
          `${label} (${new URL(url).host}) serves "${passphrase}" but STELLAR_NETWORK=${cfg.network} expects "${expected}"`,
        );
      }
    } catch (err) {
      result.unreachable.push(`${label} (${safeHost(url)}) is not reachable for the network check: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  };

  await Promise.all([
    ...cfg.rpcUrls.map((url) =>
      probe(
        "Soroban RPC",
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getNetwork" }),
        },
        (body) => body?.result?.passphrase,
      ),
    ),
    ...(cfg.horizonUrl ? [probe("Horizon", cfg.horizonUrl, { method: "GET" }, (body) => body?.network_passphrase)] : []),
  ]);
  return result;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "<invalid url>";
  }
}
