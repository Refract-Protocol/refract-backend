export interface FeedFreshnessPolicy {
  feedKey: string;
  freshnessWindowMs: number;
  maxClockSkewMs: number;
  heartbeatIntervalMs: number;
  allowIngestionTimestampFallback?: boolean;
}

export type FreshnessInvalidReason =
  | "TOO_OLD"
  | "FUTURE_SKEW_EXCEEDED"
  | "MISSING_OBSERVED_TIMESTAMP";

export interface PersistedFreshnessReading {
  feedKey: string;
  sourceId: string;
  value: number;
  observedAtMs: number;
  ingestedAtMs: number;
  usedFallbackTimestamp: boolean;
  usableForConsensus: boolean;
  invalidReason: FreshnessInvalidReason | null;
}

export interface FeedStalenessState {
  feedKey: string;
  stale: boolean;
  heartbeatGapSources: string[];
  transitionWarnings: string[];
}

export class FeedFreshnessPolicyGuard {
  private readonly policies = new Map<string, FeedFreshnessPolicy>();
  private readonly lastValidHeartbeatBySource = new Map<string, number>();
  private readonly feedStaleState = new Map<string, boolean>();
  private readonly transitionWarnings: string[] = [];

  public registerPolicy(policy: FeedFreshnessPolicy): void {
    this.policies.set(policy.feedKey, { ...policy });
  }

  public validateAtIngestion(params: {
    feedKey: string;
    sourceId: string;
    value: number;
    observedAtMs: number | null | undefined;
    ingestedAtMs: number;
  }): PersistedFreshnessReading {
    const policy = this.policies.get(params.feedKey);
    if (!policy) {
      throw new Error(`No freshness policy configured for feed '${params.feedKey}'`);
    }

    let observedAtMs = params.observedAtMs;
    let usedFallbackTimestamp = false;

    if (observedAtMs === null || observedAtMs === undefined) {
      if (policy.allowIngestionTimestampFallback) {
        observedAtMs = params.ingestedAtMs;
        usedFallbackTimestamp = true;
      } else {
        return {
          feedKey: params.feedKey,
          sourceId: params.sourceId,
          value: params.value,
          observedAtMs: params.ingestedAtMs,
          ingestedAtMs: params.ingestedAtMs,
          usedFallbackTimestamp: false,
          usableForConsensus: false,
          invalidReason: "MISSING_OBSERVED_TIMESTAMP",
        };
      }
    }

    if (observedAtMs - params.ingestedAtMs > policy.maxClockSkewMs) {
      return {
        feedKey: params.feedKey,
        sourceId: params.sourceId,
        value: params.value,
        observedAtMs,
        ingestedAtMs: params.ingestedAtMs,
        usedFallbackTimestamp,
        usableForConsensus: false,
        invalidReason: "FUTURE_SKEW_EXCEEDED",
      };
    }

    if (params.ingestedAtMs - observedAtMs > policy.freshnessWindowMs) {
      return {
        feedKey: params.feedKey,
        sourceId: params.sourceId,
        value: params.value,
        observedAtMs,
        ingestedAtMs: params.ingestedAtMs,
        usedFallbackTimestamp,
        usableForConsensus: false,
        invalidReason: "TOO_OLD",
      };
    }

    this.lastValidHeartbeatBySource.set(
      `${params.feedKey}:${params.sourceId}`,
      params.ingestedAtMs
    );

    return {
      feedKey: params.feedKey,
      sourceId: params.sourceId,
      value: params.value,
      observedAtMs,
      ingestedAtMs: params.ingestedAtMs,
      usedFallbackTimestamp,
      usableForConsensus: true,
      invalidReason: null,
    };
  }

  public evaluateFeedHeartbeatHealth(params: {
    feedKey: string;
    expectedSources: string[];
    nowMs: number;
  }): FeedStalenessState {
    const policy = this.policies.get(params.feedKey);
    if (!policy) {
      throw new Error(`No freshness policy configured for feed '${params.feedKey}'`);
    }

    const heartbeatGapSources: string[] = [];
    for (const sourceId of params.expectedSources) {
      const lastBeat = this.lastValidHeartbeatBySource.get(
        `${params.feedKey}:${sourceId}`
      );
      if (
        lastBeat === undefined ||
        params.nowMs - lastBeat > policy.heartbeatIntervalMs
      ) {
        heartbeatGapSources.push(sourceId);
      }
    }

    const isStale = heartbeatGapSources.length > 0;
    const wasStale = this.feedStaleState.get(params.feedKey) ?? false;

    if (isStale && !wasStale) {
      this.transitionWarnings.push(
        `WARN: Feed '${params.feedKey}' transitioned to STALE (missing heartbeats from: ${heartbeatGapSources.join(", ")})`
      );
    }
    this.feedStaleState.set(params.feedKey, isStale);

    return {
      feedKey: params.feedKey,
      stale: isStale,
      heartbeatGapSources,
      transitionWarnings: [...this.transitionWarnings],
    };
  }
}
