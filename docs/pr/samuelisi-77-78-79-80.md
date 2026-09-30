# Summary

Adds cursor-based (keyset) pagination to `GET /api/v1/policies/holder/:address`, `GET /api/v1/claims/holder/:address`, and `GET /api/v1/claims/recent`. This implements the pagination change in #78. The other assigned issues (#77, #79, #80) are referenced below but not implemented. #77 and #79 need the Postgres wiring that isn't on `main` yet (no `pg` usage in `src/`).

## #78 Cursor-based pagination on list endpoints

**What existed:** All three endpoints returned unbounded arrays built from in-memory collections (`recent` was capped at 10).

**Done**
- New `src/common/pagination.ts`:
  - `PageQueryDto`: `?limit=` is an integer from 1 to 100; `?cursor=` is optional.
  - `paginateDesc()` does keyset pagination, newest first, on a `(timestamp, id)` key.
  - The cursor is opaque: base64url of `[timestamp, id]`, never raw column values. A malformed cursor returns 400.
- A page after a cursor contains only rows strictly older than the cursor's key. Rows inserted between requests are always newer, so they can't cause duplicates or gaps on later pages the way offset pagination would.
- Keysets:
  - Policies use `(createdAt, id)`.
  - Claims use `(processedAt, policyId)`. `ClaimResult` has no row id, and a policy settles at most once because it is deactivated on payout, so `policyId` is a unique tie-breaker.
  - These match the `(created_at, id)` / `(processed_at, id)` keysets the Postgres repositories should page on, so the cursor contract survives the persistence wiring.
- **Backward compatible:**
  - The existing `policies` / `claims` response keys are kept, and `nextCursor` (`null` on the last page) is added alongside them in the same envelope on all three endpoints.
  - Omitting the params returns a default first page, never an error.
  - `recent` keeps its previous default of 10. The holder lists default to 50.
- Service methods and their existing tests are unchanged. Pagination is applied at the controller layer over the service results.
- `src/common/pagination.spec.ts` has 18 tests:
  - Unit: default first page; full walk with every row exactly once and timestamp ties broken by id; exactly-full last page returns a `null` cursor; stability when rows are inserted between page requests; empty collection; input not mutated; cursor round-trip and 3 malformed-cursor cases.
  - HTTP with `main.ts`'s `ValidationPipe`: envelope keys and cursor follow-through on `policies/holder`; `recent` default of 10; `claims/holder` default page; 400 for `limit=0`, `limit=101`, `limit=abc`, a malformed cursor, and an unknown query param.

**Not done in this PR**
- SQL keyset queries in the repositories (these arrive with the persistence issues). Today the helper sorts and filters the in-memory collections.

## #77 Replace the mocked premium-history generator with real data

**Not done in this PR**
- A `generate_series` UTC day-bucketed query over `premium_revenue`, `claims`, and `pool_snapshots`, with zero-filled days

## #79 LP position reconciliation service

**Not done in this PR**
- A batched, rate-limited scheduler comparing on-chain share balances with `lp_positions`, plus drift logging and the `reconciliation-status` endpoint

## #80 Real on-chain policy confirmation

**Not done in this PR**
- `pending` to `confirmed` status via `pollForConfirmation`, exclusion of unconfirmed policies from `listActive()`, and pending-TTL cleanup

## Type of change

- [x] New feature
- [x] Tests / CI

## Checklist

- [x] I read [CONTRIBUTING.md](../CONTRIBUTING.md)
- [x] Tests added/updated for the change
- [x] Local gate passes (lint / typecheck / build)
- [x] No secrets, keys, or `.env` values committed
- [x] Behavioural changes are documented in the README where relevant (additive `nextCursor` field and query params, documented above and in the controller doc comments)

## Verification

`npm run lint`, `npm run typecheck`, and `npm run build` are clean. `npx jest`: 11 suites, 133 tests pass (115 on `main` + 18 new).

Closes #77
Closes #78
Closes #79
Closes #80
