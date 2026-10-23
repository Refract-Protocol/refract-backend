import {
  assertPositiveFinite,
  FetchJson,
  SourceAdapter,
  SourceObservation,
} from "./source-adapter";

/** Primary TVL feed: DeFiLlama's per-protocol adapters over on-chain balances. */
export class DefiLlamaTvlAdapter implements SourceAdapter {
  readonly id = "defillama";
  readonly feed = "tvl" as const;
  readonly independence = {
    upstreamOrigin:
      "Community-maintained adapters reading on-chain contract balances",
    cadence: "Roughly hourly",
    authentication: "none" as const,
    knownDivergence:
      "Counts only whitelisted token balances priced via its own oracle; excludes borrowed/own-token TVL by default.",
  };

  constructor(
    private readonly fetchJson: FetchJson,
    private readonly baseUrl: string,
  ) {}

  async fetch(subject: string): Promise<SourceObservation> {
    const body = await this.fetchJson(
      `${this.baseUrl}/tvl/${encodeURIComponent(subject)}`,
    );
    return {
      source: this.id,
      feed: this.feed,
      subject,
      value: assertPositiveFinite(this.id, body),
      observedAt: Date.now(),
    };
  }
}

/**
 * Independent TVL feed: Token Terminal's protocol metrics, built from its own
 * indexing pipeline and TVL definition rather than DeFiLlama's adapters.
 * Requires an API key (TOKENTERMINAL_API_KEY), supplied via env only.
 */
export class TokenTerminalTvlAdapter implements SourceAdapter {
  readonly id = "tokenterminal";
  readonly feed = "tvl" as const;
  readonly independence = {
    upstreamOrigin:
      "Token Terminal's own indexed on-chain and financial data pipeline",
    cadence: "Daily-granularity metric, refreshed intraday on paid tiers",
    authentication: "api-key" as const,
    knownDivergence:
      "Daily granularity lags DeFiLlama by hours and uses a different TVL definition; persistent single-digit-percent gaps are expected and benign.",
  };

  constructor(
    private readonly fetchJson: FetchJson,
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async fetch(subject: string): Promise<SourceObservation> {
    const body = (await this.fetchJson(
      `${this.baseUrl}/v2/projects/${encodeURIComponent(subject)}/metrics`,
      { Authorization: `Bearer ${this.apiKey}` },
    )) as { data?: Array<{ tvl?: number; timestamp?: string }> };
    const latest = body?.data?.[body.data.length - 1];
    return {
      source: this.id,
      feed: this.feed,
      subject,
      value: assertPositiveFinite(this.id, latest?.tvl),
      observedAt: latest?.timestamp ? Date.parse(latest.timestamp) : Date.now(),
    };
  }
}
