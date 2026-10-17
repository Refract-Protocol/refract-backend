import { test } from "node:test";
import assert from "node:assert/strict";
import { DecisionRationaleGenerator } from "./decisionRationaleGenerator.ts";

test("DecisionRationaleGenerator produces structured and plain-language rationale without sensitive internals", () => {
  const generator = new DecisionRationaleGenerator();

  const out = generator.generate({
    decisionId: "dec-exp-101",
    feedId: "FLIGHT_DELAY_MINUTES",
    policyVersionHash: "sha256:pol99",
    aggregationMethod: "median",
    consensusValue: 135,
    unit: "minutes",
    triggerThresholdValue: 120,
    triggerComparison: "gte",
    requiredQuorumCount: 2,
    contributingSources: [
      {
        sourceId: "flightaware",
        observedAtIso: "2026-10-17T12:00:00Z",
        value: 130,
        unit: "minutes",
        trustTier: "tier_1_institutional",
        weight: 1.0,
      },
      {
        sourceId: "aviationstack",
        observedAtIso: "2026-10-17T12:00:05Z",
        value: 140,
        unit: "minutes",
        trustTier: "tier_2_commercial",
        weight: 0.8,
      },
    ],
    excludedSources: [
      { sourceId: "opensky", exclusionReason: "stale" },
    ],
  });

  assert.equal(out.triggered, true);
  assert.equal(out.quorumSatisfied, true);
  assert.ok(out.proseSummary.includes("PAYOUT TRIGGERED"));
  assert.ok(out.proseSummary.includes("135 minutes"));
  assert.ok(out.proseSummary.includes("opensky (stale)"));
  assert.ok(out.proseSummary.includes("sha256:pol99"));
});
