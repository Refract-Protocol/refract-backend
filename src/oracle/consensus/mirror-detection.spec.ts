import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { mirrorBacktest, runOracleOpsCli } from "./cli";
import { canonicalValue, fingerprintReading, loadMirrorDetectionConfig, MirrorDetectionConfig } from "./fingerprint";
import { MirrorDetectionService, planMirrorActions } from "./mirror-detection";
import { reconstructConsensusState } from "./reconstruction";
import { ConsensusHarness } from "./testing/fixtures";

const FEED = "StablecoinDepeg";
const MIN = 60_000;
const cfg: MirrorDetectionConfig = { ...loadMirrorDetectionConfig({}), windowMs: 2 * 60 * MIN };

/** Deterministic pseudo-random walk so tests are reproducible. */
function walk(n: number, seed: number, start = 1, step = 0.002): number[] {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const out = [start];
  for (let i = 1; i < n; i++) out.push(Math.round((out[i - 1] + (rnd() - 0.5) * step) * 1e6) / 1e6);
  return out;
}

function setup(sources = ["coingecko", "kraken", "binance"]) {
  const h = new ConsensusHarness();
  h.seedFeed(FEED, sources);
  const mirrors = new MirrorDetectionService(h.ledger, cfg);
  const t0 = h.nowMs;
  /** Feeds one value per minute per source; `values[source][i]` at minute i. */
  const feed = (values: Record<string, (number | undefined)[]>, opts: { feedId?: string; offsetMs?: Record<string, number> } = {}) => {
    const n = Math.max(...Object.values(values).map((v) => v.length));
    for (let i = 0; i < n; i++) {
      for (const [src, vs] of Object.entries(values)) {
        const v = vs[i];
        if (v === undefined) continue;
        h.consensus.recordReading({
          feedId: opts.feedId ?? FEED,
          sourceId: src,
          value: v,
          observedAt: t0 + i * MIN + 5_000 + (opts.offsetMs?.[src] ?? 0),
          rawPayload: JSON.stringify({ src, v, i }),
        });
      }
    }
    h.nowMs = t0 + n * MIN;
  };
  return { h, mirrors, feed };
}

describe("fingerprinting", () => {
  it("ignores cosmetic differences but not real ones", () => {
    expect(canonicalValue(0.1 + 0.2)).toBe(0.3);
    expect(fingerprintReading(FEED, 0.91, 1_000, MIN)).toBe(fingerprintReading(FEED, 0.9100000000001, 59_000, MIN));
    expect(fingerprintReading(FEED, 0.91, 1_000, MIN)).not.toBe(fingerprintReading(FEED, 0.911, 1_000, MIN));
    expect(fingerprintReading(FEED, 0.91, 1_000, MIN)).not.toBe(fingerprintReading("MarketCrash", 0.91, 1_000, MIN));
  });

  it("stores a fingerprint on every ingested reading", () => {
    const { h } = setup();
    const r = h.read("coingecko", 0.99);
    expect(r.fingerprint).toBe(fingerprintReading(FEED, 0.99, r.observedAt, cfg.bucketMs));
  });
});

