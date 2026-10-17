import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NexusLiquidationShieldAdapter,
  type RawNexusLiquidationEvent,
} from "./liquidationShield.ts";

describe("NexusLiquidationShieldAdapter (Issue #180)", () => {
  const contractId = "CNEXUSLIQUIDATIONPOOL12345";

  const sampleEvents: RawNexusLiquidationEvent[] = [
    {
      eventId: "ev-100-1",
      pagingToken: "cursor-100",
      ledger: 100,
      ledgerClosedAtMs: 1_700_000_000_000,
      contractId,
      vaultId: "vault-a",
      liquidatedCollateralUsd: 25_000.5,
      debtCoveredUsd: 22_000,
      collateralizationRatioBps: 10_400,
    },
    {
      eventId: "ev-104-1",
      pagingToken: "cursor-104",
      ledger: 104,
      ledgerClosedAtMs: 1_700_000_020_000,
      contractId,
      vaultId: "vault-b",
      liquidatedCollateralUsd: 15_000,
      debtCoveredUsd: 13_500,
      collateralizationRatioBps: 9_850,
    },
  ];

  it("gates liquidation readings by confirmation depth, advances cursor safely, and deduplicates replayed events", async () => {
    let currentLatestLedger = 103; // minConfirmationDepth = 3 -> maxConfirmedLedger = 100

    const adapter = new NexusLiquidationShieldAdapter({
      nexusContractId: contractId,
      minConfirmationDepth: 3,
      initialCursor: "cursor-0",
      fetchEventsFromRpc: async () => ({
        latestLedger: currentLatestLedger,
        events: sampleEvents,
      }),
    });

    assert.equal(adapter.getCatalogMetadata().isMocked, false);

    // Tick 1: Only ledger 100 is confirmed (104 > 103 - 3)
    const tick1 = await adapter.pollNextReading();
    assert.equal(tick1.status, "ok");
    if (tick1.status === "ok") {
      assert.deepEqual(tick1.reading.confirmedEventIds, ["ev-100-1"]);
      assert.equal(tick1.reading.totalLiquidatedCollateralUsd, 25_000.5);
      assert.equal(tick1.reading.encodedContractValueScaled, 250005000000n);
      assert.equal(tick1.cursorSaved, "cursor-100");
    }

    // Tick 2: Ledger advances to 108 -> maxConfirmedLedger = 105; ev-100-1 is deduplicated, ev-104-1 is emitted
    currentLatestLedger = 108;
    const tick2 = await adapter.pollNextReading();
    assert.equal(tick2.status, "ok");
    if (tick2.status === "ok") {
      assert.deepEqual(tick2.reading.confirmedEventIds, ["ev-104-1"]);
      assert.equal(tick2.reading.totalLiquidatedCollateralUsd, 15_000);
      assert.equal(tick2.reading.minObservedHealthBps, 9_850);
      assert.equal(tick2.cursorSaved, "cursor-104");
    }
  });

  it("degrades to no_reading rather than zero on RPC rate limits or outages", async () => {
    const adapter = new NexusLiquidationShieldAdapter({
      nexusContractId: contractId,
      minConfirmationDepth: 3,
      initialCursor: "cursor-saved-1",
      fetchEventsFromRpc: async () => {
        throw new Error("HTTP 429 rate limit exceeded on Soroban RPC");
      },
    });

    const outcome = await adapter.pollNextReading();
    assert.equal(outcome.status, "no_reading");
    if (outcome.status === "no_reading") {
      assert.equal(outcome.reason, "rate_limited");
      assert.equal(outcome.cursorSaved, "cursor-saved-1");
    }
  });
});
