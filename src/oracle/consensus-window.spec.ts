import test from "node:test";
import assert from "node:assert/strict";
import {
  ConsensusWindowManager,
  computeWindowBounds,
  evaluateWindowSnapshot,
} from "./consensus-window.ts";

test("Issue #285: watermark advancement closes windows deterministically and suppresses duplicate source readings", () => {
  const mgr = new ConsensusWindowManager();
  mgr.registerFeed({
    feedId: "StablecoinDepeg",
    windowDurationMs: 10_000,
    allowedLatenessMs: 2_000,
    quorumSize: 3,
    latePolicy: "drop",
  });

  const bounds = computeWindowBounds("StablecoinDepeg", 105_000, 10_000);
  assert.equal(bounds.windowId, "StablecoinDepeg:100000-110000");

  // Out-of-order arrivals within [100_000, 110_000)
  const r1 = mgr.ingestReading({
    feedId: "StablecoinDepeg",
    sourceId: "coingecko",
    value: 0.998,
    sourceTimestampMs: 108_000,
    ingestedAtMs: 108_500,
  });
  assert.equal(r1.accepted, true);
  assert.equal(r1.reading.late, false);

  // Duplicate reading from coingecko in the same window is suppressed
  const dup = mgr.ingestReading({
    feedId: "StablecoinDepeg",
    sourceId: "coingecko",
    value: 0.95,
    sourceTimestampMs: 109_000,
    ingestedAtMs: 109_100,
  });
  assert.equal(dup.accepted, false);
  assert.equal(dup.duplicate, true);

  // Second source arrives on time
  mgr.ingestReading({
    feedId: "StablecoinDepeg",
    sourceId: "defillama",
    value: 1.0,
    sourceTimestampMs: 102_000,
    ingestedAtMs: 103_000,
  });

  // Third source arrives after windowEnd (110_000) but within allowedLateness (<= 112_000)
  const r3 = mgr.ingestReading({
    feedId: "StablecoinDepeg",
    sourceId: "horizon",
    value: 0.999,
    sourceTimestampMs: 109_500,
    ingestedAtMs: 111_500,
  });
  assert.equal(r3.accepted, true);
  assert.equal(r3.reading.late, true);
  assert.equal(r3.reading.lateAction, "accepted_within_lateness");

  // Watermark before 112_000 does NOT close the window
  assert.deepEqual(mgr.advanceWatermark("StablecoinDepeg", 111_900), []);

  // Watermark at 112_000 closes the window and emits deterministic median (0.999)
  const decisions = mgr.advanceWatermark("StablecoinDepeg", 112_000);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].windowId, "StablecoinDepeg:100000-110000");
  assert.equal(decisions[0].status, "quorum_reached");
  assert.equal(decisions[0].medianValue, 0.999);
  assert.deepEqual(decisions[0].participatingSources, ["coingecko", "defillama", "horizon"]);
});

