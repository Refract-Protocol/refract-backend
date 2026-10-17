import {
  evaluateFeedAnomaly,
  type AnomalyCheckInput,
  type AnomalyRuleConfig,
  type AnomalyViolationCode,
} from "./anomaly.ts";

export type CircuitBreakerState = "closed" | "open" | "half_open";

export interface PersistedBreakerRecord {
  coverageType: string;
  state: CircuitBreakerState;
  openedAtMs?: number;
  lastTransitionAtMs: number;
  tripReasons: AnomalyViolationCode[];
  halfOpenSuccessCount: number;
}

export interface CircuitBreakerPolicyConfig extends AnomalyRuleConfig {
  minCooldownBeforeHalfOpenMs: number;
  requiredHalfOpenSuccessesToClose: number;
}

export interface CircuitBreakerPersistenceStore {
  loadAll(): PersistedBreakerRecord[];
  save(record: PersistedBreakerRecord): void;
}

export class OracleCircuitBreaker {
  private readonly policies = new Map<string, CircuitBreakerPolicyConfig>();
  private readonly states = new Map<string, PersistedBreakerRecord>();
  private readonly store?: CircuitBreakerPersistenceStore;

  constructor(options: {
    policies: CircuitBreakerPolicyConfig[];
    store?: CircuitBreakerPersistenceStore;
  }) {
    this.store = options.store;
    for (const p of options.policies) {
      this.policies.set(p.coverageType, p);
    }

    if (this.store) {
      for (const saved of this.store.loadAll()) {
        this.states.set(saved.coverageType, { ...saved });
      }
    }
  }

  public evaluateAndGate(
    input: AnomalyCheckInput,
    nowMs: number = Date.now()
  ): {
    allowPublishAndSettlement: boolean;
    state: CircuitBreakerState;
    violations: AnomalyViolationCode[];
  } {
    const policy = this.policies.get(input.coverageType);
    const current = this.getOrInitState(input.coverageType, nowMs);

    if (!policy) {
      // Fail-closed if no policy is registered for coverageType
      this.transitionToOpen(
        current,
        ["RULE_EVALUATION_ERROR"],
        nowMs
      );
      return {
        allowPublishAndSettlement: false,
        state: "open",
        violations: ["RULE_EVALUATION_ERROR"],
      };
    }

    if (current.state === "open") {
      return {
        allowPublishAndSettlement: false,
        state: "open",
        violations: current.tripReasons,
      };
    }

    const evalResult = evaluateFeedAnomaly(input, policy);
    if (evalResult.anomalous) {
      this.transitionToOpen(current, evalResult.violations, nowMs);
      return {
        allowPublishAndSettlement: false,
        state: "open",
        violations: evalResult.violations,
      };
    }

    if (current.state === "half_open") {
      current.halfOpenSuccessCount += 1;
      if (
        current.halfOpenSuccessCount >= policy.requiredHalfOpenSuccessesToClose
      ) {
        current.state = "closed";
        current.tripReasons = [];
        current.halfOpenSuccessCount = 0;
        current.lastTransitionAtMs = nowMs;
      }
      this.persist(current);
      // While still in half_open (before reaching required successes), block automatic settlement
      const allow = current.state === "closed";
      return {
        allowPublishAndSettlement: allow,
        state: current.state,
        violations: [],
      };
    }

    return {
      allowPublishAndSettlement: true,
      state: "closed",
      violations: [],
    };
  }

  public canSettleClaim(coverageType: string): boolean {
    const rec = this.states.get(coverageType);
    if (!rec) return true;
    return rec.state === "closed";
  }

  public operatorTransitionToHalfOpen(
    coverageType: string,
    nowMs: number = Date.now()
  ): PersistedBreakerRecord {
    const policy = this.policies.get(coverageType);
    const rec = this.getOrInitState(coverageType, nowMs);

    if (rec.state !== "open") {
      throw new Error(
        `Cannot transition to half_open from state ${rec.state}`
      );
    }

    const minCooldown = policy?.minCooldownBeforeHalfOpenMs ?? 60_000;
    const elapsed = nowMs - (rec.openedAtMs ?? rec.lastTransitionAtMs);
    if (elapsed < minCooldown) {
      throw new Error(
        `Cooldown period not met before half_open (${elapsed}ms < ${minCooldown}ms)`
      );
    }

    rec.state = "half_open";
    rec.halfOpenSuccessCount = 0;
    rec.lastTransitionAtMs = nowMs;
    this.persist(rec);
    return { ...rec };
  }

  public getState(coverageType: string): PersistedBreakerRecord {
    return { ...this.getOrInitState(coverageType, Date.now()) };
  }

  private getOrInitState(
    coverageType: string,
    nowMs: number
  ): PersistedBreakerRecord {
    let rec = this.states.get(coverageType);
    if (!rec) {
      rec = {
        coverageType,
        state: "closed",
        lastTransitionAtMs: nowMs,
        tripReasons: [],
        halfOpenSuccessCount: 0,
      };
      this.states.set(coverageType, rec);
    }
    return rec;
  }

  private transitionToOpen(
    rec: PersistedBreakerRecord,
    reasons: AnomalyViolationCode[],
    nowMs: number
  ): void {
    rec.state = "open";
    rec.openedAtMs = nowMs;
    rec.lastTransitionAtMs = nowMs;
    rec.tripReasons = reasons;
    rec.halfOpenSuccessCount = 0;
    this.persist(rec);
  }

  private persist(rec: PersistedBreakerRecord): void {
    this.states.set(rec.coverageType, rec);
    this.store?.save({ ...rec });
  }
}
