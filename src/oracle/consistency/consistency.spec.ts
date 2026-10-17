import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateCrossFeedConsistency,
  type FeedObservationSnapshot,
} from "./evaluate.ts";

test("Issue #280: LiquidationShield spike is blocked when fresh MarketCrash and SmartContractRisk are both calm, and allowed when corroborated", () => {
  const now = 1_750_000_000_000;
  const primarySpike: FeedObservationSnapshot = {
    feedId: "LiquidationShield",
    valueBps: 7_500, // 75% liquidation spike (>= 5000 trigger)
    observedAtMs: now,
  };

  // Both corroborating feeds are fresh and calm -> violation with severity 'block'
  const uncorroboratedReport = evaluateCrossFeedConsistency(primarySpike, {
    MarketCrash: { feedId: "MarketCrash", valueBps: 100, observedAtMs: now - 30_000 },
    SmartContractRisk: { feedId: "SmartContractRisk", valueBps: 0, observedAtMs: now - 45_000 },
  });

  assert.equal(uncorroboratedReport.allowFinalization, false);
  assert.equal(uncorroboratedReport.hasWarnings, true);
  assert.equal(uncorroboratedReport.adjustedConfidenceBps, 6_000);
  assert.equal(uncorroboratedReport.ruleEvaluations[0].status, "violated");

  // Corroborated by SmartContractRisk within 15m lead/lag window -> allowed
  const corroboratedReport = evaluateCrossFeedConsistency(primarySpike, {
    MarketCrash: { feedId: "MarketCrash", valueBps: 100, observedAtMs: now - 30_000 },
    SmartContractRisk: {
      feedId: "SmartContractRisk",
      valueBps: 3_200,
      observedAtMs: now - 5 * 60 * 1000,
    },
  });

  assert.equal(corroboratedReport.allowFinalization, true);
  assert.equal(corroboratedReport.hasWarnings, false);
  assert.equal(corroboratedReport.adjustedConfidenceBps, 10_000);
  assert.equal(corroboratedReport.ruleEvaluations[0].status, "satisfied");
});

test("Issue #280: warn-severity rules (StablecoinDepeg & FlightDelay) penalize confidence and emit warnings without blocking finalization", () => {
  const now = 1_750_000_000_000;

  const depegReport = evaluateCrossFeedConsistency(
    {
      feedId: "StablecoinDepeg",
      valueBps: 850, // 8.5% depeg
      observedAtMs: now,
    },
    {
      MarketCrash: { feedId: "MarketCrash", valueBps: 50, observedAtMs: now - 60_000 },
    }
  );

  assert.equal(depegReport.allowFinalization, true);
  assert.equal(depegReport.hasWarnings, true);
  assert.equal(depegReport.adjustedConfidenceBps, 8_000);
  assert.equal(depegReport.ruleEvaluations[0].status, "violated");

  const flightReport = evaluateCrossFeedConsistency(
    {
      feedId: "FlightDelay",
      valueBps: 10_000, // isolated cancellation
      observedAtMs: now,
    },
    {
      RouteDisruptionIndex: {
        feedId: "RouteDisruptionIndex",
        valueBps: 0, // 0% route-wide disruption
        observedAtMs: now - 120_000,
      },
    }
  );

  assert.equal(flightReport.allowFinalization, true);
  assert.equal(flightReport.hasWarnings, true);
  assert.equal(flightReport.adjustedConfidenceBps, 8_500);
  assert.equal(flightReport.ruleEvaluations[0].status, "violated");
});

test("Issue #280: missing or stale paired feeds degrade to skipped_missing_pair / skipped_stale_pair and never false-block", () => {
  const now = 1_750_000_000_000;
  const primarySpike: FeedObservationSnapshot = {
    feedId: "LiquidationShield",
    valueBps: 8_000,
    observedAtMs: now,
  };

  // Paired feeds completely missing -> skipped_missing_pair, allowFinalization remains true
  const missingPairReport = evaluateCrossFeedConsistency(primarySpike, {});
  assert.equal(missingPairReport.allowFinalization, true);
  assert.equal(missingPairReport.hasWarnings, true);
  assert.equal(missingPairReport.adjustedConfidenceBps, 10_000);
  assert.equal(missingPairReport.ruleEvaluations[0].status, "skipped_missing_pair");

  // Paired feeds present but stale (outside 15m lead/lag window) -> skipped_stale_pair, allowFinalization remains true
  const stalePairReport = evaluateCrossFeedConsistency(primarySpike, {
    MarketCrash: {
      feedId: "MarketCrash",
      valueBps: 0,
      observedAtMs: now - 45 * 60 * 1000, // 45m old (> 15m window)
    },
  });
  assert.equal(stalePairReport.allowFinalization, true);
  assert.equal(stalePairReport.hasWarnings, true);
  assert.equal(stalePairReport.adjustedConfidenceBps, 10_000);
  assert.equal(stalePairReport.ruleEvaluations[0].status, "skipped_stale_pair");
});
