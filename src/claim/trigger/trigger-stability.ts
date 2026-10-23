/**
 * Debounced threshold-trigger evaluation.
 *
 * A raw `value < threshold` check flips every time a reading crosses the
 * threshold. A feed hovering around it (USDC at 0.9499 / 0.9501 / 0.9499 …)
 * then switches a coverage condition on and off on every scan, so whether a
 * claim settles depends on which side the scan happened to land on. That is
 * inconsistent, and someone who can nudge a thin feed can time it.
 *
 * TriggerStabilityEvaluator puts three guards between the raw comparison and
 * the "condition is met" decision:
 *
 *  1. Hysteresis. The condition turns on when the value crosses the threshold,
 *     but only turns off once the value has recovered past
 *     `threshold ± hysteresis`. Values inside the band never change state.
 *  2. Minimum dwell. A change of state (on or off) is only confirmed once the
 *     value has stayed on the new side for `minDwellMs` and for at least
 *     `minConfirmations` consecutive observations. One spike can't do it.
 *  3. Flap damping. Each crossing of the raw threshold adds a penalty that
 *     decays exponentially (half-life `halfLifeMs`). Above `suppressAbove`
 *     the key is "suppressed": its confirmed state is frozen and no change is
 *     confirmed until the penalty decays below `reuseBelow`. The penalty is
 *     capped at `maxPenalty`, so suppression lasts at most
 *     `halfLifeMs * log2(maxPenalty / reuseBelow)` after the flapping stops.
 *
 * The evaluator is deterministic: it takes the observation time as input and
 * never reads the clock. Observations at or before the last accepted one are
 * ignored, so replayed or reordered readings can't rewind the state.
 */

export type TriggerDirection = "below" | "above";

export type TriggerPhase =
  /** Condition not met. */
  | "clear"
  /** Value is past the threshold; waiting for dwell/confirmations before turning on. */
  | "arming"
  /** Condition confirmed met. */
  | "triggered"
  /** Condition met, value recovered past the hysteresis band; waiting for dwell before turning off. */
  | "disarming";

export interface FlapDampingConfig {
  /** Penalty added on every crossing of the raw threshold. */
  penaltyPerFlip: number;
  /** Suppress state changes once the decayed penalty exceeds this. */
  suppressAbove: number;
  /** Lift suppression once the decayed penalty falls below this. */
  reuseBelow: number;
  /** Penalty half-life. */
  halfLifeMs: number;
  /** Upper bound on the penalty, which bounds the worst-case suppression time. */
  maxPenalty: number;
}

export interface TriggerStabilityConfig {
  /** Width of the band, in reading units, the value must clear before the condition turns off. */
  hysteresis: number;
  /** How long the value must stay on the new side before a state change is confirmed. */
  minDwellMs: number;
  /** How many consecutive observations on the new side are required before a state change is confirmed. */
  minConfirmations: number;
  flap: FlapDampingConfig;
}

export interface TriggerObservation {
  value: number;
  threshold: number;
  direction: TriggerDirection;
  /** Epoch milliseconds the reading was observed at. */
  observedAt: number;
}

export interface TriggerKeyState {
  phase: TriggerPhase;
  /** When the current arming/disarming candidate started. */
  candidateSince: number | null;
  /** Consecutive observations supporting the current candidate. */
  candidateCount: number;
  /** When the condition was last confirmed on. */
  confirmedAt: number | null;
  /** Last raw comparison result (value past threshold?). */
  lastRawBreached: boolean | null;
  penalty: number;
  suppressed: boolean;
  lastObservedAt: number | null;
  /** Number of raw threshold crossings seen. */
  flips: number;
}

export interface TriggerDecision {
  /** True when the condition is confirmed met (phase `triggered` or `disarming`). */
  triggered: boolean;
  phase: TriggerPhase;
  suppressed: boolean;
  penalty: number;
  /** When the condition was confirmed on, if it is currently met. */
  confirmedAt: number | null;
  /** True when this observation changed the confirmed outcome. */
  changed: boolean;
  /** False when the observation was ignored (out of order or duplicate). */
  accepted: boolean;
  reason: string;
}

