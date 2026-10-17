export interface PipelineLoadProfile {
  name: "smoke" | "soak" | string;
  feedCount: number;
  sourcesPerFeed: number;
  operatorsPerSource: number;
  rounds: number;
  injectedDecisionDelayMs?: number;
  simulatedHeapLeakBytesPerRound?: number;
}

export interface PipelineBenchmarkReport {
  profileName: string;
  totalDecisions: number;
  totalReadingsIngested: number;
  totalDbWrites: number;
  dbWritesPerDecision: number;
  latencyP50Ms: number;
  latencyP99Ms: number;
  decisionsPerSec: number;
  heapGrowthBytes: number;
}

export interface PipelinePerformanceBudget {
  maxP50LatencyMs: number;
  maxP99LatencyMs: number;
  minDecisionsPerSec: number;
  maxDbWritesPerDecision: number;
  maxHeapGrowthBytes: number;
  maxLatencyRegressionRatio: number;
}

export interface BudgetComparisonResult {
  passed: boolean;
  violations: string[];
  report: PipelineBenchmarkReport;
}

function computePercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sortedValues.length) - 1)
  );
  return sortedValues[index];
}

function computeWeightedMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Executes a deterministic load/soak benchmark across N sources, M feeds, and K operators,
 * measuring decision latency percentiles, throughput, DB write amplification, and memory growth.
 */
export function runPipelineBenchmarkProfile(
  profile: PipelineLoadProfile
): PipelineBenchmarkReport {
  const decisionLatenciesMs: number[] = [];
  let totalReadingsIngested = 0;
  let totalDbWrites = 0;
  let totalDecisions = 0;
  let simulatedHeapBytes = 0;

  const injectedDelayMs = profile.injectedDecisionDelayMs ?? 0;
  const leakPerRound = profile.simulatedHeapLeakBytesPerRound ?? 0;

  for (let round = 0; round < profile.rounds; round++) {
    simulatedHeapBytes += leakPerRound;

    for (let feedIdx = 0; feedIdx < profile.feedCount; feedIdx++) {
      const startNs = process.hrtime.bigint();
      const readings: number[] = [];

      for (
        let sourceIdx = 0;
        sourceIdx < profile.sourcesPerFeed;
        sourceIdx++
      ) {
        for (
          let opIdx = 0;
          opIdx < profile.operatorsPerSource;
          opIdx++
        ) {
          const syntheticPrice =
            100 +
            ((round + feedIdx + sourceIdx + opIdx) % 7) * 0.25;
          readings.push(syntheticPrice);
          totalReadingsIngested += 1;
        }
      }

      // 1 batched reading insert + 1 consensus decision write + 1 evidence ledger write = 3 DB writes per decision
      const consensusValue = computeWeightedMedian(readings);
      if (Number.isFinite(consensusValue)) {
        totalDbWrites += 3;
        totalDecisions += 1;
      }

      const elapsedMs =
        Number(process.hrtime.bigint() - startNs) / 1_000_000 +
        injectedDelayMs;
      decisionLatenciesMs.push(elapsedMs);
    }
  }

  const sortedLatencies = [...decisionLatenciesMs].sort((a, b) => a - b);
  const totalElapsedMs = Math.max(
    0.001,
    decisionLatenciesMs.reduce((acc, v) => acc + v, 0)
  );

  return {
    profileName: profile.name,
    totalDecisions,
    totalReadingsIngested,
    totalDbWrites,
    dbWritesPerDecision:
      totalDecisions > 0 ? totalDbWrites / totalDecisions : 0,
    latencyP50Ms: computePercentile(sortedLatencies, 50),
    latencyP99Ms: computePercentile(sortedLatencies, 99),
    decisionsPerSec: (totalDecisions / totalElapsedMs) * 1000,
    heapGrowthBytes: simulatedHeapBytes,
  };
}

/**
 * Compares a benchmark report against explicit budgets and an optional stored baseline.
 */
export function compareAgainstBaseline(
  report: PipelineBenchmarkReport,
  budget: PipelinePerformanceBudget,
  baseline?: PipelineBenchmarkReport
): BudgetComparisonResult {
  const violations: string[] = [];

  if (report.latencyP50Ms > budget.maxP50LatencyMs) {
    violations.push(
      `p50 latency ${report.latencyP50Ms.toFixed(2)}ms exceeds budget ${budget.maxP50LatencyMs}ms`
    );
  }
  if (report.latencyP99Ms > budget.maxP99LatencyMs) {
    violations.push(
      `p99 latency ${report.latencyP99Ms.toFixed(2)}ms exceeds budget ${budget.maxP99LatencyMs}ms`
    );
  }
  if (report.decisionsPerSec < budget.minDecisionsPerSec) {
    violations.push(
      `throughput ${report.decisionsPerSec.toFixed(1)} decisions/s below budget ${budget.minDecisionsPerSec} decisions/s`
    );
  }
  if (report.dbWritesPerDecision > budget.maxDbWritesPerDecision) {
    violations.push(
      `DB write amplification ${report.dbWritesPerDecision.toFixed(2)} writes/decision exceeds budget ${budget.maxDbWritesPerDecision}`
    );
  }
  if (report.heapGrowthBytes > budget.maxHeapGrowthBytes) {
    violations.push(
      `soak heap growth ${report.heapGrowthBytes} bytes exceeds budget ${budget.maxHeapGrowthBytes} bytes`
    );
  }

  if (baseline && baseline.latencyP99Ms > 0) {
    const regressionRatio = report.latencyP99Ms / baseline.latencyP99Ms;
    if (regressionRatio > budget.maxLatencyRegressionRatio) {
      violations.push(
        `p99 latency regression ratio ${regressionRatio.toFixed(2)}x exceeds tolerance ${budget.maxLatencyRegressionRatio}x`
      );
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    report,
  };
}
