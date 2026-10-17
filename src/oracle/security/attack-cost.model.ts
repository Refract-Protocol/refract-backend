/**
 * Analytical Oracle Attack-Cost Model, Minimum Bond & Quorum Sizing, and Startup Validator (Issue #288)
 *
 * Uses exact BigInt stroop arithmetic (10^7 stroops per unit) with zero floating-point
 * operations on monetary thresholds, bonds, or exposures.
 */

export const STROOPS_PER_UNIT = 10_000_000n;
export const BPS_DENOMINATOR = 10_000n;
export const DEFAULT_SAFETY_FACTOR_BPS = 20_000; // 2.0x safety factor (Attack Cost >= 2.0 * Max Exposure)

export interface OracleSourceModelInput {
  /** Unique source identifier */
  sourceId: string;
  /** Positive aggregation weight of this source */
  weight: number;
  /** Estimated cost in stroops to bribe or spoof this individual source for one window */
  briberyCostStroops: bigint;
  /**
   * Upstream independence group identifier.
   * Sources with the same group share an upstream vendor and can be compromised together.
   * Sources with undefined/empty independenceGroup are conservatively grouped into a single
   * shared "__unknown_shared_upstream__" group (worst-case assumption).
   */
  independenceGroup?: string;
  /** Optional incremental cost to corrupt an entire shared upstream vendor group */
  sharedGroupCorruptionCostStroops?: bigint;
}

export interface OracleFeedSecurityInput {
  feedId: string;
  /** Configured data sources for the feed */
  sources: OracleSourceModelInput[];
  /**
   * Source quorum threshold in basis points of total source weight (e.g. 5001 for >50%, 6667 for 2/3)
   * or explicit minimum number of sources `sourceQuorumCount`.
   */
  sourceQuorumCount: number;
  /** Total number of oracle operator signers (M) */
  operatorCount: number;
  /** Number of operator signatures required to finalize an on-chain round (K_op of M) */
  operatorQuorumCount: number;
  /** Slashable bond staked per operator in stroops (B) */
  operatorBondStroops: bigint;
  /** Baseline infrastructure cost to compromise a single operator signing key in stroops */
  keyCompromiseFloorStroops: bigint;
  /** Configured maximum payout exposure on this feed in stroops */
  configuredMaxExposureStroops: bigint;
  /** Target exposure in stroops used to derive implied minimum bond (defaults to configuredMaxExposureStroops) */
  targetExposureStroops?: bigint;
  /** Safety factor in basis points (default: 20000 = 2.0x) */
  safetyFactorBps?: number;
}

export interface AttackVectorBreakdown {
  /** Cost to bribe `sourceQuorumCount` distinct sources directly */
  sourceBriberyCostStroops: bigint;
  /** Cost to corrupt enough shared upstream independence groups to control `sourceQuorumCount` sources */
  sourceCollusionCostStroops: bigint;
  /** Effective number of independent upstream groups required to reach `sourceQuorumCount` sources */
  effectiveIndependentGroupsRequired: number;
  /** Cost to compromise `operatorQuorumCount` of `operatorCount` operator keys + slashable bonds */
  operatorKeyCompromiseCostStroops: bigint;
}

export interface OracleAttackCostResult {
  feedId: string;
  safetyFactorBps: number;
  vectors: AttackVectorBreakdown;
  /** Minimum cost across all modeled attack vectors */
  minAttackCostStroops: bigint;
  /** Which attack vector currently forms the weakest link */
  limitingVector: "source_bribery" | "source_collusion" | "operator_key_compromise";
  /** Maximum exposure safely supported at `safetyFactorBps`: floor(minAttackCost * 10000 / safetyFactorBps) */
  maxSupportedExposureStroops: bigint;
  /** Minimum slashable bond per operator required so operator_key_compromise supports targetExposure */
  impliedMinOperatorBondStroops: bigint;
  /** Recommended source & operator quorum size to reach target exposure under current per-unit costs */
  recommendedQuorumSize: {
    recommendedSourceQuorum: number;
    recommendedOperatorQuorum: number;
  };
  /** True if configuredMaxExposureStroops <= maxSupportedExposureStroops */
  isExposureSafe: boolean;
  /** Deficit in attack cost if configuredMaxExposureStroops exceeds maxSupportedExposureStroops */
  securityDeficitStroops: bigint;
}

