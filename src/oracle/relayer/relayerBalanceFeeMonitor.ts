export type RelayerBalanceHealthState =
  | "healthy"
  | "warning"
  | "critical"
  | "unfunded";

export interface RelayerMetricsSnapshot {
  currentBalanceXlm: number;
  averageFeeXlm: number;
  estimatedPublishesRemaining: number;
  healthState: RelayerBalanceHealthState;
  cumulativeFeesByFeedXlm: Record<string, number>;
}

export class RelayerBalanceFeeMonitor {
  private readonly warningThresholdXlm: number;
  private readonly criticalThresholdXlm: number;
  private readonly defaultFeeEstimateXlm: number;

  private currentBalanceXlm: number | null = null;
  private readonly recentFeesXlm: number[] = [];
  private readonly cumulativeFeesByFeed = new Map<string, number>();
  private readonly recordedTxHashes = new Set<string>();

  constructor(options?: {
    warningThresholdXlm?: number;
    criticalThresholdXlm?: number;
    defaultFeeEstimateXlm?: number;
  }) {
    this.warningThresholdXlm = options?.warningThresholdXlm ?? 50;
    this.criticalThresholdXlm = options?.criticalThresholdXlm ?? 10;
    this.defaultFeeEstimateXlm = options?.defaultFeeEstimateXlm ?? 0.01;
  }

  public updateCachedBalance(balanceXlm: number | null): void {
    this.currentBalanceXlm = balanceXlm;
  }

  public recordPublishFee(params: {
    txHash: string;
    feedId: string;
    feeSpentXlm: number;
    updatedBalanceXlm?: number;
  }): { deduplicated: boolean } {
    if (this.recordedTxHashes.has(params.txHash)) {
      return { deduplicated: true };
    }
    this.recordedTxHashes.add(params.txHash);

    this.recentFeesXlm.push(params.feeSpentXlm);
    if (this.recentFeesXlm.length > 50) {
      this.recentFeesXlm.shift();
    }

    const prevFeedTotal = this.cumulativeFeesByFeed.get(params.feedId) ?? 0;
    this.cumulativeFeesByFeed.set(
      params.feedId,
      Number((prevFeedTotal + params.feeSpentXlm).toFixed(7))
    );

    if (typeof params.updatedBalanceXlm === "number") {
      this.currentBalanceXlm = params.updatedBalanceXlm;
    } else if (this.currentBalanceXlm !== null) {
      this.currentBalanceXlm = Math.max(
        0,
        Number((this.currentBalanceXlm - params.feeSpentXlm).toFixed(7))
      );
    }

    return { deduplicated: false };
  }

  public getMetricsSnapshot(): RelayerMetricsSnapshot {
    const balance = this.currentBalanceXlm ?? 0;
    const avgFee =
      this.recentFeesXlm.length > 0
        ? this.recentFeesXlm.reduce((a, b) => a + b, 0) /
          this.recentFeesXlm.length
        : this.defaultFeeEstimateXlm;

    let healthState: RelayerBalanceHealthState = "healthy";
    if (this.currentBalanceXlm === null) {
      healthState = "unfunded";
    } else if (balance < this.criticalThresholdXlm) {
      healthState = "critical";
    } else if (balance < this.warningThresholdXlm) {
      healthState = "warning";
    }

    const spendableAboveReserve = Math.max(0, balance - 1); // 1 XLM base reserve
    const estimatedPublishesRemaining =
      avgFee > 0 ? Math.floor(spendableAboveReserve / avgFee) : 0;

    return {
      currentBalanceXlm: balance,
      averageFeeXlm: Number(avgFee.toFixed(7)),
      estimatedPublishesRemaining,
      healthState,
      cumulativeFeesByFeedXlm: Object.fromEntries(
        this.cumulativeFeesByFeed.entries()
      ),
    };
  }

  /**
   * Fails closed before submitting an on-chain publish when relayer balance is below critical threshold.
   */
  public assertCanPublishOrThrow(): void {
    const snap = this.getMetricsSnapshot();
    if (snap.healthState === "unfunded" || snap.healthState === "critical") {
      throw new Error(
        `RELAYER_CRITICAL_LOW_FUNDS: Relayer balance (${snap.currentBalanceXlm} XLM) is below critical threshold (${this.criticalThresholdXlm} XLM)`
      );
    }
  }
}
