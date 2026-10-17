export type FeedMetricKind = "price_usd" | "tvl_usd";

export interface SourceIndependenceDescriptor {
  sourceId: string;
  metricKind: FeedMetricKind;
  upstreamOrigin: string;
  methodology: string;
  expectedCadenceMs: number;
  maxReportingLagMs: number;
}

export interface NormalizedProviderReading {
  sourceId: string;
  feedId: string;
  metricKind: FeedMetricKind;
  canonicalValueUsd: number;
  observedAtMs: number;
  upstreamOrigin: string;
}

export interface PluggableOracleSourceAdapter {
  readonly descriptor: SourceIndependenceDescriptor;
  fetchNormalizedReading(
    feedId: string,
    nowMs?: number
  ): Promise<NormalizedProviderReading | null>;
}

export interface RawPythHermesPricePayload {
  id: string;
  price: {
    price: string;
    conf: string;
    expo: number;
    publish_time: number; // unix seconds
  };
}

export class PythHermesPriceAdapter implements PluggableOracleSourceAdapter {
  public readonly descriptor: SourceIndependenceDescriptor = {
    sourceId: "pyth-hermes-price",
    metricKind: "price_usd",
    upstreamOrigin: "pyth_network_first_party_publishers",
    methodology: "institutional_orderbook_median_with_confidence_interval",
    expectedCadenceMs: 5_000,
    maxReportingLagMs: 60_000,
  };

  private readonly maxConfidenceRatio: number;
  private readonly fetchRaw: (
    feedId: string
  ) => Promise<RawPythHermesPricePayload | null>;

  constructor(options: {
    maxConfidenceRatio?: number;
    fetchRaw: (feedId: string) => Promise<RawPythHermesPricePayload | null>;
  }) {
    this.maxConfidenceRatio = options.maxConfidenceRatio ?? 0.02;
    this.fetchRaw = options.fetchRaw;
  }

  public async fetchNormalizedReading(
    feedId: string,
    nowMs: number = Date.now()
  ): Promise<NormalizedProviderReading | null> {
    const raw = await this.fetchRaw(feedId);
    if (!raw || !raw.price) return null;

    const rawPriceInt = Number(raw.price.price);
    const rawConfInt = Number(raw.price.conf);
    const expo = raw.price.expo;

    if (
      !Number.isFinite(rawPriceInt) ||
      !Number.isFinite(rawConfInt) ||
      !Number.isFinite(expo)
    ) {
      return null;
    }

    const scale = Math.pow(10, expo);
    const canonicalValueUsd = Number((rawPriceInt * scale).toFixed(8));
    const confidenceUsd = Math.abs(rawConfInt * scale);

    if (canonicalValueUsd <= 0) return null;
    if (confidenceUsd / canonicalValueUsd > this.maxConfidenceRatio) {
      return null;
    }

    const observedAtMs = raw.price.publish_time * 1_000;
    if (nowMs - observedAtMs > this.descriptor.maxReportingLagMs) {
      return null;
    }

    return {
      sourceId: this.descriptor.sourceId,
      feedId,
      metricKind: "price_usd",
      canonicalValueUsd,
      observedAtMs,
      upstreamOrigin: this.descriptor.upstreamOrigin,
    };
  }
}

export interface RawOnChainVaultTvlPayload {
  protocolSlug: string;
  totalLockedRawUnits: string;
  unitDecimals: number;
  unitUsdPrice: number;
  indexedAtIso: string;
}

