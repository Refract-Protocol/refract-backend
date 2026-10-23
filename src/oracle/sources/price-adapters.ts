import {
  assertPositiveFinite,
  FetchJson,
  SourceAdapter,
  SourceObservation,
} from "./source-adapter";

/** CoinGecko subject ids (e.g. "usd-coin") → Kraken pair names. */
const KRAKEN_PAIRS: Record<string, string> = {
  "usd-coin": "USDCUSD",
  stellar: "XLMUSD",
};

/** Primary price feed: CoinGecko's volume-weighted aggregate across exchanges. */
export class CoinGeckoPriceAdapter implements SourceAdapter {
  readonly id = "coingecko";
  readonly feed = "price" as const;
  readonly independence = {
    upstreamOrigin: "Aggregate of many centralized and decentralized exchanges",
    cadence: "~1–5 minute cache on the public endpoint",
    authentication: "none" as const,
    knownDivergence:
      "Volume-weighted across venues and lagging by minutes; differs from a single order book by a few bps.",
  };

  constructor(
    private readonly fetchJson: FetchJson,
    private readonly baseUrl: string,
  ) {}

  async fetch(subject: string): Promise<SourceObservation> {
    const url = `${this.baseUrl}/simple/price?ids=${encodeURIComponent(subject)}&vs_currencies=usd&include_last_updated_at=true`;
    const body = (await this.fetchJson(url)) as Record<
      string,
      { usd?: number; last_updated_at?: number }
    >;
    const entry = body?.[subject];
    return {
      source: this.id,
      feed: this.feed,
      subject,
      value: assertPositiveFinite(this.id, entry?.usd),
      observedAt: (entry?.last_updated_at ?? 0) * 1000 || Date.now(),
    };
  }
}

/**
 * Independent price feed: Kraken's single-venue order book last trade. Different
 * methodology (one exchange's matching engine, not an aggregate) and a
 * different upstream operator from CoinGecko.
 */
export class KrakenPriceAdapter implements SourceAdapter {
  readonly id = "kraken";
  readonly feed = "price" as const;
  readonly independence = {
    upstreamOrigin: "Kraken spot order book (single venue, last trade price)",
    cadence: "Real time (per trade); polled at the configured interval",
    authentication: "none" as const,
    knownDivergence:
      "Single-venue price can sit a few bps from the cross-exchange aggregate, most visibly for USDC during thin liquidity.",
  };

  constructor(
    private readonly fetchJson: FetchJson,
    private readonly baseUrl: string,
  ) {}

  async fetch(subject: string): Promise<SourceObservation> {
    const pair = KRAKEN_PAIRS[subject];
    if (!pair) throw new Error(`${this.id}: unsupported subject ${subject}`);
    const body = (await this.fetchJson(
      `${this.baseUrl}/0/public/Ticker?pair=${pair}`,
    )) as {
      error?: string[];
      result?: Record<string, { c?: [string, string] }>;
    };
    if (body?.error?.length) {
      throw new Error(`${this.id}: ${body.error.join(",")}`);
    }
    const ticker = Object.values(body?.result ?? {})[0];
    return {
      source: this.id,
      feed: this.feed,
      subject,
      value: assertPositiveFinite(this.id, Number(ticker?.c?.[0])),
      // Ticker carries no timestamp; the last trade is live by construction.
      observedAt: Date.now(),
    };
  }
}
