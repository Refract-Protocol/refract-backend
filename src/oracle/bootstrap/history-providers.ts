import axios from "axios";
import { HistoricalSample } from "./baseline";

export interface HistoryRequest {
  feedId: string;
  sourceId: string;
  /** Adapter-specific settings from the source definition, e.g. a coin id or protocol slug. */
  params: Record<string, string>;
  from: Date;
  to: Date;
}

/**
 * Supplies historical readings for one adapter type. Every source adapter
 * that can be onboarded should have one, so new sources start warm.
 */
export interface HistoricalReadingProvider {
  readonly adapter: string;
  fetchHistory(request: HistoryRequest): Promise<HistoricalSample[]>;
}

export type HttpGet = (url: string, params: Record<string, string | number>) => Promise<unknown>;

const defaultHttpGet =
  (timeoutMs: number): HttpGet =>
  async (url, params) =>
    (await axios.get(url, { params, timeout: timeoutMs })).data;

function requireParam(request: HistoryRequest, name: string): string {
  const value = request.params[name];
  if (!value) {
    throw new Error(`Source ${request.sourceId} needs a "${name}" parameter for history backfill`);
  }
  return value;
}

/**
 * CoinGecko `/coins/{id}/market_chart/range`: USD price points. Used for the
 * StablecoinDepeg and MarketCrash feeds. Source param: `coinId`.
 */
export class CoinGeckoHistoryProvider implements HistoricalReadingProvider {
  readonly adapter = "coingecko";

  constructor(
    private readonly baseUrl = process.env.COINGECKO_BASE_URL ?? "https://api.coingecko.com/api/v3",
    private readonly httpGet: HttpGet = defaultHttpGet(Number(process.env.ORACLE_HTTP_TIMEOUT_MS ?? 10_000))
  ) {}

  async fetchHistory(request: HistoryRequest): Promise<HistoricalSample[]> {
    const coinId = requireParam(request, "coinId");
    const data = (await this.httpGet(`${this.baseUrl}/coins/${encodeURIComponent(coinId)}/market_chart/range`, {
      vs_currency: request.params.vsCurrency ?? "usd",
      from: Math.floor(request.from.getTime() / 1000),
      to: Math.floor(request.to.getTime() / 1000),
    })) as { prices?: Array<[number, number]> };

    if (!Array.isArray(data?.prices)) {
      throw new Error(`CoinGecko returned no price history for ${coinId}`);
    }
    return data.prices.map(([timestamp, value]) => ({ timestamp, value }));
  }
}

/**
 * DeFiLlama history. Two source shapes are supported:
 *
 *  - `protocolSlug` — `/protocol/{slug}` total TVL history, for the
 *    SmartContractRisk TVL-drop feed.
 *  - `coinId`       — coins.llama.fi `/chart/coingecko:{coinId}` hourly USD
 *    prices, for price feeds that want DeFiLlama as an independent source.
 */
export class DefiLlamaHistoryProvider implements HistoricalReadingProvider {
  readonly adapter = "defillama";

  constructor(
    private readonly baseUrl = process.env.DEFILLAMA_BASE_URL ?? "https://api.llama.fi",
    private readonly httpGet: HttpGet = defaultHttpGet(Number(process.env.ORACLE_HTTP_TIMEOUT_MS ?? 10_000)),
    private readonly coinsBaseUrl = process.env.DEFILLAMA_COINS_BASE_URL ?? "https://coins.llama.fi"
  ) {}

  async fetchHistory(request: HistoryRequest): Promise<HistoricalSample[]> {
    const from = request.from.getTime();
    const to = request.to.getTime();
    const inWindow = (sample: HistoricalSample) => sample.timestamp >= from && sample.timestamp <= to;

    if (request.params.coinId && !request.params.protocolSlug) {
      const coinKey = `coingecko:${request.params.coinId}`;
      const hours = Math.max(1, Math.ceil((to - from) / 3_600_000));
      const data = (await this.httpGet(`${this.coinsBaseUrl}/chart/${encodeURIComponent(coinKey)}`, {
        start: Math.floor(from / 1000),
        span: hours,
        period: "1h",
      })) as { coins?: Record<string, { prices?: Array<{ timestamp: number; price: number }> }> };

      const prices = data?.coins?.[coinKey]?.prices;
      if (!Array.isArray(prices)) {
        throw new Error(`DeFiLlama returned no price history for ${coinKey}`);
      }
      return prices.map((point) => ({ timestamp: point.timestamp * 1000, value: point.price })).filter(inWindow);
    }

    const slug = requireParam(request, "protocolSlug");
    const data = (await this.httpGet(`${this.baseUrl}/protocol/${encodeURIComponent(slug)}`, {})) as {
      tvl?: Array<{ date: number; totalLiquidityUSD: number }>;
    };

    if (!Array.isArray(data?.tvl)) {
      throw new Error(`DeFiLlama returned no TVL history for ${slug}`);
    }
    return data.tvl
      .map((point) => ({ timestamp: point.date * 1000, value: point.totalLiquidityUSD }))
      .filter(inWindow);
  }
}

export class HistoryProviderRegistry {
  private readonly providers = new Map<string, HistoricalReadingProvider>();

  constructor(providers: HistoricalReadingProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: HistoricalReadingProvider): void {
    this.providers.set(provider.adapter, provider);
  }

  get(adapter: string): HistoricalReadingProvider | undefined {
    return this.providers.get(adapter);
  }

  adapters(): string[] {
    return [...this.providers.keys()];
  }
}