/**
 * Emitted when the confirmed outcome changes, or when a change was due
 * (dwell met) but flap damping held it back. Carries the evidence for the
 * decision so it can be persisted and audited.
 */
export interface TriggerTransitionEvent {
  key: string;
  kind: "transition" | "suppressed";
  from: TriggerPhase;
  to: TriggerPhase;
  at: number;
  evidence: {
    value: number;
    threshold: number;
    direction: TriggerDirection;
    hysteresis: number;
    penalty: number;
    flips: number;
    candidateSince: number | null;
    reason: string;
  };
}

export type TriggerTransitionListener = (e: TriggerTransitionEvent) => void;

export const DEFAULT_FLAP_DAMPING: FlapDampingConfig = {
  penaltyPerFlip: 1000,
  suppressAbove: 3000,
  reuseBelow: 750,
  halfLifeMs: 15 * 60_000,
  maxPenalty: 6000,
};

/**
 * Hysteresis band per coverage type, in the units OracleReading.value uses for
 * that type (see oracle-encoding.ts): USD price, percent, ratio, percent, minutes.
 */
export const DEFAULT_HYSTERESIS_BY_COVERAGE_TYPE: Readonly<Record<number, number>> = {
  0: 0.005, // StablecoinDepeg: $0.005
  1: 1, // MarketCrash: 1 percentage point
  2: 0.02, // LiquidationShield: 0.02 ratio
  3: 1, // SmartContractRisk: 1 percentage point
  4: 10, // FlightDelay: 10 minutes
};

export function defaultTriggerConfig(
  coverageType: number,
  overrides: Partial<Omit<TriggerStabilityConfig, "flap">> & { flap?: Partial<FlapDampingConfig> } = {},
): TriggerStabilityConfig {
  return {
    hysteresis: overrides.hysteresis ?? DEFAULT_HYSTERESIS_BY_COVERAGE_TYPE[coverageType] ?? 0,
    minDwellMs: overrides.minDwellMs ?? 5 * 60_000,
    minConfirmations: overrides.minConfirmations ?? 2,
    flap: { ...DEFAULT_FLAP_DAMPING, ...(overrides.flap ?? {}) },
  };
}

/** Reads dwell/confirmation overrides from the environment. Invalid values fall back to the defaults. */
export function triggerOverridesFromEnv(
  env: Record<string, string | undefined>,
): Partial<Pick<TriggerStabilityConfig, "minDwellMs" | "minConfirmations">> {
  const out: Partial<Pick<TriggerStabilityConfig, "minDwellMs" | "minConfirmations">> = {};
  const dwell = parseNonNegativeInt(env.TRIGGER_MIN_DWELL_SECONDS);
  if (dwell !== undefined) out.minDwellMs = dwell * 1000;
  const confirmations = parseNonNegativeInt(env.TRIGGER_MIN_CONFIRMATIONS);
  if (confirmations !== undefined) out.minConfirmations = Math.max(1, confirmations);
  return out;
}

function parseNonNegativeInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export function validateTriggerConfig(config: TriggerStabilityConfig): void {
  const { hysteresis, minDwellMs, minConfirmations, flap } = config;
  if (!Number.isFinite(hysteresis) || hysteresis < 0) throw new Error("hysteresis must be a finite number >= 0");
  if (!Number.isFinite(minDwellMs) || minDwellMs < 0) throw new Error("minDwellMs must be >= 0");
  if (!Number.isInteger(minConfirmations) || minConfirmations < 1) throw new Error("minConfirmations must be an integer >= 1");
  if (!(flap.halfLifeMs > 0)) throw new Error("flap.halfLifeMs must be > 0");
  if (!(flap.penaltyPerFlip >= 0)) throw new Error("flap.penaltyPerFlip must be >= 0");
  if (!(flap.reuseBelow > 0 && flap.reuseBelow < flap.suppressAbove)) {
    throw new Error("flap.reuseBelow must be > 0 and < flap.suppressAbove");
  }
  if (!(flap.maxPenalty >= flap.suppressAbove)) throw new Error("flap.maxPenalty must be >= flap.suppressAbove");
}

