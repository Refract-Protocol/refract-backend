# Oracle safety controls

`OracleRecoveryGate` exposes a per-coverage admission decision. After a
breaker trip it holds readings through a cooldown, then allows healthy
corroborated readings into a canary phase. Canary readings are computation
only; graduation requires multiple distinct observation times and a minimum
canary duration. Callers must treat only `publish` as permission to publish.

`OracleFeedControl` immediately blocks local publication after a pause request
and records whether an on-chain update was confirmed. It refuses to clear a
pause until a configured publisher confirms the corresponding resume.
Without such a publisher, the feed remains paused.

## Oracle-node gossip

`SignedReadingGossip` accepts Ed25519-signed readings only from an explicit
peer-id/public-key allowlist. Configure the allowlist and the minimum peer
quorum per deployment; do not use shared unauthenticated broadcast ingress.
Signatures cover a canonical payload including sequence, round, time, value,
threshold, severity, and message. Each peer's sequence and `(peer, round)` are
reserved transactionally in `oracle_peer_sequences` and
`oracle_gossip_replays`; apply
`src/db/migrations/004_oracle_gossip_replay.sql` before enabling gossip. The
adapter limits envelope size, accepted time skew, pending-round count, peer
count, and value range. Conflicting votes return no consensus. The service
returns a consensus candidate but does not publish it: callers must pass only
that candidate through the recovery gate and then the authenticated oracle
publisher.

## Claim activity anomaly detector

`ClaimActivityAnomalyDetector` evaluates a bounded sliding window separately
from individual oracle readings. Configure per-coverage settlement-volume and
trigger-frequency ceilings, a policy payout-share ceiling, and the minimum
window volume at which concentration is meaningful. It invokes the supplied
payout breaker once per anomaly type and coverage per window; wire claim
ingestion/settlement observations into `record` and call `evaluate` from the
trusted backend path. Thresholds are deployment-specific and should be
calibrated against reviewed settlement history before enabling automatic
trips.

## Soroban contract requirement

This repository contains TypeScript client code and contract-interface
fixtures, but no Soroban Rust contract source. The available oracle interface
only specifies `update_reading`; it has no pause/kill-switch entrypoint, and
the pool interface has no settlement pause check. Therefore this backend
cannot truthfully publish or enforce a kill switch on-chain by itself. Before
production use, the external `refract-contracts` repository must add an
authorized pause/resume entrypoint and make oracle reading updates and pool
claim settlement reject paused feeds/coverage. A deployed contract exposing
that interface and an authenticated backend adapter are required; local
pause state must not be represented as on-chain confirmation.

## Integration status for this checkout

The safety classes above are explicit fail-closed components, not a claim
that the production loops are already wired to them. In this checkout,
`package.json` is empty and the existing oracle service, publisher, module,
controller, and claim-settlement service source files are empty. Until those
application paths are restored and composed with these components, do not
enable automated publication or payouts based on them. This also prevents a
meaningful repository build/test run; the intended Jest specs are included
for when the source/test harness is restored.

## Pause controls

Operators can pause and resume individual oracle feeds through the admin API.
The pause state is backed by two tables created by
`src/db/migrations/004_oracle_pause_controls.sql`:

- **`oracle_pause_state`** — one row per scope. The scope is either `'global'`
  (applies across every coverage type) or a specific coverage-type key. A
  missing row means the feed is not paused.
- **`oracle_pause_audit`** — append-only log of every pause and resume action,
  including the actor, reason, and the state that was replaced. Rows can never
  be updated or deleted (enforced by a trigger).

### Routes

Both routes require a bearer token with the `feeds:pause` permission
(`Authorization: Bearer <keyId>.<secret>`).

| Method | Path | Body | Response |
|--------|------|------|----------|
| `POST` | `/api/v1/oracle/admin/feeds/:feedId/pause` | `{ "reason": "<3–500 chars>" }` | `200 OK` |
| `POST` | `/api/v1/oracle/admin/feeds/:feedId/resume` | `{ "reason": "<3–500 chars, optional>" }` | `200 OK` |

### Role access

| Role | `feeds:pause` permission |
|------|--------------------------|
| `oracle:viewer` | No |
| `oracle:operator` | Yes |
| `oracle:admin` | Yes |

### Behaviour while paused

`OracleControlRegistry.isPaused(feedId)` returns `true` for a paused feed.
Pollers and publishers that consult this method block local publication for
that feed until a resume is confirmed. The pause takes effect immediately in
the local process; see the Soroban contract requirement section above for the
limitation that this backend cannot enforce a pause on-chain without a
corresponding contract entrypoint.
