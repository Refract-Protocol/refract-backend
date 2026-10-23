/**
 * Attack-cost model for oracle feeds.
 *
 * This module is a pure, versioned function library that estimates the cost of
 * corrupting a feed's consensus under a given quorum policy, and derives the
 * minimum operator bond and maximum supportable payout exposure.
 *
 * Threat vectors modeled:
 *   - Source bribery: cost to bribe enough sources to reach the quorum threshold.
 *   - Collusion threshold: cost of colluding sources (weighted by independence).
 *   - Key compromise: cost to compromise enough operator keys to reach quorum.
 *
 * All monetary arithmetic is performed in bigint (base units) to avoid
 * floating-point overflow/precision issues. Ratios are expressed as bigint
 * numerator/denominator pairs and converted to numbers only for display.
 *
 * Versioning: MODEL_VERSION is bumped whenever the model's semantics change.
 * It is embedded in trust documentation and validation error messages so a
 * published number can be reproduced against a specific model version.
 */

/** Version of the attack-cost model. Bump on any semantic change. */
export const MODEL_VERSION = '1.0.0';

/** Basis-points denominator used for ratio math. */
const BPS_DENOMINATOR = 10_000n;

/**
 * A source in a feed definition.
 *
 * `independenceWeight` is a value in [0, 1] describing how independent this
 * source is from the others. Unknown independence MUST be treated as fully
 * dependent (worst case), i.e. weight 0. We represent weights as basis points
 * (integer 0..10000) to keep arithmetic exact.
 */
export interface SourceDefinition {
  /** Stable identifier for the source. */
  id: string;
  /**
   * Independence weight in basis points (0..10000).
   * 10000 = fully independent, 0 = fully dependent (worst case).
   * If omitted or unknown, treated as 0 (fully dependent).
   */
  independenceWeightBps?: number | null;
  /**
   * Cost to bribe this source, in base units (bigint-compatible).
   * If omitted, the model falls back to the policy's default source bribe cost.
   */
  bribeCost?: bigint | number | string | null;
}

/**
 * An operator key that can participate in consensus.
 */
export interface OperatorDefinition {
  /** Stable identifier for the operator. */
  id: string;
  /**
   * Bond posted by this operator, in base units.
   * Zero-bond operators are permitted but contribute nothing to compromise cost.
   */
  bond: bigint | number | string;
  /**
   * Cost to compromise this operator's key, in base units.
   * If omitted, the model falls back to the policy's default key compromise cost.
   */
  keyCompromiseCost?: bigint | number | string | null;
}

/**
 * Quorum policy for a feed.
 */
export interface QuorumPolicy {
  /**
   * Number of sources required to reach source quorum.
   * Must be <= number of sources.
   */
  sourceQuorum: number;
  /**
   * Number of operator keys required to reach key quorum.
   * Must be <= number of operators.
   */
  keyQuorum: number;
  /**
   * Default cost to bribe a single source, in base units.
   * Used when a source does not specify its own bribeCost.
   */
  defaultSourceBribeCost: bigint | number | string;
  /**
   * Default cost to compromise a single operator key, in base units.
   * Used when an operator does not specify its own keyCompromiseCost.
   */
  defaultKeyCompromiseCost: bigint | number | string;
  /**
   * Safety factor in basis points (e.g. 20000 = 2x).
   * Exposure must not exceed attackCost / safetyFactor.
   */
  safetyFactorBps: number;
}

/**
 * A feed definition plus its quorum policy.
 */
export interface FeedDefinition {
  /** Feed identifier. */
  id: string;
  /** Sources that can attest to the feed. */
  sources: SourceDefinition[];
  /** Operators that can sign for the feed. */
  operators: OperatorDefinition[];
  /** Quorum policy. */
  policy: QuorumPolicy;
  /**
   * Maximum payout exposure the feed can trigger, in base units.
   * May be dynamic (e.g. derived from pool TVL); callers pass the current value.
   */
  maxPayoutExposure: bigint | number | string;
}

/**
 * Result of the attack-cost model.
 */
export interface AttackCostResult {
  /** Model version used to compute this result. */
  modelVersion: string;
  /** Cost to bribe enough sources to reach source quorum. */
  sourceBriberyCost: bigint;
  /** Cost of colluding sources, weighted by independence. */
  collusionThresholdCost: bigint;
  /** Cost to compromise enough operator keys to reach key quorum. */
  keyCompromiseCost: bigint;
  /**
   * Effective attack cost: the cheapest of the modeled vectors.
   * An attacker takes the cheapest path, so this is the binding constraint.
   */
  attackCost: bigint;
  /** Maximum supportable payout at the configured safety factor. */
  maxSupportablePayout: bigint;
  /** Implied minimum bond per operator to cover the exposure. */
  impliedMinimumBond: bigint;
  /** Whether the feed's exposure is within the modeled bound. */
  withinBound: boolean;
  /** Safety factor used (basis points). */
  safetyFactorBps: number;
}

