export interface ClaimActivity {
  claimId: string;
  policyId: string;
  coverageType: string;
  payout: number;
  triggeredAt: number;
  settledAt: number;
}

export interface ClaimAnomalyConfig {
  windowMs: number;
  maximumSettlementVolumeByCoverage: Record<string, number>;
  maximumTriggersByCoverage: Record<string, number>;
  maximumPolicyPayoutShare: number;
  minimumPolicyVolumeForConcentration: number;
  maximumObservations: number;
  /** Optional: flags a per-coverage trigger count that grew too fast relative to the previous window. */
  maximumTriggerGrowthRatio?: Record<string, number>;
  /** Optional per-coverage override of the absolute trigger-count floor used in place of the ratio check when the previous window had zero triggers. Defaults to DEFAULT_MIN_ABSOLUTE_ANOMALY_CLAIMS. */
  minimumAbsoluteTriggersForRatioAnomaly?: Record<string, number>;
}

export interface ClaimActivityAnomaly {
  coverageType: string;
  code: 'settlement_volume' | 'policy_concentration' | 'trigger_frequency' | 'trigger_growth_ratio';
  observed: number;
  limit: number;
  message: string;
}

export interface PayoutBreaker {
  trip(coverageType: string, reason: string, now?: number): void;
}

const COVERAGE_TYPES = new Set([
  'StablecoinDepeg',
  'MarketCrash',
  'LiquidationShield',
  'SmartContractRisk',
  'FlightDelay',
]);
const MAX_PAYOUT = 1e18;
const DEFAULT_MIN_ABSOLUTE_ANOMALY_CLAIMS = 5;

/**
 * Sliding-window claim activity detector. It is deliberately separate from
 * per-reading anomaly checks: normal oracle values can still accompany
 * implausible aggregate claim activity. Call `evaluate` from the claims
 * ingestion/settlement path and supply the payout circuit breaker.
 */
export class ClaimActivityAnomalyDetector {
  private readonly observations = new Map<string, ClaimActivity>();
  private readonly trippedWindows = new Set<string>();
  private readonly previousWindowTriggerCounts = new Map<string, number>();

  constructor(
    private readonly config: ClaimAnomalyConfig,
    private readonly payoutBreaker: PayoutBreaker,
  ) {
    if (
      !Number.isFinite(config.windowMs) ||
      config.windowMs < 1 ||
      !Number.isInteger(config.maximumObservations) ||
      config.maximumObservations < 1 ||
      !Number.isFinite(config.maximumPolicyPayoutShare) ||
      config.maximumPolicyPayoutShare <= 0 ||
      config.maximumPolicyPayoutShare > 1 ||
      !Number.isFinite(config.minimumPolicyVolumeForConcentration) ||
      config.minimumPolicyVolumeForConcentration < 0
    ) {
      throw new Error('Invalid claim anomaly detector configuration');
    }
    for (const [coverageType, limit] of Object.entries(
      config.maximumSettlementVolumeByCoverage,
    )) {
      if (!COVERAGE_TYPES.has(coverageType) || !Number.isFinite(limit) || limit <= 0) {
        throw new Error('Invalid settlement-volume anomaly limit');
      }
    }
    for (const [coverageType, limit] of Object.entries(
      config.maximumTriggersByCoverage,
    )) {
      if (!COVERAGE_TYPES.has(coverageType) || !Number.isInteger(limit) || limit < 1) {
        throw new Error('Invalid trigger-frequency anomaly limit');
      }
    }
    for (const [coverageType, ratio] of Object.entries(
      config.maximumTriggerGrowthRatio ?? {},
    )) {
      if (!COVERAGE_TYPES.has(coverageType) || !Number.isFinite(ratio) || ratio <= 0) {
        throw new Error('Invalid trigger-growth-ratio anomaly limit');
      }
    }
    for (const [coverageType, floor] of Object.entries(
      config.minimumAbsoluteTriggersForRatioAnomaly ?? {},
    )) {
      if (!COVERAGE_TYPES.has(coverageType) || !Number.isInteger(floor) || floor < 0) {
        throw new Error('Invalid absolute trigger-growth-ratio floor');
      }
    }
  }

  record(activity: ClaimActivity): void {
    if (
      !activity ||
      typeof activity.claimId !== 'string' ||
      activity.claimId.length < 1 ||
      activity.claimId.length > 128 ||
      typeof activity.policyId !== 'string' ||
      activity.policyId.length < 1 ||
      activity.policyId.length > 128 ||
      !COVERAGE_TYPES.has(activity.coverageType) ||
      !Number.isFinite(activity.payout) ||
      activity.payout < 0 ||
      activity.payout > MAX_PAYOUT ||
      !Number.isSafeInteger(activity.triggeredAt) ||
      activity.triggeredAt < 0 ||
      !Number.isSafeInteger(activity.settledAt) ||
      activity.settledAt < 0
    ) {
      throw new Error('Invalid claim activity observation');
    }
    if (this.observations.has(activity.claimId)) {
      return;
    }

    this.observations.set(activity.claimId, { ...activity });
    while (this.observations.size > this.config.maximumObservations) {
      const oldestClaimId = this.observations.keys().next().value as
        | string
        | undefined;
      if (!oldestClaimId) break;
      this.observations.delete(oldestClaimId);
    }
  }

