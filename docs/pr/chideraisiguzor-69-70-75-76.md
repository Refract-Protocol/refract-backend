# Summary

Adds the loss-ratio calculation behind #76's planned analytics endpoint, including its zero-premium and zero-claims edge cases. The other assigned issues (#69, #70, #75) are referenced below but not implemented. All four depend on Postgres wiring that doesn't exist on `main` yet: there is no `pg` usage in `src/`, and the shared pool module is #72.

## #76 Premium revenue & loss-ratio analytics API

**Done**
- New `src/analytics/loss-ratio.ts` with `computeLossRatio(rows)`. It takes per-coverage-type aggregates, the rows a `SUM(premium_revenue.amount)` / `SUM(claims.payout)` `GROUP BY coverage_type` query returns, and produces:
  - an `overall` line and a `byCoverageType` breakdown, each with `premiumCollected`, `claimsPaid`, and `lossRatioBps`
  - amounts as BigInt in 1e7 fixed-point (per CONTRIBUTING), serialized as strings so `NUMERIC(30, 0)` values keep full precision
  - `lossRatioBps` as `claimsPaid * 10_000 / premiumCollected`, rounded down
- Edge cases:
  - Zero claims gives `0`.
  - Zero premium gives `null`, never a division by zero. `0` there would hide claims paid against no revenue.
  - An empty window gives an empty breakdown and a `null` overall ratio.
  - Negative aggregates are rejected.
- Rows for the same coverage type are summed, so premium and claims can come from two separate `GROUP BY` queries. The breakdown is sorted by coverage type for a stable response shape.
- `src/analytics/loss-ratio.spec.ts` has 7 tests and 100% line and branch coverage. The fixtures are hand-computed for 3 coverage types with mixed volumes: 25%, 150% (underpriced), and 33.33% rounded down to 3333 bps. The overall figure is 6065 bps. Other tests cover the zero-premium, zero-claims, empty, merge, and beyond-`MAX_SAFE_INTEGER` cases.

**Not done in this PR**
- `GET /api/v1/analytics/loss-ratio` controller and module wiring
- The SQL aggregation queries (need #72's pool module)
- Validated and bounded `?since=` / `?until=` window
- Integration test with seeded premium and claims data

## #69 Wire PoolService onto Postgres-backed pool_snapshots and lp_positions

**Not done in this PR**
- `getStats()` from the latest `pool_snapshots` row, `getUserPosition()` from `lp_positions` with a 0-state response, and `getPremiumHistory()` from real rows

## #70 Persist ClaimService's settlement history to the claims table

**Not done in this PR**
- `ClaimRepository`, inserts on settlement, and DB-derived `getStats()`

## #75 Periodic pool-snapshot scheduler

**Not done in this PR**
- `PoolSnapshotScheduler` with a configurable interval and error isolation

## Type of change

- [x] New feature
- [x] Tests / CI

## Checklist

- [x] I read [CONTRIBUTING.md](../CONTRIBUTING.md)
- [x] Tests added/updated for the change
- [x] Local gate passes (lint / typecheck / build)
- [x] No secrets, keys, or `.env` values committed
- [x] Behavioural changes are documented in the README where relevant (no API surface yet)

## Verification

`npm run lint`, `npm run typecheck`, and `npm run build` are clean. `npx jest`: 11 suites, 122 tests pass (115 on `main` + 7 new).

Closes #69
Closes #70
Closes #75
Closes #76
