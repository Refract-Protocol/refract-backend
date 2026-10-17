import { test } from "node:test";
import assert from "node:assert/strict";
import { CoverageFeedDependencyResolver } from "./coverageFeedDependencyResolver.ts";

test("CoverageFeedDependencyResolver suspends coverage when required feeds degrade and resumes on recovery", () => {
  const resolver = new CoverageFeedDependencyResolver();

  resolver.registerCoverageDependency({
    coverageType: "HURRICANE_WIND",
    requiredFeeds: [
      { feedId: "NOAA_WIND_KPH", minTrustLevel: "production_quorum" },
      { feedId: "BAROMETRIC_HPA", minTrustLevel: "degraded_quorum" },
    ],
  });

  // Unmapped coverage type cannot be purchased
  assert.equal(resolver.evaluateCoverageAvailability("UNMAPPED_COV").purchasable, false);

  resolver.updateFeedTrustLevel("NOAA_WIND_KPH", "degraded_quorum");
  resolver.updateFeedTrustLevel("BAROMETRIC_HPA", "degraded_quorum");

  // NOAA_WIND_KPH requires production_quorum -> HURRICANE_WIND auto-suspended
  const degraded = resolver.evaluateCoverageAvailability("HURRICANE_WIND");
  assert.equal(degraded.purchasable, false);
  assert.deepEqual(degraded.degradedFeeds, ["NOAA_WIND_KPH"]);
  assert.throws(() => resolver.assertCanPurchasePolicy("HURRICANE_WIND"));

  // Feed recovers -> coverage automatically resumes without restart
  resolver.updateFeedTrustLevel("NOAA_WIND_KPH", "production_quorum");
  const recovered = resolver.evaluateCoverageAvailability("HURRICANE_WIND");
  assert.equal(recovered.purchasable, true);
  assert.doesNotThrow(() => resolver.assertCanPurchasePolicy("HURRICANE_WIND"));
});
