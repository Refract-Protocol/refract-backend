# Oracle Incident Runbooks

**Read first:** [Oracle trust architecture](../oracle-trust-architecture.md).
These runbooks reference its hops (H1–H8) and its operator-authority table.

**Status:** Commands match the route signatures and config names in this
commit. They have **not** been dry-run against the Docker Compose stack, and
several of the endpoints they call are **not working in this snapshot**: the
`/api/v1/ops/claims/*` backing methods and the `/api/v1/claims/dead-letter`
route are absent (see the architecture doc, §2.1). Treat those steps as the
intended procedure until the dry run in §0.4 passes.

## 0. Ground rules

### 0.1 Setup

```bash
export API=http://localhost:4001
export ADMIN_API_KEY=...        # from your secret manager, never paste into chat
export OPS_API_KEY=...          # scoped ops key; header name per src/auth (see §0.3)
```

Do not put secret values in shell history or tickets. Read them from the
secret manager or a `.env` file that is not committed.

### 0.2 Irreversible and two-person actions

| Action | Irreversible? | Two-person review? |
|---|---|---|
| `POST /api/v1/ops/claims/:policyId/settle?confirm=true` | **Yes** — on-chain payout | **Yes** |
| `POST /api/v1/ops/claims/scan` without `dryRun=true` | **Yes** — settles every triggered policy | **Yes** |
| Relayer key rotation (`ORACLE_RELAYER_SECRET_ID`) | No, but affects signing authority | **Yes** |
| Changing `REFRACT_ORACLE_CONTRACT_ID`, pool contract IDs, or thresholds | No, but changes what is trusted | **Yes** |
| `docker compose down -v` | **Yes** — deletes Postgres and Redis volumes | Yes, outside local dev |
| Dropping `oracle_events` partitions | **Yes** — evidence loss | **Yes** |

Two-person review is a process requirement today; the code does not enforce
it (see the architecture doc §6).

### 0.3 Auth header

`ops-claim.controller.ts` uses `AuthGuard` and `ScopesGuard`, but
`src/auth/` is absent from this snapshot, so the header is unconfirmed. The
commands below use `X-API-Key` for `$OPS_API_KEY`. Confirm the header in
`src/auth/auth.guard.ts` before use. Admin-only routes use
`X-API-Key: $ADMIN_API_KEY` (`src/common/admin-auth.ts`).

### 0.4 Dry run before first live use

Before trusting any section below in production, run it against the local
stack:

```bash
docker compose up --build -d
curl -s "$API/health"
```

Record the output in the change ticket. Then confirm the sections end-to-end
on the stack. Skipping this is a deviation from policy.

### 0.5 Read-only triage first

Every runbook starts with read-only commands. Do not run a settlement or a
non-dry-run scan to "see what happens".

---

## 1. Feed is stale

**Trigger:** Scheduler logs `Oracle refresh failed`; `refract_oracle_checks_total{outcome="failure"}`
is rising; claim evaluation logs `Oracle data stale (...s old)` (the limit is
1800 s, `STALENESS_LIMIT_SECONDS` in `claim.service.ts`).

**Steps:**

1. Check the last recorded reading per coverage:

   ```bash
   psql "$DATABASE_URL" -c "SELECT coverage_type, MAX(recorded_at) AS last_seen FROM oracle_events GROUP BY coverage_type ORDER BY last_seen;"
   ```

2. Check failure counters:

   ```bash
   curl -s "$API/metrics" | grep refract_oracle_checks_total
   ```

3. Check upstream reachability (only the provider for the stale feed):

   ```bash
   curl -sS -m 10 "$COINGECKO_BASE_URL/ping"
   curl -sS -m 10 "$STELLAR_HORIZON_URL/" -o /dev/null -w "%{http_code}\n"
   curl -sS -m 10 "$DEFILLAMA_BASE_URL/protocol/$DEFILLAMA_PROTOCOL_SLUG" -o /dev/null -w "%{http_code}\n"
   ```

