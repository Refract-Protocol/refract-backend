import { test } from "node:test";
import assert from "node:assert/strict";
import { PointInTimeStateReconstructor } from "./pointInTimeStateReconstructor.ts";

test("PointInTimeStateReconstructor deterministically reconstructs historical state and enforces RBAC", () => {
  const reconstructor = new PointInTimeStateReconstructor();

  reconstructor.appendPolicy({
    policyHash: "pol-v1",
    effectiveAtMs: 1_000,
    ledgerSequence: 100,
    minIndependentSources: 2,
    maxRelativeSpreadBps: 100,
  });

  reconstructor.appendSourceState({
    sourceId: "src-1",
    effectiveAtMs: 1_000,
    ledgerSequence: 100,
    eligible: true,
    trustTier: "tier_1_institutional",
  });
  reconstructor.appendSourceState({
    sourceId: "src-2",
    effectiveAtMs: 1_000,
    ledgerSequence: 100,
    eligible: true,
    trustTier: "tier_2_commercial",
  });
  // Later quarantine at t=5000 should not affect reconstruction at t=3000
  reconstructor.appendSourceState({
    sourceId: "src-2",
    effectiveAtMs: 5_000,
    ledgerSequence: 150,
    eligible: false,
    trustTier: "quarantined",
  });

  reconstructor.appendReading({
    sourceId: "src-1",
    feedId: "XLM_USD",
    observedAtMs: 2_500,
    ingestedAtMs: 2_600,
    ledgerSequence: 120,
    value: 0.12,
    payloadHash: "h1",
  });
  reconstructor.appendReading({
    sourceId: "src-2",
    feedId: "XLM_USD",
    observedAtMs: 2_700,
    ingestedAtMs: 2_800,
    ledgerSequence: 125,
    value: 0.14,
    payloadHash: "h2",
  });
  // Late arrival ingested at t=4000 should be excluded at t=3000
  reconstructor.appendReading({
    sourceId: "src-1",
    feedId: "XLM_USD",
    observedAtMs: 2_900,
    ingestedAtMs: 4_000,
    ledgerSequence: 140,
    value: 0.20,
    payloadHash: "h3",
  });

  assert.throws(() =>
    reconstructor.reconstructState({
      callerRole: "public",
      feedId: "XLM_USD",
      asOfTimestampMs: 3_000,
      asOfLedgerSequence: 130,
      maxFreshnessWindowMs: 1_000,
    })
  );

  const stateAt3000 = reconstructor.reconstructState({
    callerRole: "auditor",
    feedId: "XLM_USD",
    asOfTimestampMs: 3_000,
    asOfLedgerSequence: 130,
    maxFreshnessWindowMs: 1_000,
  });

  assert.equal(stateAt3000.quorumMet, true);
  assert.equal(stateAt3000.visibleReadings.length, 2);
  assert.ok(Math.abs((stateAt3000.recomputedMedianValue ?? 0) - 0.13) < 1e-9);
});
