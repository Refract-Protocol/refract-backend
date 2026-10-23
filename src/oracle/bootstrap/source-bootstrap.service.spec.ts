import {
  HistoricalSample,
  SEED_REPUTATION_CAP,
  cleanSamples,
  computeBaseline,
  corroborationRate,
  deviationScore,
  historyCoverage,
  seedReputation,
} from "./baseline";
import { InMemoryBootstrapStore, PgBootstrapStore, SqlQueryable } from "./bootstrap.store";
import {
  CoinGeckoHistoryProvider,
  DefiLlamaHistoryProvider,
  HistoricalReadingProvider,
  HistoryProviderRegistry,
  HistoryRequest,
} from "./history-providers";
import { SourceBootstrapService } from "./source-bootstrap.service";
import { parseArgs, parseSourceSpec, runBootstrapCli } from "./bootstrap.cli";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 1);
const LOOKBACK = 48 * HOUR;

/** Hourly series over the lookback window, value = base + wobble(i). */
function series(base: number, wobble: (i: number) => number = () => 0, count = 48): HistoricalSample[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: NOW - LOOKBACK + i * HOUR + HOUR / 2,
    value: base + wobble(i),
  }));
}

class FakeProvider implements HistoricalReadingProvider {
  readonly calls: HistoryRequest[] = [];
  constructor(
    readonly adapter: string,
    private readonly bySource: Record<string, HistoricalSample[] | Error>
  ) {}
  async fetchHistory(request: HistoryRequest): Promise<HistoricalSample[]> {
    this.calls.push(request);
    const result = this.bySource[request.sourceId];
    if (result instanceof Error) throw result;
    return result ?? [];
  }
}

function setup(bySource: Record<string, HistoricalSample[] | Error>) {
  const store = new InMemoryBootstrapStore();
  const provider = new FakeProvider("fake", bySource);
  const service = new SourceBootstrapService(store, new HistoryProviderRegistry([provider]), {
    now: () => NOW,
  });
  const opts = { lookbackMs: LOOKBACK, expectedIntervalMs: HOUR, minSamples: 24 };
  return { store, provider, service, opts };
}

describe("baseline statistics", () => {
  it("cleans non-finite values, duplicate timestamps, and ordering", () => {
    expect(
      cleanSamples([
        { timestamp: 3, value: 3 },
        { timestamp: 1, value: Number.NaN },
        { timestamp: 2, value: 2 },
        { timestamp: 2, value: 2.5 },
        { timestamp: Number.POSITIVE_INFINITY, value: 1 },
      ])
    ).toEqual([
      { timestamp: 2, value: 2.5 },
      { timestamp: 3, value: 3 },
    ]);
  });

  it("computes robust and classical statistics", () => {
    const baseline = computeBaseline([1, 2, 3, 4, 100].map((value, i) => ({ timestamp: i, value })));
    expect(baseline.median).toBe(3);
    expect(baseline.mean).toBe(22);
    expect(baseline.min).toBe(1);
    expect(baseline.max).toBe(100);
    // The outlier inflates stddev but barely moves MAD.
    expect(baseline.mad).toBeCloseTo(1.4826, 4);
    expect(baseline.stddev).toBeGreaterThan(40);
  });

  it("refuses to compute a baseline from no samples", () => {
    expect(() => computeBaseline([])).toThrow(/zero samples/);
  });

  it("scores flat (pegged) histories by relative distance instead of dividing by zero", () => {
    const flat = computeBaseline(series(1));
    expect(deviationScore(flat, 1)).toBe(0);
    expect(deviationScore(flat, 0.99)).toBeCloseTo(10, 5);
  });

  it("measures history coverage against the expected interval", () => {
    expect(historyCoverage(series(1, undefined, 24), LOOKBACK, HOUR)).toBe(0.5);
    expect(historyCoverage(series(1, undefined, 96), LOOKBACK, HOUR)).toBe(1);
  });

  it("reports corroboration against the peer median and null without overlap", () => {
    const own = series(100);
    const peers = [series(100.5), series(99.8)];
    expect(corroborationRate(own, peers, HOUR, 100)).toEqual({ rate: 1, comparedBuckets: 48 });
    expect(corroborationRate(series(110), peers, HOUR, 100)?.rate).toBe(0);
    expect(corroborationRate(own, [], HOUR, 100)).toBeNull();
  });

  it("caps seeded reputation and treats missing peer evidence as neutral", () => {
    expect(seedReputation(1, 1)).toBe(SEED_REPUTATION_CAP);
    expect(seedReputation(1, null)).toBe(0.75);
    expect(seedReputation(0, 0)).toBe(0.2);
  });
});

