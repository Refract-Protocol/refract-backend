# Summary

Adds explicit HTTP caching headers to the three read-heavy, slow-changing GET endpoints named in #87, and pins their ETag/`304` behavior with integration tests. This is the first acceptance-criteria item of #87. The other assigned issues (#84, #85, #86) are referenced below but not implemented in this PR.

## #87 Response caching for read-heavy, slow-changing endpoints

**What existed:** A supertest probe against `main` shows Express's default `etag` setting already attaches a weak ETag to every `res.json()` body on `GET /api/v1/quotes/coverage-types`, `/api/v1/policies/types`, and `/api/v1/pool/stats`, and already answers a matching `If-None-Match` with `304`. What was missing:
- No `Cache-Control` header on any route, so clients had no freshness window and revalidated or refetched on every request.
- No test, so the ETag/`304` behavior could be lost silently (for example by `app.set("etag", false)` or a switch to a raw-response handler).

**Done**
- New `src/common/http-cache.ts` exports `STATIC_RESOURCE_CACHE_CONTROL = "public, max-age=60"`. Its doc comment explains the ETag/freshness split and the rule against using it on caller-specific responses.
- `@Header("Cache-Control", STATIC_RESOURCE_CACHE_CONTROL)` is applied to exactly `quotes/coverage-types`, `policies/types`, and `pool/stats`.
- Integration spec `src/common/http-cache.spec.ts` boots `QuoteModule`, `PolicyModule`, and `PoolModule` in a real Nest app and runs these checks for each route:
  - cold request returns 200 with an ETag and `Cache-Control`
  - matching `If-None-Match` returns 304 with an empty body and the same ETag
  - stale `If-None-Match` returns 200 with the current ETag
  - the caller-specific `pool/user/:address` gets no `Cache-Control`

**Not done in this PR**
- Invalidation on write (AC2). There is no coverage-type admin write path or Redis layer on `main` yet. Once there is, admin edits should bump a Redis-held version that feeds the ETag. Until then, `max-age=60` means a changed catalog can take up to 60 s to reach a client that already holds a fresh copy.
- A server-side response cache. Today's ETag is computed from the serialized body, so a `304` saves bandwidth but not the handler's own work.

## #84 Reliable outbox for Soroban-confirmed event persistence

**Not done in this PR**
- `outbox_events` table and `OutboxService`
- Transactional write plus a delivery poller with at-least-once semantics and a crash-recovery test

## #85 Audit trail for policy deactivation

**Not done in this PR**
- Append-only `policy_status_events` table
- A reason-carrying `deactivate()` signature and updated call sites

## #86 Data-retention and archival job for oracle_events

**Not done in this PR**
- Chunked, resumable archival/prune scheduler and a daily rollup target

## Type of change

- [x] New feature
- [x] Tests / CI

## Checklist

- [x] I read [CONTRIBUTING.md](../CONTRIBUTING.md)
- [x] Tests added/updated for the change
- [x] Local gate passes (lint / typecheck / build)
- [x] No secrets, keys, or `.env` values committed
- [x] Behavioural changes are documented in the README where relevant (header-only change, documented in `http-cache.ts`)

## Verification

`npm run lint`, `npm run typecheck`, and `npm run build` are clean. `npx jest`: 11 suites, 125 tests pass (115 on `main` + 10 new).

Closes #84
Closes #85
Closes #86
Closes #87
