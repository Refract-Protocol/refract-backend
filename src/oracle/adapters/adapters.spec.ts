import { AxiosInstance } from "axios";
import { createHash } from "crypto";
import { CoinGeckoAdapter } from "./coingecko.adapter";
import { DefiLlamaAdapter } from "./defillama.adapter";
import { HorizonAdapter } from "./horizon.adapter";
import { AdapterSchemaError } from "./source-adapter";

/** Minimal axios stand-in: returns `body` as text for any GET and records calls. */
function fakeHttp(body: unknown, status = 200) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const calls: Array<{ url: string; params?: Record<string, unknown> }> = [];
  const http = {
    get: jest.fn(async (url: string, config: { params?: Record<string, unknown> }) => {
      calls.push({ url, params: config.params });
      return { status, data: text };
    }),
    getUri: ({ url, params }: { url: string; params?: Record<string, unknown> }) =>
      params ? `${url}?${new URLSearchParams(params as Record<string, string>).toString()}` : url,
  } as unknown as AxiosInstance;
  return { http, calls, text };
}

const ctx = { timeoutMs: 1000 };

describe("CoinGeckoAdapter", () => {
  it("parses USDC price with upstream timestamp and captures evidence", async () => {
    const { http, calls, text } = fakeHttp({ "usd-coin": { usd: 0.9991, last_updated_at: 1_700_000_000 } });
    const adapter = new CoinGeckoAdapter("https://cg.test", http);

    const raw = await adapter.fetch({ metric: "usdc.usd.price" }, ctx);

    expect(raw.value).toBe(0.9991);
    expect(raw.observedAt).toBe(1_700_000_000_000);
    expect(calls[0].url).toBe("https://cg.test/simple/price");
    expect(calls[0].params).toMatchObject({ ids: "usd-coin", include_last_updated_at: true });
    expect(raw.evidence.bodySha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect(raw.evidence.status).toBe(200);
    expect(raw.evidence.url).toContain("ids=usd-coin");
  });

  it("parses XLM 24h change", async () => {
    const { http, calls } = fakeHttp({ stellar: { usd: 0.1, usd_24h_change: -12.5, last_updated_at: 1 } });
    const raw = await new CoinGeckoAdapter("https://cg.test", http).fetch({ metric: "xlm.usd.change_24h_pct" }, ctx);
    expect(raw.value).toBe(-12.5);
    expect(calls[0].params).toMatchObject({ ids: "stellar", include_24hr_change: true });
  });

  it("raises a schema error when the field is missing or not numeric", async () => {
    const { http } = fakeHttp({ "usd-coin": { usd: "1.0" } });
    await expect(new CoinGeckoAdapter("x", http).fetch({ metric: "usdc.usd.price" }, ctx)).rejects.toBeInstanceOf(
      AdapterSchemaError,
    );
  });
});

describe("HorizonAdapter", () => {
  it("returns the latest ledger sequence timestamped by close time", async () => {
    const { http } = fakeHttp({ _embedded: { records: [{ sequence: 123, closed_at: "2026-01-01T00:00:00Z" }] } });
    const raw = await new HorizonAdapter("https://h.test", http).fetch({ metric: "stellar.ledger.latest" }, ctx);
    expect(raw.value).toBe(123);
    expect(raw.observedAt).toBe(Date.parse("2026-01-01T00:00:00Z"));
  });

  it("rejects an empty ledger page", async () => {
    const { http } = fakeHttp({ _embedded: { records: [] } });
    await expect(
      new HorizonAdapter("https://h.test", http).fetch({ metric: "stellar.ledger.latest" }, ctx),
    ).rejects.toBeInstanceOf(AdapterSchemaError);
  });
});

describe("DefiLlamaAdapter", () => {
  const day = 86_400;
  it("computes the trailing 24h TVL change against the last point at least a day old", async () => {
    const { http, calls } = fakeHttp({
      name: "Aave",
      tvl: [
        { date: 1000, totalLiquidityUSD: 100 },
        { date: 1000 + day, totalLiquidityUSD: 200 },
        { date: 1000 + day + 3600, totalLiquidityUSD: 150 },
        { date: 1000 + 2 * day, totalLiquidityUSD: 100 },
      ],
    });
    const raw = await new DefiLlamaAdapter("https://l.test", "aave", http).fetch(
      { metric: "protocol.tvl.change_24h_pct" },
      ctx,
    );
    expect(raw.value).toBeCloseTo(-50);
    expect(raw.observedAt).toBe((1000 + 2 * day) * 1000);
    expect(raw.context).toEqual({ protocol: "Aave" });
    expect(calls[0].url).toBe("https://l.test/protocol/aave");
  });

  it("honours a per-request subject slug", async () => {
    const { http, calls } = fakeHttp({ tvl: [{ date: 0, totalLiquidityUSD: 1 }, { date: day, totalLiquidityUSD: 1 }] });
    await new DefiLlamaAdapter("https://l.test", "aave", http).fetch(
      { metric: "protocol.tvl.change_24h_pct", subject: "blend" },
      ctx,
    );
    expect(calls[0].url).toBe("https://l.test/protocol/blend");
  });

  it("rejects insufficient history and non-positive reference TVL", async () => {
    const short = fakeHttp({ tvl: [{ date: 0, totalLiquidityUSD: 1 }] });
    await expect(
      new DefiLlamaAdapter("x", "aave", short.http).fetch({ metric: "protocol.tvl.change_24h_pct" }, ctx),
    ).rejects.toBeInstanceOf(AdapterSchemaError);
    const zero = fakeHttp({ tvl: [{ date: 0, totalLiquidityUSD: 0 }, { date: day, totalLiquidityUSD: 5 }] });
    await expect(
      new DefiLlamaAdapter("x", "aave", zero.http).fetch({ metric: "protocol.tvl.change_24h_pct" }, ctx),
    ).rejects.toBeInstanceOf(AdapterSchemaError);
  });
});
