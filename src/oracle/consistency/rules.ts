/**
 * Declarative cross-feed economic consistency rules.
 *
 * Each rule expresses an economic expectation between a *dependent* feed and one
 * or more *reference* feeds. Rules are evaluated after per-feed consensus and
 * before the dependent feed is published (see `evaluate.ts` and the post-consensus
 * gate in `oracleMonitor`).
 *
 * Design notes:
 * - Rules operate on canonicalized consensus values plus their timestamps so that
 *   replaying the same point-in-time inputs reproduces the same verdict.
 * - A rule is *skipped* (never failed) when either side of the pair is missing or
 *   stale relative to the rule's freshness window.
 * - Severity is configurable per rule: `warn` annotates + emits a metric, `block`
 *   holds publication and trips the relevant circuit breaker.
 */

export type ConsistencySeverity = 'warn' | 'block';

/** A canonicalized consensus value for a single feed at a point in time. */
export interface ConsensusValue {
  /** Feed identifier, e.g. `liquidation-volume`, `price`, `tvl`. */
  feed: string;
  /** Canonicalized consensus value. */
  value: number;
  /** ISO timestamp of the observation the consensus was computed from. */
  timestamp: string;
}

/**
 * A sign/ratio constraint between the dependent feed and a reference feed.
 * `expect` describes the economically expected relationship.
 */
export type RatioConstraint =
  | { kind: 'same-sign' }
  | { kind: 'opposite-sign' }
  | { kind: 'ratio-at-least'; ratio: number }
  | { kind: 'ratio-at-most'; ratio: number };

export interface ConsistencyRule {
  /** Stable identifier used in events, metrics and persisted evaluations. */
  id: string;
  /** Human-readable description of the economic expectation. */
  description: string;
  /** Rationale documented for operators and reviewers. */
  rationale: string;
  /** The feed whose publication this rule gates. */
  dependentFeed: string;
  /** Reference feed(s) the dependent feed must agree with. */
  referenceFeeds: string[];
  /**
   * Maximum allowed lead/lag (ms) between the dependent and reference
   * observations. If exceeded the rule is skipped rather than failed.
   */
  maxLeadLagMs: number;
  /** Constraint applied to the dependent/reference relationship. */
  constraint: RatioConstraint;
  /** Configurable severity. */
  severity: ConsistencySeverity;
}

/**
 * Initial rule set for existing coverage types.
 *
 * LiquidationShield vs price/TVL:
 *   A liquidation-volume spike should coincide with either a price move or a TVL
 *   drawdown. A spike with flat price *and* flat TVL is economically implausible
 *   and is strong evidence of a spoofed/colluding liquidation source.
 *
 * FlightDelay vs route disruption:
 *   A flight-delay rate spike should be accompanied by a route disruption signal.
 *   A delay spike with no disruption signal indicates an incoherent delay source.
 */
export const DEFAULT_CONSISTENCY_RULES: ConsistencyRule[] = [
  {
    id: 'liquidation-spike-requires-price-or-tvl-move',
    description:
      'Liquidation volume spikes must be accompanied by a price move or TVL drawdown',
    rationale:
      'Liquidations are triggered by adverse price moves and reduce TVL. A spike with ' +
      'flat price and flat TVL cannot be economically real and points to a bad source.',
    dependentFeed: 'liquidation-volume',
    referenceFeeds: ['price', 'tvl'],
    maxLeadLagMs: 5 * 60 * 1000,
    constraint: { kind: 'ratio-at-least', ratio: 0 },
    severity: 'warn',
  },
  {
    id: 'flight-delay-spike-requires-route-disruption',
    description: 'Flight-delay rate spikes must coincide with a route disruption signal',
    rationale:
      'Delays are caused by disruptions (weather, closures, strikes). A delay spike ' +
      'without any disruption signal is incoherent and suggests a spoofed delay feed.',
    dependentFeed: 'flight-delay-rate',
    referenceFeeds: ['route-disruption'],
    maxLeadLagMs: 30 * 60 * 1000,
    constraint: { kind: 'same-sign' },
    severity: 'warn',
  },
];

/** Look up the rules that gate a given dependent feed. */
export function rulesForFeed(
  feed: string,
  rules: ConsistencyRule[] = DEFAULT_CONSISTENCY_RULES,
): ConsistencyRule[] {
  return rules.filter((rule) => rule.dependentFeed === feed);
}
