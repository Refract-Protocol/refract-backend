export type ConfidenceBand = "low" | "medium" | "high";

export interface PoolExposureCapConfig {
  poolId: string;
  rollingWindowMs: number;
  warningThresholdRatio: number;
  perFeedWindowCapUsd: Record<string, number>;
  perCoverageTypeWindowCapUsd: Record<string, number>;
  perConfidenceBandCapUsd: Record<ConfidenceBand, number>;
}

export interface CandidateClaimSettlement {
  claimId: string;
  poolId: string;
  feedId: string;
  coverageType: string;
  payoutAmountUsd: number;
  decisionId: string;
  decisionConfidenceBps: number;
}

export interface ExposureCapAlert {
  severity: "warning" | "critical";
  dimension: "feed" | "coverage_type" | "confidence_band";
  dimensionKey: string;
  projectedExposureUsd: number;
  capLimitUsd: number;
  timestampMs: number;
}

export interface BatchSettlementGateOutcome {
  allowed: boolean;
  poolState: "healthy" | "degraded_cap_breach_review";
  settledClaimIds: string[];
  haltedClaimIds: string[];
  breachReasons: string[];
  alerts: ExposureCapAlert[];
}

interface SettledExposureEntry {
  claimId: string;
  poolId: string;
  feedId: string;
  coverageType: string;
  confidenceBand: ConfidenceBand;
  amountUsd: number;
  settledAtMs: number;
}

export function resolveConfidenceBand(confidenceBps: number): ConfidenceBand {
  if (confidenceBps >= 8_500) return "high";
  if (confidenceBps >= 7_000) return "medium";
  return "low";
}

export class PayoutExposureCapGuard {
  private readonly configsByPool = new Map<string, PoolExposureCapConfig>();
  private readonly poolStates = new Map<
    string,
    "healthy" | "degraded_cap_breach_review"
  >();
  private readonly ledger: SettledExposureEntry[] = [];
  private readonly settledClaimIds = new Set<string>();
  private readonly alerts: ExposureCapAlert[] = [];
  private mutexChain: Promise<void> = Promise.resolve();

  constructor(configs: PoolExposureCapConfig[]) {
    if (configs.length === 0) {
      throw new Error("PayoutExposureCapGuard requires at least one pool config");
    }
    for (const cfg of configs) {
      if (
        cfg.rollingWindowMs <= 0 ||
        cfg.warningThresholdRatio <= 0 ||
        cfg.warningThresholdRatio >= 1
      ) {
        throw new Error(`Invalid exposure cap configuration for pool ${cfg.poolId}`);
      }
      this.configsByPool.set(cfg.poolId, cfg);
      this.poolStates.set(cfg.poolId, "healthy");
    }
  }

  public async evaluateAndCommitBatch(
    poolId: string,
    candidates: CandidateClaimSettlement[],
    nowMs: number = Date.now()
  ): Promise<BatchSettlementGateOutcome> {
    // Serialize concurrent batch evaluations via an async mutex so parallel bursts cannot overshoot caps
    let releaseMutex!: () => void;
    const prevChain = this.mutexChain;
    this.mutexChain = new Promise<void>((resolve) => {
      releaseMutex = resolve;
    });

    await prevChain;
    try {
      return this.executeLockedBatch(poolId, candidates, nowMs);
    } finally {
      releaseMutex();
    }
  }

  public operatorResetDegradedPoolState(poolId: string): void {
    if (!this.configsByPool.has(poolId)) {
      throw new Error(`Unknown poolId: ${poolId}`);
    }
    this.poolStates.set(poolId, "healthy");
  }

  public getPoolState(
    poolId: string
  ): "healthy" | "degraded_cap_breach_review" {
    return this.poolStates.get(poolId) ?? "healthy";
  }

  public getAlerts(): ExposureCapAlert[] {
    return this.alerts.map((a) => ({ ...a }));
  }

