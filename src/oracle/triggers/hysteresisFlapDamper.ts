export type StabilizedTriggerState = "untriggered" | "triggered";

export interface TriggerHysteresisConfig {
  feedId: string;
  direction: "below" | "above";
  enterThreshold: number; // e.g., depeg enters at <= 0.95
  exitThreshold: number; // e.g., depeg exits at >= 0.98
  minDwellTimeMs: number; // e.g., 30_000 (must stay past threshold for 30s)
  flapWindowMs: number; // e.g., 300_000
  maxTransitionsPerWindow: number; // e.g., 2
}

export interface PersistedTriggerTransition {
  feedId: string;
  oldState: StabilizedTriggerState;
  newState: StabilizedTriggerState;
  triggeringValue: number;
  evidenceDecisionId: string;
  transitionedAtMs: number;
}

export interface TriggerEvaluationOutcome {
  feedId: string;
  stabilizedState: StabilizedTriggerState;
  transitionAccepted: boolean;
  suppressionReason:
    | null
    | "WITHIN_HYSTERESIS_DEADBAND"
    | "DWELL_TIME_NOT_ELAPSED"
    | "FLAP_DAMPING_LIMIT_REACHED";
}

interface InternalFeedTracker {
  stabilizedState: StabilizedTriggerState;
  candidateTargetState: StabilizedTriggerState | null;
  candidateSinceMs: number | null;
  transitionTimestamps: number[];
}

export class TriggerHysteresisFlapDamper {
  private readonly trackers = new Map<string, InternalFeedTracker>();
  private readonly transitionLog: PersistedTriggerTransition[] = [];
  private readonly suppressedAlerts: Array<{
    feedId: string;
    reason: string;
    observedValue: number;
    timestampMs: number;
  }> = [];

  public evaluateReading(params: {
    config: TriggerHysteresisConfig;
    value: number;
    evidenceDecisionId: string;
    nowMs: number;
  }): TriggerEvaluationOutcome {
    const { config, value, evidenceDecisionId, nowMs } = params;
    this.validateHysteresisBand(config);

    let tracker = this.trackers.get(config.feedId);
    if (!tracker) {
      // First-ever evaluation initializes untriggered (or immediate candidate if breached)
      tracker = {
        stabilizedState: "untriggered",
        candidateTargetState: null,
        candidateSinceMs: null,
        transitionTimestamps: [],
      };
      this.trackers.set(config.feedId, tracker);
    }

    const desiredState = this.computeDesiredTargetState(
      config,
      tracker.stabilizedState,
      value
    );

    if (desiredState === tracker.stabilizedState) {
      // Reset candidate dwell timer if reading retreated back inside deadband or current state
      const inDeadband = this.isInsideDeadband(config, value);
      tracker.candidateTargetState = null;
      tracker.candidateSinceMs = null;
      return {
        feedId: config.feedId,
        stabilizedState: tracker.stabilizedState,
        transitionAccepted: false,
        suppressionReason: inDeadband ? "WITHIN_HYSTERESIS_DEADBAND" : null,
      };
    }

    // Desired state differs from stabilizedState -> check dwell time
    if (tracker.candidateTargetState !== desiredState) {
      tracker.candidateTargetState = desiredState;
      tracker.candidateSinceMs = nowMs;
    }

    const dwellElapsedMs = nowMs - (tracker.candidateSinceMs ?? nowMs);
    if (dwellElapsedMs < config.minDwellTimeMs) {
      return {
        feedId: config.feedId,
        stabilizedState: tracker.stabilizedState,
        transitionAccepted: false,
        suppressionReason: "DWELL_TIME_NOT_ELAPSED",
      };
    }

    // Check flap damping window
    tracker.transitionTimestamps = tracker.transitionTimestamps.filter(
      (t) => nowMs - t <= config.flapWindowMs
    );
    if (
      tracker.transitionTimestamps.length >= config.maxTransitionsPerWindow
    ) {
      this.suppressedAlerts.push({
        feedId: config.feedId,
        reason: "FLAP_DAMPING_LIMIT_REACHED",
        observedValue: value,
        timestampMs: nowMs,
      });
      return {
        feedId: config.feedId,
        stabilizedState: tracker.stabilizedState,
        transitionAccepted: false,
        suppressionReason: "FLAP_DAMPING_LIMIT_REACHED",
      };
    }

    const oldState = tracker.stabilizedState;
    tracker.stabilizedState = desiredState;
    tracker.candidateTargetState = null;
    tracker.candidateSinceMs = null;
    tracker.transitionTimestamps.push(nowMs);

    this.transitionLog.push({
      feedId: config.feedId,
      oldState,
      newState: desiredState,
      triggeringValue: value,
      evidenceDecisionId,
      transitionedAtMs: nowMs,
    });

    return {
      feedId: config.feedId,
      stabilizedState: tracker.stabilizedState,
      transitionAccepted: true,
      suppressionReason: null,
    };
  }

  public getTransitionLog(): PersistedTriggerTransition[] {
    return [...this.transitionLog];
  }

  public getSuppressedAlerts(): Array<{
    feedId: string;
    reason: string;
    observedValue: number;
    timestampMs: number;
  }> {
    return [...this.suppressedAlerts];
  }

  private validateHysteresisBand(config: TriggerHysteresisConfig): void {
    if (config.direction === "below") {
      if (config.enterThreshold > config.exitThreshold) {
        throw new Error(
          "INVALID_HYSTERESIS_BAND: For 'below' triggers, enterThreshold must be <= exitThreshold"
        );
      }
    } else {
      if (config.enterThreshold < config.exitThreshold) {
        throw new Error(
          "INVALID_HYSTERESIS_BAND: For 'above' triggers, enterThreshold must be >= exitThreshold"
        );
      }
    }
  }

  private computeDesiredTargetState(
    config: TriggerHysteresisConfig,
    currentState: StabilizedTriggerState,
    value: number
  ): StabilizedTriggerState {
    if (config.direction === "below") {
      if (currentState === "untriggered" && value <= config.enterThreshold) {
        return "triggered";
      }
      if (currentState === "triggered" && value >= config.exitThreshold) {
        return "untriggered";
      }
      return currentState;
    }

    if (currentState === "untriggered" && value >= config.enterThreshold) {
      return "triggered";
    }
    if (currentState === "triggered" && value <= config.exitThreshold) {
      return "untriggered";
    }
    return currentState;
  }

  private isInsideDeadband(
    config: TriggerHysteresisConfig,
    value: number
  ): boolean {
    if (config.direction === "below") {
      return value > config.enterThreshold && value < config.exitThreshold;
    }
    return value < config.enterThreshold && value > config.exitThreshold;
  }
}
