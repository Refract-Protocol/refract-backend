import { test } from "node:test";
import assert from "node:assert/strict";
import { ReadingTimestampGuard } from "./readingTimestampGuard.ts";

test("ReadingTimestampGuard rejects missing, date-only, future-dated, stale, and replayed readings", () => {
  const guard = new ReadingTimestampGuard({
    maxFutureToleranceMs: 5_000,
    freshnessWindowMs: 60_000,
    clockSkewAlertThresholdMs: 3_000,
  });

  const nowMs = 1_000_000;

  // Missing timestamp rejected
  assert.equal(
    guard.validateAndIngest(
      {
        sourceId: "coingecko",
        feedId: "USDC-USD",
        value: 1.0,
        observedAt: null,
        rawPayload: '{"price":1.0}',
      },
      nowMs
    ).rejectionReason,
    "MISSING_OBSERVATION_TIMESTAMP"
  );

  // Date-only string rejected
  assert.equal(
    guard.validateAndIngest(
      {
        sourceId: "coingecko",
        feedId: "USDC-USD",
        value: 1.0,
        observedAt: "2026-10-17",
        rawPayload: '{"price":1.0}',
      },
      nowMs
    ).rejectionReason,
    "DATE_ONLY_TIMESTAMP_REJECTED"
  );

  // Future-dated reading rejected
  assert.equal(
    guard.validateAndIngest(
      {
        sourceId: "coingecko",
        feedId: "USDC-USD",
        value: 1.0,
        observedAt: nowMs + 10_000,
        rawPayload: '{"price":1.0}',
      },
      nowMs
    ).rejectionReason,
    "FUTURE_DATED_READING"
  );

  // Stale reading rejected
  assert.equal(
    guard.validateAndIngest(
      {
        sourceId: "coingecko",
        feedId: "USDC-USD",
        value: 1.0,
        observedAt: nowMs - 90_000,
        rawPayload: '{"price":1.0}',
      },
      nowMs
    ).rejectionReason,
    "STALE_READING"
  );

  // Valid reading accepted; replayed duplicate rejected
  const first = guard.validateAndIngest(
    {
      sourceId: "defillama",
      feedId: "USDC-USD",
      value: 0.9999,
      observedAt: nowMs - 500,
      rawPayload: '{"price":0.9999,"ts":999500}',
    },
    nowMs
  );
  assert.equal(first.accepted, true);
  assert.equal(first.reading?.observedAtMs, nowMs - 500);
  assert.equal(first.reading?.receivedAtMs, nowMs);

  const replayed = guard.validateAndIngest(
    {
      sourceId: "defillama",
      feedId: "USDC-USD",
      value: 0.9999,
      observedAt: nowMs - 500,
      rawPayload: '{"price":0.9999,"ts":999500}',
    },
    nowMs + 1_000
  );
  assert.equal(replayed.accepted, false);
  assert.equal(replayed.rejectionReason, "DUPLICATE_REPLAYED_READING");
});

test("ReadingTimestampGuard flags a systematically clock-skewed source", () => {
  const guard = new ReadingTimestampGuard({
    maxFutureToleranceMs: 5_000,
    freshnessWindowMs: 60_000,
    clockSkewAlertThresholdMs: 3_000,
  });

  // Source consistently lags by 4,500ms (> 3,000ms threshold)
  guard.validateAndIngest(
    {
      sourceId: "skewed-provider",
      feedId: "XLM-USD",
      value: 0.12,
      observedAt: 100_000 - 4_500,
      rawPayload: '{"seq":1}',
    },
    100_000
  );
  guard.validateAndIngest(
    {
      sourceId: "skewed-provider",
      feedId: "XLM-USD",
      value: 0.121,
      observedAt: 110_000 - 4_500,
      rawPayload: '{"seq":2}',
    },
    110_000
  );

  const stats = guard.getSourceClockSkewStats("skewed-provider");
  assert.equal(stats.sampleCount, 2);
  assert.equal(stats.meanOffsetMs, 4_500);
  assert.equal(stats.skewFlagged, true);
});
