/**
 * Load / soak runner for the oracle pipeline.
 *
 * Run:  npx ts-node --transpile-only test/load/run-load.ts --profile smoke
 *
 * Requires LOAD_DATABASE_URL and LOAD_REDIS_URL. The database name must contain
 * "load" so the run can never touch a shared or production database.
 */
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { performance } from "perf_hooks";
import { percentile, slope } from "./metrics";
import { createPipelinePort } from "./pipeline-port";
import { buildWorkload, WorkloadShape } from "./synthetic-workload";

const MB = 1024 * 1024;
const BUDGETS_PATH = join(__dirname, "budgets.json");

export interface Profile extends WorkloadShape {
  durationSeconds: number;
  sampleIntervalSeconds: number;
  warmupFraction: number;
}

export interface BudgetsFile {
  profiles: Record<string, Profile>;
  budgets: Record<string, { min?: number; max?: number; minDurationSeconds?: number }>;
  regressionTolerance: number;
  regressionMetrics: Record<string, "higher" | "lower">;
}

export interface LoadResult {
  schemaVersion: 1;
  profile: string;
  seed: number;
  shape: Profile;
  startedAt: string;
  node: string;
  durationSeconds: number;
  decisions: number;
  metrics: {
    decisionsPerSecond: number;
    latencyMsP50: number;
    latencyMsP99: number;
    payoutLatencyMsP50: number;
    payoutLatencyMsP99: number;
    dbWritesPerDecision: number;
    heapGrowthMbPerHour: number;
    peakHeapMb: number;
  };
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set to run the load suite`);
  return value;
}

function assertIsolatedDatabase(databaseUrl: string): void {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (!databaseName.includes("load")) {
    throw new Error(
      `Refusing to run load suite against database "${databaseName}": ` +
        "the name must contain \"load\" so shared databases are never used.",
    );
  }
}

export async function runLoad(profileName: string): Promise<LoadResult> {
  const budgets = JSON.parse(readFileSync(BUDGETS_PATH, "utf8")) as BudgetsFile;
  const profile = budgets.profiles[profileName];
  if (!profile) {
    throw new Error(`Unknown profile "${profileName}"`);
  }

  const databaseUrl = requireEnv("LOAD_DATABASE_URL");
  assertIsolatedDatabase(databaseUrl);
  const redisUrl = requireEnv("LOAD_REDIS_URL");

  const seed = Number(process.env.LOAD_SEED ?? 1337);
  const workload = buildWorkload(profile, seed);
  const port = await createPipelinePort({ databaseUrl, redisUrl });

  const latencies: number[] = [];
  const payoutLatencies: number[] = [];
  const heapSamples: { t: number; y: number }[] = [];
  let decisions = 0;
  let dbWrites = 0;
  let peakHeapMb = 0;

  const startedAt = new Date().toISOString();
  const start = performance.now();
  const deadline = start + profile.durationSeconds * 1000;
  let nextSample = start;

  try {
    while (performance.now() < deadline) {
      for (const feed of workload.feeds) {
        const readings = workload.readingsFor(feed, Date.now());

        const t0 = performance.now();
        const outcome = await port.decide(feed.feedId, readings, feed.payoutTriggering);
        const elapsed = performance.now() - t0;

        latencies.push(elapsed);
        if (feed.payoutTriggering) payoutLatencies.push(elapsed);
        dbWrites += outcome.dbWrites;
        decisions += 1;
      }

      const now = performance.now();
      if (now >= nextSample) {
        const heapMb = process.memoryUsage().heapUsed / MB;
        peakHeapMb = Math.max(peakHeapMb, heapMb);
        heapSamples.push({ t: (now - start) / 1000, y: heapMb });
        nextSample = now + profile.sampleIntervalSeconds * 1000;
      }
    }
  } finally {
    await port.close();
  }

  const elapsedSeconds = (performance.now() - start) / 1000;

  // Ignore the warmup window so JIT and connection-pool growth don't read as a leak.
  const warmupCutoff = profile.durationSeconds * profile.warmupFraction;
  const steadySamples = heapSamples.filter((s) => s.t >= warmupCutoff);

  return {
    schemaVersion: 1,
    profile: profileName,
    seed,
    shape: profile,
    startedAt,
    node: process.version,
    durationSeconds: Math.round(elapsedSeconds),
    decisions,
    metrics: {
      decisionsPerSecond: decisions / elapsedSeconds,
      latencyMsP50: percentile(latencies, 50),
      latencyMsP99: percentile(latencies, 99),
      payoutLatencyMsP50: percentile(payoutLatencies, 50),
      payoutLatencyMsP99: percentile(payoutLatencies, 99),
      dbWritesPerDecision: decisions === 0 ? 0 : dbWrites / decisions,
      heapGrowthMbPerHour: slope(steadySamples) * 3600,
      peakHeapMb,
    },
  };
}

async function main(): Promise<void> {
  const profileName = argValue("profile") ?? "smoke";
  const outPath = argValue("out") ?? "load-results/result.json";

  const result = await runLoad(profileName);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result.metrics, null, 2));
  console.log(`Wrote ${outPath}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
