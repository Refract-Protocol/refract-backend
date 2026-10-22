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
