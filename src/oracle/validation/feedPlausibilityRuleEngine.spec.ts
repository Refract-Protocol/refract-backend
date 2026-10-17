import { test } from "node:test";
import assert from "node:assert/strict";
import { FeedPlausibilityRuleEngine } from "./feedPlausibilityRuleEngine.ts";

test("FeedPlausibilityRuleEngine validates rule configs at startup and classifies readings into accept, reject, or quarantine", () => {
  const engine = new FeedPlausibilityRuleEngine();

  // Invalid rule config (min > max) rejected at startup
  assert.throws(() =>
    engine.registerRule({
      ruleId: "bad-rule",
      feedId: "TEMP_C",
      field: "celsius",
      minAllowed: 60,
      maxAllowed: -60,
      allowZeroOrNegative: true,
      violationAction: "reject",
    })
  );

  engine.registerRule({
    ruleId: "rule-wind-bounds",
    feedId: "WIND_KPH",
    field: "windSpeed",
    minAllowed: 0,
    maxAllowed: 400,
    maxStepDelta: 120,
    allowZeroOrNegative: true,
    violationAction: "quarantine",
  });

  // Valid initial reading
  const ok1 = engine.evaluateReading({
    sourceId: "noaa-1",
    feedId: "WIND_KPH",
    fields: { windSpeed: 50 },
  });
  assert.equal(ok1.action, "accept");

  // Impossible step jump (50 -> 250 > 120 maxStepDelta) -> quarantine with ruleId & offendingField
  const jump = engine.evaluateReading({
    sourceId: "noaa-1",
    feedId: "WIND_KPH",
    fields: { windSpeed: 250 },
  });
  assert.equal(jump.action, "quarantine");
  assert.equal(jump.violatedRuleId, "rule-wind-bounds");
  assert.equal(jump.offendingField, "windSpeed");
  assert.equal(jump.reason, "max_step_delta_exceeded");
});