4. Decide:
   - **Provider down or rate-limited:** wait and re-check. Do not hand-write
     readings into `oracle_events` or the chain.
   - **Timeouts only:** consider raising `ORACLE_HTTP_TIMEOUT_MS` (default
     5000) in configuration, and restart. Treat as a two-person change.
   - **Backend error (logs show exceptions in the refresh path):** capture the
     stack trace and escalate to the backend owner.

5. Recovery check: `last_seen` advances on the next query.

**Effect on payouts:** a stale or degraded reading is non-triggering, so
policies are not paid on silence. This is the intended fail-safe.

---

## 2. Sources diverge beyond tolerance

**Important:** there is **no** implemented corroboration or divergence check
(architecture §4). Divergence is found by an operator comparing values, or by
noticing an unexpected trigger. A divergence alert is **PLANNED**.

**Trigger:** an operator notices a live value that disagrees with an
independent fetch of the same provider or another source, or a trigger that
does not match market data.

**Steps:**

1. Capture the recorded values for the window:

   ```bash
   psql "$DATABASE_URL" -c "SELECT coverage_type, value, source, severity, recorded_at FROM oracle_events WHERE recorded_at > now() - interval '2 hours' ORDER BY recorded_at DESC;" > /tmp/oracle-window.txt
   ```

2. Fetch the same value independently and record the time:

   ```bash
   curl -sS "$COINGECKO_BASE_URL/simple/price?ids=usd-coin,stellar&vs_currencies=usd"
   ```

3. Compare. If the difference is within what the provider's own timestamps
   allow, record it and monitor. If it is outside tolerance, go to §4.

4. Do **not** force a payout or publish a corrected value. Any settlement
   requires §5's two-person review.

---

## 3. Automatic circuit breaker trips (fail-safe and dead-letter)

**Important:** there is **no** automatic circuit breaker in code. The
behaviour operators see as "tripped" is one of these existing fail-safes:

- degraded readings (`OracleService.degraded()`) are non-triggering and never
  published;
- a claim whose settlement fails for three scheduled scans is moved to the
  dead-letter list and stops retrying automatically;
- `ReconciliationService` logs `stuck-settlement` after 12 recorded failures.

A general circuit breaker is **PLANNED**.

**Steps:**

1. List dead-lettered claims (in-memory; cleared on restart). **Not present in
   this snapshot:** `claim.controller.ts` is empty, so this route is documented
   in the README but not implemented here.

   ```bash
   curl -s "$API/api/v1/claims/dead-letter" | jq .
   ```

2. Check the recent scan history:

   ```bash
   curl -s -H "X-API-Key: $OPS_API_KEY" "$API/api/v1/ops/claims/scan-history?limit=20" | jq .
   ```

3. Check the relayer audit trail for the failing policy:

   ```bash
   psql "$DATABASE_URL" -c "SELECT * FROM relayer_transaction_audit ORDER BY 1 DESC LIMIT 20;"
   ```

4. Find the root cause before retrying. Common causes are the relayer key or
   balance (`RELAYER_MIN_BALANCE`), the pool contract, or RPC health. Check
   `GET /health` and the Soroban RPC URL.

5. Retry only after the cause is fixed. A dry run is safe:

   ```bash
   curl -s -X POST -H "X-API-Key: $OPS_API_KEY" "$API/api/v1/ops/claims/scan?dryRun=true" | jq .
   ```

   A non-dry-run scan is an **irreversible** payout run. Requires §0.2 review.

---

## 4. Suspected compromised or colluding source

**Assume** a value is wrong until shown otherwise. The system has no
corroboration, so one bad source can trigger payouts for every matching active
policy.

**Steps (in order):**

1. **Stop further payouts and publishing first.** Remove the relayer
   configuration (`ORACLE_RELAYER_SECRET_ID` / `ORACLE_RELAYER_SECRET`) and
   restart the backend replicas. This stops both on-chain publishing and
   settlement, because both need the relayer. This is a blunt, manual pause;
   see §5. Record the time.