/** Worst-case time a key stays suppressed after it stops flapping. */
export function maxSuppressionMs(flap: FlapDampingConfig): number {
  return flap.halfLifeMs * Math.log2(flap.maxPenalty / flap.reuseBelow);
}

function initialState(): TriggerKeyState {
  return {
    phase: "clear",
    candidateSince: null,
    candidateCount: 0,
    confirmedAt: null,
    lastRawBreached: null,
    penalty: 0,
    suppressed: false,
    lastObservedAt: null,
    flips: 0,
  };
}

function isConfirmed(phase: TriggerPhase): boolean {
  return phase === "triggered" || phase === "disarming";
}

/**
 * Tracks one debounced trigger per key (normally a policy id). Not shared
 * across processes; use snapshot()/restore() to persist state.
 */
export class TriggerStabilityEvaluator {
  private readonly states = new Map<string, TriggerKeyState>();
  private readonly listeners: TriggerTransitionListener[] = [];

  constructor(private readonly configFor: (key: string) => TriggerStabilityConfig) {}

  evaluate(key: string, obs: TriggerObservation): TriggerDecision {
    const config = this.configFor(key);
    validateTriggerConfig(config);
    if (!Number.isFinite(obs.value) || !Number.isFinite(obs.threshold) || !Number.isFinite(obs.observedAt)) {
      throw new Error(`Non-finite trigger observation for ${key}`);
    }

    const prev = this.states.get(key) ?? initialState();
    if (prev.lastObservedAt !== null && obs.observedAt <= prev.lastObservedAt) {
      return this.decision(prev, false, false, "ignored: observation not newer than last accepted one");
    }

    const s: TriggerKeyState = { ...prev };
    const wasConfirmed = isConfirmed(s.phase);

    // Flap damping: decay, then charge for a raw threshold crossing.
    if (s.lastObservedAt !== null) {
      const elapsed = obs.observedAt - s.lastObservedAt;
      s.penalty = s.penalty * Math.pow(2, -elapsed / config.flap.halfLifeMs);
    }
    const breached = obs.direction === "below" ? obs.value < obs.threshold : obs.value > obs.threshold;
    if (s.lastRawBreached !== null && breached !== s.lastRawBreached) {
      s.flips += 1;
      s.penalty = Math.min(config.flap.maxPenalty, s.penalty + config.flap.penaltyPerFlip);
    }
    s.lastRawBreached = breached;
    s.lastObservedAt = obs.observedAt;
    if (!s.suppressed && s.penalty > config.flap.suppressAbove) s.suppressed = true;
    else if (s.suppressed && s.penalty < config.flap.reuseBelow) s.suppressed = false;

    // Exit level for hysteresis: the value must recover past threshold ± band.
    const recovered =
      obs.direction === "below"
        ? obs.value >= obs.threshold + config.hysteresis
        : obs.value <= obs.threshold - config.hysteresis;

    const dwellMet = (): boolean =>
      s.candidateSince !== null &&
      s.candidateCount >= config.minConfirmations &&
      obs.observedAt - s.candidateSince >= config.minDwellMs;

    const fromPhase = s.phase;
    const candidateSince = s.candidateSince;
    let suppressedChange = false;
    let reason: string;
    switch (s.phase) {
      case "clear":
      case "arming": {
        if (!breached) {
          s.phase = "clear";
          s.candidateSince = null;
          s.candidateCount = 0;
          reason = "threshold not breached";
          break;
        }
        if (s.phase === "clear") {
          s.phase = "arming";
          s.candidateSince = obs.observedAt;
          s.candidateCount = 1;
        } else {
          s.candidateCount += 1;
        }
        if (!dwellMet()) {
          reason = `threshold breached; waiting for dwell (${s.candidateCount}/${config.minConfirmations} observations, ${obs.observedAt - (s.candidateSince ?? obs.observedAt)}/${config.minDwellMs}ms)`;
        } else if (s.suppressed) {
          suppressedChange = true;
          reason = `threshold breached and dwell met, but trigger is suppressed for flapping (penalty ${Math.round(s.penalty)})`;
        } else {
          s.phase = "triggered";
          s.confirmedAt = obs.observedAt;
          s.candidateSince = null;
          s.candidateCount = 0;
          reason = "threshold breach confirmed";
        }
        break;
      }
      case "triggered":
      case "disarming": {
        if (!recovered) {
          s.phase = "triggered";
          s.candidateSince = null;
          s.candidateCount = 0;
          reason = breached ? "threshold breached" : "within hysteresis band; condition stays met";
          break;
        }
        if (s.phase === "triggered") {
          s.phase = "disarming";
          s.candidateSince = obs.observedAt;
          s.candidateCount = 1;
        } else {
          s.candidateCount += 1;
        }
        if (!dwellMet()) {
          reason = "recovered past hysteresis band; waiting for dwell before clearing";
        } else if (s.suppressed) {
          suppressedChange = true;
          reason = `recovered and dwell met, but clearing is suppressed for flapping (penalty ${Math.round(s.penalty)})`;
        } else {
          s.phase = "clear";
          s.confirmedAt = null;
          s.candidateSince = null;
          s.candidateCount = 0;
          reason = "recovery confirmed; condition cleared";
        }
        break;
      }
    }

    this.states.set(key, s);
    const changed = wasConfirmed !== isConfirmed(s.phase);
    if (changed || suppressedChange) {
      const target: TriggerPhase = changed ? s.phase : isConfirmed(fromPhase) ? "clear" : "triggered";
      this.emit({
        key,
        kind: changed ? "transition" : "suppressed",
        from: fromPhase,
        to: target,
        at: obs.observedAt,
        evidence: {
          value: obs.value,
          threshold: obs.threshold,
          direction: obs.direction,
          hysteresis: config.hysteresis,
          penalty: s.penalty,
          flips: s.flips,
          candidateSince,
          reason,
        },
      });
    }
    return this.decision(s, true, changed, reason);
  }