describe("mirror detection", () => {
  it("flags an exact mirror and reduces its weight in consensus", () => {
    const { h, mirrors, feed } = setup();
    const base = walk(60, 7);
    feed({ coingecko: base, kraken: walk(60, 99), binance: base });

    expect(mirrors.scan()).toEqual({ applied: 1, cleared: 0 });
    const [p] = mirrors.trustStatus().feeds[0].suspectedMirrors;
    expect(p).toMatchObject({ sourceA: "binance", sourceB: "coingecko", lagBuckets: 0, matchRatio: 1 });
    expect(p.exactMatches).toBeGreaterThan(50);
    expect(p.evidence.length).toBeGreaterThan(0);

    const result = h.consensus.evaluate(FEED, h.ledger.now());
    const coingecko = result.eligibility.find((e) => e.sourceId === "coingecko")!;
    expect(coingecko).toMatchObject({ independent: false, mirrorOf: "binance", effectiveWeight: cfg.penaltyFactor });
    expect(h.ledger.events().some((e) => e.kind === "audit" && e.action === "mirror_detection.penalty_applied")).toBe(true);
  });

  it("is idempotent: a second scan applies nothing new", () => {
    const { mirrors, feed } = setup();
    const base = walk(60, 7);
    feed({ coingecko: base, kraken: walk(60, 99), binance: base });
    mirrors.scan();
    expect(mirrors.scan()).toEqual({ applied: 0, cleared: 0 });
  });

  it("flags a near-mirror within tolerance that is delayed and jittered", () => {
    const { mirrors, feed } = setup();
    const base = walk(60, 11);
    const delayed = [undefined, ...base.map((v, i) => v * (1 + (i % 2 ? 1e-6 : -1e-6)))];
    feed({ coingecko: base, kraken: walk(60, 5), binance: delayed }, { offsetMs: { binance: 20_000 } });
    mirrors.scan();
    const [p] = mirrors.trustStatus().feeds[0].suspectedMirrors;
    expect(p).toMatchObject({ sourceA: "binance", sourceB: "coingecko" });
    expect(Math.abs(p.lagBuckets)).toBe(1);
  });

  it("does not penalise legitimate agreement on a flat feed", () => {
    const { mirrors, feed } = setup();
    const flat = Array(60).fill(1);
    feed({ coingecko: flat, kraken: flat, binance: flat });
    expect(mirrors.scan().applied).toBe(0);
  });

  it("does not penalise independent sources that track the same market with their own noise", () => {
    const { mirrors, feed } = setup();
    const market = walk(60, 3, 1, 0.01);
    const noisy = (seed: number) => market.map((v, i) => v + (walk(60, seed, 0, 0.002)[i]));
    feed({ coingecko: noisy(21), kraken: noisy(22), binance: noisy(23) });
    expect(mirrors.scan().applied).toBe(0);
  });

  it("does not penalise low-cardinality categorical feeds that agree", () => {
    const { mirrors, feed } = setup();
    const toggles = Array.from({ length: 60 }, (_, i) => (Math.floor(i / 3) % 2 ? 1 : 0));
    feed({ coingecko: toggles, kraken: toggles, binance: toggles });
    expect(mirrors.scan().applied).toBe(0);
  });

  it("does not compare sources across different feeds", () => {
    const { h, mirrors, feed } = setup(["coingecko", "kraken"]);
    h.consensus.registerSource({ sourceId: "mc-src", providerId: "x", feedId: "MarketCrash", weight: 1, retentionDays: 1 });
    h.consensus.setQuorumPolicy({ feedId: "MarketCrash", minSources: 1, minTotalWeight: 0, maxReadingAgeMs: MIN, trigger: { op: "lt", threshold: 0 } });
    const base = walk(60, 13);
    feed({ coingecko: base, kraken: walk(60, 14) });
    feed({ "mc-src": base }, { feedId: "MarketCrash" });
    expect(mirrors.scan().applied).toBe(0);
  });

  it("clears the penalty once the pair has diverged over enough movement", () => {
    const { mirrors, feed } = setup();
    const base = walk(60, 7);
    feed({ coingecko: base, kraken: walk(60, 99), binance: base });
    mirrors.scan();
    feed({ coingecko: walk(180, 31), kraken: walk(180, 32), binance: walk(180, 33) });
    expect(mirrors.scan()).toEqual({ applied: 0, cleared: 1 });
    expect(mirrors.trustStatus().feeds[0].suspectedMirrors).toHaveLength(0);
  });

  it("drops the feed below quorum when only a mirror pair remains", () => {
    const { h, mirrors, feed } = setup(["coingecko", "binance"]);
    const base = walk(60, 7);
    feed({ coingecko: base, binance: base });
    mirrors.scan();
    const d = h.consensus.decide(FEED);
    expect(d.outcome).toBe("no_decision");
    expect(d.reason).toMatch(/1 independent eligible source\(s\) \(\+1 suspected mirror\)/);
  });

  it("is replayed by reconstruction: before the penalty full weight, after it reduced", () => {
    const { h, mirrors, feed } = setup();
    const base = walk(60, 7).map((v) => v - 0.1);
    feed({ coingecko: base, kraken: walk(60, 99).map((v) => v - 0.1), binance: base });
    const before = h.consensus.decide(FEED);
    mirrors.scan();
    const after = h.consensus.decide(FEED);

    for (const d of [before, after]) {
      expect(reconstructConsensusState(h.ledger.events(), { feedId: FEED, at: d.at }).consistency).toBe("matches_recorded");
    }
    expect(before.contributing.every((c) => c.independent)).toBe(true);
    expect(after.contributing.find((c) => c.sourceId === "coingecko")).toMatchObject({ independent: false });
    expect(reconstructConsensusState(h.ledger.events(), { feedId: FEED, at: after.at }).independencePenalties).toHaveLength(1);
  });

  it("does not let a mirror pair satisfy expectedSources for a payout", () => {
    const { h, mirrors, feed } = setup();
    const base = walk(60, 7).map((v) => v - 0.2);
    feed({ coingecko: base, kraken: walk(60, 99).map((v) => v - 0.2), binance: base });
    mirrors.scan();
    const gate = h.holds.gate({ policyId: "p", holder: "G", feedId: FEED, policyExpiresAt: h.nowMs + 86_400_000 });
    expect(gate.action).toBe("block");
    expect(h.holds.list()[0].gaps).toEqual([expect.objectContaining({ type: "insufficient_sources", detail: expect.stringMatching(/suspected mirror/) })]);
  });

  it("reports metrics", () => {
    const { h, feed } = setup();
    const metrics = { recordSuspectedMirrorPairs: jest.fn(), recordMirrorPenaltyChange: jest.fn() };
    const mirrors = new MirrorDetectionService(h.ledger, cfg, metrics as never);
    const base = walk(60, 7);
    feed({ coingecko: base, kraken: walk(60, 99), binance: base });
    mirrors.scan();
    expect(metrics.recordMirrorPenaltyChange).toHaveBeenCalledWith(FEED, "applied");
    expect(metrics.recordSuspectedMirrorPairs).toHaveBeenCalledWith(FEED, 1);
  });
});