export interface StartupValidationOptions {
  /** When true, returns violations with critical alerts instead of throwing an Error */
  dryRun?: boolean;
}

export interface StartupValidationReport {
  passed: boolean;
  results: OracleAttackCostResult[];
  criticalAlerts: string[];
}

function ceilDivBigInt(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("Denominator must be positive");
  }
  if (numerator <= 0n) {
    return 0n;
  }
  return (numerator + denominator - 1n) / denominator;
}

function validateInput(input: OracleFeedSecurityInput): void {
  if (!input.feedId || input.feedId.trim() === "") {
    throw new Error("feedId must be non-empty");
  }
  if (input.sources.length === 0) {
    throw new Error(`Feed ${input.feedId}: sources array cannot be empty`);
  }
  if (input.sourceQuorumCount <= 0 || input.sourceQuorumCount > input.sources.length) {
    throw new Error(
      `Feed ${input.feedId}: sourceQuorumCount (${input.sourceQuorumCount}) must be in 1..${input.sources.length}`
    );
  }
  if (input.operatorCount <= 0) {
    throw new Error(`Feed ${input.feedId}: operatorCount must be positive`);
  }
  if (input.operatorQuorumCount <= 0 || input.operatorQuorumCount > input.operatorCount) {
    throw new Error(
      `Feed ${input.feedId}: operatorQuorumCount (${input.operatorQuorumCount}) must be in 1..${input.operatorCount}`
    );
  }
  if (input.operatorBondStroops < 0n || input.keyCompromiseFloorStroops < 0n) {
    throw new Error(`Feed ${input.feedId}: bond and key compromise floor cannot be negative`);
  }
  for (const src of input.sources) {
    if (src.briberyCostStroops < 0n) {
      throw new Error(`Feed ${input.feedId}: source ${src.sourceId} briberyCostStroops cannot be negative`);
    }
    if (src.weight <= 0) {
      throw new Error(`Feed ${input.feedId}: source ${src.sourceId} weight must be positive`);
    }
  }
}

/**
 * Computes the analytical oracle attack cost across source bribery, shared-upstream collusion,
 * and operator key compromise, and derives minimum bond and quorum sizing.
 */