/** Coerce a bigint-compatible value to bigint. */
function toBigInt(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot convert non-finite number to bigint: ${value}`);
    }
    if (!Number.isInteger(value)) {
      throw new Error(`Cannot convert non-integer number to bigint: ${value}`);
    }
    return BigInt(value);
  }
  return BigInt(value);
}

/** Clamp an independence weight (bps) into [0, 10000]. Unknown -> 0. */
function normalizeIndependenceBps(weight: number | null | undefined): bigint {
  if (weight === null || weight === undefined || !Number.isFinite(weight)) {
    // Unknown independence: treat as fully dependent (worst case).
    return 0n;
  }
  let w = Math.trunc(weight);
  if (w < 0) {
    w = 0;
  }
  if (w > 10_000) {
    w = 10_000;
  }
  return BigInt(w);
}

/** Ceiling division for non-negative bigints. */
function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error('ceilDiv denominator must be positive');
  }
  if (numerator <= 0n) {
    return 0n;
  }
  return (numerator + denominator - 1n) / denominator;
}

/** Multiply a bigint by a basis-points ratio, rounding up. */
function applyBps(value: bigint, bps: bigint): bigint {
  if (value <= 0n) {
    return 0n;
  }
  return ceilDiv(value * bps, BPS_DENOMINATOR);
}

/**
 * Compute the cost to bribe enough sources to reach the source quorum.
 *
 * The attacker picks the cheapest `sourceQuorum` sources to bribe. Independence
 * weights do not affect bribery cost directly (bribery is a direct payment),
 * but they do affect collusion cost below.
 */
export function computeSourceBriberyCost(
  sources: SourceDefinition[],
  policy: QuorumPolicy,
): bigint {
  if (policy.sourceQuorum <= 0) {
    return 0n;
  }
  if (policy.sourceQuorum > sources.length) {
    throw new Error(
      `sourceQuorum (${policy.sourceQuorum}) exceeds number of sources (${sources.length})`,
    );
  }
  const defaultCost = toBigInt(policy.defaultSourceBribeCost);
  const costs = sources.map((s) =>
    s.bribeCost === null || s.bribeCost === undefined
      ? defaultCost
      : toBigInt(s.bribeCost),
  );
  costs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let total = 0n;
  for (let i = 0; i < policy.sourceQuorum; i++) {
    total += costs[i];
  }
  return total;
}

/**
 * Compute the cost of colluding sources to reach quorum, weighted by
 * independence.
 *
 * Rationale: a colluding source is cheaper to subvert than an independent one
 * because it shares infrastructure/ownership with others. We model the
 * effective collusion cost as the sum over the cheapest `sourceQuorum` sources
 * of `bribeCost * (1 - independenceWeight)`. Fully dependent sources
 * (weight 0) cost their full bribe cost to collude; fully independent sources
 * (weight 10000) cost nothing to "collude" because collusion is meaningless
 * for them — but they are also the hardest to bribe, so the attacker would
 * rather bribe them. To keep the model conservative (worst case for the
 * defender), we take the minimum of bribery and collusion paths.
 */
export function computeCollusionThresholdCost(
  sources: SourceDefinition[],
  policy: QuorumPolicy,
): bigint {
  if (policy.sourceQuorum <= 0) {
    return 0n;
  }
  if (policy.sourceQuorum > sources.length) {
    throw new Error(
      `sourceQuorum (${policy.sourceQuorum}) exceeds number of sources (${sources.length})`,
    );
  }
  const defaultCost = toBigInt(policy.defaultSourceBribeCost);
  const effective = sources.map((s) => {
    const cost =
      s.bribeCost === null || s.bribeCost === undefined
        ? defaultCost
        : toBigInt(s.bribeCost);
    const independence = normalizeIndependenceBps(s.independenceWeightBps);
    // Dependent fraction = (10000 - independence) / 10000.
    const dependentBps = BPS_DENOMINATOR - independence;
    return applyBps(cost, dependentBps);
  });
  effective.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let total = 0n;
  for (let i = 0; i < policy.sourceQuorum; i++) {
    total += effective[i];
  }
  return total;
}

/**
 * Compute the cost to compromise enough operator keys to reach key quorum.
 *
 * The attacker picks the cheapest `keyQuorum` operators to compromise. The
 * cost per operator is the greater of its key-compromise cost and its bond
 * (an operator with a large bond is expensive to compromise because slashing
 * would cost the attacker the bond). Zero-bond operators contribute only their
 * key-compromise cost.
 */
export function computeKeyCompromiseCost(
  operators: OperatorDefinition[],
  policy: QuorumPolicy,
): bigint {
  if (policy.keyQuorum <= 0) {
    return 0n;
  }
  if (policy.keyQuorum > operators.length) {
    throw new Error(
      `keyQuorum (${policy.keyQuorum}) exceeds number of operators (${operators.length})`,
    );
  }
  const defaultCost = toBigInt(policy.defaultKeyCompromiseCost);
  const costs = operators.map((op) => {
    const keyCost =
      op.keyCompromiseCost === null || op.keyCompromiseCost === undefined
        ? defaultCost
        : toBigInt(op.keyCompromiseCost);
    const bond = toBigInt(op.bond);
    // Compromise cost is at least the key cost; a large bond raises the bar.
    return keyCost > bond ? keyCost : bond;
  });
  costs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let total = 0n;
  for (let i = 0; i < policy.keyQuorum; i++) {
    total += costs[i];
  }
  return total;
}

/**
 * Derive the maximum supportable payout given an attack cost and safety factor.
 *
 * maxSupportablePayout = attackCost / safetyFactor (rounded down).
 */
export function computeMaxSupportablePayout(
  attackCost: bigint,
  safetyFactorBps: number,
): bigint {
  if (safetyFactorBps <= 0) {
    throw new Error('safetyFactorBps must be positive');
  }
  const sf = BigInt(Math.trunc(safetyFactorBps));
  if (attackCost <= 0n) {
    return 0n;
  }
  return attackCost / sf;
}

/**
 * Derive the implied minimum bond per operator required so that the total
 * operator bond covers the exposure at the configured safety factor.
 *
 * The exposure must be <= totalBond / safetyFactor, so
 * totalBond >= exposure * safetyFactor, and per-operator bond is
 * ceil(totalBond / keyQuorum).
 */
export function computeImpliedMinimumBond(
  maxPayoutExposure: bigint,
  keyQuorum: number,
  safetyFactorBps: number,
): bigint {
  if (safetyFactorBps <= 0) {
    throw new Error('safetyFactorBps must be positive');
  }
  if (keyQuorum <= 0) {
    return 0n;
  }
  const sf = BigInt(Math.trunc(safetyFactorBps));
  const totalBond = maxPayoutExposure * sf;
  return ceilDiv(totalBond, BigInt(keyQuorum));
}

/**
 * Run the full attack-cost model for a feed definition.
 *
 * This is the primary entry point used by both the CLI and configuration
 * validation. It is a pure function: given the same inputs and MODEL_VERSION,
 * it always returns the same result.
 */
export function evaluateFeed(feed: FeedDefinition): AttackCostResult {
  const { sources, operators, policy } = feed;

  const sourceBriberyCost = computeSourceBriberyCost(sources, policy);
  const collusionThresholdCost = computeCollusionThresholdCost(sources, policy);
  const keyCompromiseCost = computeKeyCompromiseCost(operators, policy);

  // An attacker takes the cheapest path.
  let attackCost = sourceBriberyCost;
  if (collusionThresholdCost < attackCost) {
    attackCost = collusionThresholdCost;
  }
  if (keyCompromiseCost < attackCost) {
    attackCost = keyCompromiseCost;
  }

  const maxSupportablePayout = computeMaxSupportablePayout(
    attackCost,
    policy.safetyFactorBps,
  );

  const exposure = toBigInt(feed.maxPayoutExposure);
  const impliedMinimumBond = computeImpliedMinimumBond(
    exposure,
    policy.keyQuorum,
    policy.safetyFactorBps,
  );

  const withinBound = exposure <= maxSupportablePayout;

  return {
    modelVersion: MODEL_VERSION,
    sourceBriberyCost,
    collusionThresholdCost,
    keyCompromiseCost,
    attackCost,
    maxSupportablePayout,
    impliedMinimumBond,
    withinBound,
    safetyFactorBps: policy.safetyFactorBps,
  };
}

/**
 * Validate that a feed's exposure is within the modeled attack-cost bound.
 *
 * Throws if the exposure exceeds the maximum supportable payout at the
 * configured safety factor. Used by configuration validation to refuse
 * startup.
 */
export function assertExposureWithinBound(feed: FeedDefinition): AttackCostResult {
  const result = evaluateFeed(feed);
  if (!result.withinBound) {
    const exposure = toBigInt(feed.maxPayoutExposure);
    throw new Error(
      `Feed "${feed.id}" exposure (${exposure}) exceeds modeled attack-cost bound ` +
        `(${result.maxSupportablePayout}) at safety factor ${result.safetyFactorBps} bps ` +
        `(model v${result.modelVersion}). ` +
        `Attack cost: ${result.attackCost}, implied minimum bond: ${result.impliedMinimumBond}.`,
    );
  }
  return result;
}