export class DirectVaultIndexerTvlAdapter
  implements PluggableOracleSourceAdapter
{
  public readonly descriptor: SourceIndependenceDescriptor = {
    sourceId: "direct-vault-indexer-tvl",
    metricKind: "tvl_usd",
    upstreamOrigin: "stellar_rpc_direct_vault_balance_indexer",
    methodology: "on_chain_contract_reserve_summation",
    expectedCadenceMs: 30_000,
    maxReportingLagMs: 180_000,
  };

  private readonly fetchRaw: (
    feedId: string
  ) => Promise<RawOnChainVaultTvlPayload | null>;

  constructor(options: {
    fetchRaw: (feedId: string) => Promise<RawOnChainVaultTvlPayload | null>;
  }) {
    this.fetchRaw = options.fetchRaw;
  }

  public async fetchNormalizedReading(
    feedId: string,
    nowMs: number = Date.now()
  ): Promise<NormalizedProviderReading | null> {
    const raw = await this.fetchRaw(feedId);
    if (!raw) return null;

    const rawUnits = Number(raw.totalLockedRawUnits);
    if (
      !Number.isFinite(rawUnits) ||
      rawUnits < 0 ||
      !Number.isFinite(raw.unitDecimals) ||
      !Number.isFinite(raw.unitUsdPrice) ||
      raw.unitUsdPrice <= 0
    ) {
      return null;
    }

    const observedAtMs = Date.parse(raw.indexedAtIso);
    if (
      !Number.isFinite(observedAtMs) ||
      nowMs - observedAtMs > this.descriptor.maxReportingLagMs
    ) {
      return null;
    }

    const tokenBalance = rawUnits / Math.pow(10, raw.unitDecimals);
    const canonicalValueUsd = Number(
      (tokenBalance * raw.unitUsdPrice).toFixed(2)
    );

    return {
      sourceId: this.descriptor.sourceId,
      feedId,
      metricKind: "tvl_usd",
      canonicalValueUsd,
      observedAtMs,
      upstreamOrigin: this.descriptor.upstreamOrigin,
    };
  }
}

export class IndependentProviderCorroborator {
  private readonly adaptersByFeed = new Map<
    string,
    PluggableOracleSourceAdapter[]
  >();

  public registerAdapterForFeed(
    feedId: string,
    adapter: PluggableOracleSourceAdapter
  ): void {
    const list = this.adaptersByFeed.get(feedId) ?? [];
    list.push(adapter);
    this.adaptersByFeed.set(feedId, list);
  }

  public async pollAndCorroborateFeed(
    feedId: string,
    toleranceRatio: number,
    nowMs: number = Date.now()
  ): Promise<{
    corroborated: boolean;
    agreedValueUsd: number | null;
    distinctUpstreamOrigins: string[];
    readings: NormalizedProviderReading[];
  }> {
    const adapters = this.adaptersByFeed.get(feedId) ?? [];
    const readings: NormalizedProviderReading[] = [];

    for (const adapter of adapters) {
      const r = await adapter.fetchNormalizedReading(feedId, nowMs);
      if (r) {
        readings.push(r);
      }
    }

    const distinctUpstreamOrigins = Array.from(
      new Set(readings.map((r) => r.upstreamOrigin))
    );

    // Require at least 2 genuinely distinct upstream origins for real corroboration
    if (distinctUpstreamOrigins.length < 2) {
      return {
        corroborated: false,
        agreedValueUsd: null,
        distinctUpstreamOrigins,
        readings,
      };
    }

    const sortedVals = readings
      .map((r) => r.canonicalValueUsd)
      .sort((a, b) => a - b);
    const mid = Math.floor(sortedVals.length / 2);
    const median =
      sortedVals.length % 2 === 0
        ? (sortedVals[mid - 1]! + sortedVals[mid]!) / 2
        : sortedVals[mid]!;

    const denom = Math.max(Math.abs(median), 1e-9);
    const agreeing = readings.filter(
      (r) => Math.abs(r.canonicalValueUsd - median) / denom <= toleranceRatio
    );
    const agreeingOrigins = new Set(agreeing.map((r) => r.upstreamOrigin));

    if (agreeingOrigins.size < 2) {
      return {
        corroborated: false,
        agreedValueUsd: null,
        distinctUpstreamOrigins,
        readings,
      };
    }

    return {
      corroborated: true,
      agreedValueUsd: Number(median.toFixed(6)),
      distinctUpstreamOrigins,
      readings: agreeing,
    };
  }
}
