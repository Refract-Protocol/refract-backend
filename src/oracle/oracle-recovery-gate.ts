import type { OracleReading } from './oracle-reading';

export type OracleAdmission = 'publish' | 'canary' | 'hold';

export interface OracleRecoveryConfig {
  cooldownMs: number;
  healthyReadingsToGraduate: number;
  minimumCanaryDurationMs: number;
  minimumCorroboratingPeers: number;
}

interface CoverageRecoveryState {
  mode: 'normal' | 'open' | 'canary';
  resumeAt: number;
  canaryStartedAt: number;
  healthyReadings: number;
  lastCanaryReadingAt: number;
  reason?: string;
}

const DEFAULT_CONFIG: OracleRecoveryConfig = {
  cooldownMs: 60_000,
  healthyReadingsToGraduate: 5,
  minimumCanaryDurationMs: 5 * 60_000,
  minimumCorroboratingPeers: 2,
};

/**
 * Per-coverage payout admission gate. An open breaker automatically admits
 * healthy readings into a non-publishing canary after its cooldown; it only
 * returns to normal after a sustained, corroborated healthy interval.
 */
export class OracleRecoveryGate {
  private readonly config: OracleRecoveryConfig;
  private readonly states = new Map<string, CoverageRecoveryState>();

  constructor(config: Partial<OracleRecoveryConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (
      !Number.isInteger(this.config.healthyReadingsToGraduate) ||
      this.config.healthyReadingsToGraduate < 2 ||
      !Number.isInteger(this.config.minimumCorroboratingPeers) ||
      this.config.minimumCorroboratingPeers < 1 ||
      this.config.cooldownMs < 0 ||
      this.config.minimumCanaryDurationMs < 0
    ) {
      throw new Error('Invalid oracle recovery gate configuration');
    }
  }

  trip(coverageType: string, reason: string, now = Date.now()): void {
    const state = this.stateFor(coverageType);
    state.mode = 'open';
    state.resumeAt = now + this.config.cooldownMs;
    state.canaryStartedAt = 0;
    state.healthyReadings = 0;
    state.lastCanaryReadingAt = 0;
    state.reason = reason;
  }

  admit(
    reading: OracleReading,
    corroboratingPeers: number,
    now = Date.now(),
  ): OracleAdmission {
    const state = this.stateFor(reading.coverageType);
    if (reading.severity === 'triggered' || reading.degraded) {
      this.trip(
        reading.coverageType,
        reading.degraded ? 'degraded reading' : 'triggered reading',
        now,
      );
      return 'hold';
    }

    const corroborated =
      Number.isInteger(corroboratingPeers) &&
      corroboratingPeers >= this.config.minimumCorroboratingPeers;

    if (state.mode === 'normal') {
      return corroborated ? 'publish' : 'hold';
    }

    if (state.mode === 'open') {
      if (now < state.resumeAt || !corroborated) {
        return 'hold';
      }
      state.mode = 'canary';
      state.canaryStartedAt = now;
      state.lastCanaryReadingAt = now;
      state.healthyReadings = 1;
      return 'canary';
    }

    if (!corroborated || now <= state.lastCanaryReadingAt) {
      this.trip(reading.coverageType, 'canary corroboration lost', now);
      return 'hold';
    }

    state.lastCanaryReadingAt = now;
    state.healthyReadings += 1;
    if (
      state.healthyReadings >= this.config.healthyReadingsToGraduate &&
      now - state.canaryStartedAt >= this.config.minimumCanaryDurationMs
    ) {
      state.mode = 'normal';
      state.reason = undefined;
      state.healthyReadings = 0;
    }

    // The reading that completes graduation is still canary-only.
    return 'canary';
  }

  getState(coverageType: string): Readonly<CoverageRecoveryState> {
    return { ...this.stateFor(coverageType) };
  }

  private stateFor(coverageType: string): CoverageRecoveryState {
    let state = this.states.get(coverageType);
    if (!state) {
      state = {
        mode: 'normal',
        resumeAt: 0,
        canaryStartedAt: 0,
        healthyReadings: 0,
        lastCanaryReadingAt: 0,
      };
      this.states.set(coverageType, state);
    }
    return state;
  }
}
