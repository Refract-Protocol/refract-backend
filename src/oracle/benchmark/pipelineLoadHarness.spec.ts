import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareAgainstBaseline,
  runPipelineBenchmarkProfile,
  type PipelinePerformanceBudget,
} from "./pipelineLoadHarness.ts";

const DEFAULT_BUDGET: PipelinePerformanceBudget = {
  maxP50LatencyMs: 5,
  maxP99LatencyMs: 15,
  minDecisionsPerSec: 100,
  maxDbWritesPerDecision: 3,
  maxHeapGrowthBytes: 1_048_576, // 1 MB max steady-state growth
  maxLatencyRegressionRatio: 1.5,
};

test("runPipelineBenchmarkProfile passes smoke performance budgets across multiple feeds, sources, and operators", () => {
  const baselineReport = runPipelineBenchmarkProfile({
    name: "smoke",
    feedCount: 10,
    sourcesPerFeed: 5,
    operatorsPerSource: 3,
    rounds: 20,
  });

  assert.equal(baselineReport.totalDecisions, 200);
  assert.equal(baselineReport.totalReadingsIngested, 3000);
  assert.equal(baselineReport.dbWritesPerDecision, 3);

  const comparison = compareAgainstBaseline(baselineReport, DEFAULT_BUDGET);
  assert.equal(comparison.passed, true);
  assert.equal(comparison.violations.length, 0);
});

test("compareAgainstBaseline fails when an artificial slowdown or soak memory leak breaches budgets", () => {
  const baselineReport = runPipelineBenchmarkProfile({
    name: "smoke-baseline",
    feedCount: 5,
    sourcesPerFeed: 3,
    operatorsPerSource: 2,
    rounds: 10,
    injectedDecisionDelayMs: 1,
  });

  const regressedReport = runPipelineBenchmarkProfile({
    name: "regressed-soak",
    feedCount: 5,
    sourcesPerFeed: 3,
    operatorsPerSource: 2,
    rounds: 10,
    injectedDecisionDelayMs: 25,
    simulatedHeapLeakBytesPerRound: 500_000,
  });

  const comparison = compareAgainstBaseline(
    regressedReport,
    DEFAULT_BUDGET,
    baselineReport
  );
  assert.equal(comparison.passed, false);
  assert.ok(
    comparison.violations.some((v) => v.includes("p99 latency")),
    "Expected p99 latency violation"
  );
  assert.ok(
    comparison.violations.some((v) => v.includes("soak heap growth")),
    "Expected soak heap growth violation"
  );
  assert.ok(
    comparison.violations.some((v) => v.includes("regression ratio")),
    "Expected baseline regression ratio violation"
  );
});
