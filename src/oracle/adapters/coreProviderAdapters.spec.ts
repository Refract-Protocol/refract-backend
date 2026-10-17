import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CoinGeckoPricePollerAdapter,
  HorizonOrderbookPollerAdapter,
  DefiLlamaTvlPollerAdapter,
  CoreProviderAdapterRegistry,
} from "./coreProviderAdapters.ts";

describe("Port CoinGecko, Horizon, and DeFiLlama Pollers onto the Adapter Registry (#228)", () => {
  it("registers all three core adapters, preserves Horizon cursor progression, and verifies equivalence against legacy values", async () => {
    const nowMs = Date.parse("2026-10-17T12:00:00.000Z");
    const nowSec = Math.floor(nowMs / 1_000);

    const cgAdapter = new CoinGeckoPricePollerAdapter({
      coinIdByFeed: { "USDC/USD": "usd-coin" },
      fetchJson: async () => ({
        "usd-coin": {
          usd: 0.99985,
          last_updated_at: nowSec - 15,
        },
      }),
    });

    const receivedCursors: Array<string | undefined> = [];
    const horizonAdapter = new HorizonOrderbookPollerAdapter({
      fetchTrades: async (_feedId, cursor) => {
        receivedCursors.push(cursor);
        return [
          {
            paging_token: cursor ? "cursor-ledger-2002" : "cursor-ledger-2001",
            ledger_close_time: "2026-10-17T11:59:50.000Z",
            price: { n: "999850", d: "1000000" },
          },
        ];
      },
    });

    const llamaAdapter = new DefiLlamaTvlPollerAdapter({
      fetchProtocol: async () => ({
        tvl: [
          { date: nowSec - 60, totalLiquidityUSD: 42_000_000 },
          { date: nowSec - 10, totalLiquidityUSD: 42_500_000.25 },
        ],
      }),
    });

    const registry = new CoreProviderAdapterRegistry();
    registry.register(cgAdapter);
    registry.register(horizonAdapter);
    registry.register(llamaAdapter);

    assert.deepEqual(registry.getRegisteredIds().sort(), [
      "coingecko-spot",
      "defillama-tvl",
      "stellar-horizon-dex",
    ]);

    const cgRes = await cgAdapter.pollNormalized("USDC/USD", nowMs);
    assert.ok(cgRes);
    assert.equal(
      CoreProviderAdapterRegistry.verifyLegacyEquivalence(0.99985, cgRes),
      true
    );

    // Horizon first poll starts with undefined cursor and advances to cursor-ledger-2001
    const hzRes1 = await horizonAdapter.pollNormalized("USDC/XLM", nowMs);
    assert.ok(hzRes1);
    assert.equal(hzRes1.canonicalValue, 0.99985);
    assert.equal(horizonAdapter.getCursor("USDC/XLM"), "cursor-ledger-2001");

    // Horizon second poll passes cursor-ledger-2001 so no ledger is skipped
    const hzRes2 = await horizonAdapter.pollNormalized("USDC/XLM", nowMs);
    assert.ok(hzRes2);
    assert.deepEqual(receivedCursors, [undefined, "cursor-ledger-2001"]);
    assert.equal(horizonAdapter.getCursor("USDC/XLM"), "cursor-ledger-2002");

    // DeFiLlama timeseries array normalization
    const llamaRes = await llamaAdapter.pollNormalized("BLEND_TVL", nowMs);
    assert.ok(llamaRes);
    assert.equal(llamaRes.canonicalValue, 42_500_000.25);
  });
});