2. **Preserve evidence** before anything rotates or expires:

   ```bash
   psql "$DATABASE_URL" -c "\copy (SELECT * FROM oracle_events WHERE recorded_at > now() - interval '24 hours') TO '/tmp/oracle-evidence.csv' CSV HEADER"
   psql "$DATABASE_URL" -c "\copy (SELECT * FROM relayer_transaction_audit WHERE created_at > now() - interval '24 hours') TO '/tmp/relayer-evidence.csv' CSV HEADER"
   curl -s "$API/metrics" > /tmp/metrics-snapshot.txt
   ```

   The `\copy` column names above are not confirmed by the schema fragment in
   this snapshot. `relayer_transaction_audit.created_at` in particular must be
   checked. Adjust the column names to the migrations before running.

   Also collect the `security_audit` and error log lines for the window from
   your log aggregator.

3. **Quantify exposure:** list active policies affected by the suspect coverage.
   A dry run shows what would trigger without paying:

   ```bash
   curl -s -X POST -H "X-API-Key: $OPS_API_KEY" "$API/api/v1/ops/claims/scan?dryRun=true" | jq .
   ```

4. **Verify the source independently** (§2 step 2) and, if the provider is
   the suspect, contact the provider's security channel.

5. **Rotate credentials** for any provider key or the relayer if compromise is
   plausible. Relayer rotation is a two-person change; see the README's rolling
   rotation guidance.

6. **Report.** For a vulnerability in Refract itself, use the structured
   intake in [`SECURITY.md`](../../SECURITY.md). Do not open a public issue.

7. **Resume** only after the source is restored or replaced and §5 is complete.
   Any already-confirmed payouts are not reversible from this service; the
   contracts team must assess recovery.

---

## 5. Restore normal operation after a pause

**Important:** there is **no operator pause switch** in code. A pause today is
a configuration change and a restart. Writing a real pause command is
**PLANNED**.

**Pausing (manual):**

1. Remove `ORACLE_RELAYER_SECRET_ID` (and `ORACLE_RELAYER_SECRET` if set).
2. Restart the backend replicas.
3. Confirm no relayer is configured:

   ```bash
   curl -s "$API/health"
   ```

   `ClaimService.getStats()` reports `settlementConfigured`. Check it on the
   claim stats endpoint if exposed in your deployment. Do not assume the
   pause took effect until you have checked the logs for the relayer
   configuration on startup.

**Restoring:**

1. Confirm the cause is fixed and recorded in the ticket. Two-person sign-off
   is required.
2. Re-add `ORACLE_RELAYER_SECRET_ID` (the key is loaded at runtime from AWS
   Secrets Manager). Restart the replicas, one at a time.
3. Check startup. The pool contract spec check runs at startup and fails fast
   on an interface mismatch. Do not bypass it.

   ```bash
   curl -s "$API/health"
   curl -s "$API/metrics" | grep -E "refract_oracle_checks_total|refract_scheduler_runs_total"
   ```

4. Run a dry-run scan and review the output before any real run:

   ```bash
   curl -s -X POST -H "X-API-Key: $OPS_API_KEY" "$API/api/v1/ops/claims/scan?dryRun=true" | jq .
   ```

5. Check that `oracle_events.recorded_at` is advancing (§1 step 1).
6. Review `GET /api/v1/claims/dead-letter` and the reconciliation logs for
   drift accumulated during the pause. Reconciliation does not auto-correct;
   each item needs an owner.

**Do not** run a non-dry-run scan on the first restart. Wait for the dry run
to be reviewed and approved (§0.2).

---

## 6. Known limits of these runbooks

- Several commands depend on files absent from this snapshot (see the
  architecture doc, §2.1). They must be validated on a complete tree.
- The `/api/v1/ops/claims/*` routes call `ClaimService` methods that are not
  in this snapshot. Dry runs and force settle cannot be confirmed here.
- Column names for `relayer_transaction_audit` and `claims` are not in the
  schema fragment here; check the migrations before running SQL.
- There is no pause, circuit breaker, divergence alert, or evidence hash
  chain. These are the first items to build when this document is next
  reviewed.
