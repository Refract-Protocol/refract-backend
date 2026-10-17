import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DeterministicOracleReplayHarness,
  type ReplayTickFixture,
} from "./deterministicReplayHarness.ts";

describe("Deterministic Replay and Fault-Injection Harness for Oracle Feed Processing (#189)", () => {
  it("produces byte-identical consensus decisions across repeated runs for identical fixture + seed + clock and exercises all fault-injection switches", () => {
    const ticks: ReplayTickFixture[] = [
      // Tick 1: healthy 2-of-3 corroboration (1 source times out)
      {
        tickAtMs: 1_700_000_010_000,
        samples: [
          {
            sourceId: "coingecko",
            value: 0.9999,
            observedAtMs: 1_700_000_009_000,
            fault: "none",
          },
          {
            sourceId: "pyth",
            value: 1.0001,
            observedAtMs: 1_700_000_009_500,
            fault: "none",
          },
          {
            sourceId: "horizon",
            value: 1.0,
            observedAtMs: 1_700_000_009_500,
            fault: "source_timeout",
          },
        ],
      },
      // Tick 2: divergent outlier + malformed payload -> quorum fails
      {
        tickAtMs: 1_700_000_020_000,
        samples: [
          {
            sourceId: "coingecko",
            value: 1.0,
            observedAtMs: 1_700_000_019_000,
            fault: "none",
          },
          {
            sourceId: "pyth",
            value: 1.0,
            observedAtMs: 1_700_000_019_000,
            fault: "divergent_outlier",
          },
          {
            sourceId: "horizon",
            value: "MALFORMED",
            observedAtMs: 1_700_000_019_000,
            fault: "malformed_payload",
          },
        ],
      },
      // Tick 3: delayed out-of-order + clock skew -> HOLD_QUORUM_FAILED
      {
        tickAtMs: 1_700_000_030_000,
        samples: [
          {
            sourceId: "coingecko",
            value: 1.0,
            observedAtMs: 1_700_000_029_000,
            fault: "delayed_out_of_order",
          },
          {
            sourceId: "pyth",
            value: 1.0,
            observedAtMs: 1_700_000_029_000,
            fault: "clock_skew",
          },
        ],
      },
    ];

    const expectedSha =
      DeterministicOracleReplayHarness.computeFixtureSha256(ticks);

    const harness1 = new DeterministicOracleReplayHarness();
    harness1.registerScenario({
      scenarioName: "usdc-fault-matrix",
      seed: 42,
      freshnessWindowMs: 30_000,
      quorumMinimum: 2,
      maxDivergenceRatio: 0.02,
      ticks,
      expectedFixtureSha256: expectedSha,
    });

    const harness2 = new DeterministicOracleReplayHarness();
    harness2.registerScenario({
      scenarioName: "usdc-fault-matrix",
      seed: 42,
      freshnessWindowMs: 30_000,
      quorumMinimum: 2,
      maxDivergenceRatio: 0.02,
      ticks,
      expectedFixtureSha256: expectedSha,
    });

    const run1 = harness1.runScenario("usdc-fault-matrix");
    const run2 = harness2.runScenario("usdc-fault-matrix");

    assert.equal(run1.trajectoryDigest, run2.trajectoryDigest);
    assert.deepEqual(run1.decisions, run2.decisions);
    assert.equal(run1.decisions[0]?.outcome, "PUBLISH_CORROBORATED");
    assert.equal(run1.decisions[0]?.agreedValue, 1.0);
    assert.equal(run1.decisions[1]?.outcome, "HOLD_DIVERGENCE");
    assert.equal(run1.decisions[2]?.outcome, "HOLD_QUORUM_FAILED");
  });

  it("fails loudly on unknown scenario names or corrupted fixture checksums", () => {
    const harness = new DeterministicOracleReplayHarness();
    assert.throws(
      () => harness.runScenario("non-existent-scenario"),
      /UNKNOWN_SCENARIO_NAME/
    );

    harness.registerScenario({
      scenarioName: "corrupted-fixture",
      seed: 1,
      freshnessWindowMs: 30_000,
      quorumMinimum: 2,
      maxDivergenceRatio: 0.02,
      ticks: [],
      expectedFixtureSha256: "deadbeef_invalid_digest",
    });

    assert.throws(
      () => harness.runScenario("corrupted-fixture"),
      /CORRUPTED_FIXTURE_DIGEST/
    );
  });
});
