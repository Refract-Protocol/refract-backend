import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OracleFeedConfigStaticLinter } from "./feedQuorumStaticLinter.ts";

describe("Startup Validation and Static Linting for Oracle Feed and Quorum Configuration (#236)", () => {
  it("reports all cross-field invariant violations, tolerates disabled feeds, and emits a deterministic redacted effective config dump", () => {
    const validAndDisabledFeeds = [
      {
        feedId: "USDC/USD",
        enabled: true,
        trustMode: "corroborated" as const,
        quorumMinimum: 2,
        pollIntervalMs: 10_000,
        freshnessWindowMs: 30_000,
        maxDivergenceRatio: 0.02,
        sources: [
          {
            sourceId: "coingecko",
            upstreamOrigin: "coingecko_aggregator",
            enabled: true,
            apiKey: "cg_live_secret_123",
          },
          {
            sourceId: "pyth",
            upstreamOrigin: "pyth_publishers",
            enabled: true,
          },
        ],
      },
      {
        feedId: "FLIGHT_LEGACY",
        enabled: false, // Disabled feed tolerated even with 0 enabled sources
        trustMode: "corroborated" as const,
        quorumMinimum: 2,
        pollIntervalMs: 10_000,
        freshnessWindowMs: 5_000,
        maxDivergenceRatio: 0.02,
        sources: [],
      },
    ];

    const okRes = OracleFeedConfigStaticLinter.lintConfiguration(
      validAndDisabledFeeds
    );
    assert.equal(okRes.valid, true);
    assert.equal(okRes.violations.length, 0);

    const dump = OracleFeedConfigStaticLinter.renderRedactedEffectiveConfigJson(
      validAndDisabledFeeds
    );
    assert.ok(!dump.includes("cg_live_secret_123"));
    assert.ok(dump.includes("[REDACTED]"));

    // Invalid feed violating duplicate sourceId, short freshness window, out-of-range divergence, and quorum > distinct origins
    const invalidRes = OracleFeedConfigStaticLinter.lintConfiguration([
      {
        feedId: "BROKEN_FEED",
        enabled: true,
        trustMode: "corroborated",
        quorumMinimum: 2,
        pollIntervalMs: 15_000,
        freshnessWindowMs: 20_000, // < 15_000 * 2
        maxDivergenceRatio: 0.85, // > 0.50
        sources: [
          {
            sourceId: "dup-src",
            upstreamOrigin: "same_origin",
            enabled: true,
          },
          {
            sourceId: "dup-src",
            upstreamOrigin: "same_origin",
            enabled: true,
          },
        ],
      },
    ]);

    assert.equal(invalidRes.valid, false);
    const rules = invalidRes.violations.map((v) => v.ruleId).sort();
    assert.deepEqual(rules, [
      "ANOMALY_THRESHOLD_OUT_OF_RANGE",
      "DUPLICATE_SOURCE_ID",
      "FRESHNESS_WINDOW_TOO_SHORT",
      "QUORUM_EXCEEDS_INDEPENDENT_ORIGINS",
    ]);
  });
});