  private executeLockedBatch(
    poolId: string,
    candidates: CandidateClaimSettlement[],
    nowMs: number
  ): BatchSettlementGateOutcome {
    const cfg = this.configsByPool.get(poolId);
    if (!cfg) {
      throw new Error(`No exposure cap configuration registered for pool ${poolId}`);
    }

    const dedupedCandidates = candidates.filter(
      (c) => c.poolId === poolId && !this.settledClaimIds.has(c.claimId)
    );

    if (this.poolStates.get(poolId) === "degraded_cap_breach_review") {
      return {
        allowed: false,
        poolState: "degraded_cap_breach_review",
        settledClaimIds: [],
        haltedClaimIds: dedupedCandidates.map((c) => c.claimId),
        breachReasons: ["POOL_IN_DEGRADED_CAP_BREACH_REVIEW"],
        alerts: [],
      };
    }

    const windowStart = nowMs - cfg.rollingWindowMs;
    const activeEntries = this.ledger.filter(
      (e) => e.poolId === poolId && e.settledAtMs > windowStart
    );

    const feedTotals = new Map<string, number>();
    const covTotals = new Map<string, number>();
    const bandTotals = new Map<ConfidenceBand, number>();

    for (const e of activeEntries) {
      feedTotals.set(e.feedId, (feedTotals.get(e.feedId) ?? 0) + e.amountUsd);
      covTotals.set(
        e.coverageType,
        (covTotals.get(e.coverageType) ?? 0) + e.amountUsd
      );
      bandTotals.set(
        e.confidenceBand,
        (bandTotals.get(e.confidenceBand) ?? 0) + e.amountUsd
      );
    }

    // Project cumulative totals if the entire candidate batch were settled
    for (const c of dedupedCandidates) {
      const band = resolveConfidenceBand(c.decisionConfidenceBps);
      feedTotals.set(
        c.feedId,
        (feedTotals.get(c.feedId) ?? 0) + c.payoutAmountUsd
      );
      covTotals.set(
        c.coverageType,
        (covTotals.get(c.coverageType) ?? 0) + c.payoutAmountUsd
      );
      bandTotals.set(band, (bandTotals.get(band) ?? 0) + c.payoutAmountUsd);
    }

    const breachReasons: string[] = [];
    const batchAlerts: ExposureCapAlert[] = [];

    const checkDimension = (
      dimension: "feed" | "coverage_type" | "confidence_band",
      key: string,
      projected: number,
      capLimit: number | undefined
    ) => {
      if (capLimit === undefined) return;
      if (projected > capLimit) {
        breachReasons.push(
          `${dimension}:${key} projected ${projected} > cap ${capLimit}`
        );
        const alert: ExposureCapAlert = {
          severity: "critical",
          dimension,
          dimensionKey: key,
          projectedExposureUsd: projected,
          capLimitUsd: capLimit,
          timestampMs: nowMs,
        };
        batchAlerts.push(alert);
        this.alerts.push(alert);
      } else if (projected >= capLimit * cfg.warningThresholdRatio) {
        const alert: ExposureCapAlert = {
          severity: "warning",
          dimension,
          dimensionKey: key,
          projectedExposureUsd: projected,
          capLimitUsd: capLimit,
          timestampMs: nowMs,
        };
        batchAlerts.push(alert);
        this.alerts.push(alert);
      }
    };

    for (const [feedId, projected] of feedTotals.entries()) {
      checkDimension("feed", feedId, projected, cfg.perFeedWindowCapUsd[feedId]);
    }
    for (const [cov, projected] of covTotals.entries()) {
      checkDimension(
        "coverage_type",
        cov,
        projected,
        cfg.perCoverageTypeWindowCapUsd[cov]
      );
    }
    for (const [band, projected] of bandTotals.entries()) {
      checkDimension(
        "confidence_band",
        band,
        projected,
        cfg.perConfidenceBandCapUsd[band]
      );
    }

    // Fail-closed: if any cap is breached, halt the ENTIRE batch (never partial-pay) and enter degraded review state
    if (breachReasons.length > 0) {
      this.poolStates.set(poolId, "degraded_cap_breach_review");
      return {
        allowed: false,
        poolState: "degraded_cap_breach_review",
        settledClaimIds: [],
        haltedClaimIds: dedupedCandidates.map((c) => c.claimId),
        breachReasons,
        alerts: batchAlerts,
      };
    }

    // Commit all candidates atomically
    for (const c of dedupedCandidates) {
      this.settledClaimIds.add(c.claimId);
      this.ledger.push({
        claimId: c.claimId,
        poolId: c.poolId,
        feedId: c.feedId,
        coverageType: c.coverageType,
        confidenceBand: resolveConfidenceBand(c.decisionConfidenceBps),
        amountUsd: c.payoutAmountUsd,
        settledAtMs: nowMs,
      });
    }

    return {
      allowed: true,
      poolState: "healthy",
      settledClaimIds: dedupedCandidates.map((c) => c.claimId),
      haltedClaimIds: [],
      breachReasons: [],
      alerts: batchAlerts,
    };
  }
}
