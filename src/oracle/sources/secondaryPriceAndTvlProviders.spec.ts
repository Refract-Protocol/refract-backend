import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PythHermesPriceAdapter,
  DirectVaultIndexerTvlAdapter,
  IndependentProviderCorroborator,
  type PluggableOracleSourceAdapter,
} from "./secondaryPriceAndTvlProviders.ts";

describe("Independent Secondary Price and TVL Providers (#204)", () => {
  it("normalizes Pyth Hermes fixed-point exponents and rejects wide confidence intervals or stale timestamps", async () => {
    let currentConf = "150000"; // $0.0015 on $1.00050000
    let publishTimeSec = 1_700_000_000;

    const pythAdapter = new PythHermesPriceAdapter({
      maxConfidenceRatio: 0.01,
      fetchRaw: async () => ({
        id: "usdc-usd",
        price: {
          price: "100050000",
          conf: currentConf,
          expo: -8,
          publish_time: publishTimeSec,
        },
      }),
    });

    const validReading = await pythAdapter.fetchNormalizedReading(
      "USDC/USD",
      1_700_000_005_000
    );
    assert.ok(validReading);
    assert.equal(validReading.canonicalValueUsd, 1.0005);
    assert.equal(
      validReading.upstreamOrigin,
      "pyth_network_first_party_publishers"
    );

    // Excessive confidence interval (> 1%) is rejected
    currentConf = "5000000"; // $0.05 on $1.0005 (~5%)
    const noisyReading = await pythAdapter.fetchNormalizedReading(
      "USDC/USD",
      1_700_000_005_000
    );
    assert.equal(noisyReading, null);

    // Restore confidence, test stale reading (> 60s lag)
    currentConf = "100000";
    const staleReading = await pythAdapter.fetchNormalizedReading(
      "USDC/USD",
      1_700_000_120_000
    );
    assert.equal(staleReading, null);
  });

  it("normalizes on-chain vault indexer raw units to USD TVL and corroborates only across distinct upstream origins", async () => {
    const nowMs = Date.parse("2026-10-17T12:00:00.000Z");

    const vaultTvlAdapter = new DirectVaultIndexerTvlAdapter({
      fetchRaw: async () => ({
        protocolSlug: "blend-pool-v1",
        totalLockedRawUnits: "250000000000000", // 25,000,000.0000000 with 7 decimals
        unitDecimals: 7,
        unitUsdPrice: 1.0,
        indexedAtIso: "2026-10-17T11:59:30.000Z",
      }),
    });

    const primaryDefiLlamaAdapter: PluggableOracleSourceAdapter = {
      descriptor: {
        sourceId: "defillama-tvl",
        metricKind: "tvl_usd",
        upstreamOrigin: "defillama_offchain_aggregator",
        methodology: "adapter_tvl_aggregation",
        expectedCadenceMs: 60_000,
        maxReportingLagMs: 300_000,
      },
      fetchNormalizedReading: async (feedId) => ({
        sourceId: "defillama-tvl",
        feedId,
        metricKind: "tvl_usd",
        canonicalValueUsd: 25_100_000,
        observedAtMs: nowMs - 20_000,
        upstreamOrigin: "defillama_offchain_aggregator",
      }),
    };

    const corroborator = new IndependentProviderCorroborator();
    corroborator.registerAdapterForFeed("BLEND_TVL", primaryDefiLlamaAdapter);

    // Single upstream origin cannot corroborate on its own
    const singleResult = await corroborator.pollAndCorroborateFeed(
      "BLEND_TVL",
      0.02,
      nowMs
    );
    assert.equal(singleResult.corroborated, false);
    assert.equal(singleResult.distinctUpstreamOrigins.length, 1);

    // Registering independent secondary on-chain vault TVL adapter enables real corroboration
    corroborator.registerAdapterForFeed("BLEND_TVL", vaultTvlAdapter);
    const dualResult = await corroborator.pollAndCorroborateFeed(
      "BLEND_TVL",
      0.02,
      nowMs
    );
    assert.equal(dualResult.corroborated, true);
    assert.equal(dualResult.agreedValueUsd, 25_050_000);
    assert.deepEqual(dualResult.distinctUpstreamOrigins.sort(), [
      "defillama_offchain_aggregator",
      "stellar_rpc_direct_vault_balance_indexer",
    ]);
  });
});
