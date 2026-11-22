# Oracle Alert Runbook

Alert titles below are the exact strings passed to `AlertingService.emit()`
(`src/alerting/alerting.service.ts`). `AlertingService` itself emits no named
alerts; it logs whatever its callers pass. `critical` is logged at `error`,
`warning` at `warn`, and `info` at `log`.

The feed alerts are raised by `OracleFeedMonitor` (`src/oracle/oracle-feed.monitor.ts`).
When `ORACLE_ALERT_WEBHOOK_URL` is set, those alerts are also POSTed as JSON to
that URL.

An alert fires only after `ORACLE_ALERT_CONSECUTIVE_BREACHES` consecutive
breaching evaluation cycles (default 3). A single healthy cycle resets the
streak. When a breach that had alerted clears, an `info` notice titled
`Oracle feed stale resolved` or `Oracle feed divergent resolved` is logged.

**Wiring:** `OracleFeedMonitor` and `OracleChainReconciler` are not registered in
any Nest module in this snapshot, so their alerts cannot fire here. See
[Known gaps](#known-gaps). `LeaderElector` is registered in `LeaderModule`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ORACLE_STALENESS_THRESHOLD_SECONDS` | `900` | Newest reading older than this counts as stale. |
| `ORACLE_DISPERSION_THRESHOLD` | `0.02` | Relative spread `(max − min) / \|mean\|` across sources above this counts as divergent. |
| `ORACLE_ALERT_CONSECUTIVE_BREACHES` | `3` | Breaching cycles in a row required before alerting. |
| `ORACLE_ALERT_WEBHOOK_URL` | unset | Optional delivery target. Treat as a secret; it is never logged. |

## Alerts

### Oracle feed stale

- **Severity:** `critical`. **Source:** `OracleFeedMonitor`.
- **Metric:** Newest reading age above `ORACLE_STALENESS_THRESHOLD_SECONDS`. The
  age gauge is not exported in this snapshot (see [Metrics reference](#metrics-reference)).
- **Meaning:** The feed has stopped updating, or every upstream source for that
  coverage is failing. Claim decisions for this coverage are being made on old
  data, so a valid claim could be withheld or a bad one paid.
- **Check first:** `refract_oracle_checks_total{outcome="failure"}` for the
  coverage, then the oracle scheduler logs for `Oracle refresh failed`.
  Full steps are in [`docs/runbooks/oracle-incidents.md` §1](runbooks/oracle-incidents.md#1-feed-is-stale).
- **Control:** No pause or breaker control is implemented in this snapshot. If
  the staleness is real and not transient, stop claim settlement by scaling the
  backend's claim scheduler down or halting the deployment, and restart it only
  after the feed is fresh again. Do not settle claims on the stale value. The
  manual pause is in [`oracle-incidents.md` §5](runbooks/oracle-incidents.md#5-restore-normal-operation-after-a-pause).

### Oracle feed divergent

- **Severity:** `critical`. **Source:** `OracleFeedMonitor`.
- **Metric:** Relative spread across sources above `ORACLE_DISPERSION_THRESHOLD`.
  The spread gauge is not exported in this snapshot.
- **Meaning:** Independent sources disagree on the current value. One source may
  be wrong, delayed, or manipulated. This is the case corroboration exists to catch.
- **Check first:** Compare each source's latest value directly against its
  public API, as in [`oracle-incidents.md` §2](runbooks/oracle-incidents.md#2-sources-diverge-beyond-tolerance).
  Check the oracle scheduler logs for a source that has dropped out, which can
  skew the spread.
- **Control:** No corroboration or quorum enforcement exists in this snapshot,
  so the alert is the only automatic guard. Hold payout-triggering claim
  settlement for the coverage type by halting the backend's claim scheduler
  until the sources agree. Do not override one source by hand. If a source is
  suspected of compromise, follow [`oracle-incidents.md` §4](runbooks/oracle-incidents.md#4-suspected-compromised-or-colluding-source).

### Oracle feed stale resolved / Oracle feed divergent resolved

- **Severity:** `info`. **Source:** `OracleFeedMonitor`.
- **Meaning:** The breach that had alerted is back within threshold. No action is
  needed beyond confirming the cause is gone. Check that `last_seen` in
  `oracle_events` is advancing (see `oracle-incidents.md` §1 step 1).

### Oracle reconciliation failed

- **Severity:** `warning`. **Source:** `OracleChainReconciler` (not wired in this snapshot).
- **Meaning:** A chain-to-database reconciliation run threw an error and was
  recorded as `failed`. Drift was not checked for that window.
- **First response:** Find `Oracle chain reconciliation failed: <message>` in the
  logs, and the run in `oracle_reconciliation_runs`. Fix the cause (usually RPC
  or database access), then wait for the next run. Do not treat a missing run as
  "no drift".

### Oracle reconciliation read truncated

- **Severity:** `warning`. **Source:** `OracleChainReconciler` (not wired in this snapshot).
- **Meaning:** The on-chain read stopped at `ORACLE_RECONCILIATION_MAX_ENTRIES`.
  Older entries in the window were not compared.
- **First response:** Treat the window as partly unchecked. Raise
  `ORACLE_RECONCILIATION_MAX_ENTRIES` or shorten the lookback, then re-run.

### Oracle drift: `<driftClass>`

- **Source:** `OracleChainReconciler` (not wired in this snapshot). One alert per
  drift class found in a run. The message gives the count and the run id.
- **Severity by class:**

  | Drift class | Severity | Notes |
  |---|---|---|
  | `missing_local_receipt` | `warning` | Logged at `info` with "(auto-repaired)" when the receipt was backfilled from chain. |
  | `timestamp_mismatch` | `warning` | |
  | `missing_on_chain_value` | `critical` | |
  | `value_mismatch` | `critical` | Treat as a possible bad source. Go to [`oracle-incidents.md` §4](runbooks/oracle-incidents.md#4-suspected-compromised-or-colluding-source). |
  | `unexpected_writer` | `critical` | Treat as a possible key compromise. Go to [`oracle-incidents.md` §4](runbooks/oracle-incidents.md#4-suspected-compromised-or-colluding-source). |

- **First response:** Read the examples in the alert context (`feedId`, `txHash`,
  `detail`). Records marked "review required" are not auto-corrected. Each needs
  an owner. Do not edit `oracle_events` by hand.

### Oracle leader election Redis failure

- **Severity:** `critical`. **Source:** `LeaderElector` (`src/leader/leader-elector.service.ts`).
- **Meaning:** The instance could not reach Redis for leader election. If it held
  leadership, it stepped down. Leader-gated work such as the claim scheduler
  (`src/claim/claim.scheduler.ts`) then stops on that replica until leadership is
  re-acquired.
- **First response:** Check Redis reachability from the backend replicas. Confirm
  one replica has taken leadership once Redis is back. Do not start extra oracle
  workers to fill the gap.

## Metrics reference

These are the metrics `MetricsService` exports (`src/metrics/metrics.service.ts`):

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `refract_oracle_checks_total` | counter | `coverage_type`, `outcome` | Per oracle check. Watch `outcome="failure"` for staleness. |
| `refract_oracle_check_duration_seconds` | histogram | `coverage_type` | Per oracle check. |
| `refract_oracle_stage_duration_seconds` | histogram | `feed`, `stage` | Per pipeline stage. |
| `refract_oracle_deadline_breaches_total` | counter | `feed`, `stage` | Stage deadline missed. |
| `refract_oracle_deadline_overrun_seconds` | histogram | `feed`, `stage` | How far past the deadline a stage ran. |

Labels are bounded: `feed`, `stage`, `source`, and `coverage_type` are fixed
identifiers. Raw source URLs and flight numbers are never used as labels.

## Known gaps

- **Monitor not wired:** `OracleFeedMonitor` is not registered in any Nest module
  because `OracleModule` is not yet implemented in this snapshot. Until it is,
  the `Oracle feed stale` and `Oracle feed divergent` alerts never fire. Register
  the monitor in the module and call `observe()` on each evaluation cycle.
- **Monitor metrics not exported:** `OracleFeedMonitor` calls
  `setOracleReadingAge` and `setOracleSourceDispersion` on `MetricsService`, but
  neither method exists in this snapshot. The gauges
  `oracle_reading_age_seconds` and `oracle_source_dispersion` are therefore not
  exported. Do not grep for them.
- **Metrics that do not exist:** `oracle_source_failures_total`,
  `oracle_source_request_duration_seconds`, `oracle_quorum_failures_total`, and
  `oracle_breaker_state` are not defined anywhere in `src/`. No check that relies
  on them will show data.
- **Reconciler not wired:** `OracleChainReconciler` is not registered in any Nest
  module, so the reconciliation and drift alerts above do not fire in this snapshot.
- **Pause control:** No operator pause endpoint exists yet. The threat model
  lists an operator pause for payout-triggering values as an open P1 item.
- **Breaker reset:** No circuit breaker is wired in this snapshot, so there is
  no breaker state to reset.
- **Quorum:** No quorum check exists, so no quorum alert is emitted.
