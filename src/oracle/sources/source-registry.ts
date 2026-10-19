import { CoinGeckoPriceAdapter, KrakenPriceAdapter } from "./price-adapters";
import {
  createFetchJson,
  FeedKind,
  SourceAdapter,
  SourceObservation,
} from "./source-adapter";
import { DefiLlamaTvlAdapter, TokenTerminalTvlAdapter } from "./tvl-adapters";

export class SourceRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();

  register(adapter: SourceAdapter): this {
    const key = `${adapter.feed}:${adapter.id}`;
    if (this.adapters.has(key)) throw new Error(`Duplicate source ${key}`);
    this.adapters.set(key, adapter);
    return this;
  }

  forFeed(feed: FeedKind): SourceAdapter[] {
    return [...this.adapters.values()].filter((a) => a.feed === feed);
  }
}

/** Provider endpoints, credentials and enablement are all environment-driven. */
export function createSourceRegistry(
  env: NodeJS.ProcessEnv = process.env,
): SourceRegistry {
  const fetchJson = createFetchJson(Number(env.ORACLE_HTTP_TIMEOUT_MS ?? 5000));
  const registry = new SourceRegistry()
    .register(
      new CoinGeckoPriceAdapter(
        fetchJson,
        env.COINGECKO_BASE_URL ?? "https://api.coingecko.com/api/v3",
      ),
    )
    .register(
      new DefiLlamaTvlAdapter(
        fetchJson,
        env.DEFILLAMA_BASE_URL ?? "https://api.llama.fi",
      ),
    );

  if (env.KRAKEN_ENABLED !== "false") {
    registry.register(
      new KrakenPriceAdapter(
        fetchJson,
        env.KRAKEN_BASE_URL ?? "https://api.kraken.com",
      ),
    );
  }
  // Only registered when a key is configured; no key means single-source TVL.
  if (env.TOKENTERMINAL_API_KEY) {
    registry.register(
      new TokenTerminalTvlAdapter(
        fetchJson,
        env.TOKENTERMINAL_BASE_URL ?? "https://api.tokenterminal.com",
        env.TOKENTERMINAL_API_KEY,
      ),
    );
  }
  return registry;
}

export type CorroborationStatus =
  | "corroborated"
  | "single_source"
  | "divergent"
  | "unavailable";

export interface CorroborationResult {
  status: CorroborationStatus;
  /** Median of the sources; undefined when unavailable or divergent. */
  value?: number;
  observations: SourceObservation[];
  maxDivergencePct?: number;
}

export interface CorroborationOptions {
  /** Max relative spread (%) between sources before they count as divergent. */
  tolerancePct: number;
  /** Observations older than this (ms) are dropped, allowing for provider lag. */
  maxAgeMs: number;
  now?: number;
}

/**
 * Polls every adapter registered for a feed and reports whether at least two
 * distinct providers agree. It only classifies inputs; consensus weights and
 * quorum thresholds are untouched.
 */
export async function corroborate(
  registry: SourceRegistry,
  feed: FeedKind,
  subjects: Record<string, string>,
  opts: CorroborationOptions,
): Promise<CorroborationResult> {
  const now = opts.now ?? Date.now();
  const settled = await Promise.allSettled(
    registry
      .forFeed(feed)
      .map((a) => a.fetch(subjects[a.id] ?? subjects.default)),
  );
  const observations = settled
    .filter(
      (r): r is PromiseFulfilledResult<SourceObservation> =>
        r.status === "fulfilled",
    )
    .map((r) => r.value)
    .filter((o) => now - o.observedAt <= opts.maxAgeMs);

  if (observations.length === 0) return { status: "unavailable", observations };
  if (observations.length === 1) {
    return {
      status: "single_source",
      value: observations[0].value,
      observations,
    };
  }
  const values = observations.map((o) => o.value).sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)];
  const maxDivergencePct =
    ((values[values.length - 1] - values[0]) / median) * 100;
  if (maxDivergencePct > opts.tolerancePct) {
    return { status: "divergent", observations, maxDivergencePct };
  }
  return { status: "corroborated", value: median, observations, maxDivergencePct };
}
