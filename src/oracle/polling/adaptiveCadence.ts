export type CadenceMode =
  | "base"
  | "accelerated_volatile"
  | "accelerated_threshold_proximity"
  | "pressured_quota"
  | "error_backoff";

export interface SourceCadencePolicy {
  sourceId: string;
  feedId: string;
  minIntervalMs: number;
  baseIntervalMs: number;
  maxIntervalMs: number;
  freshnessWindowMs: number;
  minModeDwellMs: number;
  volatilityEnterThreshold: number;
  volatilityExitThreshold: number;
  proximityEnterRatio: number;
  proximityExitRatio: number;
  quotaLowRatioThreshold: number;
  jitterFraction?: number;
}

export interface CadenceSignalInput {
  sourceId: string;
  nowMs: number;
  recentVolatility?: number;
  distanceToPayoutThresholdRatio?: number;
  remainingQuotaRatio?: number;
  receivedHttp429?: boolean;
  consecutiveErrors?: number;
  sampleSeq?: number;
}

export interface CadenceScheduleDecision {
  sourceId: string;
  feedId: string;
  previousMode: CadenceMode;
  currentMode: CadenceMode;
  transitioned: boolean;
  transitionReason: string;
  rawIntervalMs: number;
  effectiveIntervalMs: number;
  nextPollAtMs: number;
  freshnessCeilingMs: number;
  evidenceMetadata: {
    cadenceMode: CadenceMode;
    effectiveIntervalMs: number;
    freshnessCeilingMs: number;
  };
}

interface SourceRuntimeState {
  mode: CadenceMode;
  modeEnteredAtMs: number;
  lastIntervalMs: number;
  stepCount: number;
}

function deterministicJitterRatio(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const unsigned = hash >>> 0;
  // Map to [-1, 1]
  return (unsigned / 2147483647.5) - 1;
}

export class AdaptivePollingController {
  private readonly policies = new Map<string, SourceCadencePolicy>();
  private readonly states = new Map<string, SourceRuntimeState>();

  public registerSourcePolicy(policy: SourceCadencePolicy): void {
    if (policy.minIntervalMs <= 0 || policy.baseIntervalMs < policy.minIntervalMs) {
      throw new Error(
        `Invalid cadence intervals for source ${policy.sourceId}: minIntervalMs must be > 0 and <= baseIntervalMs`
      );
    }
    if (policy.freshnessWindowMs < policy.baseIntervalMs) {
      throw new Error(
        `Invalid freshnessWindowMs for source ${policy.sourceId}: freshnessWindowMs (${policy.freshnessWindowMs}) must be >= baseIntervalMs (${policy.baseIntervalMs})`
      );
    }
    if (policy.volatilityExitThreshold > policy.volatilityEnterThreshold) {
      throw new Error(
        `Invalid volatility hysteresis for source ${policy.sourceId}: exit threshold must be <= enter threshold`
      );
    }
    if (policy.proximityExitRatio < policy.proximityEnterRatio) {
      throw new Error(
        `Invalid proximity hysteresis for source ${policy.sourceId}: exit ratio must be >= enter ratio`
      );
    }

    this.policies.set(policy.sourceId, {
      ...policy,
      jitterFraction: policy.jitterFraction ?? 0.05,
    });
  }

  public evaluateNextCadence(signal: CadenceSignalInput): CadenceScheduleDecision {
    const policy = this.policies.get(signal.sourceId);
    if (!policy) {
      throw new Error(`No cadence policy registered for source ${signal.sourceId}`);
    }

    const freshnessCeilingMs = Math.min(policy.maxIntervalMs, policy.freshnessWindowMs);
    const existingState = this.states.get(signal.sourceId) ?? {
      mode: "base" as CadenceMode,
      modeEnteredAtMs: signal.nowMs - policy.minModeDwellMs,
      lastIntervalMs: policy.baseIntervalMs,
      stepCount: 0,
    };

    const dwellElapsedMs = signal.nowMs - existingState.modeEnteredAtMs;
    const canExitCurrentMode = dwellElapsedMs >= policy.minModeDwellMs;

    const { nextMode, reason } = this.resolveModeTransition(
      policy,
      existingState.mode,
      canExitCurrentMode,
      signal
    );

    const transitioned = nextMode !== existingState.mode;
    const modeEnteredAtMs = transitioned ? signal.nowMs : existingState.modeEnteredAtMs;
    const stepCount = existingState.stepCount + 1;

    const rawIntervalMs = this.computeRawIntervalMs(
      policy,
      nextMode,
      freshnessCeilingMs,
      signal
    );

    const jitterRatio = deterministicJitterRatio(
      `${signal.sourceId}:${stepCount}:${signal.sampleSeq ?? stepCount}`
    );
    const maxJitterDelta = rawIntervalMs * (policy.jitterFraction ?? 0.05);
    const jitteredInterval = Math.round(rawIntervalMs + jitterRatio * maxJitterDelta);

    const effectiveIntervalMs = Math.max(
      policy.minIntervalMs,
      Math.min(freshnessCeilingMs, jitteredInterval)
    );

    this.states.set(signal.sourceId, {
      mode: nextMode,
      modeEnteredAtMs,
      lastIntervalMs: effectiveIntervalMs,
      stepCount,
    });

    return {
      sourceId: policy.sourceId,
      feedId: policy.feedId,
      previousMode: existingState.mode,
      currentMode: nextMode,
      transitioned,
      transitionReason: reason,
      rawIntervalMs,
      effectiveIntervalMs,
      nextPollAtMs: signal.nowMs + effectiveIntervalMs,
      freshnessCeilingMs,
      evidenceMetadata: {
        cadenceMode: nextMode,
        effectiveIntervalMs,
        freshnessCeilingMs,
      },
    };
  }

