import { MetricId, OracleSourceAdapter, RawObservation } from "./adapters/source-adapter";
import { OracleSourceRegistry } from "./adapters/source-registry";
import { OracleService } from "./oracle.service";

const evidence = { url: "u", status: 200, bodySha256: "h", bytes: 1, excerpt: "{}", capturedAt: 0 };

function stubAdapter(id: string, values: Partial<Record<MetricId, number | Error>>): OracleSourceAdapter {
  return {
    id,
    displayName: id,
    trustTier: "live",
    metrics: Object.keys(values) as MetricId[],
    fetch: async ({ metric }): Promise<RawObservation> => {
      const v = values[metric];
      if (v instanceof Error) throw v;
      return { value: v as number, observedAt: Date.now(), evidence };
    },
  };
}

function service(...adapters: OracleSourceAdapter[]) {
  const registry = new OracleSourceRegistry({ timeoutMs: 100, quarantineAfterFailures: 3, quarantineMs: 0 });
  adapters.forEach((a) => registry.register(a));
  return new OracleService(registry);
}

describe("OracleService (registry-backed)", () => {
  it("builds a StablecoinDepeg reading with source attribution and evidence", async () => {
    const svc = service(stubAdapter("coingecko", { "usdc.usd.price": 0.97 }));
    const r = await svc.checkStablecoinDepeg();
    expect(r).toMatchObject({ coverageType: "StablecoinDepeg", value: 0.97, severity: "high", sources: ["coingecko"] });
    expect(r.observations?.[0].evidence).toBe(evidence);
    expect(r.message).toContain("[coingecko]");
  });

  it("attaches Horizon ledger context to MarketCrash without depending on it", async () => {
    const withLedger = service(
      stubAdapter("coingecko", { "xlm.usd.change_24h_pct": -31 }),
      stubAdapter("horizon", { "stellar.ledger.latest": 42 }),
    );
    const r = await withLedger.checkMarketCrash();
    expect(r).toMatchObject({ value: -31, severity: "triggered", sources: ["coingecko", "horizon"] });
    expect(r.message).toContain("ledger #42");

    const horizonDown = service(
      stubAdapter("coingecko", { "xlm.usd.change_24h_pct": -5 }),
      stubAdapter("horizon", { "stellar.ledger.latest": new Error("down") }),
    );
    const r2 = await horizonDown.checkMarketCrash();
    expect(r2).toMatchObject({ severity: "low", sources: ["coingecko"] });
    expect(r2.degraded).toBeUndefined();
  });

  it("builds SmartContractRisk from DeFiLlama", async () => {
    const r = await service(stubAdapter("defillama", { "protocol.tvl.change_24h_pct": -60 })).checkSmartContractRisk();
    expect(r).toMatchObject({ value: -60, severity: "triggered", sources: ["defillama"] });
  });

  it("degrades to a non-triggering reading when every source fails", async () => {
    const r = await service(stubAdapter("coingecko", { "usdc.usd.price": new Error("timeout") })).checkStablecoinDepeg();
    expect(r).toMatchObject({ degraded: true, severity: "low", value: 0.95, threshold: 0.95 });
    expect(r.message).toContain("coingecko: fetch_error");
  });

  it("checkAll reuses a fresh snapshot; checkAllFresh re-observes", async () => {
    const adapter = stubAdapter("s", {
      "usdc.usd.price": 1,
      "xlm.usd.change_24h_pct": 0,
      "protocol.tvl.change_24h_pct": 0,
    });
    const spy = jest.spyOn(adapter, "fetch");
    const svc = service(adapter);
    await svc.checkAll();
    await svc.checkAll();
    expect(spy).toHaveBeenCalledTimes(3);
    await svc.checkAllFresh();
    expect(spy).toHaveBeenCalledTimes(6);
  });
});
