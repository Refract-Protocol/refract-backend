export interface ProviderQuotaPolicy {
  providerId: string;
  rollingWindowMs: number;
  softCallThreshold: number;
  hardCallThreshold: number;
  unitCostUsd: number;
  degradedCadenceMultiplier: number;
  freeTierNoAlert?: boolean;
}

export interface ProviderCallRecord {
  providerId: string;
  feedId: string;
  endpointClass: string;
  timestampMs: number;
  costUsd: number;
}

export interface ProviderQuotaEvaluation {
  providerId: string;
  status: "normal" | "soft_warning" | "hard_throttled";
  allowedToDispatch: boolean;
  effectivePollCadenceMultiplier: number;
  windowCallCount: number;
  windowSpendUsd: number;
  alertEmitted: boolean;
}

export class ProviderQuotaBudgetAccountant {
  private readonly policies = new Map<string, ProviderQuotaPolicy>();
  private readonly callHistory = new Map<string, ProviderCallRecord[]>();
  private redisHealthy = true;

  public registerPolicy(policy: ProviderQuotaPolicy): void {
    this.policies.set(policy.providerId, { ...policy });
  }

  public setRedisHealth(healthy: boolean): void {
    this.redisHealthy = healthy;
  }

  public recordAndEvaluateCall(params: {
    providerId: string;
    feedId: string;
    endpointClass: string;
    nowMs: number;
    pollTickIndex?: number;
  }): ProviderQuotaEvaluation {
    const policy = this.policies.get(params.providerId);
    if (!policy) {
      throw new Error(`No quota policy configured for provider '${params.providerId}'`);
    }

    // Fail-safe on spend when Redis counter store is unavailable: degrade cadence rather than failing open
    if (!this.redisHealthy) {
      const tick = params.pollTickIndex ?? 1;
      return {
        providerId: params.providerId,
        status: "hard_throttled",
        allowedToDispatch: tick % policy.degradedCadenceMultiplier === 0,
        effectivePollCadenceMultiplier: policy.degradedCadenceMultiplier,
        windowCallCount: policy.hardCallThreshold,
        windowSpendUsd: Number(
          (policy.hardCallThreshold * policy.unitCostUsd).toFixed(4)
        ),
        alertEmitted: !policy.freeTierNoAlert,
      };
    }

    const windowStart = params.nowMs - policy.rollingWindowMs;
    const existing = (this.callHistory.get(params.providerId) ?? []).filter(
      (c) => c.timestampMs > windowStart
    );

    if (existing.length >= policy.hardCallThreshold) {
      this.callHistory.set(params.providerId, existing);
      const tick = params.pollTickIndex ?? 1;
      const allowedOnDegradedTick =
        tick % policy.degradedCadenceMultiplier === 0;
      if (allowedOnDegradedTick) {
        existing.push({
          providerId: params.providerId,
          feedId: params.feedId,
          endpointClass: params.endpointClass,
          timestampMs: params.nowMs,
          costUsd: policy.unitCostUsd,
        });
      }
      return {
        providerId: params.providerId,
        status: "hard_throttled",
        allowedToDispatch: allowedOnDegradedTick,
        effectivePollCadenceMultiplier: policy.degradedCadenceMultiplier,
        windowCallCount: existing.length,
        windowSpendUsd: Number(
          (existing.length * policy.unitCostUsd).toFixed(4)
        ),
        alertEmitted: !policy.freeTierNoAlert,
      };
    }

    existing.push({
      providerId: params.providerId,
      feedId: params.feedId,
      endpointClass: params.endpointClass,
      timestampMs: params.nowMs,
      costUsd: policy.unitCostUsd,
    });
    this.callHistory.set(params.providerId, existing);

    const isSoftWarning = existing.length >= policy.softCallThreshold;
    return {
      providerId: params.providerId,
      status: isSoftWarning ? "soft_warning" : "normal",
      allowedToDispatch: true,
      effectivePollCadenceMultiplier: 1,
      windowCallCount: existing.length,
      windowSpendUsd: Number(
        (existing.length * policy.unitCostUsd).toFixed(4)
      ),
      alertEmitted: isSoftWarning && !policy.freeTierNoAlert,
    };
  }
}
