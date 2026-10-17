import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OracleObservabilityMonitor } from "./oracleMetricsAndAlerting.ts";

describe("Oracle Observability: Staleness, Divergence, and Quorum Metrics with Alerting (#182)", () => {
  it("records all 6 required Prometheus metrics with bounded sanitized labels and emits alerts only after N consecutive breaches", () => {
    const monitor = new OracleObservabilityMonitor({
      config: {
        maxReadingAgeSeconds: 60,
        maxDispersionRatio: 0.03,
        minConsecutiveBreachesBeforeAlert: 3,
      },
    });

    monitor.recordSourceRequest({
      source: "coingecko-primary",
      durationSeconds: 0.185,
      failed: false,
    });
    monitor.recordSourceRequest({
      source: "pyth-hermes",
      durationSeconds: 0.42,
      failed: true,
    });

    // Interval 1 & 2: stale reading (90s > 60s), should NOT alert yet (< 3 consecutive breaches)
    monitor.recordFeedEvaluation({
      coverageType: "stablecoin-depeg",
      readingAgeSeconds: 90,
      dispersionRatio: 0.01,
      quorumFailed: false,
      breakerState: "closed",
      nowMs: 1_000,
    });
    monitor.recordFeedEvaluation({
      coverageType: "stablecoin-depeg",
      readingAgeSeconds: 105,
      dispersionRatio: 0.01,
      quorumFailed: false,
      breakerState: "closed",
      nowMs: 2_000,
    });
    assert.equal(monitor.getEmittedAlerts().length, 0);

    // Interval 3: 3rd consecutive breach triggers FEED_STALENESS_BREACH alert with operator_pause guidance
    monitor.recordFeedEvaluation({
      coverageType: "stablecoin-depeg",
      readingAgeSeconds: 125,
      dispersionRatio: 0.01,
      quorumFailed: true,
      breakerState: "open",
      nowMs: 3_000,
    });

    const alerts = monitor.getEmittedAlerts();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.alertType, "FEED_STALENESS_BREACH");
    assert.equal(alerts[0]?.consecutiveBreaches, 3);
    assert.equal(alerts[0]?.recommendedControl, "operator_pause");

    const metricsOutput = monitor.renderPrometheusMetrics();
    assert.ok(
      metricsOutput.includes(
        'oracle_source_request_duration_seconds{source="coingecko-primary"} 0.185'
      )
    );
    assert.ok(
      metricsOutput.includes(
        'oracle_source_failures_total{source="pyth-hermes"} 1'
      )
    );
    assert.ok(
      metricsOutput.includes(
        'oracle_reading_age_seconds{coverage_type="stablecoin-depeg"} 125'
      )
    );
    assert.ok(
      metricsOutput.includes(
        'oracle_source_dispersion{coverage_type="stablecoin-depeg"} 0.01'
      )
    );
    assert.ok(
      metricsOutput.includes(
        'oracle_quorum_failures_total{coverage_type="stablecoin-depeg"} 1'
      )
    );
    assert.ok(
      metricsOutput.includes(
        'oracle_breaker_state{coverage_type="stablecoin-depeg"} 2'
      )
    );
  });
});
