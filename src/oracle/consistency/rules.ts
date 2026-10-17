/**
 * Declarative Cross-Feed Economic Consistency Rules (Issue #280)
 *
 * Defines economic and operational invariants across correlated Refract feeds
 * with explicit lead/lag timing windows and severity levels.
 */

export type ConsistencyRuleSeverity = "warn" | "block";

export interface CorroboratingFeedCondition {
  feedId: string;
  /** Minimum value (in basis points or normalized index units) expected when primary trigger fires */
  minExpectedValueBps: number;
}

export interface CrossFeedConsistencyRule {
  ruleId: string;
  description: string;
  /** Feed being evaluated prior to round finalization */
  primaryFeedId: string;
  /** Threshold at or above which the primary feed requires cross-feed corroboration */
  primaryTriggerThresholdBps: number;
  /**
   * Corroborating feeds. Satisfaction requires AT LEAST ONE corroborating feed
   * to be present within `maxLeadLagWindowMs` and at or above `minExpectedValueBps`.
   */
  corroboratingFeeds: CorroboratingFeedCondition[];
  /** Maximum allowed timestamp difference |t_primary - t_corroborating| in milliseconds */
  maxLeadLagWindowMs: number;
  /** Action when all present, fresh corroborating feeds contradict the primary feed */
  severity: ConsistencyRuleSeverity;
  /** Confidence score penalty (in basis points) applied when rule is violated */
  confidencePenaltyBps: number;
}

export const DEFAULT_CROSS_FEED_CONSISTENCY_RULES: CrossFeedConsistencyRule[] = [
  {
    ruleId: "liquidation_shield_requires_market_or_protocol_stress",
    description:
      "High liquidation volume on LiquidationShield requires corroborating stress on either MarketCrash or SmartContractRisk within the lead/lag window",
    primaryFeedId: "LiquidationShield",
    primaryTriggerThresholdBps: 5_000, // >= 50% liquidation surge index
    corroboratingFeeds: [
      { feedId: "MarketCrash", minExpectedValueBps: 1_500 }, // >= 15% market drawdown/volatility index
      { feedId: "SmartContractRisk", minExpectedValueBps: 2_500 }, // or >= 25% protocol exploit/risk signal
    ],
    maxLeadLagWindowMs: 15 * 60 * 1000, // 15 minutes lead/lag window
    severity: "block",
    confidencePenaltyBps: 4_000,
  },
  {
    ruleId: "extreme_stablecoin_depeg_market_stress_check",
    description:
      "Extreme StablecoinDepeg (>500 bps depeg) with zero correlated MarketCrash stress requires secondary confirmation",
    primaryFeedId: "StablecoinDepeg",
    primaryTriggerThresholdBps: 500, // >= 5% depeg
    corroboratingFeeds: [
      { feedId: "MarketCrash", minExpectedValueBps: 500 }, // >= 5% market stress index
    ],
    maxLeadLagWindowMs: 10 * 60 * 1000, // 10 minutes lead/lag window
    severity: "warn",
    confidencePenaltyBps: 2_000,
  },
  {
    ruleId: "single_flight_cancellation_route_anomaly_check",
    description:
      "Severe single-flight delay/cancellation on FlightDelay when airport/route-wide RouteDisruptionIndex is 0 bps receives elevated scrutiny",
    primaryFeedId: "FlightDelay",
    primaryTriggerThresholdBps: 10_000, // 100% (cancelled / severe delay trigger)
    corroboratingFeeds: [
      { feedId: "RouteDisruptionIndex", minExpectedValueBps: 200 }, // >= 2% route/airport delay index
    ],
    maxLeadLagWindowMs: 30 * 60 * 1000, // 30 minutes lead/lag window
    severity: "warn",
    confidencePenaltyBps: 1_500,
  },
];
