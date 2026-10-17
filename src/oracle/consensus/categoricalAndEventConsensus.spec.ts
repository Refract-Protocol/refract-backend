import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateCategoricalConsensus,
  evaluateDiscreteEventConsensus,
} from "./categoricalAndEventConsensus.ts";

describe("Categorical and Event-Based Consensus for Non-Numeric Oracle Feeds (#217)", () => {
  it("deduplicates identical upstream origins and enforces supermajority quorum for categorical FlightDelay feeds", () => {
    // 2 adapters sharing the same upstream origin should only count as 1 vote
    const proxyOnly = evaluateCategoricalConsensus(
      [
        {
          sourceId: "flightaware-primary",
          upstreamOrigin: "flightaware_adsb_network",
          category: "CANCELLED",
          observedAtMs: 1_000,
        },
        {
          sourceId: "flightaware-mirror",
          upstreamOrigin: "flightaware_adsb_network",
          category: "CANCELLED",
          observedAtMs: 1_100,
        },
      ],
      {
        expectedTotalOrigins: 3,
        minDistinctOrigins: 2,
        supermajorityRatio: 0.66,
      }
    );
    assert.equal(proxyOnly.status, "partial_reporting");
    assert.equal(proxyOnly.agreedCategory, null);

    // 2 distinct origins agreeing on CANCELLED out of 3 total origins (66.7% >= 66%) -> corroborated
    const corroborated = evaluateCategoricalConsensus(
      [
        {
          sourceId: "flightaware-primary",
          upstreamOrigin: "flightaware_adsb_network",
          category: "CANCELLED",
          observedAtMs: 1_000,
        },
        {
          sourceId: "cirium-direct",
          upstreamOrigin: "cirium_airline_ops_feed",
          category: "CANCELLED",
          observedAtMs: 1_050,
        },
        {
          sourceId: "oag-status",
          upstreamOrigin: "oag_schedule_feed",
          category: "DELAYED_120M_PLUS",
          observedAtMs: 1_020,
        },
      ],
      {
        expectedTotalOrigins: 3,
        minDistinctOrigins: 2,
        supermajorityRatio: 0.66,
      }
    );
    assert.equal(corroborated.status, "corroborated");
    assert.equal(corroborated.agreedCategory, "CANCELLED");
    assert.equal(corroborated.agreeingOrigins.length, 2);
    assert.equal(corroborated.dissentingOrigins.length, 1);
    assert.ok(corroborated.confidenceBps >= 7_000);
  });

  it("matches discrete LiquidationShield events across jittered timestamps and magnitude tolerance", () => {
    const baseTimeMs = 1_700_000_000_000;

    const corroboratedEvent = evaluateDiscreteEventConsensus(
      [
        {
          sourceId: "binance-ws",
          upstreamOrigin: "binance_futures_liquidation_stream",
          asset: "BTC",
          venue: "binance-perp",
          magnitudeUsd: 12_400_000,
          occurredAtMs: baseTimeMs,
        },
        {
          sourceId: "coinglass-indexer",
          upstreamOrigin: "coinglass_liquidation_aggregator",
          asset: "btc",
          venue: "BINANCE-PERP",
          magnitudeUsd: 12_600_000, // ~1.6% diff, within 5% tolerance
          occurredAtMs: baseTimeMs + 4_000, // 4s skew, within 15s window
        },
      ],
      {
        minDistinctOrigins: 2,
        maxTimeSkewMs: 15_000,
        magnitudeToleranceRatio: 0.05,
      }
    );

    assert.equal(corroboratedEvent.status, "corroborated");
    assert.equal(corroboratedEvent.corroborated, true);
    assert.equal(corroboratedEvent.asset, "BTC");
    assert.equal(corroboratedEvent.agreedMagnitudeUsd, 12_500_000);
    assert.equal(corroboratedEvent.agreedOccurredAtMs, baseTimeMs + 2_000);

    // Events outside the time skew or magnitude tolerance return disagreement_split
    const splitEvent = evaluateDiscreteEventConsensus(
      [
        {
          sourceId: "binance-ws",
          upstreamOrigin: "binance_futures_liquidation_stream",
          asset: "BTC",
          venue: "binance-perp",
          magnitudeUsd: 12_400_000,
          occurredAtMs: baseTimeMs,
        },
        {
          sourceId: "coinglass-indexer",
          upstreamOrigin: "coinglass_liquidation_aggregator",
          asset: "BTC",
          venue: "binance-perp",
          magnitudeUsd: 25_000_000, // >100% divergence
          occurredAtMs: baseTimeMs + 2_000,
        },
      ],
      {
        minDistinctOrigins: 2,
        maxTimeSkewMs: 15_000,
        magnitudeToleranceRatio: 0.05,
      }
    );

    assert.equal(splitEvent.status, "disagreement_split");
    assert.equal(splitEvent.corroborated, false);
  });
});
