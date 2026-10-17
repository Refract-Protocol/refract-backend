import { test } from "node:test";
import assert from "node:assert/strict";
import { FeedFreshnessPolicyGuard } from "./feedFreshnessPolicyGuard.ts";

test("FeedFreshnessPolicyGuard marks too-old, future-skewed, and missing-timestamp readings unusable and tracks heartbeat staleness recovery", () => {
  const guard = new FeedFreshnessPolicyGuard();
  guard.registerPolicy({
    feedKey: "USDC-DEPEG",
    freshnessWindowMs: 30_000,
    maxClockSkewMs: 3_000,
    heartbeatIntervalMs: 15_000,
  });

  // 1. Too old reading is persisted with usableForConsensus=false
  const tooOld = guard.validateAtIngestion({
    feedKey: "USDC-DEPEG",
    sourceId: "coingecko",
    value: 0.9998,
    observedAtMs: 10_000,
    ingestedAtMs: 50_000,
  });
  assert.equal(tooOld.usableForConsensus, false);
  assert.equal(tooOld.invalidReason, "TOO_OLD");

  // 2. Future skew reading rejected
  const futureSkew = guard.validateAtIngestion({
    feedKey: "USDC-DEPEG",
    sourceId: "coingecko",
    value: 0.9998,
    observedAtMs: 55_000,
    ingestedAtMs: 50_000,
  });
  assert.equal(futureSkew.usableForConsensus, false);
  assert.equal(futureSkew.invalidReason, "FUTURE_SKEW_EXCEEDED");

  // 3. Missing timestamp rejected when fallback disabled
  const missingTs = guard.validateAtIngestion({
    feedKey: "USDC-DEPEG",
    sourceId: "coingecko",
    value: 0.9998,
    observedAtMs: null,
    ingestedAtMs: 50_000,
  });
  assert.equal(missingTs.usableForConsensus, false);
  assert.equal(missingTs.invalidReason, "MISSING_OBSERVED_TIMESTAMP");

  // 4. Valid heartbeat at t=50_000 -> healthy at t=60_000, flips to stale at t=70_000, recovers at t=72_000
  const valid = guard.validateAtIngestion({
    feedKey: "USDC-DEPEG",
    sourceId: "coingecko",
    value: 0.9999,
    observedAtMs: 49_500,
    ingestedAtMs: 50_000,
  });
  assert.equal(valid.usableForConsensus, true);

  assert.equal(
    guard.evaluateFeedHeartbeatHealth({
      feedKey: "USDC-DEPEG",
      expectedSources: ["coingecko"],
      nowMs: 60_000,
    }).stale,
    false
  );

  const staleState = guard.evaluateFeedHeartbeatHealth({
    feedKey: "USDC-DEPEG",
    expectedSources: ["coingecko"],
    nowMs: 70_000,
  });
  assert.equal(staleState.stale, true);
  assert.equal(staleState.transitionWarnings.length, 1);

  // Resume fresh reading at t=72_000 -> feed recovers from stale
  guard.validateAtIngestion({
    feedKey: "USDC-DEPEG",
    sourceId: "coingecko",
    value: 1.0,
    observedAtMs: 71_800,
    ingestedAtMs: 72_000,
  });
  assert.equal(
    guard.evaluateFeedHeartbeatHealth({
      feedKey: "USDC-DEPEG",
      expectedSources: ["coingecko"],
      nowMs: 75_000,
    }).stale,
    false
  );
});