describe("SourceBootstrapService", () => {
  it("seeds readings, baseline, and reputation for a new source", async () => {
    const { service, store, opts } = setup({ a: series(1, (i) => (i % 2 ? 0.001 : -0.001)) });

    const report = await service.bootstrapSource("depeg", { sourceId: "a", adapter: "fake" }, opts);

    expect(report).toMatchObject({ status: "warm", skipped: false, sampleCount: 48, coverage: 1 });
    expect(report.corroboration).toBeNull();
    expect(report.reputation).toBe(0.75);
    expect(await store.getSeedReadings("depeg", "a")).toHaveLength(48);
  });

  it("corroborates sources of one feed against each other and penalises the outlier", async () => {
    const { service, opts } = setup({
      a: series(1),
      b: series(1.002),
      c: series(1.2),
    });

    const reports = await service.bootstrapFeed(
      "depeg",
      ["a", "b", "c"].map((sourceId) => ({ sourceId, adapter: "fake" })),
      opts
    );

    const bySource = Object.fromEntries(reports.map((r) => [r.sourceId, r]));
    expect(bySource.a.corroboration).toBe(1);
    expect(bySource.b.corroboration).toBe(1);
    expect(bySource.c.corroboration).toBe(0);
    expect(bySource.c.reputation!).toBeLessThan(bySource.a.reputation!);
  });

  it("compares a newly added source with already-warm sources of the feed", async () => {
    const { service, opts } = setup({ a: series(1), b: series(1.001) });
    await service.bootstrapSource("depeg", { sourceId: "a", adapter: "fake" }, opts);

    const report = await service.bootstrapSource("depeg", { sourceId: "b", adapter: "fake" }, opts);

    expect(report.corroboration).toBe(1);
  });

  it("skips warm sources unless forced", async () => {
    const { service, provider, opts } = setup({ a: series(1) });
    await service.bootstrapSource("depeg", { sourceId: "a", adapter: "fake" }, opts);

    const again = await service.bootstrapSource("depeg", { sourceId: "a", adapter: "fake" }, opts);
    expect(again).toMatchObject({ status: "warm", skipped: true });
    expect(provider.calls).toHaveLength(1);

    await service.bootstrapSource("depeg", { sourceId: "a", adapter: "fake" }, { ...opts, force: true });
    expect(provider.calls).toHaveLength(2);
  });

  it("marks sources with too little history and keeps anomaly checks off", async () => {
    const { service, opts } = setup({ a: series(1, undefined, 5) });

    const report = await service.bootstrapSource("depeg", { sourceId: "a", adapter: "fake" }, opts);

    expect(report.status).toBe("insufficient_history");
    expect(report.error).toMatch(/Only 5 usable samples/);
    expect(await service.assess("depeg", "a", 2)).toEqual({ ready: false, status: "insufficient_history" });
  });

  it("records fetch failures and missing providers as failed", async () => {
    const { service, opts } = setup({ a: new Error("429 Too Many Requests") });

    const [failed, unknown] = await service.bootstrapFeed(
      "depeg",
      [
        { sourceId: "a", adapter: "fake" },
        { sourceId: "b", adapter: "nope" },
      ],
      opts
    );

    expect(failed).toMatchObject({ status: "failed", error: "429 Too Many Requests" });
    expect(unknown.error).toMatch(/No history provider registered for adapter "nope"/);
  });

  it("keeps the previous warm baseline when a forced re-run fails", async () => {
    const bySource: Record<string, HistoricalSample[] | Error> = { a: series(1) };
    const { service, store, opts } = setup(bySource);
    await service.bootstrapSource("depeg", { sourceId: "a", adapter: "fake" }, opts);

    bySource.a = new Error("upstream down");
    const report = await service.bootstrapSource("depeg", { sourceId: "a", adapter: "fake" }, { ...opts, force: true });

    expect(report.status).toBe("warm");
    expect(report.error).toBe("upstream down");
    const record = await store.getRecord("depeg", "a");
    expect(record?.baseline?.sampleCount).toBe(48);
    expect(record?.error).toMatch(/Re-bootstrap failed/);
  });

  it("assesses live readings against the seeded baseline once warm", async () => {
    const { service, opts } = setup({ a: series(100, (i) => (i % 4) - 1.5) });
    expect(await service.assess("depeg", "a", 100)).toEqual({ ready: false, status: "cold" });

    await service.bootstrapSource("depeg", { sourceId: "a", adapter: "fake" }, opts);

    const normal = await service.assess("depeg", "a", 101);
    const spike = await service.assess("depeg", "a", 150);
    expect(normal).toMatchObject({ ready: true, anomalous: false });
    expect(spike).toMatchObject({ ready: true, anomalous: true });
  });

  it("drops history older than the lookback window", async () => {
    const stale = series(1).map((s) => ({ ...s, timestamp: s.timestamp - 10 * LOOKBACK }));
    const { service, opts } = setup({ a: [...stale, ...series(1)] });

    const report = await service.bootstrapSource("depeg", { sourceId: "a", adapter: "fake" }, opts);

    expect(report.sampleCount).toBe(48);
  });
});