describe("mirror backtest", () => {
  it("reports which pairs would be penalised, without writing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-"));
    const ledgerPath = path.join(dir, "evidence.jsonl");
    const h = new ConsensusHarness({ ledgerPath });
    h.seedFeed(FEED, ["coingecko", "kraken", "binance"]);
    const t0 = h.nowMs;
    const base = walk(240, 7);
    const other = walk(240, 8);
    for (let i = 0; i < 240; i++) {
      for (const [src, v] of [["coingecko", base[i]], ["kraken", other[i]], ["binance", base[i]]] as const) {
        h.consensus.recordReading({ feedId: FEED, sourceId: src, value: v, observedAt: t0 + i * MIN, rawPayload: `${src}${i}` });
      }
    }
    const size = fs.statSync(ledgerPath).size;
    const env = { MIRROR_WINDOW_MS: String(2 * 60 * MIN) };
    const out = runOracleOpsCli(["mirror-backtest", "--ledger-file", ledgerPath], { env, readFile: (p) => fs.readFileSync(p, "utf8") });
    expect(out.exitCode).toBe(0);
    const report = JSON.parse(out.stdout).feeds[0];
    expect(report.wouldPenalise).toBe(1);
    expect(report.pairs.find((p: { wouldPenalise: boolean }) => p.wouldPenalise)).toMatchObject({ sourceA: "binance", sourceB: "coingecko" });
    expect(fs.statSync(ledgerPath).size).toBe(size);
    expect(mirrorBacktest(h.ledger.events() as never, { feed: "Nope" }, env).feeds[0].readings).toBe(0);
    expect(planMirrorActions(h.ledger.events(), FEED, t0 + 240 * MIN, cfg).apply).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
