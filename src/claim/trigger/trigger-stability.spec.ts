import {
  TriggerStabilityConfig,
  TriggerTransitionEvent,
  TriggerStabilityEvaluator,
  defaultTriggerConfig,
  maxSuppressionMs,
  triggerOverridesFromEnv,
  validateTriggerConfig,
} from "./trigger-stability";

const MIN = 60_000;
const THRESHOLD = 0.95;

function config(overrides: Partial<TriggerStabilityConfig> = {}): TriggerStabilityConfig {
  return {
    hysteresis: 0.01,
    minDwellMs: 5 * MIN,
    minConfirmations: 2,
    flap: { penaltyPerFlip: 1000, suppressAbove: 3000, reuseBelow: 750, halfLifeMs: 15 * MIN, maxPenalty: 6000 },
    ...overrides,
  };
}

function evaluator(cfg = config()) {
  const ev = new TriggerStabilityEvaluator(() => cfg);
  const at = (minute: number, value: number, direction: "below" | "above" = "below", threshold = THRESHOLD) =>
    ev.evaluate("p1", { value, threshold, direction, observedAt: minute * MIN });
  return { ev, at };
}

describe("TriggerStabilityEvaluator", () => {
  describe("minimum dwell", () => {
    it("does not trigger on a single breach", () => {
      const { at } = evaluator();
      const d = at(0, 0.94);
      expect(d.triggered).toBe(false);
      expect(d.phase).toBe("arming");
    });

    it("triggers once the breach has lasted minDwellMs across minConfirmations observations", () => {
      const { at } = evaluator();
      at(0, 0.94);
      expect(at(4, 0.94).triggered).toBe(false); // 2 observations but only 4 minutes
      const d = at(5, 0.94);
      expect(d.triggered).toBe(true);
      expect(d.changed).toBe(true);
      expect(d.confirmedAt).toBe(5 * MIN);
    });

    it("requires minConfirmations even when the dwell time has passed", () => {
      const { at } = evaluator(config({ minConfirmations: 3, minDwellMs: 0 }));
      at(0, 0.94);
      expect(at(10, 0.94).triggered).toBe(false);
      expect(at(11, 0.94).triggered).toBe(true);
    });

    it("resets the dwell clock when the value recovers mid-arming", () => {
      const { at } = evaluator();
      at(0, 0.94);
      at(3, 0.951); // back above threshold
      at(4, 0.94); // dwell restarts here
      expect(at(8, 0.94).triggered).toBe(false);
      expect(at(9, 0.94).triggered).toBe(true);
    });

    it("triggers immediately with zero dwell and one confirmation (legacy behavior)", () => {
      const { at } = evaluator(config({ minDwellMs: 0, minConfirmations: 1 }));
      expect(at(0, 0.94).triggered).toBe(true);
    });
  });

  describe("hysteresis", () => {
    it("stays triggered while the value sits inside the band above the threshold", () => {
      const { at } = evaluator(config({ minDwellMs: 0, minConfirmations: 1 }));
      at(0, 0.94);
      const d = at(1, 0.955); // above 0.95 but below 0.95 + 0.01
      expect(d.triggered).toBe(true);
      expect(d.phase).toBe("triggered");
    });

    it("clears only after the value recovers past threshold + band for the dwell period", () => {
      const { at } = evaluator(config({ minDwellMs: 2 * MIN, minConfirmations: 2 }));
      at(0, 0.94);
      expect(at(2, 0.94).triggered).toBe(true);
      expect(at(3, 0.97).phase).toBe("disarming");
      expect(at(4, 0.97).triggered).toBe(true); // only 1 min of recovery
      const d = at(5, 0.97);
      expect(d.triggered).toBe(false);
      expect(d.phase).toBe("clear");
      expect(d.changed).toBe(true);
    });

    it("drops back to triggered if recovery is interrupted", () => {
      const { at } = evaluator(config({ minDwellMs: 2 * MIN, minConfirmations: 1 }));
      at(0, 0.94);
      at(2, 0.94);
      at(3, 0.97);
      expect(at(4, 0.955).phase).toBe("triggered");
      at(5, 0.97);
      expect(at(6, 0.97).triggered).toBe(true); // recovery restarted at minute 5
      expect(at(7, 0.97).triggered).toBe(false);
    });

    it("mirrors the band for 'above' triggers such as FlightDelay", () => {
      const { at } = evaluator(config({ hysteresis: 10, minDwellMs: 0, minConfirmations: 1 }));
      expect(at(0, 130, "above", 120).triggered).toBe(true);
      expect(at(1, 115, "above", 120).triggered).toBe(true); // inside 110..120 band
      expect(at(2, 105, "above", 120).triggered).toBe(false);
    });
  });

  describe("flap damping", () => {
    it("suppresses a value oscillating around the threshold so it never toggles the condition", () => {
      const { at } = evaluator(config({ minDwellMs: 0, minConfirmations: 1, hysteresis: 0 }));
      const outcomes: boolean[] = [];
      for (let m = 0; m < 20; m++) outcomes.push(at(m, m % 2 === 0 ? 0.949 : 0.951).triggered);
      // Without damping this would be true/false/true/… With damping, after
      // the penalty crosses suppressAbove the confirmed state freezes.
      const changes = outcomes.filter((v, i) => i > 0 && v !== outcomes[i - 1]).length;
      expect(changes).toBeLessThanOrEqual(4);
      expect(at(20, 0.949).suppressed).toBe(true);
    });

    it("freezes the confirmed state while suppressed and resumes after decay", () => {
      const cfg = config({ minDwellMs: 0, minConfirmations: 1, hysteresis: 0 });
      const { ev, at } = evaluator(cfg);
      for (let m = 0; m < 8; m++) at(m, m % 2 === 0 ? 0.949 : 0.951);
      const frozen = ev.get("p1")!;
      expect(frozen.suppressed).toBe(true);

      // Sustained breach while suppressed: the phase must not confirm on.
      const stillSuppressed = at(10, 0.94);
      expect(stillSuppressed.suppressed).toBe(true);
      expect(stillSuppressed.triggered).toBe(frozen.phase === "triggered" || frozen.phase === "disarming");

      // Long after flapping stops, the penalty decays and the sustained breach confirms.
      const resumed = at(10 + Math.ceil(maxSuppressionMs(cfg.flap) / MIN) + 1, 0.94);
      expect(resumed.suppressed).toBe(false);
      expect(resumed.triggered).toBe(true);
    });

    it("bounds the penalty at maxPenalty", () => {
      const cfg = config({ minDwellMs: 0, minConfirmations: 1, hysteresis: 0 });
      const { ev, at } = evaluator(cfg);
      for (let i = 0; i < 100; i++) at(i / 100, i % 2 === 0 ? 0.949 : 0.951);
      expect(ev.get("p1")!.penalty).toBeLessThanOrEqual(cfg.flap.maxPenalty);
    });

    it("does not penalize movement inside the band that never crosses the threshold", () => {
      const { ev, at } = evaluator(config({ minDwellMs: 0, minConfirmations: 1 }));
      at(0, 0.94);
      for (let m = 1; m < 10; m++) at(m, m % 2 === 0 ? 0.951 : 0.958);
      expect(ev.get("p1")!.flips).toBe(1);
      expect(ev.get("p1")!.suppressed).toBe(false);
    });
  });

  describe("transition events", () => {
    it("emits a transition with evidence when the confirmed outcome changes", () => {
      const { ev, at } = evaluator(config({ minDwellMs: 0, minConfirmations: 1 }));
      const events: TriggerTransitionEvent[] = [];
      ev.onTransition((e) => events.push(e));
      at(0, 0.94);
      at(1, 0.955); // inside band: no event
      at(2, 0.97);
      expect(events.map((e) => [e.kind, e.from, e.to])).toEqual([
        ["transition", "clear", "triggered"],
        ["transition", "triggered", "clear"],
      ]);
      expect(events[0].evidence).toMatchObject({ value: 0.94, threshold: THRESHOLD, direction: "below", hysteresis: 0.01 });
    });

    it("emits a suppressed event instead of silently dropping a damped change", () => {
      const { ev, at } = evaluator(config({ minDwellMs: 0, minConfirmations: 1, hysteresis: 0 }));
      const events: TriggerTransitionEvent[] = [];
      ev.onTransition((e) => events.push(e));
      for (let m = 0; m < 10; m++) at(m, m % 2 === 0 ? 0.949 : 0.951);
      const suppressed = events.filter((e) => e.kind === "suppressed");
      expect(suppressed.length).toBeGreaterThan(0);
      expect(suppressed[0].evidence.reason).toMatch(/suppressed for flapping/);
    });

    it("never lets a throwing listener change the decision", () => {
      const { ev, at } = evaluator(config({ minDwellMs: 0, minConfirmations: 1 }));
      ev.onTransition(() => {
        throw new Error("boom");
      });
      expect(at(0, 0.94).triggered).toBe(true);
    });

    it("does not damp away the first-ever evaluation", () => {
      const { ev, at } = evaluator(config({ minDwellMs: 0, minConfirmations: 1 }));
      expect(at(0, 0.94).triggered).toBe(true);
      expect(ev.get("p1")!.penalty).toBe(0);
    });
  });

  describe("ordering and determinism", () => {
    it("ignores out-of-order and duplicate observations", () => {
      const { at } = evaluator();
      at(5, 0.94);
      expect(at(4, 0.94).accepted).toBe(false);
      expect(at(5, 0.94).accepted).toBe(false);
      expect(at(10, 0.94).triggered).toBe(true);
    });

    it("produces identical decisions when replayed from a snapshot", () => {
      const series: Array<[number, number]> = [[0, 0.94], [2, 0.951], [3, 0.94], [9, 0.94], [10, 0.97], [16, 0.97]];
      const a = evaluator();
      const b = evaluator();
      const first = series.slice(0, 3).map(([m, v]) => a.at(m, v));
      b.ev.restore(a.ev.snapshot());
      const restA = series.slice(3).map(([m, v]) => a.at(m, v).triggered);
      // Rebuild a fresh evaluator from the same prefix and compare.
      const c = evaluator();
      series.slice(0, 3).forEach(([m, v]) => c.at(m, v));
      const restC = series.slice(3).map(([m, v]) => c.at(m, v).triggered);
      expect(first.length).toBe(3);
      expect(restA).toEqual(restC);
      expect(series.slice(3).map(([m, v]) => b.at(m, v).triggered)).toEqual(restA);
    });

    it("keeps keys independent and drops state on forget()", () => {
      const cfg = config({ minDwellMs: 0, minConfirmations: 1 });
      const ev = new TriggerStabilityEvaluator(() => cfg);
      ev.evaluate("a", { value: 0.94, threshold: THRESHOLD, direction: "below", observedAt: 0 });
      expect(ev.get("b")).toBeUndefined();
      ev.forget("a");
      expect(ev.get("a")).toBeUndefined();
    });

    it("rejects non-finite observations", () => {
      const { ev } = evaluator();
      expect(() => ev.evaluate("p1", { value: NaN, threshold: 1, direction: "below", observedAt: 0 })).toThrow();
    });
  });

  describe("config", () => {
    it("builds per-coverage-type defaults with a hysteresis band in that type's units", () => {
      expect(defaultTriggerConfig(0).hysteresis).toBe(0.005);
      expect(defaultTriggerConfig(4).hysteresis).toBe(10);
      expect(defaultTriggerConfig(99).hysteresis).toBe(0);
      expect(defaultTriggerConfig(0, { minDwellMs: 0, flap: { halfLifeMs: 1 } }).flap.halfLifeMs).toBe(1);
    });

    it("reads dwell/confirmation overrides from env and ignores invalid ones", () => {
      expect(triggerOverridesFromEnv({ TRIGGER_MIN_DWELL_SECONDS: "60", TRIGGER_MIN_CONFIRMATIONS: "3" })).toEqual({
        minDwellMs: 60_000,
        minConfirmations: 3,
      });
      expect(triggerOverridesFromEnv({ TRIGGER_MIN_DWELL_SECONDS: "-1", TRIGGER_MIN_CONFIRMATIONS: "x" })).toEqual({});
      expect(triggerOverridesFromEnv({ TRIGGER_MIN_CONFIRMATIONS: "0" })).toEqual({ minConfirmations: 1 });
    });

    it("rejects inconsistent damping settings", () => {
      expect(() => validateTriggerConfig(config({ flap: { ...config().flap, reuseBelow: 5000 } }))).toThrow();
      expect(() => validateTriggerConfig(config({ minConfirmations: 0 }))).toThrow();
      expect(() => validateTriggerConfig(config({ hysteresis: -1 }))).toThrow();
    });
  });
});
