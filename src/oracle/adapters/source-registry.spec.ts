import { AdapterSchemaError, MetricId, OracleSourceAdapter, RawObservation } from "./source-adapter";
import { OracleObservabilitySink, OracleSourceRegistry } from "./source-registry";

const evidence = { url: "u", status: 200, bodySha256: "h", bytes: 1, excerpt: "{}", capturedAt: 0 };

function adapter(
  id: string,
  impl: () => Promise<Partial<RawObservation>> | Partial<RawObservation>,
  metrics: MetricId[] = ["usdc.usd.price"],
  trustTier: "live" | "mock" = "live",
): OracleSourceAdapter & { fetch: jest.Mock } {
  return {
    id,
    displayName: id,
    trustTier,
    metrics,
    fetch: jest.fn(async () => ({ evidence, ...(await impl()) }) as RawObservation),
  };
}

function setup(now = { t: 1_000_000 }) {
  const sink: jest.Mocked<OracleObservabilitySink> = {
    recordSourceObservation: jest.fn(),
    recordQuarantine: jest.fn(),
  };
  const registry = new OracleSourceRegistry({
    timeoutMs: 100,
    quarantineAfterFailures: 2,
    quarantineMs: 60_000,
    now: () => now.t,
    sink,
  });
  return { registry, sink, now };
}

describe("OracleSourceRegistry", () => {
  it("fans out to every adapter for the metric and canonicalizes values", async () => {
    const { registry, now } = setup();
    registry
      .register(adapter("a", () => ({ value: 0.99912345678, observedAt: now.t - 1000 })))
      .register(adapter("b", () => ({ value: 1.0000001, observedAt: now.t })))
      .register(adapter("other", () => ({ value: 5 }), ["xlm.usd.change_24h_pct"]));

    const results = await registry.observe({ metric: "usdc.usd.price" });

    expect(results).toHaveLength(2);
    const values = results.map((r) => (r.ok ? r.observation.value : null));
    expect(values).toEqual([0.999123, 1]);
    expect(results.every((r) => r.ok && r.observation.evidence === evidence)).toBe(true);
  });

  it("rejects duplicate registration", () => {
    const { registry } = setup();
    registry.register(adapter("a", () => ({ value: 1 })));
    expect(() => registry.register(adapter("a", () => ({ value: 1 })))).toThrow(/already registered/);
  });

  it("rejects stale observations", async () => {
    const { registry, now } = setup();
    registry.register(adapter("a", () => ({ value: 1, observedAt: now.t - 11 * 60_000 })));
    const [r] = await registry.observe({ metric: "usdc.usd.price" });
    expect(r).toMatchObject({ ok: false, reason: "stale" });
  });

  it("rejects future-dated, non-finite and out-of-bounds values", async () => {
    const { registry, now } = setup();
    registry
      .register(adapter("future", () => ({ value: 1, observedAt: now.t + 60_000 })))
      .register(adapter("nan", () => ({ value: NaN })))
      .register(adapter("big", () => ({ value: 50 })));
    const results = await registry.observe({ metric: "usdc.usd.price" });
    expect(results.map((r) => !r.ok && r.reason)).toEqual(["invalid", "invalid", "invalid"]);
  });

  it("falls back to fetch time when upstream has no timestamp and flags it", async () => {
    const { registry, now } = setup();
    registry.register(adapter("a", () => ({ value: 1 })));
    const [r] = await registry.observe({ metric: "usdc.usd.price" });
    expect(r.ok && r.observation).toMatchObject({ observedAt: now.t, hasUpstreamTimestamp: false });
  });

  it("quarantines after consecutive fetch errors, then probes again after the cooldown", async () => {
    const { registry, sink, now } = setup();
    let fail = true;
    const a = adapter("a", () => {
      if (fail) throw new Error("ECONNRESET");
      return { value: 1, observedAt: now.t };
    });
    registry.register(a);

    expect((await registry.observe({ metric: "usdc.usd.price" }))[0]).toMatchObject({ reason: "fetch_error" });
    expect((await registry.observe({ metric: "usdc.usd.price" }))[0]).toMatchObject({ reason: "fetch_error" });
    expect(sink.recordQuarantine).toHaveBeenCalledTimes(1);

    expect((await registry.observe({ metric: "usdc.usd.price" }))[0]).toMatchObject({ reason: "quarantined" });
    expect(a.fetch).toHaveBeenCalledTimes(2);

    now.t += 60_001;
    fail = false;
    const [probe] = await registry.observe({ metric: "usdc.usd.price" });
    expect(probe.ok).toBe(true);
    expect(registry.healthSnapshot()[0]).toMatchObject({ consecutiveFailures: 0, quarantinedUntil: null });
  });

  it("quarantines immediately on a schema violation", async () => {
    const { registry } = setup();
    registry.register(
      adapter("a", () => {
        throw new AdapterSchemaError("a", "bad");
      }),
    );
    expect((await registry.observe({ metric: "usdc.usd.price" }))[0]).toMatchObject({ reason: "invalid" });
    expect((await registry.observe({ metric: "usdc.usd.price" }))[0]).toMatchObject({ reason: "quarantined" });
  });

  it("notifies subscribers of every successful observation and isolates a throwing listener", async () => {
    const { registry, now } = setup();
    registry
      .register(adapter("a", () => ({ value: 1, observedAt: now.t })))
      .register(adapter("b", () => ({ value: NaN })));
    const seen: string[] = [];
    registry.subscribe(() => {
      throw new Error("bad listener");
    });
    const unsubscribe = registry.subscribe((o) => seen.push(o.sourceId));
    await registry.observe({ metric: "usdc.usd.price" });
    expect(seen).toEqual(["a"]);
    unsubscribe();
    await registry.observe({ metric: "usdc.usd.price" });
    expect(seen).toEqual(["a"]);
  });

  it("emits an observability event for every outcome and survives a throwing sink", async () => {
    const { registry, sink, now } = setup();
    registry.register(adapter("a", () => ({ value: 1, observedAt: now.t })));
    sink.recordSourceObservation.mockImplementationOnce(() => {
      throw new Error("sink down");
    });
    const [r] = await registry.observe({ metric: "usdc.usd.price" });
    expect(r.ok).toBe(true);
    expect(sink.recordSourceObservation).toHaveBeenCalledWith("a", "usdc.usd.price", "ok", expect.any(Number));
  });
});
