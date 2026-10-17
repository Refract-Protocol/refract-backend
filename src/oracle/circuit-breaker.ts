export type CircuitBreakerState = "closed" | "open" | "half_open_canary";

export interface CircuitBreakerConfig {
  feedId: string;
  baseOpenDwellMs?: number;
  maxOpenDwellMs?: number;
  canaryDwellMs?: number;
  requiredHealthyRounds?: number;
  canaryToleranceBps?: number;
}

export interface BreakerTransitionRecord {
  feedId: string;
  fromState: CircuitBreakerState;
  toState: CircuitBreakerState;
  actor: "system";
  reason: string;
  tripCount: number;
  atMs: number;
}

export interface FeedBreakerSnapshot {
  feedId: string;
  state: CircuitBreakerState;
  tripCount: number;
  openedAtMs: number | null;
  currentOpenDwellMs: number;
  canaryEnteredAtMs: number | null;
  consecutiveHealthyCanaryRounds: number;
  lastTransitionAtMs: number;
  transitions: BreakerTransitionRecord[];
}

export interface CircuitBreakerStore {
  get(feedId: string): Promise<FeedBreakerSnapshot | null>;
  save(snapshot: FeedBreakerSnapshot): Promise<void>;
}

export class InMemoryCircuitBreakerStore implements CircuitBreakerStore {
  private readonly map = new Map<string, FeedBreakerSnapshot>();

  async get(feedId: string): Promise<FeedBreakerSnapshot | null> {
    const snap = this.map.get(feedId);
    return snap ? structuredClone(snap) : null;
  }

  async save(snapshot: FeedBreakerSnapshot): Promise<void> {
    this.map.set(snapshot.feedId, structuredClone(snapshot));
  }
}

export interface CanaryRoundInput {
  feedId: string;
  canaryValue: number;
  referenceSourceValues: readonly number[];
  hasDivergenceOrStalenessAlert?: boolean;
  nowMs?: number;
}

export interface CanaryEvaluationResult {
  feedId: string;
  stateBefore: CircuitBreakerState;
  stateAfter: CircuitBreakerState;
  publishForPayout: boolean;
  withinTolerance: boolean;
  maxDeviationBps: number;
  consecutiveHealthyRounds: number;
  transitioned: boolean;
  reason: string;
}

export function computeMaxRelativeDeviationBps(
  canaryValue: number,
  referenceValues: readonly number[]
): number {
  if (referenceValues.length === 0) return Number.POSITIVE_INFINITY;
  let maxBps = 0;
  for (const ref of referenceValues) {
    const denom = Math.max(Math.abs(ref), 1e-9);
    const bps = Math.round((Math.abs(canaryValue - ref) / denom) * 10_000);
    if (bps > maxBps) maxBps = bps;
  }
  return maxBps;
}

export class OracleCircuitBreakerService {
  private readonly store: CircuitBreakerStore;
  private readonly configs = new Map<string, Required<CircuitBreakerConfig>>();
  private readonly evidenceLedger: BreakerTransitionRecord[] = [];

  constructor(options: {
    store?: CircuitBreakerStore;
    configs?: CircuitBreakerConfig[];
  } = {}) {
    this.store = options.store ?? new InMemoryCircuitBreakerStore();
    for (const cfg of options.configs ?? []) {
      this.registerFeedConfig(cfg);
    }
  }

  registerFeedConfig(config: CircuitBreakerConfig): void {
    const requiredHealthyRounds = Math.max(1, config.requiredHealthyRounds ?? 3);
    const baseOpenDwellMs = Math.max(1_000, config.baseOpenDwellMs ?? 60_000);
    const maxOpenDwellMs = Math.max(baseOpenDwellMs, config.maxOpenDwellMs ?? 3_600_000);
    const canaryDwellMs = Math.max(0, config.canaryDwellMs ?? 30_000);
    const canaryToleranceBps = Math.max(1, config.canaryToleranceBps ?? 100);

    this.configs.set(config.feedId, {
      feedId: config.feedId,
      baseOpenDwellMs,
      maxOpenDwellMs,
      canaryDwellMs,
      requiredHealthyRounds,
      canaryToleranceBps,
    });
  }

