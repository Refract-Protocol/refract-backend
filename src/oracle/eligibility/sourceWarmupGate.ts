export interface WarmupPolicyConfig {
  minReadingCount: number;
  minObservationWindowMs: number;
  minAgreementRate: number;
}

export interface SourceWarmupState {
  sourceId: string;
  status: "warming_up" | "eligible" | "quarantined";
  warmupStartedAtMs: number;
  validReadingCount: number;
  agreedReadingCount: number;
}

export class SourceWarmupGate {
  private readonly policy: WarmupPolicyConfig;
  private readonly sources = new Map<string, SourceWarmupState>();

  constructor(policy: WarmupPolicyConfig) {
    this.policy = policy;
  }

  public registerOrResetWarmup(sourceId: string, nowMs: number): SourceWarmupState {
    const state: SourceWarmupState = {
      sourceId,
      status: "warming_up",
      warmupStartedAtMs: nowMs,
      validReadingCount: 0,
      agreedReadingCount: 0,
    };
    this.sources.set(sourceId, state);
    return { ...state };
  }

  public recordShadowReading(params: {
    sourceId: string;
    observedAtMs: number;
    agreedWithConsensus: boolean;
  }): SourceWarmupState {
    const state = this.sources.get(params.sourceId);
    if (!state) {
      throw new Error(`Unknown source '${params.sourceId}'`);
    }
    if (state.status === "quarantined") {
      return { ...state };
    }

    state.validReadingCount += 1;
    if (params.agreedWithConsensus) {
      state.agreedReadingCount += 1;
    }

    const elapsedMs = params.observedAtMs - state.warmupStartedAtMs;
    const agreementRate =
      state.validReadingCount > 0 ? state.agreedReadingCount / state.validReadingCount : 0;

    if (
      state.status === "warming_up" &&
      state.validReadingCount >= this.policy.minReadingCount &&
      elapsedMs >= this.policy.minObservationWindowMs &&
      agreementRate >= this.policy.minAgreementRate
    ) {
      state.status = "eligible";
    }

    return { ...state };
  }

  public quarantineSource(sourceId: string): void {
    const state = this.sources.get(sourceId);
    if (state) {
      state.status = "quarantined";
    }
  }

  public unQuarantineSource(sourceId: string, nowMs: number): SourceWarmupState {
    return this.registerOrResetWarmup(sourceId, nowMs);
  }

  public isConsensusEligible(sourceId: string): boolean {
    return this.sources.get(sourceId)?.status === "eligible";
  }
}