  evaluate(now = Date.now()): ClaimActivityAnomaly[] {
    const windowStart = now - this.config.windowMs;
    for (const [claimId, observation] of this.observations) {
      if (
        observation.triggeredAt < windowStart &&
        observation.settledAt < windowStart
      ) {
        this.observations.delete(claimId);
      }
    }

    const active = [...this.observations.values()];
    const coverageTypes = new Set([
      ...Object.keys(this.config.maximumSettlementVolumeByCoverage),
      ...Object.keys(this.config.maximumTriggersByCoverage),
      ...Object.keys(this.config.maximumTriggerGrowthRatio ?? {}),
    ]);
    const anomalies: ClaimActivityAnomaly[] = [];
    const windowId = Math.floor(now / this.config.windowMs);

    for (const coverageType of coverageTypes) {
      const coverageEvents = active.filter(
        (event) => event.coverageType === coverageType,
      );
      const settled = coverageEvents.filter(
        (event) =>
          event.settledAt >= windowStart &&
          event.settledAt <= now,
      );
      const volume = settled.reduce((sum, event) => sum + event.payout, 0);
      const volumeLimit =
        this.config.maximumSettlementVolumeByCoverage[coverageType];
      if (volumeLimit !== undefined && volume > volumeLimit) {
        anomalies.push({
          coverageType,
          code: 'settlement_volume',
          observed: volume,
          limit: volumeLimit,
          message: `Settlement volume ${volume} exceeds limit ${volumeLimit}`,
        });
      }

      const triggers = coverageEvents.filter(
        (event) =>
          event.triggeredAt >= windowStart &&
          event.triggeredAt <= now,
      );
      const triggerLimit = this.config.maximumTriggersByCoverage[coverageType];
      if (triggerLimit !== undefined && triggers.length > triggerLimit) {
        anomalies.push({
          coverageType,
          code: 'trigger_frequency',
          observed: triggers.length,
          limit: triggerLimit,
          message: `Trigger frequency ${triggers.length} exceeds limit ${triggerLimit}`,
        });
      }

      const triggerRatioLimit = this.config.maximumTriggerGrowthRatio?.[coverageType];
      if (triggerRatioLimit !== undefined) {
        const previousTriggerCount = this.previousWindowTriggerCounts.get(
          `${windowId - 1}:${coverageType}`,
        );
        if (previousTriggerCount !== undefined && previousTriggerCount > 0) {
          const ratio = triggers.length / previousTriggerCount;
          if (ratio > triggerRatioLimit) {
            anomalies.push({
              coverageType,
              code: 'trigger_growth_ratio',
              observed: ratio,
              limit: triggerRatioLimit,
              message: `Trigger count ratio ${ratio.toFixed(2)}x exceeds limit ${triggerRatioLimit}x of the previous window`,
            });
          }
        } else {
          // A zero (or unseen) previous window makes the ratio Infinity,
          // which is "no signal" rather than "infinite anomaly" — fall back
          // to an absolute floor instead of dividing by zero.
          const absoluteFloor =
            this.config.minimumAbsoluteTriggersForRatioAnomaly?.[coverageType] ??
            DEFAULT_MIN_ABSOLUTE_ANOMALY_CLAIMS;
          if (triggers.length > absoluteFloor) {
            anomalies.push({
              coverageType,
              code: 'trigger_growth_ratio',
              observed: triggers.length,
              limit: absoluteFloor,
              message: `Trigger count ${triggers.length} exceeds the absolute anomaly floor ${absoluteFloor} after a quiet previous window`,
            });
          }
        }
      }
      this.previousWindowTriggerCounts.set(`${windowId}:${coverageType}`, triggers.length);

      if (volume >= this.config.minimumPolicyVolumeForConcentration) {
        const byPolicy = new Map<string, number>();
        for (const event of settled) {
          byPolicy.set(
            event.policyId,
            (byPolicy.get(event.policyId) ?? 0) + event.payout,
          );
        }
        for (const [policyId, policyPayout] of byPolicy) {
          const share = policyPayout / volume;
          if (share > this.config.maximumPolicyPayoutShare) {
            anomalies.push({
              coverageType,
              code: 'policy_concentration',
              observed: share,
              limit: this.config.maximumPolicyPayoutShare,
              message: `Policy ${policyId} accounts for ${(share * 100).toFixed(2)}% of settled payouts`,
            });
          }
        }
      }
    }

    for (const anomaly of anomalies) {
      const key = `${windowId}:${anomaly.coverageType}:${anomaly.code}`;
      if (!this.trippedWindows.has(key)) {
        this.trippedWindows.add(key);
        this.payoutBreaker.trip(anomaly.coverageType, anomaly.message, now);
      }
    }
    this.pruneTrippedWindows(windowId);
    this.prunePreviousWindowTriggerCounts(windowId);
    return anomalies;
  }

  private pruneTrippedWindows(currentWindow: number): void {
    for (const key of this.trippedWindows) {
      const windowId = Number(key.slice(0, key.indexOf(':')));
      if (windowId < currentWindow - 1) {
        this.trippedWindows.delete(key);
      }
    }
  }

  private prunePreviousWindowTriggerCounts(currentWindow: number): void {
    for (const key of this.previousWindowTriggerCounts.keys()) {
      const windowId = Number(key.slice(0, key.indexOf(':')));
      if (windowId < currentWindow - 1) {
        this.previousWindowTriggerCounts.delete(key);
      }
    }
  }
}
