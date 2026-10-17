export type FeedTrustHealthState = "healthy" | "degraded" | "paused";

export type DegradedReasonCode =
  | "quorum_shortfall"
  | "zero_fresh_sources"
  | "all_sources_divergent"
  | "consensus_engine_unavailable";

export type ClaimResolutionState =
  | "settled_payout"
  | "not_triggered"
  | "blocked_degraded_trust";

export interface CorroborationHealthTick {
  coverageType: string;
  totalConfiguredSources: number;
  freshSourcesCount: number;
  agreeingSourcesCount: number;
  requiredQuorumSources: number;
  consensusEngineAvailable: boolean;
  agreedValue?: number | null;
  nowMs?: number;
}

export interface FeedDegradedStatusSnapshot {
  coverageType: string;
  state: FeedTrustHealthState;
  reasonCode: DegradedReasonCode | null;
  allowOnChainPayoutPublish: boolean;
  allowClaimSettlement: boolean;
  operatorAlertRequired: boolean;
  enteredDegradedAtMs: number | null;
  lastEvaluatedAtMs: number;
}

export interface TrackedCoverageClaim {
  claimId: string;
  coverageType: string;
  payoutConditionMet: (agreedValue: number) => boolean;
  state: ClaimResolutionState | "pending_evaluation";
  blockedReasonCode?: DegradedReasonCode;
  corroboratedValueAtTrigger?: number;
  updatedAtMs: number;
}

export class FeedDegradedModeController {
  private readonly feedStates = new Map<string, FeedDegradedStatusSnapshot>();
  private readonly claims = new Map<string, TrackedCoverageClaim>();

  public evaluateFeedTick(
    tick: CorroborationHealthTick
  ): FeedDegradedStatusSnapshot {
    const nowMs = tick.nowMs ?? Date.now();
    const prev = this.feedStates.get(tick.coverageType);

    let reasonCode: DegradedReasonCode | null = null;
    let state: FeedTrustHealthState = "healthy";

    if (!tick.consensusEngineAvailable) {
      reasonCode = "consensus_engine_unavailable";
      state = "paused";
    } else if (tick.freshSourcesCount <= 0) {
      reasonCode = "zero_fresh_sources";
      state = "paused";
    } else if (tick.freshSourcesCount < tick.requiredQuorumSources) {
      reasonCode = "quorum_shortfall";
      state = "degraded";
    } else if (tick.agreeingSourcesCount < tick.requiredQuorumSources) {
      reasonCode = "all_sources_divergent";
      state = "degraded";
    } else {
      // Even if some sources are stale (freshSourcesCount < totalConfiguredSources),
      // quorum is satisfied -> stay healthy!
      reasonCode = null;
      state = "healthy";
    }

    const isHealthy = state === "healthy";
    const enteredDegradedAtMs = isHealthy
      ? null
      : (prev?.enteredDegradedAtMs ?? nowMs);

    const snapshot: FeedDegradedStatusSnapshot = {
      coverageType: tick.coverageType,
      state,
      reasonCode,
      allowOnChainPayoutPublish: isHealthy,
      allowClaimSettlement: isHealthy,
      operatorAlertRequired: !isHealthy,
      enteredDegradedAtMs,
      lastEvaluatedAtMs: nowMs,
    };

    this.feedStates.set(tick.coverageType, snapshot);

    // If healthy and an agreedValue is present, automatically process pending or previously blocked claims
    if (
      isHealthy &&
      tick.agreedValue !== undefined &&
      tick.agreedValue !== null
    ) {
      this.processClaimsForHealthyFeed(
        tick.coverageType,
        tick.agreedValue,
        nowMs
      );
    }

    return { ...snapshot };
  }

  public registerClaim(params: {
    claimId: string;
    coverageType: string;
    payoutConditionMet: (agreedValue: number) => boolean;
    nowMs?: number;
  }): TrackedCoverageClaim {
    const claim: TrackedCoverageClaim = {
      claimId: params.claimId,
      coverageType: params.coverageType,
      payoutConditionMet: params.payoutConditionMet,
      state: "pending_evaluation",
      updatedAtMs: params.nowMs ?? Date.now(),
    };
    this.claims.set(claim.claimId, claim);
    return { ...claim };
  }

  public evaluateClaim(
    claimId: string,
    candidateAgreedValue: number | null,
    nowMs: number = Date.now()
  ): TrackedCoverageClaim {
    const claim = this.claims.get(claimId);
    if (!claim) {
      throw new Error(`Unknown claimId: ${claimId}`);
    }

    // Never lose an already-settled claim that was corroborated before degraded mode
    if (claim.state === "settled_payout") {
      return { ...claim };
    }

    const feedStatus = this.feedStates.get(claim.coverageType);
    if (
      !feedStatus ||
      feedStatus.state !== "healthy" ||
      candidateAgreedValue === null
    ) {
      claim.state = "blocked_degraded_trust";
      claim.blockedReasonCode =
        feedStatus?.reasonCode ?? "consensus_engine_unavailable";
      claim.updatedAtMs = nowMs;
      return { ...claim };
    }

    if (claim.payoutConditionMet(candidateAgreedValue)) {
      claim.state = "settled_payout";
      claim.corroboratedValueAtTrigger = candidateAgreedValue;
      claim.blockedReasonCode = undefined;
      claim.updatedAtMs = nowMs;
    } else {
      claim.state = "not_triggered";
      claim.blockedReasonCode = undefined;
      claim.updatedAtMs = nowMs;
    }

    return { ...claim };
  }

  public getFeedStatus(
    coverageType: string
  ): FeedDegradedStatusSnapshot | undefined {
    const s = this.feedStates.get(coverageType);
    return s ? { ...s } : undefined;
  }

  public getClaim(claimId: string): TrackedCoverageClaim | undefined {
    const c = this.claims.get(claimId);
    return c ? { ...c } : undefined;
  }

  private processClaimsForHealthyFeed(
    coverageType: string,
    agreedValue: number,
    nowMs: number
  ): void {
    for (const claim of this.claims.values()) {
      if (
        claim.coverageType === coverageType &&
        (claim.state === "pending_evaluation" ||
          claim.state === "blocked_degraded_trust")
      ) {
        this.evaluateClaim(claim.claimId, agreedValue, nowMs);
      }
    }
  }
}