  /** Subscribe to confirmed transitions and damping-suppressed ones. */
  onTransition(listener: TriggerTransitionListener): void {
    this.listeners.push(listener);
  }

  private emit(e: TriggerTransitionEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // A broken listener must not change trigger decisions.
      }
    }
  }

  /** Current state for a key, or undefined if it has never been observed. */
  get(key: string): TriggerKeyState | undefined {
    const s = this.states.get(key);
    return s ? { ...s } : undefined;
  }

  /** Drop state for a key, e.g. after its policy settles or expires. */
  forget(key: string): void {
    this.states.delete(key);
  }

  snapshot(): Record<string, TriggerKeyState> {
    const out: Record<string, TriggerKeyState> = {};
    for (const [k, v] of this.states) out[k] = { ...v };
    return out;
  }

  restore(snapshot: Record<string, TriggerKeyState>): void {
    this.states.clear();
    for (const [k, v] of Object.entries(snapshot)) this.states.set(k, { ...v });
  }

  private decision(s: TriggerKeyState, accepted: boolean, changed: boolean, reason: string): TriggerDecision {
    return {
      triggered: isConfirmed(s.phase),
      phase: s.phase,
      suppressed: s.suppressed,
      penalty: s.penalty,
      confirmedAt: isConfirmed(s.phase) ? s.confirmedAt : null,
      changed,
      accepted,
      reason,
    };
  }
}
