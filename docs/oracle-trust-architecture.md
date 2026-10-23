# Oracle Trust Architecture

**Status:** Describes the implementation as of this commit. Items marked
**PLANNED** are not built and must not be relied on.
**Owner:** Backend maintainers. **Review:** any change to `src/oracle/`,
`src/claim/`, the oracle sources, or operator endpoints requires a second
maintainer review and an update to this document in the same PR.
**Related:** [threat model](./threat-model.md) ·
[incident runbooks](./runbooks/oracle-incidents.md)

> **Snapshot caveat.** In this checkout several files that implement the
> path below are zero bytes in `HEAD`: `src/oracle/oracle.service.ts`,
> `src/oracle/oracle-publisher.service.ts`, and
> `src/claim/claim-settlement.service.ts`, and `src/claim/claim.controller.ts`
> (the README's dead-letter route lives there). The modules `src/auth`,
> `src/parameters`, and `src/audit` imported by `oracle.scheduler.ts`,
> `claim.service.ts`, and `ops-claim.controller.ts` are also absent.
> `ops-claim.controller.ts` calls `ClaimService.runScan`, `settlePolicy`,
> `getScanHistory`, and `isScanRunning`, and `claim.scheduler.ts` calls
> `settleClaims`; none exist in `claim.service.ts`, which exposes
> `processTriggered()`. The `/api/v1/ops/claims` routes are therefore declared
> but would fail at runtime in this snapshot. Statements about the missing
> files below come from the README, `.env.example`, and the code that does
> exist. Verify them against a complete tree before relying on this document
> for an audit.

## 1. Purpose

A payout-triggering value is produced by one path: a source is polled, its
reading is validated and classified, the classification is recorded, the
active policies are evaluated against it, and a confirmed on-chain payout is
made through the relayer. This document states what each hop trusts.

## 2. End-to-end path

```
 external source ──► OracleService (src/oracle/oracle.service.ts)
   (CoinGecko, Horizon, DeFiLlama; mocked for two coverages)
        │  OracleReading { value, threshold, severity, degraded? }
        ├──► OracleScheduler ─ cron every ORACLE_SCHEDULER_INTERVAL_SECONDS
        │      └─► OracleEventRepository ──► oracle_events (evidence)
        │      └─► OraclePublisherService ──► RefractOracle.update_reading (on-chain)
        │
        └──► ClaimService.processTriggered (src/claim/claim.service.ts)
               ├─ staleness check (1800 s limit)
               ├─ threshold comparison per coverage type
               ├─ ClaimSettlementService.settleClaim ──► pool.process_claim (on-chain)
               └─ deactivate policy only after settlement confirms
     ClaimScheduler (@Cron EVERY_MINUTE) drives settleClaims()
     ReconciliationService (every 15 min) reports drift; does not correct it
```

### 2.1 Hops and trust assumptions

| # | Hop | Code | What is checked today | What the hop trusts | Gap |
|---|---|---|---|---|---|
| 1 | Source poll | `OracleService.check*()` (file not in snapshot; see caveat) | HTTP timeout `ORACLE_HTTP_TIMEOUT_MS` (default 5000 ms). On timeout or error the service returns `OracleService.degraded()`, a non-triggering reading with `degraded: true`. | The provider's HTTPS endpoint and the provider's data. | No response-shape, numeric-range, or timestamp validation is documented. Source authenticity is TLS only. |
| 2 | Classification | `OracleReading` (`src/oracle/oracle-reading.ts`) | `severity` is one of `low`, `medium`, `high`, `triggered`. | The service's own threshold logic. | Thresholds are set in code; no independent check. |
| 3 | Scheduled broadcast | `OracleScheduler` (`src/oracle/oracle.scheduler.ts`) | Errors are logged; a failed refresh does not stop the next tick. | The scheduler runs once per tick. Overlap protection is not present (see §6). | **PLANNED:** overlap guard. |
| 4 | Evidence write | `OracleEventRepository.record()` (`src/oracle/oracle-event.repository.ts`) | `coverage_type` is mapped to the schema enum. Writes are fire-and-forget; errors are logged and not re-thrown. | Postgres accepts the row. | A failed write is not retried and is not visible except in logs. The source name is parsed back out of `reading.message` by `extractSource()`, so it is only as reliable as that message format. |
| 5 | On-chain publish | `OraclePublisherService` (file not in snapshot) | Runs only when the relayer secret is configured. Degraded readings are never published (`OracleReading.degraded` contract). Cadence set by `ORACLE_PUBLISH_MODE` (`on_change` or `every_poll`) and `ORACLE_PUBLISH_MIN_INTERVAL_MS`. | The relayer key and the `REFRACT_ORACLE_CONTRACT_ID` contract. | The contract is the only consumer of the published value; there is no backend cross-check of the value before it is published. |
| 6 | Claim evaluation | `ClaimService.processTriggered()` (`src/claim/claim.service.ts`) | Active policies only. Readings older than 1800 s are non-triggering. `FlightDelay` triggers when `value > threshold`; the other four coverages trigger when `value < threshold`. Each evaluated reading is persisted through hop 4. | The reading from hop 1. A single source decides. | No corroboration (**PLANNED**). A single bad value can trigger a payout for every matching active policy. |
| 7 | Settlement | `ClaimSettlementService` (file not in snapshot) → `pool.process_claim(policy_id: u64)` | Submission retries across scans; the policy is deactivated only after on-chain confirmation. Relayer sequences are serialised with PostgreSQL advisory locks. Each relayer transaction is written to `relayer_transaction_audit`. Failures are exposed via `/api/v1/claims/dead-letter` after three scans. | The relayer key (AWS Secrets Manager) and the pool contract, which is the authority for payout execution. | Payout limits and per-claim bounds are not in code (**PLANNED**). The `process_claim` signature is documented as unverified in the README, and startup checks it against the deployed spec. |
| 8 | Post-hoc reconciliation | `ReconciliationService` (`src/claim/reconciliation.service.ts`) | Logs four drift classes every 15 minutes. After 12 failed settlements it logs `stuck-settlement`. | Nothing is corrected automatically. | Reconciliation findings do not block payouts. |

## 3. Source inventory

Source of truth for providers and mode: README ("Oracle data sources") and
`.env.example`. The per-coverage mapping of provider to coverage is stated in
the README but lives in `src/oracle/oracle.service.ts`, which is empty in this
snapshot. Confirm the mapping against that file before publishing this table as
authoritative.

| Feed (`coverageType`) | Provider(s) | Mode | Trust mode today | Notes |
|---|---|---|---|---|
| `StablecoinDepeg` | CoinGecko (USDC price), `COINGECKO_BASE_URL` | **Live** (keyless) | Single source, no corroboration | Triggers when value is below threshold. |
| `MarketCrash` | CoinGecko (XLM price) | **Live** (keyless) | Single source, no corroboration | README attributes the CoinGecko price check to this feed group; confirm the exact coverage mapping in `oracle.service.ts`. |
| `SmartContractRisk` | DeFiLlama protocol TVL (`DEFILLAMA_PROTOCOL_SLUG`, default `aave`), Stellar Horizon (chain context) | **Live** (keyless) | Single source per check | The protocol slug is a placeholder "covered protocol" until Refract defines a list. |
| `LiquidationShield` | None | **Mocked** | Not a live trust source | No public API for NEXUS liquidation events. Do not offer as live coverage. |
| `FlightDelay` | AviationStack (paid key) | **Mocked** | Not a live trust source | No API key is configured; there is intentionally no env var for it. Do not offer as live coverage. |

Metrics use `outcome="mocked"` for mocked checks
(`src/metrics/metrics.service.ts`, `refract_oracle_checks_total`), so mocked
and live results are distinguishable in dashboards.

## 4. Corroboration, quorum, and trust modes

**Implemented today:** none. Every live feed is single-source. The only
protections are the fail-safe degraded reading, the staleness limit, and the
rule that degraded readings are never published.

**PLANNED** (not built; no code, config, or table exists for these):

- **Corroboration rules:** an evaluated value must agree with at least one
  independent source within a stated tolerance before it can trigger.
- **Quorum:** the minimum number of agreeing sources, and the behaviour on
  shortfall (non-triggering, with an alert).
- **Trust modes:** a per-feed mode, for example `mocked`, `single_source`,
  `corroborated`, and `paused`, controlling whether a reading may trigger and
  whether it may be published.
- **Staged rollout and staking:** a feed moves through stages before it can
  trigger payouts. Not designed in code yet.

Until corroboration exists, `single_source` is the only live mode, and
`LiquidationShield` and `FlightDelay` must remain mocked and not be offered as
live coverage.

## 5. Evidence ledger

**Implemented:**

- `oracle_events` — one row per recorded reading: `coverage_type`, `value`
  (`>= 0`, enforced by `chk_oracle_value_nonneg`), `source`, `severity`
  (`low|medium|high|triggered`), and `recorded_at`. Partitioned monthly.
  `OracleRetentionService` creates partitions ahead of time and drops
  partitions older than `DB_ORACLE_RETENTION_MONTHS` (default 6). **Dropped
  partitions are gone; this is not a permanent ledger.**
- `claims` — settlement status, `trigger_detected_at`, `settled_at`, and
  `payout_amount`.
- `relayer_transaction_audit` — every relayer-signed transaction with its
  lifecycle status, hash, signing public key, and policy ID (per README).
- `security_audit` JSON lines on stdout for state-changing API attempts
  (`SECURITY.md`).

**Semantics:**

- Writes to `oracle_events` are best-effort. A failed write is logged, not
  retried, and leaves no marker in the table. Reviewers should not treat the
  table as complete for any window without checking logs for insert failures.
- `source` is derived from the reading message, not from a dedicated field.
- Evidence is not tamper-evident. There are no hashes chaining rows, and the
  database operator can alter or drop rows.
- The ledger does not yet link a reading to the policy evaluations and
  settlement it caused. Correlate by time window and `coverage_type` until a
  join key exists.

**PLANNED:** append-only, hash-chained evidence records linking reading →
trigger decision → settlement hash, with a retention policy that does not drop
evidence needed for a dispute.

## 6. Operator authority

| Capability | Mechanism | Who | Guard |
|---|---|---|---|
| Read ops scan history | `GET /api/v1/ops/claims/scan-history` | Scope `ops:read` | `AuthGuard` + `ScopesGuard` (`src/claim/ops-claim.controller.ts`) |
| Run a claim scan | `POST /api/v1/ops/claims/scan` (`dryRun=true` evaluates without paying) | Scope `ops:write` | Same |
| Force-settle one policy | `POST /api/v1/ops/claims/:policyId/settle`. A non-dry-run settle requires `confirm=true`, or the request is rejected and audited. | Scope `ops:write` | Same. **Irreversible on-chain payout.** |
| Admin-only routes | `@AdminOnly()` requires `X-API-Key: $ADMIN_API_KEY`. Fails closed with `503` if the key is unset. | Holder of the admin key | `AdminApiKeyGuard` (`src/common/admin-auth.ts`) |
| Bearer ops token | `OpsAuthGuard` accepts `Authorization: Bearer $OPS_API_TOKEN`. Community keys (`COMMUNITY_API_KEYS`) are read-only on an allowlist. | Token holders | `src/common/guards/ops-auth.guard.ts` |
| Relayer signing | Key read at runtime from AWS Secrets Manager (`ORACLE_RELAYER_SECRET_ID`). | Runtime IAM role | Not an operator action. |
| Pause a feed or publishing | **Not implemented.** The only current lever is removing relayer configuration and restarting (see the runbook). | — | **PLANNED:** per-feed pause with audit. |

**Status of these routes in this snapshot:** declared in
`ops-claim.controller.ts`, but the `ClaimService` methods they call are absent,
so they are not verified as working. Treat the table as the intended contract.

Two authentication mechanisms exist (scoped API keys via `AuthGuard`, and the
bearer token via `OpsAuthGuard`). The `ops-claim.controller.ts` routes use
`AuthGuard`; the scope and header format must be confirmed in `src/auth/`, which
is absent from this snapshot.

**Two-person review (PLANNED, currently a process requirement, not enforced in
code):** force settle with `confirm=true`, relayer key rotation, changes to
`REFRACT_ORACLE_CONTRACT_ID` or pool contract IDs, threshold or staleness
changes, and any change to the source inventory above.

## 7. Known gaps (summary)

1. Single-source live feeds. No corroboration, quorum, or divergence check.
2. No automatic circuit breaker and no operator pause switch.
3. Evidence is best-effort, not tamper-evident, and subject to partition drop.
4. The claim scanner's cron runs every minute (`@Cron(CronExpression.EVERY_MINUTE)`);
   the `scheduler.claim.interval_seconds` registry value does not change that cron.
   The threat model previously stated five minutes; it has been corrected.
5. Snapshot files named in §2.1 are empty or missing in this checkout.
