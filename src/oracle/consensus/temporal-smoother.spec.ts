import { SourceObservation } from "../adapters/source-adapter";
import { TemporalSmoother } from "./temporal-smoother";

const MIN = 60_000;
const clock = { t: 100 * MIN };

function obs(value: number, observedAt: number, sourceId = "coingecko"): SourceObservation {
  return {
    sourceId,
    trustTier: "live",
    metric: "usdc.usd.price",
    value,
    observedAt,
    fetchedAt: observedAt,
    hasUpstreamTimestamp: true,
    evidence: { url: "u", status: 200, bodySha256: "h", bytes: 1, excerpt: "", capturedAt: observedAt },
  };
}

function smoother() {
  return new TemporalSmoother({ windowMs: 15 * MIN, minSamples: 3, minSpanMs: 2 * MIN, maxSamples: 60, now: () => clock.t });
}

describe("TemporalSmoother", () => {
  beforeEach(() => {
    clock.t = 100 * MIN;
  });

  it("is not ready until it has enough distinct samples over enough time", () => {
    const s = smoother();
    expect(s.smooth(obs(1, clock.t - 4 * MIN))).toMatchObject({ ready: false, samples: 1 });
    expect(s.smooth(obs(1, clock.t - 3 * MIN))).toMatchObject({ ready: false, samples: 2 });
    expect(s.smooth(obs(1, clock.t - MIN))).toMatchObject({ ready: true, samples: 3, spanMs: 3 * MIN });

    const burst = smoother();
    burst.ingest(obs(1, clock.t - 3000));
    burst.ingest(obs(1, clock.t - 2000));
    const r = burst.smooth(obs(1, clock.t - 1000));
    expect(r).toMatchObject({ ready: false, samples: 3 });
    expect(r.reason).toMatch(/span/);
  });

  it("ignores a one-off spike: the window median does not move", () => {
    const s = smoother();
    for (let i = 10; i >= 2; i--) s.ingest(obs(1.0, clock.t - i * MIN));
    const spike = s.smooth(obs(0.5, clock.t - MIN));
    expect(spike.latest).toBe(0.5);
    expect(spike.value).toBe(1.0);
  });

  it("follows a sustained move once it dominates the window", () => {
    const s = smoother();
    for (let i = 10; i >= 6; i--) s.ingest(obs(1.0, clock.t - i * MIN));
    for (let i = 5; i >= 1; i--) s.ingest(obs(0.9, clock.t - i * MIN));
    expect(s.smooth(obs(0.9, clock.t)).value).toBe(0.9);
  });

  it("counts a repeated cached response (same upstream timestamp) once and keeps its first value", () => {
    const s = smoother();
    const at = clock.t - MIN;
    s.ingest(obs(1.0, at));
    s.ingest(obs(1.0, at));
    s.ingest(obs(0.1, at)); // replay with a different body
    expect(s.windowSize("coingecko", "usdc.usd.price")).toBe(1);
    expect(s.smooth(obs(1.0, at)).latest).toBe(1.0);
  });

  it("drops samples older than the window and caps window size", () => {
    const s = smoother();
    s.ingest(obs(0.1, clock.t - 20 * MIN));
    s.ingest(obs(1, clock.t - 5 * MIN));
    expect(s.windowSize("coingecko", "usdc.usd.price")).toBe(1);

    const capped = new TemporalSmoother({ windowMs: 60 * MIN, minSamples: 1, minSpanMs: 0, maxSamples: 3, now: () => clock.t });
    for (let i = 10; i >= 1; i--) capped.ingest(obs(i, clock.t - i * MIN));
    expect(capped.windowSize("coingecko", "usdc.usd.price")).toBe(3);
  });

  it("keeps separate windows per source", () => {
    const s = smoother();
    s.ingest(obs(1, clock.t - 5 * MIN, "a"));
    s.ingest(obs(1, clock.t - 4 * MIN, "b"));
    expect(s.windowSize("a", "usdc.usd.price")).toBe(1);
    expect(s.windowSize("b", "usdc.usd.price")).toBe(1);
  });
});