  private getConfig(feedId: string): Required<CircuitBreakerConfig> {
    const existing = this.configs.get(feedId);
    if (existing) return existing;
    this.registerFeedConfig({ feedId });
    return this.configs.get(feedId)!;
  }

  getEvidenceLedger(): BreakerTransitionRecord[] {
    return [...this.evidenceLedger];
  }

  async getSnapshot(feedId: string): Promise<FeedBreakerSnapshot> {
    const existing = await this.store.get(feedId);
    if (existing) return existing;
    const cfg = this.getConfig(feedId);
    const initial: FeedBreakerSnapshot = {
      feedId,
      state: "closed",
      tripCount: 0,
      openedAtMs: null,
      currentOpenDwellMs: cfg.baseOpenDwellMs,
      canaryEnteredAtMs: null,
      consecutiveHealthyCanaryRounds: 0,
      lastTransitionAtMs: 0,
      transitions: [],
    };
    await this.store.save(initial);
    return initial;
  }

  private recordTransition(
    snap: FeedBreakerSnapshot,
    toState: CircuitBreakerState,
    reason: string,
    nowMs: number
  ): BreakerTransitionRecord {
    // Invariant: an open breaker can NEVER jump directly to closed without passing through half_open_canary
    if (snap.state === "open" && toState === "closed") {
      throw new Error(
        `Illegal circuit breaker transition open -> closed for feed "${snap.feedId}"; must pass through half_open_canary`
      );
    }

    const record: BreakerTransitionRecord = {
      feedId: snap.feedId,
      fromState: snap.state,
      toState,
      actor: "system",
      reason,
      tripCount: snap.tripCount,
      atMs: nowMs,
    };
    snap.state = toState;
    snap.lastTransitionAtMs = nowMs;
    snap.transitions.push(record);
    this.evidenceLedger.push(record);
    return record;
  }

  /**
   * Trips the circuit breaker into `open` state on anomaly/divergence.
   * Escalates `currentOpenDwellMs` exponentially (`baseOpenDwellMs * 2^(tripCount - 1)`)
   * up to `maxOpenDwellMs` when a feed repeatedly trips (flapping protection).
   */
  async trip(feedId: string, reason: string, nowMs = Date.now()): Promise<FeedBreakerSnapshot> {
    const cfg = this.getConfig(feedId);
    const snap = await this.getSnapshot(feedId);

    snap.tripCount += 1;
    const backoffFactor = 2 ** Math.min(10, Math.max(0, snap.tripCount - 1));
    snap.currentOpenDwellMs = Math.min(cfg.maxOpenDwellMs, cfg.baseOpenDwellMs * backoffFactor);
    snap.openedAtMs = nowMs;
    snap.canaryEnteredAtMs = null;
    snap.consecutiveHealthyCanaryRounds = 0;

    if (snap.state !== "open") {
      this.recordTransition(snap, "open", reason, nowMs);
    }
    await this.store.save(snap);
    return snap;
  }

  /**
   * Evaluates whether an `open` breaker has satisfied its open dwell timer and
   * can advance to `half_open_canary`.
   */
  async advanceTimers(feedId: string, nowMs = Date.now()): Promise<FeedBreakerSnapshot> {
    const snap = await this.getSnapshot(feedId);
    if (snap.state === "open" && snap.openedAtMs !== null) {
      if (nowMs - snap.openedAtMs >= snap.currentOpenDwellMs) {
        snap.canaryEnteredAtMs = nowMs;
        snap.consecutiveHealthyCanaryRounds = 0;
        this.recordTransition(
          snap,
          "half_open_canary",
          `Open dwell timer (${snap.currentOpenDwellMs}ms) elapsed; entering canary verification`,
          nowMs
        );
        await this.store.save(snap);
      }
    }
    return snap;
  }

