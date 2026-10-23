# Oracle Alert Runbook

Alerts raised by `OracleFeedMonitor` (`src/oracle/oracle-feed.monitor.ts`).
Each alert is logged at `error` level through `AlertingService` and, when
`ORACLE_ALERT_WEBHOOK_URL` is set, POSTed as JSON to that URL.

An alert fires only after `ORACLE_ALERT_CONSECUTIVE_BREACHES` consecutive
breaching evaluation cycles (default 3). A single healthy cycle resets the
streak. A resolution notice is logged at `info` once a breach that had alerted
clears.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ORACLE_STALENESS_THRESHOLD_SECONDS` | `900` | Newest reading older than this counts as stale. |
| `ORACLE_DISPERSION_THRESHOLD` | `0.02` | Relative spread `(max − min) / \|mean\|` across sources above this counts as divergent. |
| `ORACLE_ALERT_CONSECUTIVE_BREACHES` | `3` | Breaching cycles in a row required before alerting. |
| `ORACLE_ALERT_WEBHOOK_URL` | unset | Optional delivery target. Treat as a secret; it is never logged. |

## Alerts

### Oracle feed stale

- **Metric:** `oracle_reading_age_seconds{coverage_type}` above the staleness threshold.
- **Meaning:** The feed has stopped updating, or every upstream source for that
  coverage is failing. Claim decisions for this coverage are being made on old
  data, so a valid claim could be withheld or a bad one paid.
- **Check first:** `oracle_source_failures_total{source}` and
  `oracle_source_request_duration_seconds` for the coverage's sources. Then check
  the oracle scheduler logs for `Oracle refresh failed`.
- **Control:** No pause or breaker control is implemented in this snapshot. If
  the staleness is real and not transient, stop claim settlement by scaling the
  backend's claim scheduler down or halting the deployment, and restart it only
  after the feed is fresh again. Do not settle claims on the stale value.

### Oracle feed divergent

- **Metric:** `oracle_source_dispersion{coverage_type}` above the dispersion threshold.
- **Meaning:** Independent sources disagree on the current value. One source may
  be wrong, delayed, or manipulated. This is the case corroboration exists to catch.
- **Check first:** Compare each source's latest value directly against its
  public API. Check `oracle_source_failures_total` for a source that has dropped
  out, which can skew the spread.
- **Control:** No corroboration or quorum enforcement exists in this snapshot,
  so the alert is the only automatic guard. Hold payout-triggering claim
  settlement for the coverage type by halting the backend's claim scheduler
  until the sources agree. Do not override one source by hand.

## Metrics reference

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `oracle_source_request_duration_seconds` | histogram | `source`, `outcome` | Per upstream request. |
| `oracle_source_failures_total` | counter | `source` | Incremented on each failed upstream request. |
| `oracle_reading_age_seconds` | gauge | `coverage_type` | Age of the newest reading each evaluation. |
| `oracle_source_dispersion` | gauge | `coverage_type` | Relative spread of the latest multi-source reading. |
| `oracle_quorum_failures_total` | counter | `coverage_type` | Readings withheld for lack of agreeing sources. |
| `oracle_breaker_state` | gauge | `coverage_type` | `0` closed, `1` half-open, `2` open. |

Labels are bounded: `source` and `coverage_type` are fixed identifiers. Raw
source URLs and flight numbers are never used as labels.

## Known gaps

- **Pause control:** No operator pause endpoint exists yet. The threat model
  lists an operator pause for payout-triggering values as an open P1 item.
- **Breaker reset:** `oracle_breaker_state` is exported, but no circuit breaker
  is wired to it in this snapshot, so it will not change until one is added.
- **Quorum failures:** `oracle_quorum_failures_total` is exported, but no
  quorum check exists yet to increment it.
- **Monitor wiring:** `OracleFeedMonitor` is not registered in any Nest module
  because `OracleModule` is not yet implemented in this snapshot. Once it is,
  register the monitor there and call `observe()` on each evaluation cycle.
