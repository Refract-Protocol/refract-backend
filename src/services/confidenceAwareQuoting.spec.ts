import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConfidenceAwareQuotingService } from "./confidenceAwareQuoting.ts";

describe("Factor Oracle Confidence into Premium Quoting and Coverage Availability (#208)", () => {
  it("applies bounded risk multipliers in degraded mode, returns 1.0x in available mode, and smooths transient confidence flaps", () => {
    const quoting = new ConfidenceAwareQuotingService({
      fullConfidenceBps: 8_500,
      minAvailableConfidenceBps: 6_000,
      maxRiskMultiplier: 1.5,
      maxTelemetryAgeMs: 60_000,
      smoothingAlpha: 0.5,
    });

    const nowMs = 1_700_000_000_000;

    // 1. High confidence (9,000 bps) -> available, 1.0x multiplier
    quoting.recordConfidenceTelemetry({
      coverageType: "stablecoin-depeg",
      rawConfidenceBps: 9_000,
      isMockedSource: false,
      circuitBreakerTripped: false,
      updatedAtMs: nowMs,
    });

    const availableQuote = quoting.computeQuote({
      coverageType: "stablecoin-depeg",
      basePremiumUsd: 100,
      nowMs,
    });
    assert.equal(availableQuote.httpStatus, 200);
    assert.equal(availableQuote.availability, "available");
    assert.equal(availableQuote.riskMultiplier, 1.0);
    assert.equal(availableQuote.finalPremiumUsd, 100);
    assert.equal(availableQuote.warning, null);

    // 2. Single-sample drop to 5,500 bps is smoothed via EMA (0.5 * 5500 + 0.5 * 9000 = 7250 bps -> degraded, not unavailable)
    quoting.recordConfidenceTelemetry({
      coverageType: "stablecoin-depeg",
      rawConfidenceBps: 5_500,
      isMockedSource: false,
      circuitBreakerTripped: false,
      updatedAtMs: nowMs + 5_000,
    });

    const degradedQuote = quoting.computeQuote({
      coverageType: "stablecoin-depeg",
      basePremiumUsd: 100,
      nowMs: nowMs + 5_000,
    });
    assert.equal(degradedQuote.httpStatus, 200);
    assert.equal(degradedQuote.availability, "degraded");
    assert.equal(degradedQuote.smoothedConfidenceBps, 7_250);
    // 7250 is midpoint between 8500 and 6000 -> multiplier 1.25x
    assert.equal(degradedQuote.riskMultiplier, 1.25);
    assert.equal(degradedQuote.finalPremiumUsd, 125);
    assert.ok(degradedQuote.warning?.includes("1.25x"));
  });

  it("deterministically blocks quoting (409 unavailable) for mocked sources, tripped circuit breakers, or low/stale confidence", () => {
    const quoting = new ConfidenceAwareQuotingService({
      fullConfidenceBps: 8_500,
      minAvailableConfidenceBps: 6_000,
      maxRiskMultiplier: 1.5,
      maxTelemetryAgeMs: 60_000,
      smoothingAlpha: 1.0,
    });

    const nowMs = 1_700_000_000_000;

    // Mocked coverage source cannot be quoted even if rawConfidenceBps is 10_000
    quoting.recordConfidenceTelemetry({
      coverageType: "flight-delay",
      rawConfidenceBps: 10_000,
      isMockedSource: true,
      circuitBreakerTripped: false,
      updatedAtMs: nowMs,
    });

    const mockedQuote = quoting.computeQuote({
      coverageType: "flight-delay",
      basePremiumUsd: 50,
      nowMs,
    });
    assert.equal(mockedQuote.httpStatus, 409);
    assert.equal(mockedQuote.availability, "unavailable");
    assert.equal(mockedQuote.finalPremiumUsd, null);
    assert.equal(mockedQuote.errorCode, "COVERAGE_MOCK_SOURCE_UNQUOTABLE");

    // Low confidence (< 6000 bps) -> unavailable
    quoting.recordConfidenceTelemetry({
      coverageType: "protocol-exploit",
      rawConfidenceBps: 4_500,
      isMockedSource: false,
      circuitBreakerTripped: false,
      updatedAtMs: nowMs,
    });
    const lowConfQuote = quoting.computeQuote({
      coverageType: "protocol-exploit",
      basePremiumUsd: 200,
      nowMs,
    });
    assert.equal(lowConfQuote.httpStatus, 409);
    assert.equal(lowConfQuote.errorCode, "COVERAGE_CONFIDENCE_TOO_LOW");
  });
});
