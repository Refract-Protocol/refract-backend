import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HistoricalBootstrapSeeder } from "./historicalSeeder.ts";

describe("HistoricalBootstrapSeeder (Issue #237)", () => {
  it("seeds historical readings idempotently, computes initial statistical baselines, and excludes seeded rows from payout triggers", async () => {
    const seeder = new HistoricalBootstrapSeeder();
    const t0 = 1_700_000_000_000;

    const samplePages = [
      [
        { sourceId: "noaa-1", observedAtMs: t0 + 10_000, value: 100 },
        { sourceId: "noaa-1", observedAtMs: t0 + 20_000, value: 102 },
        { sourceId: "noaa-2", observedAtMs: t0 + 30_000, value: 98 },
      ],
      [
        { sourceId: "noaa-1", observedAtMs: t0 + 40_000, value: 104 },
        { sourceId: "noaa-2", observedAtMs: t0 + 50_000, value: 96 },
      ],
    ];

    const baseline1 = await seeder.seedHistoricalWindow(
      {
        feedId: "wind-speed-tampa",
        windowStartMs: t0,
        windowEndMs: t0 + 60_000,
        nowMs: t0 + 65_000,
      },
      async ({ pageIndex }) => ({
        points: samplePages[pageIndex] ?? [],
        nextPageAvailable: pageIndex < samplePages.length - 1,
      })
    );

    assert.equal(baseline1.state, "warm_seeded");
    assert.equal(baseline1.sampleCount, 5);
    assert.equal(baseline1.medianValue, 100);
    assert.equal(baseline1.madDispersion, 2);
    assert.equal(baseline1.medianInterReadingIntervalMs, 10_000);

    // Re-running over the exact same window is strictly idempotent
    const baseline2 = await seeder.seedHistoricalWindow(
      {
        feedId: "wind-speed-tampa",
        windowStartMs: t0,
        windowEndMs: t0 + 60_000,
        nowMs: t0 + 70_000,
      },
      async ({ pageIndex }) => ({
        points: samplePages[pageIndex] ?? [],
        nextPageAvailable: pageIndex < samplePages.length - 1,
      })
    );

    assert.equal(baseline2.sampleCount, 5);
    assert.equal(seeder.getFeedReadings("wind-speed-tampa").length, 5);

    // Seeded readings must NEVER be eligible for payout triggers or on-chain publish
    assert.equal(seeder.getPayoutEligibleReadings("wind-speed-tampa").length, 0);
  });

  it("aborts atomically on partial page failure and records explicit cold_start state when history is unavailable", async () => {
    const seeder = new HistoricalBootstrapSeeder();
    const t0 = 1_700_000_000_000;

    // 1. Mid-stream failure on page 1 -> neither readings nor baseline are committed
    await assert.rejects(
      async () => {
        await seeder.seedHistoricalWindow(
          {
            feedId: "atomic-test-feed",
            windowStartMs: t0,
            windowEndMs: t0 + 60_000,
          },
          async ({ pageIndex }) => {
            if (pageIndex === 0) {
              return {
                points: [
                  { sourceId: "src-1", observedAtMs: t0 + 5_000, value: 50 },
                ],
                nextPageAvailable: true,
              };
            }
            throw new Error("Upstream historical archive timeout");
          }
        );
      },
      /Upstream historical archive timeout/
    );

    assert.equal(seeder.getFeedReadings("atomic-test-feed").length, 0);
    assert.equal(seeder.getBaseline("atomic-test-feed"), undefined);

    // 2. Source without historical backfill support enters explicit cold_start state
    const coldBaseline = await seeder.seedHistoricalWindow(
      {
        feedId: "new-sensor-feed",
        windowStartMs: t0,
        windowEndMs: t0 + 60_000,
        nowMs: t0 + 60_000,
      },
      async () => ({
        points: [],
        nextPageAvailable: false,
        supportsHistoricalBackfill: false,
      })
    );

    assert.equal(coldBaseline.state, "cold_start");
    assert.equal(coldBaseline.sampleCount, 0);
    assert.equal(coldBaseline.outlierRejectionMultiplier, 5.0);
  });
});
