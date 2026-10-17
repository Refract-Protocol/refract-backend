import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AdaptivePollingController,
  type SourceCadencePolicy,
} from "./adaptiveCadence.ts";

describe("AdaptivePollingController (Issue #243)", () => {
  const defaultPolicy: SourceCadencePolicy = {
    sourceId: "noaa-station-1",
    feedId: "rainfall-miami",
    minIntervalMs: 5_000,
    baseIntervalMs: 30_000,
    maxIntervalMs: 120_000,
    freshnessWindowMs: 90_000,
    minModeDwellMs: 20_000,
    volatilityEnterThreshold: 0.4,
    volatilityExitThreshold: 0.2,
    proximityEnterRatio: 0.1,
    proximityExitRatio: 0.25,
    quotaLowRatioThreshold: 0.15,
    jitterFraction: 0.04,
  };

  it("accelerates cadence on volatility and threshold proximity, and enforces dwell time + hysteresis before returning to base", () => {
    const controller = new AdaptivePollingController();
    controller.registerSourcePolicy(defaultPolicy);

    const t0 = 1_700_000_000_000;
    const baseDecision = controller.evaluateNextCadence({
      sourceId: "noaa-station-1",
      nowMs: t0,
      recentVolatility: 0.05,
      distanceToPayoutThresholdRatio: 0.8,
    });
    assert.equal(baseDecision.currentMode, "base");

    // Spike in volatility at t0 + 5_000 -> accelerates immediately
    const volDecision = controller.evaluateNextCadence({
      sourceId: "noaa-station-1",
      nowMs: t0 + 5_000,
      recentVolatility: 0.55,
      distanceToPayoutThresholdRatio: 0.8,
    });
    assert.equal(volDecision.currentMode, "accelerated_volatile");
    assert.equal(volDecision.transitioned, true);
    assert.ok(volDecision.effectiveIntervalMs < baseDecision.effectiveIntervalMs);

    // Volatility drops to 0.1 at t0 + 10_000 (only 5s elapsed < 20s dwell time) -> holds accelerated_volatile
    const dwellHold = controller.evaluateNextCadence({
      sourceId: "noaa-station-1",
      nowMs: t0 + 10_000,
      recentVolatility: 0.1,
      distanceToPayoutThresholdRatio: 0.8,
    });
    assert.equal(dwellHold.currentMode, "accelerated_volatile");
    assert.equal(dwellHold.transitionReason, "dwell_time_hold");

    // At t0 + 30_000 (25s elapsed >= 20s dwell), volatility is 0.25 (between exit 0.20 and enter 0.40) -> hysteresis hold
    const hysteresisHold = controller.evaluateNextCadence({
      sourceId: "noaa-station-1",
      nowMs: t0 + 30_000,
      recentVolatility: 0.25,
      distanceToPayoutThresholdRatio: 0.8,
    });
    assert.equal(hysteresisHold.currentMode, "accelerated_volatile");
    assert.equal(hysteresisHold.transitionReason, "hysteresis_hold_volatility");

    // At t0 + 35_000, volatility drops to 0.12 (<= exit 0.20) -> returns to base
    const calmed = controller.evaluateNextCadence({
      sourceId: "noaa-station-1",
      nowMs: t0 + 35_000,
      recentVolatility: 0.12,
      distanceToPayoutThresholdRatio: 0.8,
    });
    assert.equal(calmed.currentMode, "base");
    assert.equal(calmed.transitioned, true);
  });

  it("slows cadence under quota pressure and error backoff while clamping strictly to freshnessWindowMs", () => {
    const controller = new AdaptivePollingController();
    controller.registerSourcePolicy(defaultPolicy);

    const t0 = 1_700_000_000_000;
    const quotaPressured = controller.evaluateNextCadence({
      sourceId: "noaa-station-1",
      nowMs: t0,
      remainingQuotaRatio: 0.05,
      receivedHttp429: true,
    });
    assert.equal(quotaPressured.currentMode, "pressured_quota");
    assert.ok(quotaPressured.effectiveIntervalMs > defaultPolicy.baseIntervalMs);
    assert.ok(quotaPressured.effectiveIntervalMs <= defaultPolicy.freshnessWindowMs);

    // Severe consecutive errors -> exponential backoff still clamped to freshnessWindowMs (90,000ms)
    const backoff = controller.evaluateNextCadence({
      sourceId: "noaa-station-1",
      nowMs: t0 + 40_000,
      consecutiveErrors: 5,
    });
    assert.equal(backoff.currentMode, "error_backoff");
    assert.equal(backoff.freshnessCeilingMs, 90_000);
    assert.ok(backoff.effectiveIntervalMs <= 90_000);
    assert.equal(
      backoff.evidenceMetadata.effectiveIntervalMs,
      backoff.effectiveIntervalMs
    );
  });
});