  private resolveModeTransition(
    policy: SourceCadencePolicy,
    currentMode: CadenceMode,
    canExitCurrentMode: boolean,
    signal: CadenceSignalInput
  ): { nextMode: CadenceMode; reason: string } {
    const errors = signal.consecutiveErrors ?? 0;
    const quotaRatio = signal.remainingQuotaRatio ?? 1.0;
    const volatility = signal.recentVolatility ?? 0;
    const proximityRatio = signal.distanceToPayoutThresholdRatio ?? 1.0;

    // Urgent protective transitions (error backoff & quota pressure) take immediate precedence
    if (errors > 0 && !signal.receivedHttp429) {
      return {
        nextMode: "error_backoff",
        reason: `consecutive_errors=${errors}`,
      };
    }

    if (signal.receivedHttp429 || quotaRatio <= policy.quotaLowRatioThreshold) {
      return {
        nextMode: "pressured_quota",
        reason: signal.receivedHttp429
          ? "http_429_rate_limited"
          : `low_quota_ratio=${quotaRatio.toFixed(3)}`,
      };
    }

    // Urgent acceleration transitions (threshold proximity & high volatility) can preempt base mode immediately
    if (proximityRatio <= policy.proximityEnterRatio) {
      return {
        nextMode: "accelerated_threshold_proximity",
        reason: `threshold_proximity_ratio=${proximityRatio.toFixed(3)}`,
      };
    }

    if (volatility >= policy.volatilityEnterThreshold) {
      return {
        nextMode: "accelerated_volatile",
        reason: `high_volatility=${volatility.toFixed(3)}`,
      };
    }

    // Hysteresis and dwell-time hold when calming down
    if (!canExitCurrentMode && currentMode !== "base") {
      return {
        nextMode: currentMode,
        reason: "dwell_time_hold",
      };
    }

    if (
      currentMode === "accelerated_threshold_proximity" &&
      proximityRatio < policy.proximityExitRatio
    ) {
      return {
        nextMode: "accelerated_threshold_proximity",
        reason: "hysteresis_hold_threshold_proximity",
      };
    }

    if (
      currentMode === "accelerated_volatile" &&
      volatility > policy.volatilityExitThreshold
    ) {
      return {
        nextMode: "accelerated_volatile",
        reason: "hysteresis_hold_volatility",
      };
    }

    return {
      nextMode: "base",
      reason: "nominal_conditions",
    };
  }

  private computeRawIntervalMs(
    policy: SourceCadencePolicy,
    mode: CadenceMode,
    freshnessCeilingMs: number,
    signal: CadenceSignalInput
  ): number {
    switch (mode) {
      case "accelerated_threshold_proximity":
        return policy.minIntervalMs;

      case "accelerated_volatile": {
        const halfBase = Math.round(
          (policy.minIntervalMs + policy.baseIntervalMs) / 2
        );
        return Math.max(policy.minIntervalMs, halfBase);
      }

      case "pressured_quota": {
        const quotaRatio = Math.max(0.01, signal.remainingQuotaRatio ?? 0.1);
        const scale = signal.receivedHttp429
          ? 2.5
          : Math.min(3.0, policy.quotaLowRatioThreshold / quotaRatio);
        return Math.min(
          freshnessCeilingMs,
          Math.round(policy.baseIntervalMs * Math.max(1.5, scale))
        );
      }

      case "error_backoff": {
        const errors = Math.min(6, Math.max(1, signal.consecutiveErrors ?? 1));
        const backoff = policy.baseIntervalMs * Math.pow(2, errors);
        return Math.min(freshnessCeilingMs, Math.round(backoff));
      }

      case "base":
      default:
        return Math.min(freshnessCeilingMs, policy.baseIntervalMs);
    }
  }
}
