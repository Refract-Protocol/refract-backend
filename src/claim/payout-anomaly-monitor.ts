export type PayoutMonitorMode = "advisory" | "enforcing";

export interface CoveragePayoutAnomalyConfig {
  coverageType: string;
  mode?: PayoutMonitorMode;
  minBaselineBuckets?: number;
  zScoreThreshold?: number;
  maxHourlyPayoutStroops?: bigint;
  maxHourlyClaimsSettled?: number;
  maxTriggerToPolicyRatio?: number;
  maxSinglePolicyConcentrationBps?: number;
}

export interface SettlementObservationInput {
  settlementId: string;
  coverageType: string;
  policyId: string;
  payoutStroops: bigint | number | string;
  activePoliciesCount: number;
  timestampMs?: number;
}

export interface HourlyBucketAggregate {
  bucketHourUtc: number;
  claimsSettled: number;
  totalPayoutStroops: bigint;
  distinctPolicies: Set<string>;
  perPolicyPayoutStroops: Map<string, bigint>;
  activePoliciesCount: number;
}

export interface PayoutAnomalyBreach {
  coverageType: string;
  bucketHourUtc: number;
  reasons: string[];
  claimsSettledPerHour: number;
  totalPayoutStroopsPerHour: string;
  distinctPoliciesClaimingPerHour: number;
  triggerToPolicyRatio: number;
  zScorePayout: number | null;
  zScoreClaims: number | null;
  mode: PayoutMonitorMode;
  holdPlaced: boolean;
  detectedAtMs: number;
}

export interface CoverageHoldStatus {
  coverageType: string;
  held: boolean;
  heldAtMs: number | null;
  breach: PayoutAnomalyBreach | null;
  acknowledgedBy: string | null;
  acknowledgedAtMs: number | null;
  resumeNote: string | null;
}

const HOUR_MS = 60 * 60 * 1000;

export function toHourBucketUtc(timestampMs: number): number {
  return Math.floor(timestampMs / HOUR_MS) * HOUR_MS;
}