export function evaluateOracleAttackCost(input: OracleFeedSecurityInput): OracleAttackCostResult {
  validateInput(input);

  const safetyFactorBps = input.safetyFactorBps ?? DEFAULT_SAFETY_FACTOR_BPS;
  if (safetyFactorBps <= 0) {
    throw new Error("safetyFactorBps must be positive");
  }
  const safetyFactorBig = BigInt(safetyFactorBps);

  // 1. Source Bribery Vector:
  // Attacker bribes the `sourceQuorumCount` cheapest individual sources.
  const sortedSourceBriberyCosts = input.sources
    .map((s) => s.briberyCostStroops)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  let sourceBriberyCostStroops = 0n;
  for (let i = 0; i < input.sourceQuorumCount; i++) {
    sourceBriberyCostStroops += sortedSourceBriberyCosts[i];
  }

  // 2. Source Collusion / Shared Upstream Vector:
  // Sources without an explicit independenceGroup are grouped into a single shared group (worst case).
  const groupMap = new Map<
    string,
    { count: number; groupCostStroops: bigint }
  >();

  for (const src of input.sources) {
    const groupKey =
      src.independenceGroup && src.independenceGroup.trim() !== ""
        ? src.independenceGroup.trim()
        : "__unknown_shared_upstream__";

    const existing = groupMap.get(groupKey);
    const candidateCost = src.sharedGroupCorruptionCostStroops ?? src.briberyCostStroops;
    if (!existing) {
      groupMap.set(groupKey, {
        count: 1,
        groupCostStroops: candidateCost,
      });
    } else {
      existing.count += 1;
      // Compromise cost of a shared upstream vendor is at least the max single-vendor cost in that group
      if (candidateCost > existing.groupCostStroops) {
        existing.groupCostStroops = candidateCost;
      }
    }
  }

  // Find minimum-cost subset of upstream groups whose combined source count >= sourceQuorumCount
  // Exact 0/1 knapsack / subset search over groups (number of sources per feed is small, typically <= 20)
  const groups = Array.from(groupMap.values());
  const targetSources = input.sourceQuorumCount;
  // dp[c] = { cost: min stroops to cover >= c sources, groupsUsed: min groups for that cost }
  const dp: Array<{ cost: bigint; groupsUsed: number } | null> = new Array(targetSources + 1).fill(null);
  dp[0] = { cost: 0n, groupsUsed: 0 };

  for (const g of groups) {
    for (let c = targetSources; c >= 0; c--) {
      const current = dp[c];
      if (!current) continue;
      const nextCount = Math.min(targetSources, c + g.count);
      const nextCost = current.cost + g.groupCostStroops;
      const nextGroups = current.groupsUsed + 1;
      const existingNext = dp[nextCount];
      if (
        !existingNext ||
        nextCost < existingNext.cost ||
        (nextCost === existingNext.cost && nextGroups < existingNext.groupsUsed)
      ) {
        dp[nextCount] = { cost: nextCost, groupsUsed: nextGroups };
      }
    }
  }

  const collusionSolution = dp[targetSources] ?? {
    cost: sourceBriberyCostStroops,
    groupsUsed: input.sourceQuorumCount,
  };
  // Collusion cost is bounded above by direct individual bribery cost
  const sourceCollusionCostStroops =
    collusionSolution.cost < sourceBriberyCostStroops
      ? collusionSolution.cost
      : sourceBriberyCostStroops;
  const effectiveIndependentGroupsRequired = collusionSolution.groupsUsed;

  // 3. Operator Key Compromise Vector:
  // Compromising K_op of M operator keys costs K_op * (keyCompromiseFloorStroops + operatorBondStroops)
  const perOperatorCostStroops = input.keyCompromiseFloorStroops + input.operatorBondStroops;
  const operatorKeyCompromiseCostStroops =
    perOperatorCostStroops * BigInt(input.operatorQuorumCount);

  // Determine minimum attack cost across all 3 vectors
  let minAttackCostStroops = sourceBriberyCostStroops;
  let limitingVector: OracleAttackCostResult["limitingVector"] = "source_bribery";

  if (sourceCollusionCostStroops <= minAttackCostStroops) {
    minAttackCostStroops = sourceCollusionCostStroops;
    limitingVector =
      sourceCollusionCostStroops < sourceBriberyCostStroops
        ? "source_collusion"
        : "source_bribery";
  }
  if (operatorKeyCompromiseCostStroops < minAttackCostStroops) {
    minAttackCostStroops = operatorKeyCompromiseCostStroops;
    limitingVector = "operator_key_compromise";
  }

  // Max supported exposure: floor(minAttackCost * 10000 / safetyFactorBps)
  const maxSupportedExposureStroops =
    (minAttackCostStroops * BPS_DENOMINATOR) / safetyFactorBig;

  // Target exposure to size against
  const targetExposureStroops =
    input.targetExposureStroops ?? input.configuredMaxExposureStroops;
  const requiredAttackCostForTarget = ceilDivBigInt(
    targetExposureStroops * safetyFactorBig,
    BPS_DENOMINATOR
  );

  // Implied minimum operator bond per signer so that K_op * (keyCompromiseFloor + B) >= requiredAttackCostForTarget
  const requiredPerOperatorCost = ceilDivBigInt(
    requiredAttackCostForTarget,
    BigInt(input.operatorQuorumCount)
  );
  const impliedMinOperatorBondStroops =
    requiredPerOperatorCost > input.keyCompromiseFloorStroops
      ? requiredPerOperatorCost - input.keyCompromiseFloorStroops
      : 0n;

  // Recommended source quorum size (smallest K in 1..N whose prefix bribery sum >= requiredAttackCostForTarget, or N)
  let recommendedSourceQuorum = input.sources.length;
  let runningBriberySum = 0n;
  for (let k = 0; k < sortedSourceBriberyCosts.length; k++) {
    runningBriberySum += sortedSourceBriberyCosts[k];
    if (runningBriberySum >= requiredAttackCostForTarget) {
      recommendedSourceQuorum = k + 1;
      break;
    }
  }

  // Recommended operator quorum size at current bond
  let recommendedOperatorQuorum = input.operatorCount;
  if (perOperatorCostStroops > 0n) {
    const neededOperators = Number(
      ceilDivBigInt(requiredAttackCostForTarget, perOperatorCostStroops)
    );
    recommendedOperatorQuorum = Math.max(
      1,
      Math.min(input.operatorCount, neededOperators)
    );
  }

  const requiredAttackCostForConfigured = ceilDivBigInt(
    input.configuredMaxExposureStroops * safetyFactorBig,
    BPS_DENOMINATOR
  );
  const isExposureSafe =
    input.configuredMaxExposureStroops <= maxSupportedExposureStroops;
  const securityDeficitStroops =
    requiredAttackCostForConfigured > minAttackCostStroops
      ? requiredAttackCostForConfigured - minAttackCostStroops
      : 0n;

  return {
    feedId: input.feedId,
    safetyFactorBps,
    vectors: {
      sourceBriberyCostStroops,
      sourceCollusionCostStroops,
      effectiveIndependentGroupsRequired,
      operatorKeyCompromiseCostStroops,
    },
    minAttackCostStroops,
    limitingVector,
    maxSupportedExposureStroops,
    impliedMinOperatorBondStroops,
    recommendedQuorumSize: {
      recommendedSourceQuorum,
      recommendedOperatorQuorum,
    },
    isExposureSafe,
    securityDeficitStroops,
  };
}

