export type DeclaredCanonicalUnit = "USD_PRICE_8DEC" | "USD_TVL_2DEC";

export interface AdapterReadingResult {
  providerId: string;
  feedId: string;
  declaredUnit: DeclaredCanonicalUnit;
  canonicalValue: number;
  observedAtMs: number;
  cursorToken?: string;
}

export interface RegisteredOracleProviderAdapter {
  readonly providerId: string;
  readonly declaredUnit: DeclaredCanonicalUnit;
  readonly freshnessWindowMs: number;
  pollNormalized(
    feedId: string,
    nowMs?: number
  ): Promise<AdapterReadingResult | null>;
  isHealthy(): boolean;
}

export interface CoinGeckoRawResponse {
  [coinId: string]: {
    usd?: number;
    last_updated_at?: number; // unix seconds
  };
}

export class CoinGeckoPricePollerAdapter
  implements RegisteredOracleProviderAdapter
{
  public readonly providerId = "coingecko-spot";
  public readonly declaredUnit: DeclaredCanonicalUnit = "USD_PRICE_8DEC";
  public readonly freshnessWindowMs: number;
  private readonly coinIdByFeed: Record<string, string>;
  private readonly fetchJson: (coinId: string) => Promise<CoinGeckoRawResponse>;
  private healthy = true;

  constructor(options: {
    freshnessWindowMs?: number;
    coinIdByFeed: Record<string, string>;
    fetchJson: (coinId: string) => Promise<CoinGeckoRawResponse>;
  }) {
    this.freshnessWindowMs = options.freshnessWindowMs ?? 120_000;
    this.coinIdByFeed = options.coinIdByFeed;
    this.fetchJson = options.fetchJson;
  }

  public async pollNormalized(
    feedId: string,
    nowMs: number = Date.now()
  ): Promise<AdapterReadingResult | null> {
    const coinId = this.coinIdByFeed[feedId];
    if (!coinId) return null;

    try {
      const data = await this.fetchJson(coinId);
      const entry = data?.[coinId];
      if (
        !entry ||
        typeof entry.usd !== "number" ||
        !Number.isFinite(entry.usd) ||
        entry.usd <= 0
      ) {
        this.healthy = false;
        return null;
      }

      const observedAtMs =
        typeof entry.last_updated_at === "number"
          ? entry.last_updated_at * 1_000
          : nowMs;
      if (nowMs - observedAtMs > this.freshnessWindowMs) {
        this.healthy = false;
        return null;
      }

      this.healthy = true;
      return {
        providerId: this.providerId,
        feedId,
        declaredUnit: this.declaredUnit,
        canonicalValue: Number(entry.usd.toFixed(8)),
        observedAtMs,
      };
    } catch {
      this.healthy = false;
      return null;
    }
  }

  public isHealthy(): boolean {
    return this.healthy;
  }
}

export interface HorizonTradeRecord {
  paging_token: string;
  ledger_close_time: string;
  price: { n: string; d: string };
}

export class HorizonOrderbookPollerAdapter
  implements RegisteredOracleProviderAdapter
{
  public readonly providerId = "stellar-horizon-dex";
  public readonly declaredUnit: DeclaredCanonicalUnit = "USD_PRICE_8DEC";
  public readonly freshnessWindowMs: number;
  private readonly cursorsByFeed = new Map<string, string>();
  private readonly fetchTrades: (
    feedId: string,
    cursor?: string
  ) => Promise<HorizonTradeRecord[]>;
  private healthy = true;

  constructor(options: {
    freshnessWindowMs?: number;
    fetchTrades: (
      feedId: string,
      cursor?: string
    ) => Promise<HorizonTradeRecord[]>;
  }) {
    this.freshnessWindowMs = options.freshnessWindowMs ?? 120_000;
    this.fetchTrades = options.fetchTrades;
  }

  public getCursor(feedId: string): string | undefined {
    return this.cursorsByFeed.get(feedId);
  }

  public async pollNormalized(
    feedId: string,
    nowMs: number = Date.now()
  ): Promise<AdapterReadingResult | null> {
    try {
      const currentCursor = this.cursorsByFeed.get(feedId);
      const trades = await this.fetchTrades(feedId, currentCursor);
      if (!trades || trades.length === 0) {
        return null;
      }

      const latest = trades[trades.length - 1]!;
      const num = Number(latest.price?.n);
      const den = Number(latest.price?.d);
      if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0 || num <= 0) {
        this.healthy = false;
        return null;
      }

      const observedAtMs = Date.parse(latest.ledger_close_time);
      if (
        !Number.isFinite(observedAtMs) ||
        nowMs - observedAtMs > this.freshnessWindowMs
      ) {
        this.healthy = false;
        return null;
      }

      // Advance cursor only after valid trade parsing so no ledger is skipped
      this.cursorsByFeed.set(feedId, latest.paging_token);
      this.healthy = true;

      return {
        providerId: this.providerId,
        feedId,
        declaredUnit: this.declaredUnit,
        canonicalValue: Number((num / den).toFixed(8)),
        observedAtMs,
        cursorToken: latest.paging_token,
      };
    } catch {
      this.healthy = false;
      return null;
    }
  }

  public isHealthy(): boolean {
    return this.healthy;
  }
}

