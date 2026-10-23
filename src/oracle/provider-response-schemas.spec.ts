import {
  CoinGeckoMarketV1,
  CoinGeckoStablecoinV1,
  DefiLlamaProtocolV1,
  HorizonLedgerV1,
  MAX_ORACLE_RESPONSE_BYTES,
  parseProviderResponse,
} from "./provider-response-schemas";

const json = (value: unknown): string => JSON.stringify(value);

describe("versioned oracle provider response schemas", () => {
  it("accepts only numeric CoinGecko stablecoin prices", () => {
    expect(
      parseProviderResponse("CoinGecko", json({ "usd-coin": { usd: 0.99 } }), CoinGeckoStablecoinV1),
    ).toEqual({ "usd-coin": { usd: 0.99 } });

    expect(() =>
      parseProviderResponse("CoinGecko", json({ "usd-coin": { usd: "0.99" } }), CoinGeckoStablecoinV1),
    ).toThrow(/schema v1/);
    expect(() =>
      parseProviderResponse("CoinGecko", json({ "usd-coin": { price: 0.99 } }), CoinGeckoStablecoinV1),
    ).toThrow(/schema v1/);
  });

  it("rejects missing or non-numeric CoinGecko market fields", () => {
    expect(
      parseProviderResponse(
        "CoinGecko",
        json({ stellar: { usd: 0.2, usd_24h_change: -12.5 } }),
        CoinGeckoMarketV1,
      ).stellar.usd_24h_change,
    ).toBe(-12.5);

    expect(() =>
      parseProviderResponse(
        "CoinGecko",
        json({ stellar: { usd: 0.2, usd_24h_change: "-12.5" } }),
        CoinGeckoMarketV1,
      ),
    ).toThrow(/schema v1/);
    expect(() =>
      parseProviderResponse("CoinGecko", json({ stellar: { usd: 0.2 } }), CoinGeckoMarketV1),
    ).toThrow(/schema v1/);
  });

  it("requires one well-formed Horizon ledger record", () => {
    const valid = {
      _embedded: {
        records: [{ sequence: 42, closed_at: "2026-10-21T08:00:00Z" }],
      },
    };
    expect(parseProviderResponse("Horizon", json(valid), HorizonLedgerV1)._embedded.records[0].sequence).toBe(42);

    expect(() =>
      parseProviderResponse(
        "Horizon",
        json({ _embedded: { records: [{ sequence: "42", closed_at: "2026-10-21T08:00:00Z" }] } }),
        HorizonLedgerV1,
      ),
    ).toThrow(/schema v1/);
    expect(() =>
      parseProviderResponse("Horizon", json({ _embedded: { records: [] } }), HorizonLedgerV1),
    ).toThrow(/schema v1/);
  });

  it("validates DeFiLlama history values and rejects renamed fields", () => {
    const valid = {
      name: "Example Protocol",
      tvl: [
        { date: 1_800_000_000, totalLiquidityUSD: 100 },
        { date: 1_800_086_400, totalLiquidityUSD: 90 },
      ],
    };
    expect(parseProviderResponse("DeFiLlama", json(valid), DefiLlamaProtocolV1).tvl).toHaveLength(2);

    expect(() =>
      parseProviderResponse(
        "DeFiLlama",
        json({ name: "Example Protocol", tvl: [{ date: 1, totalLiquidityUSD: "100" }, { date: 2, totalLiquidityUSD: 90 }] }),
        DefiLlamaProtocolV1,
      ),
    ).toThrow(/schema v1/);
    expect(() =>
      parseProviderResponse(
        "DeFiLlama",
        json({ name: "Example Protocol", history: valid.tvl }),
        DefiLlamaProtocolV1,
      ),
    ).toThrow(/schema v1/);
  });

  it.each([
    ["CoinGecko", CoinGeckoStablecoinV1, { "usd-coin": { usd: 1 } }],
    ["CoinGecko", CoinGeckoMarketV1, { stellar: { usd: 1, usd_24h_change: 0 } }],
    ["Horizon", HorizonLedgerV1, { _embedded: { records: [{ sequence: 1, closed_at: "2026-10-21T08:00:00Z" }] } }],
    ["DeFiLlama", DefiLlamaProtocolV1, { tvl: [{ date: 1, totalLiquidityUSD: 1 }, { date: 2, totalLiquidityUSD: 2 }] }],
  ])("rejects an oversized %s response before parsing", (provider, schema, body) => {
    const oversized = `${json(body)}${" ".repeat(MAX_ORACLE_RESPONSE_BYTES)}`;
    expect(() => parseProviderResponse(provider, oversized, schema)).toThrow(/exceeds/);
  });
});