/**
 * Startup configuration validator: ensures every feed's configuredMaxExposureStroops
 * does not exceed its modeled maxSupportedExposureStroops.
 * Fails closed by throwing an Error unless `options.dryRun` is true.
 */
export function validateFeedExposureAgainstAttackCost(
  feeds: OracleFeedSecurityInput[],
  options: StartupValidationOptions = {}
): StartupValidationReport {
  const results: OracleAttackCostResult[] = [];
  const criticalAlerts: string[] = [];

  for (const feed of feeds) {
    const evaluated = evaluateOracleAttackCost(feed);
    results.push(evaluated);
    if (!evaluated.isExposureSafe) {
      criticalAlerts.push(
        `[ORACLE_SECURITY_VIOLATION] Feed "${evaluated.feedId}" configuredMaxExposureStroops=${feed.configuredMaxExposureStroops.toString()} exceeds maxSupportedExposureStroops=${evaluated.maxSupportedExposureStroops.toString()} (limitingVector=${evaluated.limitingVector}, minAttackCostStroops=${evaluated.minAttackCostStroops.toString()}, deficitStroops=${evaluated.securityDeficitStroops.toString()}, impliedMinOperatorBondStroops=${evaluated.impliedMinOperatorBondStroops.toString()})`
      );
    }
  }

  const passed = criticalAlerts.length === 0;
  if (!passed && !options.dryRun) {
    throw new Error(
      `Oracle attack-cost startup validation failed for ${criticalAlerts.length} feed(s):\n${criticalAlerts.join("\n")}`
    );
  }

  return {
    passed,
    results,
    criticalAlerts,
  };
}
