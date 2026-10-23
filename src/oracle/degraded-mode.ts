/**
 * Per-feed degraded-mode state machine (issue #195).
 *
 *   healthy ──(any failed corroboration check)──▶ degraded
 *   degraded ──(consecutiveFailures ≥ pauseAfterFailures)──▶ paused
 *   degraded ──(clean observation)──▶ healthy
 *   paused   ──(operator resume only)──▶ healthy
 *
 * Policy is fail-closed: only `healthy` permits publishing a payout-triggering
 * value on-chain or settling a claim. `degraded` and `paused` both block; the
 * difference is operator visibility (paused requires manual resume).
 *
 * This module is pure: it holds no I/O and no clock. The oracle subsystem
 * persists FeedState (table `oracle_feed_state`) and both the publisher and the
 * claim processor must read it through `isPayoutAllowed` rather than making
 * their own decisions. Transitions are idempotent: re-applying the same
 * observation to the resulting state returns the same state.
 */

export enum FeedHealth {
  Healthy = "healthy",
  Degraded = "degraded",
  Paused = "paused",
}

/** Why corroboration failed. Stored on feed state and copied to blocked claims. */
export enum DegradedReason {
  /** Fewer sources answered than the quorum requires, but some answered. */
  QuorumShortfall = "quorum_shortfall",
  /** No source returned a fresh reading. */
  NoFreshSources = "no_fresh_sources",
  /** Quorum answered but the sources disagree beyond tolerance. */
  SourcesDivergent = "sources_divergent",
  /** The consensus engine itself errored or timed out. */
  ConsensusUnavailable = "consensus_unavailable",
}

export interface FeedState {
  coverageType: number;
  health: FeedHealth;
  reason: DegradedReason | null;
  consecutiveFailures: number;
}

/** `null` reason means corroboration was satisfied for this evaluation. */
export interface FeedObservation {
  reason: DegradedReason | null;
}

export interface FeedPolicy {
  /** Consecutive failed evaluations before degraded escalates to paused. */
  pauseAfterFailures: number;
}

/**
 * Declarative policy, keyed by Coverage type (see src/common/coverage-catalog.ts).
 * Reviewed and audited as a unit; change here, not in call sites.
 */
export const DEGRADED_MODE_POLICY: Readonly<Record<number, FeedPolicy>> = {
  0: { pauseAfterFailures: 5 }, // StablecoinDepeg
  1: { pauseAfterFailures: 5 }, // MarketCrash
  2: { pauseAfterFailures: 5 }, // LiquidationShield
  3: { pauseAfterFailures: 5 }, // SmartContractRisk
  4: { pauseAfterFailures: 10 }, // FlightDelay: slower feed, tolerate more retries
};

export function initialFeedState(coverageType: number): FeedState {
  return { coverageType, health: FeedHealth.Healthy, reason: null, consecutiveFailures: 0 };
}

/**
 * Applies one corroboration evaluation to a feed. Returns the same object when
 * nothing changes so callers can skip writes on repeated evaluations.
 */
export function applyObservation(
  state: FeedState,
  observation: FeedObservation,
  policy: FeedPolicy = DEGRADED_MODE_POLICY[state.coverageType],
): FeedState {
  // Paused is sticky: only an operator resume leaves it.
  if (state.health === FeedHealth.Paused) return state;

  if (observation.reason === null) {
    if (state.health === FeedHealth.Healthy && state.consecutiveFailures === 0) return state;
    return { ...state, health: FeedHealth.Healthy, reason: null, consecutiveFailures: 0 };
  }

  const consecutiveFailures = state.consecutiveFailures + 1;
  const health =
    consecutiveFailures >= policy.pauseAfterFailures ? FeedHealth.Paused : FeedHealth.Degraded;
  if (
    health === state.health &&
    observation.reason === state.reason &&
    consecutiveFailures === state.consecutiveFailures
  ) {
    return state;
  }
  return { ...state, health, reason: observation.reason, consecutiveFailures };
}

/** Operator action: the only way out of `paused`. */
export function resumeFeed(state: FeedState): FeedState {
  if (state.health !== FeedHealth.Paused) return state;
  return { ...state, health: FeedHealth.Healthy, reason: null, consecutiveFailures: 0 };
}

/** Publishing and settlement both require a healthy feed (fail-closed). */
export function isPayoutAllowed(state: FeedState): boolean {
  return state.health === FeedHealth.Healthy;
}
