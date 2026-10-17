import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CompositeFeedRegistry,
  type CompositeFeedDefinition,
  type UpstreamConsensusDecision,
} from "./compositeFeeds.ts";

const SCALE = 10_000n; // 4 decimals (bps)

test("Issue #298: evaluates composite feeds deterministically, supports historical version replay, and guards against divide-by-zero", () => {
  const registry = new CompositeFeedRegistry();

  // Version 1: TVL Ratio = (PoolTvl / TotalProtocolTvl)
  const v1Def: CompositeFeedDefinition = {
    feedId: "TvlConcentrationRatio",
    version: 1,
    unit: "ratio_bps",
    scaleDecimals: 4,
    roundingMode: "half_up",
    inputs: [
      { feedId: "PoolTvl", maxFreshnessAgeMs: 60_000 },
      { feedId: "TotalProtocolTvl", maxFreshnessAgeMs: 60_000 },
    ],
    formula: {
      kind: "binary",
      op: "div",
      left: { kind: "input", feedId: "PoolTvl" },
      right: { kind: "input", feedId: "TotalProtocolTvl" },
    },
  };

  // Version 2: adds a 100 bps risk buffer to the ratio
  const v2Def: CompositeFeedDefinition = {
    ...v1Def,
    version: 2,
    formula: {
      kind: "binary",
      op: "add",
      left: v1Def.formula,
      right: { kind: "constant", valueScaled: 100n },
    },
  };

  registry.registerCompositeFeed(v1Def);
  registry.registerCompositeFeed(v2Def);

  const now = 1_750_000_000_000;
  const upstream: Record<string, UpstreamConsensusDecision> = {
    PoolTvl: {
      feedId: "PoolTvl",
      decisionId: "dec_pool_1",
      valueScaled: 1_000n * SCALE,
      decidedAtMs: now - 10_000,
      trustState: "healthy",
    },
    TotalProtocolTvl: {
      feedId: "TotalProtocolTvl",
      decisionId: "dec_total_1",
      valueScaled: 3_000n * SCALE,
      decidedAtMs: now - 10_000,
      trustState: "healthy",
    },
  };

  // Active version is v2: (1000 / 3000) * 10000 + 100 = 3333 + 100 = 3433 bps
  const activeEval = registry.evaluateComposite("TvlConcentrationRatio", upstream, now);
  assert.equal(activeEval.formulaVersion, 2);
  assert.equal(activeEval.status, "healthy");
  assert.equal(activeEval.computedValueScaled, 3_433n);
  assert.deepEqual(activeEval.inputDecisionIds, {
    PoolTvl: "dec_pool_1",
    TotalProtocolTvl: "dec_total_1",
  });

  // Historical replay against explicitVersion=1 produces 3333 bps byte-for-byte
  const replayV1 = registry.evaluateComposite("TvlConcentrationRatio", upstream, now, 1);
  assert.equal(replayV1.formulaVersion, 1);
  assert.equal(replayV1.computedValueScaled, 3_333n);

  // Divide-by-zero returns evaluation_error without crashing the pipeline
  const divZeroEval = registry.evaluateComposite(
    "TvlConcentrationRatio",
    {
      ...upstream,
      TotalProtocolTvl: {
        ...upstream.TotalProtocolTvl,
        valueScaled: 0n,
      },
    },
    now,
    1
  );
  assert.equal(divZeroEval.status, "evaluation_error");
  assert.equal(divZeroEval.computedValueScaled, null);
});

test("Issue #298: enforces topological evaluation across composites of composites, rejects cycles, and inherits degraded/stale states", () => {
  const registry = new CompositeFeedRegistry();

  // Composite 1: CrossMarketSpread = abs_diff(SpotA, SpotB)
  registry.registerCompositeFeed({
    feedId: "CrossMarketSpread",
    version: 1,
    unit: "bps",
    scaleDecimals: 4,
    roundingMode: "floor",
    inputs: [
      { feedId: "SpotA", maxFreshnessAgeMs: 30_000 },
      { feedId: "SpotB", maxFreshnessAgeMs: 30_000 },
    ],
    formula: {
      kind: "binary",
      op: "abs_diff",
      left: { kind: "input", feedId: "SpotA" },
      right: { kind: "input", feedId: "SpotB" },
    },
  });

  // Composite 2 (depends on Composite 1): SpreadStressIndex = CrossMarketSpread * 2
  registry.registerCompositeFeed({
    feedId: "SpreadStressIndex",
    version: 1,
    unit: "bps",
    scaleDecimals: 4,
    roundingMode: "floor",
    inputs: [{ feedId: "CrossMarketSpread", maxFreshnessAgeMs: 30_000 }],
    formula: {
      kind: "binary",
      op: "mul",
      left: { kind: "input", feedId: "CrossMarketSpread" },
      right: { kind: "constant", valueScaled: 2n * SCALE },
    },
  });

  assert.deepEqual(registry.resolveTopologicalOrder(), [
    "CrossMarketSpread",
    "SpreadStressIndex",
  ]);

  // Rejects cycle if a composite tries to create a cycle back
  assert.throws(
    () =>
      registry.registerCompositeFeed({
        feedId: "CycleFeedA",
        version: 1,
        unit: "bps",
        scaleDecimals: 4,
        roundingMode: "floor",
        inputs: [{ feedId: "CycleFeedA", maxFreshnessAgeMs: 10_000 }],
        formula: { kind: "input", feedId: "CycleFeedA" },
      }),
    /cannot reference itself/
  );

  const now = 1_750_000_000_000;
  // Evaluate when SpotB is in degraded trust state -> both composites inherit 'degraded'
  const allResults = registry.evaluateAllActiveComposites(
    {
      SpotA: {
        feedId: "SpotA",
        decisionId: "d_a",
        valueScaled: 10_000n,
        decidedAtMs: now - 5_000,
        trustState: "healthy",
      },
      SpotB: {
        feedId: "SpotB",
        decisionId: "d_b",
        valueScaled: 9_750n,
        decidedAtMs: now - 5_000,
        trustState: "degraded",
      },
    },
    now
  );

  assert.equal(allResults.CrossMarketSpread.computedValueScaled, 250n);
  assert.equal(allResults.CrossMarketSpread.status, "degraded");
  assert.equal(allResults.SpreadStressIndex.computedValueScaled, 500n);
  assert.equal(allResults.SpreadStressIndex.status, "degraded");

  // When SpotA is stale (>30s old), composite suspends with suspended_stale_input
  const staleResult = registry.evaluateComposite(
    "CrossMarketSpread",
    {
      SpotA: {
        feedId: "SpotA",
        decisionId: "d_a_old",
        valueScaled: 10_000n,
        decidedAtMs: now - 90_000,
        trustState: "healthy",
      },
      SpotB: {
        feedId: "SpotB",
        decisionId: "d_b",
        valueScaled: 9_750n,
        decidedAtMs: now - 5_000,
        trustState: "healthy",
      },
    },
    now
  );
  assert.equal(staleResult.status, "suspended_stale_input");
  assert.equal(staleResult.computedValueScaled, null);
});
