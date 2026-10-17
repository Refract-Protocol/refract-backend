import { createHash } from "node:crypto";

export type FaultInjectionMode =
  | "none"
  | "source_timeout"
  | "source_5xx"
  | "malformed_payload"
  | "divergent_outlier"
  | "all_sources_down"
  | "delayed_out_of_order"
  | "clock_skew";

export interface ReplaySourceSample {
  sourceId: string;
  value: number | "MALFORMED";
  observedAtMs: number;
  fault?: FaultInjectionMode;
}

export interface ReplayTickFixture {
  tickAtMs: number;
  samples: ReplaySourceSample[];
}

export interface ReplayScenarioDefinition {
  scenarioName: string;
  seed: number;
  freshnessWindowMs: number;
  quorumMinimum: number;
  maxDivergenceRatio: number;
  ticks: ReplayTickFixture[];
  expectedFixtureSha256?: string;
}

export interface ReplayTickDecision {
  tickAtMs: number;
  outcome: "PUBLISH_CORROBORATED" | "HOLD_QUORUM_FAILED" | "HOLD_DIVERGENCE";
  agreedValue: number | null;
  validSources: string[];
  DeterministicTieBreakRoll: number;
}

export class SeededDeterministicPrng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  public nextFloat(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

export class InjectableDeterministicClock {
  private currentMs: number;

  constructor(initialMs: number) {
    this.currentMs = initialMs;
  }

  public now(): number {
    return this.currentMs;
  }

  public setTo(targetMs: number): void {
    this.currentMs = targetMs;
  }

  public advanceBy(deltaMs: number): void {
    this.currentMs += deltaMs;
  }
}

export class DeterministicOracleReplayHarness {
  private readonly scenarios = new Map<string, ReplayScenarioDefinition>();

  public registerScenario(scenario: ReplayScenarioDefinition): void {
    this.scenarios.set(scenario.scenarioName, scenario);
  }

  public static computeFixtureSha256(ticks: ReplayTickFixture[]): string {
    return createHash("sha256")
      .update(JSON.stringify(ticks))
      .digest("hex");
  }

  public runScenario(scenarioName: string): {
    scenarioName: string;
    decisions: ReplayTickDecision[];
    trajectoryDigest: string;
  } {
    const scenario = this.scenarios.get(scenarioName);
    if (!scenario) {
      throw new Error(
        `UNKNOWN_SCENARIO_NAME: Scenario "${scenarioName}" is not registered`
      );
    }

    if (scenario.expectedFixtureSha256) {
      const actualDigest = DeterministicOracleReplayHarness.computeFixtureSha256(
        scenario.ticks
      );
      if (actualDigest !== scenario.expectedFixtureSha256) {
        throw new Error(
          `CORRUPTED_FIXTURE_DIGEST: Expected ${scenario.expectedFixtureSha256}, got ${actualDigest}`
        );
      }
    }

    const prng = new SeededDeterministicPrng(scenario.seed);
    const clock = new InjectableDeterministicClock(
      scenario.ticks[0]?.tickAtMs ?? 0
    );
    const decisions: ReplayTickDecision[] = [];

    for (const tick of scenario.ticks) {
      clock.setTo(tick.tickAtMs);
      const nowMs = clock.now();
      const validReadings: Array<{ sourceId: string; value: number }> = [];

      for (const sample of tick.samples) {
        const fault = sample.fault ?? "none";
        if (
          fault === "source_timeout" ||
          fault === "source_5xx" ||
          fault === "all_sources_down" ||
          fault === "malformed_payload" ||
          sample.value === "MALFORMED"
        ) {
          continue;
        }

        let effectiveObservedMs = sample.observedAtMs;
        if (fault === "delayed_out_of_order") {
          effectiveObservedMs -= scenario.freshnessWindowMs * 2;
        } else if (fault === "clock_skew") {
          effectiveObservedMs += scenario.freshnessWindowMs * 2;
        }

        // Reject stale or future-skewed readings (> 5s future tolerance)
        if (
          nowMs - effectiveObservedMs > scenario.freshnessWindowMs ||
          effectiveObservedMs - nowMs > 5_000
        ) {
          continue;
        }

        const effectiveVal =
          fault === "divergent_outlier"
            ? (sample.value as number) * 1.5
            : (sample.value as number);

        if (Number.isFinite(effectiveVal) && effectiveVal > 0) {
          validReadings.push({
            sourceId: sample.sourceId,
            value: effectiveVal,
          });
        }
      }

      const tieBreakRoll = Number(prng.nextFloat().toFixed(6));

      if (validReadings.length < scenario.quorumMinimum) {
        decisions.push({
          tickAtMs: nowMs,
          outcome: "HOLD_QUORUM_FAILED",
          agreedValue: null,
          validSources: validReadings.map((r) => r.sourceId),
          DeterministicTieBreakRoll: tieBreakRoll,
        });
        continue;
      }

      const sortedVals = validReadings
        .map((r) => r.value)
        .sort((a, b) => a - b);
      const mid = Math.floor(sortedVals.length / 2);
      const median =
        sortedVals.length % 2 === 0
          ? (sortedVals[mid - 1]! + sortedVals[mid]!) / 2
          : sortedVals[mid]!;

      const denom = Math.max(Math.abs(median), 1e-9);
      const agreeing = validReadings.filter(
        (r) => Math.abs(r.value - median) / denom <= scenario.maxDivergenceRatio
      );

      if (agreeing.length < scenario.quorumMinimum) {
        decisions.push({
          tickAtMs: nowMs,
          outcome: "HOLD_DIVERGENCE",
          agreedValue: null,
          validSources: validReadings.map((r) => r.sourceId),
          DeterministicTieBreakRoll: tieBreakRoll,
        });
        continue;
      }

      decisions.push({
        tickAtMs: nowMs,
        outcome: "PUBLISH_CORROBORATED",
        agreedValue: Number(median.toFixed(6)),
        validSources: agreeing.map((r) => r.sourceId),
        DeterministicTieBreakRoll: tieBreakRoll,
      });
    }

    const trajectoryDigest = createHash("sha256")
      .update(JSON.stringify(decisions))
      .digest("hex");

    return {
      scenarioName,
      decisions,
      trajectoryDigest,
    };
  }
}