describe("history providers", () => {
  const request = (params: Record<string, string>): HistoryRequest => ({
    feedId: "f",
    sourceId: "s",
    params,
    from: new Date(NOW - LOOKBACK),
    to: new Date(NOW),
  });

  it("maps CoinGecko market_chart/range prices", async () => {
    const httpGet = jest.fn().mockResolvedValue({ prices: [[NOW - HOUR, 0.999]] });
    const provider = new CoinGeckoHistoryProvider("https://cg.example", httpGet);

    await expect(provider.fetchHistory(request({ coinId: "usd-coin" }))).resolves.toEqual([
      { timestamp: NOW - HOUR, value: 0.999 },
    ]);
    expect(httpGet).toHaveBeenCalledWith("https://cg.example/coins/usd-coin/market_chart/range", {
      vs_currency: "usd",
      from: Math.floor((NOW - LOOKBACK) / 1000),
      to: Math.floor(NOW / 1000),
    });
  });

  it("requires the adapter's source parameter", async () => {
    const provider = new CoinGeckoHistoryProvider("https://cg.example", jest.fn());
    await expect(provider.fetchHistory(request({}))).rejects.toThrow(/needs a "coinId" parameter/);
  });

  it("maps and windows DeFiLlama TVL history", async () => {
    const httpGet = jest.fn().mockResolvedValue({
      tvl: [
        { date: (NOW - 10 * LOOKBACK) / 1000, totalLiquidityUSD: 1 },
        { date: (NOW - HOUR) / 1000, totalLiquidityUSD: 5_000_000 },
      ],
    });
    const provider = new DefiLlamaHistoryProvider("https://llama.example", httpGet);

    await expect(provider.fetchHistory(request({ protocolSlug: "aave" }))).resolves.toEqual([
      { timestamp: NOW - HOUR, value: 5_000_000 },
    ]);
  });

  it("maps DeFiLlama coin price charts for coinId sources", async () => {
    const httpGet = jest.fn().mockResolvedValue({
      coins: { "coingecko:usd-coin": { prices: [{ timestamp: (NOW - HOUR) / 1000, price: 1.0002 }] } },
    });
    const provider = new DefiLlamaHistoryProvider("https://llama.example", httpGet, "https://coins.example");

    await expect(provider.fetchHistory(request({ coinId: "usd-coin" }))).resolves.toEqual([
      { timestamp: NOW - HOUR, value: 1.0002 },
    ]);
    expect(httpGet).toHaveBeenCalledWith("https://coins.example/chart/coingecko%3Ausd-coin", {
      start: Math.floor((NOW - LOOKBACK) / 1000),
      span: 48,
      period: "1h",
    });
  });
});

describe("PgBootstrapStore", () => {
  it("chunks seed inserts below the bind-parameter limit", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const store = new PgBootstrapStore({ query } as unknown as SqlQueryable);

    await store.replaceSeedReadings("f", "s", series(1, undefined, 2_500));

    const inserts = query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO oracle_seed_readings"));
    expect(query.mock.calls[0][0]).toMatch(/DELETE FROM oracle_seed_readings/);
    expect(inserts).toHaveLength(3);
    for (const [, params] of inserts) expect((params as unknown[]).length).toBeLessThanOrEqual(2_002);
  });
});

describe("bootstrap CLI", () => {
  it("parses source specs with adapter parameters", () => {
    expect(parseSourceSpec("cg-usdc:coingecko:coinId=usd-coin,vsCurrency=usd")).toEqual({
      sourceId: "cg-usdc",
      adapter: "coingecko",
      params: { coinId: "usd-coin", vsCurrency: "usd" },
    });
    expect(() => parseSourceSpec("missing-adapter")).toThrow(/Invalid --source/);
  });

  it("requires a feed and at least one source", () => {
    expect(() => parseArgs(["--source", "a:fake"])).toThrow(/--feed is required/);
    expect(() => parseArgs(["--feed", "f"])).toThrow(/At least one --source/);
  });

  it("returns 2 on usage errors, 0 when every source is warm, 1 otherwise", async () => {
    const lines: string[] = [];
    const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
    const providers = new HistoryProviderRegistry([
      new FakeProvider("fake", { a: series(1), b: series(1, undefined, 3) }),
    ]);
    const env = {};

    expect(await runBootstrapCli(["--bogus"], io, env, { providers })).toBe(2);
    expect(
      await runBootstrapCli(
        ["--feed", "f", "--source", "a:fake", "--lookback-days", "3650", "--dry-run"],
        io,
        env,
        { providers, store: new InMemoryBootstrapStore() }
      )
    ).toBe(0);
    expect(
      await runBootstrapCli(["--feed", "f", "--source", "b:fake", "--dry-run"], io, env, {
        providers,
        store: new InMemoryBootstrapStore(),
      })
    ).toBe(1);
    expect(lines.some((l) => l.startsWith("f/a: warm"))).toBe(true);
    expect(lines.some((l) => l.startsWith("f/b: insufficient_history"))).toBe(true);
  });
});
