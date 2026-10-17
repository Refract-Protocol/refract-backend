import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OracleCircuitBreaker,
  type CircuitBreakerPersistenceStore,
  type PersistedBreakerRecord,
} from "./circuitBreaker.ts";

class InMemoryBreakerStore implements CircuitBreakerPersistenceStore {
  private readonly records = new Map<string, PersistedBreakerRecord>();

  public loadAll(): PersistedBreakerRecord[] {
    return Array.from(this.records.values());
  }

  public save(record: PersistedBreakerRecord): void {
    this.records.set(record.coverageType, { ...record });
  }
}

describe("OracleCircuitBreaker & Anomaly Detection (Issue #178)", () => {
  const defaultPolicy = {
    coverageType: "stablecoin_depeg",
    maxStepDeltaRatio: 0.15, // max 15% single-tick jump
    maxDispersionRatio: 0.08, // max 8% inter-source spread
    maxConsecutiveQuorumFailures: 3,
    minPlausibleValue: 0.1,
    maxPlausibleValue: 2.0,
    minCooldownBeforeHalfOpenMs: 60_000,
    requiredHalfOpenSuccessesToClose: 2,
  };

  it("trips to open on step-delta or dispersion anomalies, persists across restarts, and blocks settlement", () => {
    const store = new InMemoryBreakerStore();
    const breaker = new OracleCircuitBreaker({
      policies: [defaultPolicy],
      store,
    });

    const t0 = 1_700_000_000_000;

    // 1. Nominal reading -> remains closed
    const okTick = breaker.evaluateAndGate(
      {
        coverageType: "stablecoin_depeg",
        currentValue: 0.995,
        previousValue: 1.0,
        dispersionRatio: 0.01,
      },
      t0
    );
    assert.equal(okTick.allowPublishAndSettlement, true);
    assert.equal(okTick.state, "closed");
    assert.equal(breaker.canSettleClaim("stablecoin_depeg"), true);

    // 2. Sudden 40% step jump -> trips to open
    const spikeTick = breaker.evaluateAndGate(
      {
        coverageType: "stablecoin_depeg",
        currentValue: 0.59,
        previousValue: 0.995,
        dispersionRatio: 0.12,
      },
      t0 + 5_000
    );
    assert.equal(spikeTick.allowPublishAndSettlement, false);
    assert.equal(spikeTick.state, "open");
    assert.ok(spikeTick.violations.includes("STEP_DELTA_SPIKE"));
    assert.ok(spikeTick.violations.includes("SOURCE_DISPERSION_SPIKE"));
    assert.equal(breaker.canSettleClaim("stablecoin_depeg"), false);

    // 3. Simulated process restart reloads open state from store -> still blocks settlement
    const restartedBreaker = new OracleCircuitBreaker({
      policies: [defaultPolicy],
      store,
    });
    assert.equal(restartedBreaker.getState("stablecoin_depeg").state, "open");
    assert.equal(restartedBreaker.canSettleClaim("stablecoin_depeg"), false);
  });

  it("enforces cooldown before half_open and requires consecutive clean ticks before closing", () => {
    const breaker = new OracleCircuitBreaker({
      policies: [defaultPolicy],
    });
    const t0 = 1_700_000_000_000;

    // Trip via consecutive quorum failures
    breaker.evaluateAndGate(
      {
        coverageType: "stablecoin_depeg",
        consecutiveQuorumFailures: 3,
      },
      t0
    );
    assert.equal(breaker.getState("stablecoin_depeg").state, "open");

    // Attempt to transition to half_open before 60s cooldown -> throws
    assert.throws(() => {
      breaker.operatorTransitionToHalfOpen("stablecoin_depeg", t0 + 20_000);
    }, /Cooldown period not met/);

    // After 65s cooldown -> enters half_open
    const halfOpenRec = breaker.operatorTransitionToHalfOpen(
      "stablecoin_depeg",
      t0 + 65_000
    );
    assert.equal(halfOpenRec.state, "half_open");

    // First clean tick in half_open -> stays half_open (requires 2 clean ticks)
    const probe1 = breaker.evaluateAndGate(
      {
        coverageType: "stablecoin_depeg",
        currentValue: 1.0,
        previousValue: 0.998,
        dispersionRatio: 0.01,
      },
      t0 + 70_000
    );
    assert.equal(probe1.state, "half_open");
    assert.equal(probe1.allowPublishAndSettlement, false);

    // Second clean tick in half_open -> closes breaker and resumes settlement
    const probe2 = breaker.evaluateAndGate(
      {
        coverageType: "stablecoin_depeg",
        currentValue: 1.0,
        previousValue: 1.0,
        dispersionRatio: 0.01,
      },
      t0 + 75_000
    );
    assert.equal(probe2.state, "closed");
    assert.equal(probe2.allowPublishAndSettlement, true);
    assert.equal(breaker.canSettleClaim("stablecoin_depeg"), true);
  });
});
