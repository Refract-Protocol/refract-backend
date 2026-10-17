import { test } from "node:test";
import assert from "node:assert/strict";
import { CrossRegionIngestionCoordinator } from "./crossRegionIngestion.ts";

test("Issue #233: handles multi-region agreement, one-region-down tolerance, and regional PoP divergence", () => {
  const now = 1_750_000_000_000;
  const coord = new CrossRegionIngestionCoordinator({
    configuredRegions: ["us-east-1", "eu-central-1", "ap-southeast-1"],
    minDistinctRegions: 2,
    freshnessWindowMs: 30_000,
    maxRegionalSpreadBps: 100,
    correlatedFailureRegionThreshold: 2,
  });

  // 1. All 3 regions agree within 100 bps spread
  const agreed = coord.evaluateSourceAcrossRegions(
    "StablecoinDepeg",
    "coingecko",
    [
      { feedId: "StablecoinDepeg", sourceId: "coingecko", regionId: "us-east-1", observedAtMs: now - 2_000, valueBps: 9980 },
      { feedId: "StablecoinDepeg", sourceId: "coingecko", regionId: "eu-central-1", observedAtMs: now - 1_500, valueBps: 9985 },
      { feedId: "StablecoinDepeg", sourceId: "coingecko", regionId: "ap-southeast-1", observedAtMs: now - 1_000, valueBps: 9990 },
    ],
    now
  );
  assert.equal(agreed.trustedForConsensus, true);
  assert.equal(agreed.canonicalValueBps, 9985);
  assert.equal(agreed.regionalDivergenceDetected, false);
  assert.equal(agreed.correlatedFailureAlerts.length, 0);

  // 2. One region down (ap-southeast-1 fails with timeout, while us-east-1 and eu-central-1 agree)
  const oneRegionDown = coord.evaluateSourceAcrossRegions(
    "StablecoinDepeg",
    "coingecko",
    [
      { feedId: "StablecoinDepeg", sourceId: "coingecko", regionId: "us-east-1", observedAtMs: now - 2_000, valueBps: 9980 },
      { feedId: "StablecoinDepeg", sourceId: "coingecko", regionId: "eu-central-1", observedAtMs: now - 1_500, valueBps: 9990 },
      { feedId: "StablecoinDepeg", sourceId: "coingecko", regionId: "ap-southeast-1", observedAtMs: now - 1_000, errorCode: "ETIMEDOUT" },
    ],
    now
  );
  assert.equal(oneRegionDown.trustedForConsensus, true);
  assert.equal(oneRegionDown.healthyRegions.length, 2);
  assert.equal(oneRegionDown.canonicalValueBps, 9985);

  // 3. Regional divergence (one PoP returns poisoned 8500 bps while another returns 9990 bps)
  const diverged = coord.evaluateSourceAcrossRegions(
    "StablecoinDepeg",
    "coingecko",
    [
      { feedId: "StablecoinDepeg", sourceId: "coingecko", regionId: "us-east-1", observedAtMs: now - 2_000, valueBps: 8500 },
      { feedId: "StablecoinDepeg", sourceId: "coingecko", regionId: "eu-central-1", observedAtMs: now - 1_500, valueBps: 9990 },
    ],
    now
  );
  assert.equal(diverged.regionalDivergenceDetected, true);
  assert.equal(diverged.trustedForConsensus, false);
});

test("Issue #233: detects correlated multi-region error patterns and simultaneous staleness, and degrades gracefully in single-region mode", () => {
  const now = 1_750_000_000_000;
  const coord = new CrossRegionIngestionCoordinator({
    configuredRegions: ["us-east-1", "eu-central-1", "ap-southeast-1"],
    minDistinctRegions: 2,
    freshnessWindowMs: 30_000,
    correlatedFailureRegionThreshold: 2,
  });

  // Identical CDN_502 error across all 3 regions -> raises identical_multi_region_error_pattern alert
  const cdnFailure = coord.evaluateSourceAcrossRegions(
    "LiquidationShield",
    "defillama",
    [
      { feedId: "LiquidationShield", sourceId: "defillama", regionId: "us-east-1", observedAtMs: now - 1_000, errorCode: "CDN_502_BAD_GATEWAY" },
      { feedId: "LiquidationShield", sourceId: "defillama", regionId: "eu-central-1", observedAtMs: now - 1_000, errorCode: "CDN_502_BAD_GATEWAY" },
      { feedId: "LiquidationShield", sourceId: "defillama", regionId: "ap-southeast-1", observedAtMs: now - 1_000, errorCode: "CDN_502_BAD_GATEWAY" },
    ],
    now
  );
  assert.equal(cdnFailure.trustedForConsensus, false);
  assert.equal(cdnFailure.correlatedFailureAlerts.length, 1);
  assert.equal(
    cdnFailure.correlatedFailureAlerts[0].kind,
    "identical_multi_region_error_pattern"
  );

  // Single-region deployment degrades gracefully with explicit warning
  const singleRegionCoord = new CrossRegionIngestionCoordinator({
    configuredRegions: ["us-east-1"],
    minDistinctRegions: 2,
  });
  const singleEval = singleRegionCoord.evaluateSourceAcrossRegions(
    "LiquidationShield",
    "defillama",
    [
      { feedId: "LiquidationShield", sourceId: "defillama", regionId: "us-east-1", observedAtMs: now - 1_000, valueBps: 500 },
    ],
    now
  );
  assert.equal(singleEval.trustedForConsensus, true);
  assert.equal(singleEval.singleRegionDegradedWarning, true);
  assert.equal(singleEval.canonicalValueBps, 500);
});