  /**
   * Processes a consensus round through the breaker gate:
   * - `closed`: `publishForPayout = true`.
   * - `open` (before dwell): `publishForPayout = false`.
   * - `half_open_canary`: computes decision with `publishForPayout = false`,
   *   checks agreement against `referenceSourceValues` within `canaryToleranceBps`
   *   and absence of alerts. Any mismatch immediately re-opens the breaker with
   *   escalated dwell time; `requiredHealthyRounds` + `canaryDwellMs` promotes
   *   the breaker back to `closed` and resets `tripCount`.
   */
  async evaluateRound(input: CanaryRoundInput): Promise<CanaryEvaluationResult> {
    const nowMs = input.nowMs ?? Date.now();
    const cfg = this.getConfig(input.feedId);
    await this.advanceTimers(input.feedId, nowMs);
    const snap = await this.getSnapshot(input.feedId);
    const stateBefore = snap.state;

    if (snap.state === "closed") {
      if (input.hasDivergenceOrStalenessAlert) {
        await this.trip(input.feedId, "Alert raised while closed", nowMs);
        return {
          feedId: input.feedId,
          stateBefore,
          stateAfter: "open",
          publishForPayout: false,
          withinTolerance: false,
          maxDeviationBps: 0,
          consecutiveHealthyRounds: 0,
          transitioned: true,
          reason: "tripped_on_alert",
        };
      }
      return {
        feedId: input.feedId,
        stateBefore,
        stateAfter: "closed",
        publishForPayout: true,
        withinTolerance: true,
        maxDeviationBps: 0,
        consecutiveHealthyRounds: snap.consecutiveHealthyCanaryRounds,
        transitioned: false,
        reason: "healthy_closed",
      };
    }

    if (snap.state === "open") {
      return {
        feedId: input.feedId,
        stateBefore,
        stateAfter: "open",
        publishForPayout: false,
        withinTolerance: false,
        maxDeviationBps: 0,
        consecutiveHealthyRounds: 0,
        transitioned: false,
        reason: "breaker_open_dwell_active",
      };
    }

    // State is half_open_canary: decisions are NEVER published for payouts during canary
    const maxDeviationBps = computeMaxRelativeDeviationBps(
      input.canaryValue,
      input.referenceSourceValues
    );
    const withinTolerance =
      !input.hasDivergenceOrStalenessAlert &&
      Number.isFinite(maxDeviationBps) &&
      maxDeviationBps <= cfg.canaryToleranceBps;

    if (!withinTolerance) {
      const reTripped = await this.trip(
        input.feedId,
        `Canary validation failed (deviation=${maxDeviationBps}bps, alert=${Boolean(
          input.hasDivergenceOrStalenessAlert
        )})`,
        nowMs
      );
      return {
        feedId: input.feedId,
        stateBefore,
        stateAfter: reTripped.state,
        publishForPayout: false,
        withinTolerance: false,
        maxDeviationBps,
        consecutiveHealthyRounds: 0,
        transitioned: true,
        reason: "canary_failed_reopened",
      };
    }

    snap.consecutiveHealthyCanaryRounds += 1;
    const canaryElapsedMs =
      snap.canaryEnteredAtMs !== null ? nowMs - snap.canaryEnteredAtMs : 0;

    if (
      snap.consecutiveHealthyCanaryRounds >= cfg.requiredHealthyRounds &&
      canaryElapsedMs >= cfg.canaryDwellMs
    ) {
      snap.tripCount = 0;
      snap.currentOpenDwellMs = cfg.baseOpenDwellMs;
      snap.openedAtMs = null;
      snap.canaryEnteredAtMs = null;
      this.recordTransition(
        snap,
        "closed",
        `Canary passed ${snap.consecutiveHealthyCanaryRounds} consecutive rounds over ${canaryElapsedMs}ms`,
        nowMs
      );
      await this.store.save(snap);
      return {
        feedId: input.feedId,
        stateBefore,
        stateAfter: "closed",
        publishForPayout: false, // Current round was the final canary verification round; subsequent rounds publish
        withinTolerance: true,
        maxDeviationBps,
        consecutiveHealthyRounds: snap.consecutiveHealthyCanaryRounds,
        transitioned: true,
        reason: "canary_promoted_to_closed",
      };
    }

    await this.store.save(snap);
    return {
      feedId: input.feedId,
      stateBefore,
      stateAfter: "half_open_canary",
      publishForPayout: false,
      withinTolerance: true,
      maxDeviationBps,
      consecutiveHealthyRounds: snap.consecutiveHealthyCanaryRounds,
      transitioned: false,
      reason: "canary_round_healthy_accumulating",
    };
  }
}