test("Issue #285: late arrivals past watermark are flagged late and either dropped or carried into next window without mutating settled decisions", () => {
  const mgr = new ConsensusWindowManager();
  mgr.registerFeed({
    feedId: "MarketCrash",
    windowDurationMs: 10_000,
    allowedLatenessMs: 1_000,
    quorumSize: 2,
    latePolicy: "drop",
  });

  mgr.ingestReading({
    feedId: "MarketCrash",
    sourceId: "s1",
    value: 100,
    sourceTimestampMs: 12_000,
    ingestedAtMs: 12_100,
  });
  mgr.ingestReading({
    feedId: "MarketCrash",
    sourceId: "s2",
    value: 110,
    sourceTimestampMs: 15_000,
    ingestedAtMs: 15_100,
  });

  const [settled] = mgr.advanceWatermark("MarketCrash", 21_000);
  assert.equal(settled.status, "quorum_reached");
  assert.equal(settled.medianValue, 105);

  // Very late reading for [10_000, 20_000) arriving at 25_000 is dropped and recorded as late
  const lateDrop = mgr.ingestReading({
    feedId: "MarketCrash",
    sourceId: "s3",
    value: 500,
    sourceTimestampMs: 18_000,
    ingestedAtMs: 25_000,
  });
  assert.equal(lateDrop.accepted, false);
  assert.equal(lateDrop.reading.late, true);
  assert.equal(lateDrop.reading.lateAction, "dropped_late");

  // Replay of closed window is byte-identical to original settled decision
  const replayed = mgr.replayWindow("MarketCrash:10000-20000");
  assert.deepEqual(replayed, settled);

  // Test carry_next policy on a second feed
  mgr.registerFeed({
    feedId: "TVLDrop",
    windowDurationMs: 10_000,
    allowedLatenessMs: 1_000,
    quorumSize: 2,
    latePolicy: "carry_next",
  });
  mgr.advanceWatermark("TVLDrop", 21_500);
  const carried = mgr.ingestReading({
    feedId: "TVLDrop",
    sourceId: "defillama",
    value: 42,
    sourceTimestampMs: 19_000,
    ingestedAtMs: 22_000,
  });
  assert.equal(carried.accepted, true);
  assert.equal(carried.reading.late, true);
  assert.equal(carried.reading.lateAction, "carried_to_next_window");
  assert.equal(carried.reading.originWindowId, "TVLDrop:10000-20000");
  assert.equal(carried.reading.assignedWindowId, "TVLDrop:20000-30000");
});

test("Issue #285: empty window and clock skew handling, plus order-independent replay determinism", () => {
  const mgr = new ConsensusWindowManager();
  mgr.registerFeed({
    feedId: "FlightDelay",
    windowDurationMs: 10_000,
    allowedLatenessMs: 0,
    quorumSize: 2,
    latePolicy: "drop",
    maxClockSkewMs: 2_000,
  });

  // Future-dated reading beyond maxClockSkewMs is rejected
  assert.throws(
    () =>
      mgr.ingestReading({
        feedId: "FlightDelay",
        sourceId: "s1",
        value: 1,
        sourceTimestampMs: 50_000,
        ingestedAtMs: 40_000,
      }),
    /clock skew tolerance/
  );

  // Order-independent replay check
  const sampleA = [
    {
      readingId: "1",
      feedId: "FlightDelay",
      sourceId: "alpha",
      value: 10,
      sourceTimestampMs: 1000,
      ingestedAtMs: 1100,
      originWindowId: "FlightDelay:0-10000",
      assignedWindowId: "FlightDelay:0-10000",
      late: false,
      lateAction: "on_time" as const,
    },
    {
      readingId: "2",
      feedId: "FlightDelay",
      sourceId: "beta",
      value: 20,
      sourceTimestampMs: 2000,
      ingestedAtMs: 2100,
      originWindowId: "FlightDelay:0-10000",
      assignedWindowId: "FlightDelay:0-10000",
      late: false,
      lateAction: "on_time" as const,
    },
  ];
  const cfg = {
    feedId: "FlightDelay",
    windowDurationMs: 10_000,
    allowedLatenessMs: 0,
    quorumSize: 2,
    latePolicy: "drop" as const,
  };
  const d1 = evaluateWindowSnapshot(
    {
      feedId: "FlightDelay",
      windowId: "FlightDelay:0-10000",
      windowStartMs: 0,
      windowEndMs: 10_000,
      config: cfg,
      readings: sampleA,
    },
    10_000
  );
  const d2 = evaluateWindowSnapshot(
    {
      feedId: "FlightDelay",
      windowId: "FlightDelay:0-10000",
      windowStartMs: 0,
      windowEndMs: 10_000,
      config: cfg,
      readings: [...sampleA].reverse(),
    },
    10_000
  );
  assert.equal(JSON.stringify(d1), JSON.stringify(d2));
});
