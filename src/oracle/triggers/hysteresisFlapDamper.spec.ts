import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TriggerHysteresisFlapDamper,
  type TriggerHysteresisConfig,
} from "./hysteresisFlapDamper.ts";

describe("Trigger-State Hysteresis and Flap Damping for Threshold-Based Payout Conditions (#234)", () => {
  it("enforces minimum dwell time, suppresses deadband oscillations, and limits transitions per window via flap damping", () => {
    const damper = new TriggerHysteresisFlapDamper();
    const config: TriggerHysteresisConfig = {
      feedId: "USDC/USD",
      direction: "below",
      enterThreshold: 0.95,
      exitThreshold: 0.98,
      minDwellTimeMs: 20_000,
      flapWindowMs: 120_000,
      maxTransitionsPerWindow: 2,
    };

    const t0 = 1_700_000_000_000;

    // 1. Breach enterThreshold at t0 ($0.94) -> starts dwell timer, does not transition yet
    const r1 = damper.evaluateReading({
      config,
      value: 0.94,
      evidenceDecisionId: "dec-1",
      nowMs: t0,
    });
    assert.equal(r1.stabilizedState, "untriggered");
    assert.equal(r1.suppressionReason, "DWELL_TIME_NOT_ELAPSED");

    // 2. Sustained breach at t0 + 25s -> dwell time (20s) satisfied, transitions to triggered (transition #1)
    const r2 = damper.evaluateReading({
      config,
      value: 0.935,
      evidenceDecisionId: "dec-2",
      nowMs: t0 + 25_000,
    });
    assert.equal(r2.stabilizedState, "triggered");
    assert.equal(r2.transitionAccepted, true);

    // 3. Value rises to $0.965 (inside hysteresis deadband (0.95, 0.98)) -> stays triggered without resetting
    const r3 = damper.evaluateReading({
      config,
      value: 0.965,
      evidenceDecisionId: "dec-3",
      nowMs: t0 + 30_000,
    });
    assert.equal(r3.stabilizedState, "triggered");
    assert.equal(r3.suppressionReason, "WITHIN_HYSTERESIS_DEADBAND");

    // 4. Value recovers above exitThreshold ($0.99) for 20s -> transitions back to untriggered (transition #2)
    damper.evaluateReading({
      config,
      value: 0.99,
      evidenceDecisionId: "dec-4",
      nowMs: t0 + 40_000,
    });
    const r5 = damper.evaluateReading({
      config,
      value: 0.992,
      evidenceDecisionId: "dec-5",
      nowMs: t0 + 62_000,
    });
    assert.equal(r5.stabilizedState, "untriggered");
    assert.equal(r5.transitionAccepted, true);

    // 5. Third transition attempt within the 120s flap window is damped and logged/alerted
    damper.evaluateReading({
      config,
      value: 0.92,
      evidenceDecisionId: "dec-6",
      nowMs: t0 + 70_000,
    });
    const r7 = damper.evaluateReading({
      config,
      value: 0.91,
      evidenceDecisionId: "dec-7",
      nowMs: t0 + 95_000,
    });
    assert.equal(r7.stabilizedState, "untriggered");
    assert.equal(r7.transitionAccepted, false);
    assert.equal(r7.suppressionReason, "FLAP_DAMPING_LIMIT_REACHED");
    assert.equal(damper.getSuppressedAlerts().length, 1);
    assert.equal(damper.getTransitionLog().length, 2);
  });
});
