# Load, Soak, and Performance Budgets

This suite drives the oracle pipeline (source ingestion, corroboration, anomaly
checks, decision persistence, publishing) with a deterministic synthetic
workload of N sources, M feeds and K node operators. Sources are a fake adapter
and publishing goes to a stub publisher, so results isolate oracle logic from
network variance.

| File | Role |
|------|------|
| `synthetic-workload.ts` | Seeded feeds, sources and readings (`mulberry32`) |
| `pipeline-port.ts` | The seam to the real pipeline. `createPipelinePort()` must be wired to the oracle Nest module |
| `run-load.ts` | Runs a profile and writes the machine-readable result artifact |
| `metrics.ts` | Nearest-rank percentiles and least-squares slope (heap growth) |
| `budgets.json` | Profiles, absolute budgets, regression tolerance |
| `baseline.json` | Stored results per profile, keyed by profile name |
| `../../scripts/load-compare.ts` | Enforces budgets and baseline tolerance, exits 1 on breach |

## Running locally

Start the dependencies, then point the suite at a database whose name contains `load`
(the runner refuses any other name):

```bash
docker compose up -d postgres redis
export LOAD_DATABASE_URL=postgresql://refract:refract_dev@127.0.0.1:5432/refract_load
export LOAD_REDIS_URL=redis://127.0.0.1:6379

npx ts-node --transpile-only test/load/run-load.ts --profile smoke --out load-results/result.json
npx ts-node --transpile-only scripts/load-compare.ts --result load-results/result.json --baseline test/load/baseline.json
```

`--profile soak` runs for two hours and samples heap every 30 seconds. Set
`LOAD_SEED` to change the deterministic workload.

## Profiles

| Profile | Sources | Feeds | Operators | Duration | Trigger |
|---------|---------|-------|-----------|----------|---------|
| `smoke` | 8 | 20 | 4 | 60 s | every PR |
| `soak` | 24 | 100 | 8 | 2 h | nightly schedule, manual dispatch |

## Budgets

Defined in `budgets.json`. Each metric is one of:

- **Absolute budget**: `max` or `min`. Breaching it fails the job.
- **Regression**: compared against `baseline.json` for the same profile. A metric
  fails if it is worse than the baseline by more than `regressionTolerance` (20%).
  Latency and throughput are gated this way. Heap growth is gated only by its
  absolute budget because a baseline slope is noisy.

Metrics in `result.metrics`:

| Metric | Meaning |
|--------|---------|
| `decisionsPerSecond` | Sustained feed decisions per second on one instance |
| `latencyMsP50` / `latencyMsP99` | End-to-end decision latency, all feeds |
| `payoutLatencyMsP50` / `payoutLatencyMsP99` | Same, for payout-triggering feeds only |
| `dbWritesPerDecision` | DB write amplification per decision |
| `heapGrowthMbPerHour` | Least-squares heap slope after the warmup window (soak leak signal) |
| `peakHeapMb` | Highest sampled heap, informational |

## Interpreting output

- A `budget` failure means an absolute ceiling or floor was crossed. Investigate
  even if the baseline also moved.
- A `regression` failure means the metric got worse than the stored baseline by
  more than the tolerance. Compare `shape` and `node` in the two JSON files first.
- `heapGrowthMbPerHour` above budget in a soak run suggests a leak. Confirm with a
  longer run before changing code. Smoke runs are too short to judge it.
- An empty `baseline.json` is valid. The compare script then enforces absolute
  budgets only and prints a warning.

## Updating the baseline

Run the profile on the reference runner (the nightly soak or a manual dispatch),
copy the `result.json` for that profile into `baseline.json` under its key, and
commit it in a PR that explains the change. Never update the baseline to make a
failing regression pass without that explanation.
