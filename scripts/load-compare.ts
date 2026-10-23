/**
 * Enforces performance budgets and compares a load run against the stored baseline.
 *
 * Run:  npx ts-node --transpile-only scripts/load-compare.ts \
 *         --result load-results/result.json --baseline test/load/baseline.json
 *
 * Exits non-zero on any absolute budget breach or any regression beyond
 * `regressionTolerance` relative to the baseline for the same profile.
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { BudgetsFile, LoadResult } from "../test/load/run-load";

export interface Violation {
  metric: string;
  kind: "budget" | "regression";
  actual: number;
  limit: number;
  message: string;
}

export function evaluate(
  result: LoadResult,
  baseline: LoadResult | undefined,
  config: BudgetsFile,
): Violation[] {
  const violations: Violation[] = [];
  const metrics = result.metrics as unknown as Record<string, number>;
  const baselineMetrics = baseline?.metrics as unknown as Record<string, number> | undefined;

  for (const [metric, rule] of Object.entries(config.budgets)) {
    const actual = metrics[metric];
    if (actual === undefined) continue;

    // Heap growth only means something over a long enough window.
    if (rule.minDurationSeconds !== undefined && result.durationSeconds < rule.minDurationSeconds) {
      continue;
    }

    if (rule.max !== undefined && actual > rule.max) {
      violations.push({
        metric,
        kind: "budget",
        actual,
        limit: rule.max,
        message: `${metric} ${actual.toFixed(2)} exceeds budget max ${rule.max}`,
      });
    }
    if (rule.min !== undefined && actual < rule.min) {
      violations.push({
        metric,
        kind: "budget",
        actual,
        limit: rule.min,
        message: `${metric} ${actual.toFixed(2)} is below budget min ${rule.min}`,
      });
    }
  }

  if (baselineMetrics) {
    for (const [metric, direction] of Object.entries(config.regressionMetrics)) {
      const actual = metrics[metric];
      const expected = baselineMetrics[metric];
      if (actual === undefined || expected === undefined || expected <= 0) continue;

      const limit =
        direction === "lower"
          ? expected * (1 + config.regressionTolerance)
          : expected * (1 - config.regressionTolerance);
      const regressed = direction === "lower" ? actual > limit : actual < limit;
      if (regressed) {
        violations.push({
          metric,
          kind: "regression",
          actual,
          limit,
          message:
            `${metric} regressed: ${actual.toFixed(2)} vs baseline ${expected.toFixed(2)} ` +
            `(${direction} is better, tolerance ${config.regressionTolerance * 100}%)`,
        });
      }
    }
  }

  return violations;
}

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function main(): void {
  const resultPath = argValue("result", "load-results/result.json");
  const baselinePath = argValue("baseline", join(__dirname, "../test/load/baseline.json"));
  const budgetsPath = join(__dirname, "../test/load/budgets.json");

  const result = JSON.parse(readFileSync(resultPath, "utf8")) as LoadResult;
  const config = JSON.parse(readFileSync(budgetsPath, "utf8")) as BudgetsFile;

  let baseline: LoadResult | undefined;
  if (existsSync(baselinePath)) {
    const baselines = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, LoadResult>;
    baseline = baselines[result.profile];
  }
  if (!baseline) {
    console.warn(
      `No baseline for profile "${result.profile}" in ${baselinePath}; enforcing absolute budgets only.`,
    );
  }

  const violations = evaluate(result, baseline, config);
  if (violations.length === 0) {
    console.log(`Load profile "${result.profile}" is within budgets and baseline tolerance.`);
    return;
  }

  for (const violation of violations) {
    console.error(`::error::[${violation.kind}] ${violation.message}`);
  }
  process.exit(1);
}

if (require.main === module) {
  main();
}
