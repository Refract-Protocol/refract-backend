export type SourceReliabilityState = "healthy" | "degraded" | "quarantined";

export type ManualSourceOverrideMode = "force_quarantine" | "force_clear" | null;

export interface SourceReliabilitySnapshot {
  sourceId: string;
  state: SourceReliabilityState;
  eligibleForConsensus: boolean;
  consecutiveFailures: number;
  consecutiveCleanInBandPolls: number;
  trailingErrorRate: number;
  trailingDivergenceRate: number;
  lastSuccessfulReadingAtMs: number | null;
  manualOverride: ManualSourceOverrideMode;
  manualOverrideActor: string | null;
  manualOverrideReason: string | null;
}

export interface SourceReliabilityThresholdConfig {
  windowSize: number;
  degradeConsecutiveFailures: number;
  quarantineConsecutiveFailures: number;
  quarantineDivergenceRate: number;
  divergenceBandRatio: number;
  recoverAfterCleanPolls: number;
}

interface PollSample {
  failed: boolean;
  divergedFromConsensus: boolean;
}

const DEFAULT_CONFIG: SourceReliabilityThresholdConfig = {
  windowSize: 10,
  degradeConsecutiveFailures: 2,
  quarantineConsecutiveFailures: 4,
  quarantineDivergenceRate: 0.5,
  divergenceBandRatio: 0.03,
  recoverAfterCleanPolls: 3,
};

export class SourceReliabilityTracker {
  private readonly config: SourceReliabilityThresholdConfig;
  private readonly snapshots = new Map<string, SourceReliabilitySnapshot>();
  private readonly historyBySource = new Map<string, PollSample[]>();
  private readonly soleSourceAlerts: Array<{
    sourceId: string;
    timestampMs: number;
    message: string;
  }> = [];

  constructor(config: Partial<SourceReliabilityThresholdConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  public recordPollOutcome(params: {
    sourceId: string;
    failed: boolean;
    observedValue?: number;
    consensusValue?: number;
    soleParticipantOnFeed?: boolean;
    nowMs?: number;
  }): SourceReliabilitySnapshot {
    const nowMs = params.nowMs ?? Date.now();
    let snap = this.snapshots.get(params.sourceId);
    if (!snap) {
      // Cold start: trust but watch
      snap = {
        sourceId: params.sourceId,
        state: "healthy",
        eligibleForConsensus: true,
        consecutiveFailures: 0,
        consecutiveCleanInBandPolls: 0,
        trailingErrorRate: 0,
        trailingDivergenceRate: 0,
        lastSuccessfulReadingAtMs: null,
        manualOverride: null,
        manualOverrideActor: null,
        manualOverrideReason: null,
      };
    }

    let diverged = false;
    if (
      !params.failed &&
      typeof params.observedValue === "number" &&
      typeof params.consensusValue === "number"
    ) {
      const denom = Math.max(Math.abs(params.consensusValue), 1e-9);
      diverged =
        Math.abs(params.observedValue - params.consensusValue) / denom >
        this.config.divergenceBandRatio;
    }

    const history = this.historyBySource.get(params.sourceId) ?? [];
    history.push({ failed: params.failed, divergedFromConsensus: diverged });
    if (history.length > this.config.windowSize) {
      history.splice(0, history.length - this.config.windowSize);
    }
    this.historyBySource.set(params.sourceId, history);

    if (params.failed || diverged) {
      snap.consecutiveFailures += 1;
      snap.consecutiveCleanInBandPolls = 0;
    } else {
      snap.consecutiveFailures = 0;
      snap.consecutiveCleanInBandPolls += 1;
      snap.lastSuccessfulReadingAtMs = nowMs;
    }

    const totalSamples = history.length;
    snap.trailingErrorRate = Number(
      (history.filter((h) => h.failed).length / totalSamples).toFixed(4)
    );
    snap.trailingDivergenceRate = Number(
      (
        history.filter((h) => h.divergedFromConsensus).length / totalSamples
      ).toFixed(4)
    );

    // State transition with hysteresis
    let computedState = snap.state;
    const shouldQuarantine =
      snap.consecutiveFailures >= this.config.quarantineConsecutiveFailures ||
      (totalSamples >= 4 &&
        snap.trailingDivergenceRate >= this.config.quarantineDivergenceRate);

    if (shouldQuarantine) {
      if (params.soleParticipantOnFeed) {
        // Sole participant on feed: emit high-severity alert and degrade rather than silent black-hole
        this.soleSourceAlerts.push({
          sourceId: params.sourceId,
          timestampMs: nowMs,
          message: `SOLE_SOURCE_DEGRADATION_ALERT: Sole participant "${params.sourceId}" breached quarantine thresholds`,
        });
        computedState = "degraded";
      } else {
        computedState = "quarantined";
      }
    } else if (snap.state === "quarantined") {
      // Hysteresis: remain quarantined until recoverAfterCleanPolls consecutive clean in-band polls
      if (
        snap.consecutiveCleanInBandPolls >= this.config.recoverAfterCleanPolls
      ) {
        computedState = "healthy";
      }
    } else if (
      snap.consecutiveFailures >= this.config.degradeConsecutiveFailures
    ) {
      computedState = "degraded";
    } else if (
      snap.state === "degraded" &&
      snap.consecutiveCleanInBandPolls >= 2
    ) {
      computedState = "healthy";
    }

    // Apply operator manual override if set
    if (snap.manualOverride === "force_quarantine") {
      snap.state = "quarantined";
    } else if (snap.manualOverride === "force_clear") {
      snap.state = "healthy";
    } else {
      snap.state = computedState;
    }

    snap.eligibleForConsensus = snap.state !== "quarantined";
    this.snapshots.set(params.sourceId, snap);
    return { ...snap };
  }

  public setManualOverride(params: {
    sourceId: string;
    mode: ManualSourceOverrideMode;
    actorId: string;
    reason: string;
  }): SourceReliabilitySnapshot {
    const existing = this.snapshots.get(params.sourceId) ?? {
      sourceId: params.sourceId,
      state: "healthy",
      eligibleForConsensus: true,
      consecutiveFailures: 0,
      consecutiveCleanInBandPolls: 0,
      trailingErrorRate: 0,
      trailingDivergenceRate: 0,
      lastSuccessfulReadingAtMs: null,
      manualOverride: null,
      manualOverrideActor: null,
      manualOverrideReason: null,
    };

    existing.manualOverride = params.mode;
    existing.manualOverrideActor = params.actorId;
    existing.manualOverrideReason = params.reason;

    if (params.mode === "force_quarantine") {
      existing.state = "quarantined";
      existing.eligibleForConsensus = false;
    } else if (params.mode === "force_clear") {
      existing.state = "healthy";
      existing.eligibleForConsensus = true;
      existing.consecutiveFailures = 0;
    }

    this.snapshots.set(params.sourceId, existing);
    return { ...existing };
  }

  public getSoleSourceAlerts(): Array<{
    sourceId: string;
    timestampMs: number;
    message: string;
  }> {
    return [...this.soleSourceAlerts];
  }
}