function computeMedian(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Computes the robust z-score using Median and MAD (Median Absolute Deviation)
 * so historic outliers do not skew the trailing baseline.
 */
export function computeRobustZScore(value: number, baseline: readonly number[]): number | null {
  if (baseline.length === 0) return null;
  const median = computeMedian(baseline);
  const absDevs = baseline.map((v) => Math.abs(v - median));
  const mad = computeMedian(absDevs);
  const scaledMad = mad * 1.4826;
  if (scaledMad === 0) {
    if (value <= median) return 0;
    const fallbackScale = Math.max(1, median * 0.25);
    return (value - median) / fallbackScale;
  }
  return (value - median) / scaledMad;
}

export class PayoutAnomalyMonitor {
  private readonly configs = new Map<string, Required<CoveragePayoutAnomalyConfig>>();
  private readonly bucketsByCoverage = new Map<string, Map<number, HourlyBucketAggregate>>();
  private readonly seenSettlementIds = new Set<string>();
  private readonly holds = new Map<string, CoverageHoldStatus>();
  private readonly onBreach?: (breach: PayoutAnomalyBreach) => void;

  constructor(options: {
    defaultMode?: PayoutMonitorMode;
    configs?: CoveragePayoutAnomalyConfig[];
    onBreach?: (breach: PayoutAnomalyBreach) => void;
  } = {}) {
    this.onBreach = options.onBreach;
    for (const cfg of options.configs ?? []) {
      this.registerCoverageConfig({
        mode: options.defaultMode ?? "advisory",
        ...cfg,
      });
    }
  }

  registerCoverageConfig(config: CoveragePayoutAnomalyConfig): void {
    const normalized: Required<CoveragePayoutAnomalyConfig> = {
      coverageType: config.coverageType,
      mode: config.mode ?? "advisory",
      minBaselineBuckets: config.minBaselineBuckets ?? 6,
      zScoreThreshold: config.zScoreThreshold ?? 4.0,
      maxHourlyPayoutStroops: config.maxHourlyPayoutStroops ?? 10_000_000_000_000n,
      maxHourlyClaimsSettled: config.maxHourlyClaimsSettled ?? 500,
      maxTriggerToPolicyRatio: config.maxTriggerToPolicyRatio ?? 0.5,
      maxSinglePolicyConcentrationBps: config.maxSinglePolicyConcentrationBps ?? 9500,
    };
    this.configs.set(config.coverageType, normalized);
    if (!this.holds.has(config.coverageType)) {
      this.holds.set(config.coverageType, {
        coverageType: config.coverageType,
        held: false,
        heldAtMs: null,
        breach: null,
        acknowledgedBy: null,
        acknowledgedAtMs: null,
        resumeNote: null,
      });
    }
  }

  private getConfig(coverageType: string): Required<CoveragePayoutAnomalyConfig> {
    const existing = this.configs.get(coverageType);
    if (existing) return existing;
    this.registerCoverageConfig({ coverageType });
    return this.configs.get(coverageType)!;
  }

  isSettlementHeld(coverageType: string): boolean {
    return this.holds.get(coverageType)?.held === true;
  }

  getHoldStatus(coverageType: string): CoverageHoldStatus {
    const status = this.holds.get(coverageType);
    if (!status) {
      return {
        coverageType,
        held: false,
        heldAtMs: null,
        breach: null,
        acknowledgedBy: null,
        acknowledgedAtMs: null,
        resumeNote: null,
      };
    }
    return structuredClone(status);
  }

  /**
   * Operator override: acknowledges a tripped payout breaker and resumes
   * settlement for `coverageType`.
   */
  acknowledgeAndResume(
    coverageType: string,
    operatorId: string,
    note = "Reviewed by operator",
    nowMs = Date.now()
  ): CoverageHoldStatus {
    const status = this.holds.get(coverageType) ?? {
      coverageType,
      held: false,
      heldAtMs: null,
      breach: null,
      acknowledgedBy: null,
      acknowledgedAtMs: null,
      resumeNote: null,
    };
    status.held = false;
    status.acknowledgedBy = operatorId;
    status.acknowledgedAtMs = nowMs;
    status.resumeNote = note;
    this.holds.set(coverageType, status);
    return structuredClone(status);
  }

  /**
   * Records a claim settlement event idempotently (de-duplicated by `settlementId`
   * so retries never double-count) and evaluates rolling-window anomaly rules.
   */
  recordSettlement(input: SettlementObservationInput): {
    duplicate: boolean;
    allowedToSettle: boolean;
    breach: PayoutAnomalyBreach | null;
  } {
    if (this.seenSettlementIds.has(input.settlementId)) {
      return {
        duplicate: true,
        allowedToSettle: !this.isSettlementHeld(input.coverageType),
        breach: null,
      };
    }
    this.seenSettlementIds.add(input.settlementId);

    const cfg = this.getConfig(input.coverageType);
    const nowMs = input.timestampMs ?? Date.now();
    const bucketHourUtc = toHourBucketUtc(nowMs);
    const payoutStroops = BigInt(input.payoutStroops);

    let coverageBuckets = this.bucketsByCoverage.get(input.coverageType);
    if (!coverageBuckets) {
      coverageBuckets = new Map<number, HourlyBucketAggregate>();
      this.bucketsByCoverage.set(input.coverageType, coverageBuckets);
    }

    let bucket = coverageBuckets.get(bucketHourUtc);
    if (!bucket) {
      bucket = {
        bucketHourUtc,
        claimsSettled: 0,
        totalPayoutStroops: 0n,
        distinctPolicies: new Set<string>(),
        perPolicyPayoutStroops: new Map<string, bigint>(),
        activePoliciesCount: Math.max(1, input.activePoliciesCount),
      };
      coverageBuckets.set(bucketHourUtc, bucket);
    }

    bucket.claimsSettled += 1;
    bucket.totalPayoutStroops += payoutStroops;
    bucket.distinctPolicies.add(input.policyId);
    bucket.activePoliciesCount = Math.max(1, input.activePoliciesCount);
    bucket.perPolicyPayoutStroops.set(
      input.policyId,
      (bucket.perPolicyPayoutStroops.get(input.policyId) ?? 0n) + payoutStroops
    );

    const trailingBuckets = [...coverageBuckets.values()]
      .filter((b) => b.bucketHourUtc < bucketHourUtc)
      .sort((a, b) => a.bucketHourUtc - b.bucketHourUtc)
      .slice(-24);

    const hasWarmBaseline = trailingBuckets.length >= cfg.minBaselineBuckets;
    const zScorePayout = hasWarmBaseline
      ? computeRobustZScore(
          Number(bucket.totalPayoutStroops),
          trailingBuckets.map((b) => Number(b.totalPayoutStroops))
        )
      : null;
    const zScoreClaims = hasWarmBaseline
      ? computeRobustZScore(
          bucket.claimsSettled,
          trailingBuckets.map((b) => b.claimsSettled)
        )
      : null;

    const triggerToPolicyRatio =
      bucket.distinctPolicies.size / Math.max(1, bucket.activePoliciesCount);

    const reasons: string[] = [];

    if (bucket.totalPayoutStroops > cfg.maxHourlyPayoutStroops) {
      reasons.push(
        `hourly_payout_cap_exceeded (${bucket.totalPayoutStroops} > ${cfg.maxHourlyPayoutStroops})`
      );
    }
    if (bucket.claimsSettled > cfg.maxHourlyClaimsSettled) {
      reasons.push(
        `hourly_claim_count_cap_exceeded (${bucket.claimsSettled} > ${cfg.maxHourlyClaimsSettled})`
      );
    }
    if (
      bucket.distinctPolicies.size >= 3 &&
      triggerToPolicyRatio > cfg.maxTriggerToPolicyRatio
    ) {
      reasons.push(
        `trigger_to_policy_ratio_exceeded (${triggerToPolicyRatio.toFixed(3)} > ${cfg.maxTriggerToPolicyRatio})`
      );
    }
    if (zScorePayout !== null && zScorePayout >= cfg.zScoreThreshold) {
      reasons.push(
        `payout_volume_zscore_breach (z=${zScorePayout.toFixed(2)} >= ${cfg.zScoreThreshold})`
      );
    }
    if (zScoreClaims !== null && zScoreClaims >= cfg.zScoreThreshold) {
      reasons.push(
        `claim_surge_zscore_breach (z=${zScoreClaims.toFixed(2)} >= ${cfg.zScoreThreshold})`
      );
    }

    if (reasons.length === 0) {
      return {
        duplicate: false,
        allowedToSettle: !this.isSettlementHeld(input.coverageType),
        breach: null,
      };
    }

    const holdPlaced = cfg.mode === "enforcing";
    const breach: PayoutAnomalyBreach = {
      coverageType: input.coverageType,
      bucketHourUtc,
      reasons,
      claimsSettledPerHour: bucket.claimsSettled,
      totalPayoutStroopsPerHour: bucket.totalPayoutStroops.toString(),
      distinctPoliciesClaimingPerHour: bucket.distinctPolicies.size,
      triggerToPolicyRatio,
      zScorePayout,
      zScoreClaims,
      mode: cfg.mode,
      holdPlaced,
      detectedAtMs: nowMs,
    };

    if (holdPlaced) {
      this.holds.set(input.coverageType, {
        coverageType: input.coverageType,
        held: true,
        heldAtMs: nowMs,
        breach,
        acknowledgedBy: null,
        acknowledgedAtMs: null,
        resumeNote: null,
      });
    }

    this.onBreach?.(breach);
    return {
      duplicate: false,
      allowedToSettle: !this.isSettlementHeld(input.coverageType),
      breach,
    };
  }
}
