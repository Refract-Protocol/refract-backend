import { test } from "node:test";
import assert from "node:assert/strict";
import { SourceWarmupGate } from "./sourceWarmupGate.ts";

test("SourceWarmupGate enforces minReadingCount, minObservationWindowMs, minAgreementRate, and resets on un-quarantine", () => {
  const gate = new SourceWarmupGate({
    minReadingCount: 3,
    minObservationWindowMs: 10_000,
    minAgreementRate: 0.8,
  });

  gate.registerOrResetWarmup("new-weather-api", 1_000);
  assert.equal(gate.isConsensusEligible("new-weather-api"), false);

  gate.recordShadowReading({ sourceId: "new-weather-api", observedAtMs: 4_000, agreedWithConsensus: true });
  gate.recordShadowReading({ sourceId: "new-weather-api", observedAtMs: 8_000, agreedWithConsensus: true });
  // 3rd reading before 10_000ms window elapsed -> still warming_up
  gate.recordShadowReading({ sourceId: "new-weather-api", observedAtMs: 9_000, agreedWithConsensus: true });
  assert.equal(gate.isConsensusEligible("new-weather-api"), false);

  // Reading at 12_000ms satisfies both count (4 >= 3), window (11_000 >= 10_000), and agreement (1.0 >= 0.8)
  gate.recordShadowReading({ sourceId: "new-weather-api", observedAtMs: 12_000, agreedWithConsensus: true });
  assert.equal(gate.isConsensusEligible("new-weather-api"), true);

  // Quarantine and un-quarantine forces source back into warming_up
  gate.quarantineSource("new-weather-api");
  assert.equal(gate.isConsensusEligible("new-weather-api"), false);
  const resetState = gate.unQuarantineSource("new-weather-api", 20_000);
  assert.equal(resetState.status, "warming_up");
  assert.equal(gate.isConsensusEligible("new-weather-api"), false);
});