export interface DefiLlamaProtocolPayload {
  tvl?:
    | number
    | Array<{
        date: number; // unix seconds
        totalLiquidityUSD: number;
      }>;
  currentChainTvls?: Record<string, number>;
}

export class DefiLlamaTvlPollerAdapter
  implements RegisteredOracleProviderAdapter
{
  public readonly providerId = "defillama-tvl";
  public readonly declaredUnit: DeclaredCanonicalUnit = "USD_TVL_2DEC";
  public readonly freshnessWindowMs: number;
  private readonly fetchProtocol: (
    feedId: string
  ) => Promise<DefiLlamaProtocolPayload>;
  private healthy = true;

  constructor(options: {
    freshnessWindowMs?: number;
    fetchProtocol: (feedId: string) => Promise<DefiLlamaProtocolPayload>;
  }) {
    this.freshnessWindowMs = options.freshnessWindowMs ?? 300_000;
    this.fetchProtocol = options.fetchProtocol;
  }

  public async pollNormalized(
    feedId: string,
    nowMs: number = Date.now()
  ): Promise<AdapterReadingResult | null> {
    try {
      const payload = await this.fetchProtocol(feedId);
      if (!payload) return null;

      let tvlUsd: number | null = null;
      let observedAtMs = nowMs;

      if (typeof payload.tvl === "number" && Number.isFinite(payload.tvl)) {
        tvlUsd = payload.tvl;
      } else if (Array.isArray(payload.tvl) && payload.tvl.length > 0) {
        const latestPoint = payload.tvl[payload.tvl.length - 1]!;
        tvlUsd = latestPoint.totalLiquidityUSD;
        observedAtMs = latestPoint.date * 1_000;
      }

      if (tvlUsd === null || !Number.isFinite(tvlUsd) || tvlUsd < 0) {
        this.healthy = false;
        return null;
      }

      if (nowMs - observedAtMs > this.freshnessWindowMs) {
        this.healthy = false;
        return null;
      }

      this.healthy = true;
      return {
        providerId: this.providerId,
        feedId,
        declaredUnit: this.declaredUnit,
        canonicalValue: Number(tvlUsd.toFixed(2)),
        observedAtMs,
      };
    } catch {
      this.healthy = false;
      return null;
    }
  }

  public isHealthy(): boolean {
    return this.healthy;
  }
}

export class CoreProviderAdapterRegistry {
  private readonly adapters = new Map<string, RegisteredOracleProviderAdapter>();

  public register(adapter: RegisteredOracleProviderAdapter): void {
    this.adapters.set(adapter.providerId, adapter);
  }

  public getRegisteredIds(): string[] {
    return Array.from(this.adapters.keys());
  }

  public getAdapter(
    providerId: string
  ): RegisteredOracleProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  public static verifyLegacyEquivalence(
    legacyValue: number,
    adapterResult: AdapterReadingResult | null,
    epsilon: number = 1e-8
  ): boolean {
    if (!adapterResult) return false;
    return Math.abs(legacyValue - adapterResult.canonicalValue) <= epsilon;
  }
}
