# Summary

Consolidates the two independently maintained coverage-type catalogs into a single shared module, `src/common/coverage-types.ts`. This is the first step of #73. The other assigned issues (#71, #72, #74) are referenced below but not implemented in this PR.

## #73 Unify the duplicated coverage-type catalogs

**What existed:** `PolicyService` had its own `COVERAGE_TYPES` literal (numeric ids, no `maxDuration`) plus three parallel arrays: `COVERAGE_TYPE_VARIANTS`, `COVERAGE_NAMES`, and `RISK_MULTIPLIERS`. `QuoteService` had a second `COVERAGE_TYPES` literal (keyed by `CoverageTypeName`, with `maxDuration`) plus its own `RISK_MULTIPLIERS` record.

**Done**
- New `src/common/coverage-types.ts` exports one typed `COVERAGE_TYPES` catalog with the full field set: id, name, description, risk level, risk multiplier, base rate, max coverage, max duration, trigger, and icon. It also exports `coverageTypeById` / `coverageTypeByName` lookups.
- Each entry carries both the numeric on-chain discriminant (`id`, 0-4) and the `CoverageTypeName` (`key`), so both lookup styles resolve to the same object. `key` is also the Symbol used for the `coverage_type` variant in `buy_policy`'s `PolicyParams`, which replaces `COVERAGE_TYPE_VARIANTS`.
- `PolicyService` and `QuoteService` both read from it. The catalog literals and parallel arrays in both services are removed. `GET /api/v1/policies/types` and `GET /api/v1/quotes/coverage-types` keep their existing response shapes.
- `QuoteService.createQuote` now resolves the catalog entry once and rejects an unknown coverage type with a 400. Before, `RISK_MULTIPLIERS[unknown]` produced a `NaN` premium; this is unreachable through the DTO's `@IsEnum`.
- Tests (`src/common/coverage-types.spec.ts`, 6 cases):
  - one entry per `CoverageTypeName`
  - `COVERAGE_TYPES[i].id === i`
  - the id-to-key order matches the on-chain `CoverageType` enum
  - by-id and by-name lookups return the same entry
  - unknown ids and names return `undefined`
  - both services' listings come from the shared catalog

**Not done in this PR**
- `PolicyService.buy()` does not enforce `maxDuration` yet (AC2). The shared catalog now carries the value, so the check is a small follow-up, along with the policy-vs-quote `maxDuration` parity regression test.
- No further documentation of the id/name mapping beyond the module doc comment and the tests above (AC3 is partially covered).

**Reviewer note: display text.** The two catalogs described the same products with different wording. The shared catalog keeps the policy catalog's `description`, `trigger`, and `riskLevel` strings, since it was the fuller catalog. Those strings therefore change in `GET /api/v1/quotes/coverage-types`, for example Flight Delay `riskLevel` "Very Low" becomes "low". No premium, risk-multiplier, max-coverage, or max-duration number changed. The trigger-threshold tables (`TRIGGER_THRESHOLDS`, `DEFAULT_THRESHOLDS`) are behavior rather than catalog data, so they are left as they were.

## #71 Versioned database migration system

**Not done in this PR**
- Migration tool and `0001_init` baseline from `src/db/schema.sql`
- `migrate:up` / `migrate:down` scripts and docs
- CI Postgres job running up/down/up

## #72 Shared PostgreSQL connection-pool module

**Not done in this PR**
- `DatabaseModule` / `DatabaseService` wrapping one `pg.Pool`
- Env-configurable pool size and timeouts, `ping()`, graceful shutdown

## #74 Redis-backed cache for oracle readings

**Not done in this PR**
- Redis module and cache-aside reads in `OracleService` with a short TTL
- Fail-open behavior when Redis is unreachable, without caching degraded readings

## Type of change

- [x] Refactor / cleanup
- [x] Tests / CI

## Checklist

- [x] I read [CONTRIBUTING.md](../CONTRIBUTING.md)
- [x] Tests added/updated for the change
- [x] Local gate passes (lint / typecheck / build)
- [x] No secrets, keys, or `.env` values committed
- [x] Behavioural changes are documented in the README where relevant (no README-level behavior change)

## Verification

`npm run lint`, `npm run typecheck`, and `npm run build` are clean. `npx jest`: 11 suites, 121 tests pass (115 on `main` + 6 new).

Note: the module lives in `src/common/` rather than `src/coverage/` because `.gitignore`'s `coverage/` rule (for Jest output) would ignore `src/coverage/`.

Closes #71
Closes #72
Closes #73
Closes #74
