import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TimeWindowedSpikeSuppressingAggregator } from "./windowedAggregator.ts";

describe("Time-Windowed Reading Aggregation and Spike Suppression (#227)", () => {
  it("suppresses a single-sample transient spike so it cannot flip a payout threshold while retaining raw samples for audit", () => {
    const aggregator = new TimeWindowedSpikeSuppressingAggregator();
    const nowMs = 1_700_000_060_000;

    // 4 normal USDC readings around $1.0000 and 1 extreme transient flash-wick to $0.8200
    const samples = [
      { value: 1.0001, observedAtMs: nowMs - 40_000 },
      { value: 0.9999, observedAtMs: nowMs - 30_000 },
      { value: 0.82, observedAtMs: nowMs - 20_000 }, // transient spike (-18%)
      { value: 1.0, observedAtMs: nowMs - 10_000 },
      { value: 1.0002, observedAtMs: nowMs - 2_000 },
    ];

    for (const s of samples) {
      aggregator.recordSample({
        sourceId: "pyth-price",
        feedId: "USDC/USD",
        value: s.value,
        observedAtMs: s.observedAtMs,
      });
    }

    const snapshot = aggregator.evaluateWindow(
      "pyth-price",
      "USDC/USD",
      {
        windowDurationMs: 60_000,
        minSamplesInWindow: 3,
        maxOutlierDeviationRatio: 0.03,
        strategy: "rolling_median",
      },
      nowMs
    );

    assert.equal(snapshot.status, "spike_suppressed");
    assert.equal(snapshot.aggregatedValue, 1.00005);
    assert.equal(snapshot.suppressedOutlierSamples.length, 1);
    assert.equal(snapshot.suppressedOutlierSamples[0]?.value, 0.82);
    // Raw evidence retains all 5 samples including the suppressed spike
    assert.equal(snapshot.retainedRawSamples.length, 5);
  });

  it("marks aggregate as stale_insufficient_samples when window has fewer than minSamplesInWindow without widening the window", () => {
    const aggregator = new TimeWindowedSpikeSuppressingAggregator();
    const nowMs = 1_700_000_200_000;

    // 2 old samples outside the 60s window, 1 recent sample inside the window
    aggregator.recordSample({
      sourceId: "coingecko-price",
      feedId: "USDC/USD",
      value: 1.0,
      observedAtMs: nowMs - 120_000,
    });
    aggregator.recordSample({
      sourceId: "coingecko-price",
      feedId: "USDC/USD",
      value: 1.0,
      observedAtMs: nowMs - 90_000,
    });
    aggregator.recordSample({
      sourceId: "coingecko-price",
      feedId: "USDC/USD",
      value: 0.9998,
      observedAtMs: nowMs - 10_000,
    });

    const snapshot = aggregator.evaluateWindow(
      "coingecko-price",
      "USDC/USD",
      {
        windowDurationMs: 60_000,
        minSamplesInWindow: 3,
        maxOutlierDeviationRatio: 0.02,
        strategy: "time_weighted_median",
      },
      nowMs
    );

    assert.equal(snapshot.status, "stale_insufficient_samples");
    assert.equal(snapshot.aggregatedValue, null);
    assert.equal(snapshot.retainedRawSamples.length, 1);
  });
});
