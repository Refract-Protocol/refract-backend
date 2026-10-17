import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CorroborationEngine } from "./corroboration.ts";

describe("CorroborationEngine (Issue #177)", () => {
  const nowMs = 1_700_000_000_000;

  it("corroborates majority agreement, rejects single outliers, and deduplicates same-source readings", () => {
    const engine = new CorroborationEngine([
      {
        coverageType: "stablecoin_depeg",
        minQuorumSources: 3,
        toleranceBandRatio: 0.02, // 2%
        maxReadingAgeMs: 60_000,
      },
    ]);

    // 3 agreeing sources + 1 wild outlier + 1 duplicate from src-1 -> corroborated with 3 sources
    const res = engine.evaluate(
      "stablecoin_depeg",
      [
        {
          sourceId: "coingecko",
          coverageType: "stablecoin_depeg",
          value: 0.998,
          observedAtMs: nowMs - 10_000,
        },
        {
          sourceId: "coingecko",
          coverageType: "stablecoin_depeg",
          value: 1.0,
          observedAtMs: nowMs - 2_000, // fresher duplicate supersedes older one
        },
        {
          sourceId: "defillama",
          coverageType: "stablecoin_depeg",
          value: 1.005,
          observedAtMs: nowMs - 3_000,
        },
        {
          sourceId: "horizon-sdex",
          coverageType: "stablecoin_depeg",
          value: 0.995,
          observedAtMs: nowMs - 4_000,
        },
        {
          sourceId: "rogue-feed",
          coverageType: "stablecoin_depeg",
          value: 0.5, // 50% off -> rejected as outlier
          observedAtMs: nowMs - 1_000,
        },
      ],
      nowMs
    );

    assert.equal(res.status, "corroborated");
    assert.equal(res.canPublishOnChain, true);
    assert.equal(res.agreedValue, 1.0);
    assert.equal(res.participatingSources.length, 3);
    assert.equal(res.rejectedSources.length, 2);

    const acceptedVals = res.participatingSources.map((s) => s.value);
    assert.ok(
      res.agreedValue! >= Math.min(...acceptedVals) &&
        res.agreedValue! <= Math.max(...acceptedVals)
    );
  });

  it("refuses to publish when readings are stale, quorum is insufficient, or sources split divergently", () => {
    const engine = new CorroborationEngine([
      {
        coverageType: "stablecoin_depeg",
        minQuorumSources: 3,
        toleranceBandRatio: 0.02,
        maxReadingAgeMs: 30_000,
      },
    ]);

    // 1. Stale reading drops fresh source count to 2 (< 3) -> insufficient_quorum
    const staleResult = engine.evaluate(
      "stablecoin_depeg",
      [
        {
          sourceId: "src-1",
          coverageType: "stablecoin_depeg",
          value: 1.0,
          observedAtMs: nowMs - 5_000,
        },
        {
          sourceId: "src-2",
          coverageType: "stablecoin_depeg",
          value: 1.0,
          observedAtMs: nowMs - 5_000,
        },
        {
          sourceId: "src-3",
          coverageType: "stablecoin_depeg",
          value: 1.0,
          observedAtMs: nowMs - 90_000, // stale
        },
      ],
      nowMs
    );
    assert.equal(staleResult.status, "insufficient_quorum");
    assert.equal(staleResult.canPublishOnChain, false);
    assert.equal(staleResult.agreedValue, null);

    // 2. 4 fresh sources split 2 vs 2 across a wide chasm -> divergent
    const splitResult = engine.evaluate(
      "stablecoin_depeg",
      [
        {
          sourceId: "src-1",
          coverageType: "stablecoin_depeg",
          value: 0.8,
          observedAtMs: nowMs - 2_000,
        },
        {
          sourceId: "src-2",
          coverageType: "stablecoin_depeg",
          value: 0.81,
          observedAtMs: nowMs - 2_000,
        },
        {
          sourceId: "src-3",
          coverageType: "stablecoin_depeg",
          value: 1.0,
          observedAtMs: nowMs - 2_000,
        },
        {
          sourceId: "src-4",
          coverageType: "stablecoin_depeg",
          value: 1.01,
          observedAtMs: nowMs - 2_000,
        },
      ],
      nowMs
    );
    assert.equal(splitResult.status, "divergent");
    assert.equal(splitResult.canPublishOnChain, false);
    assert.equal(splitResult.agreedValue, null);
  });
});
