# Refract Backend

> Off-chain services for [Refract](https://github.com/refract-protocol) — oracle monitoring, automatic claim processing, and premium quoting.

This service watches real-world data feeds, pushes readings to the on-chain
`RefractOracle`, scans active policies for triggered conditions, and exposes a
REST + WebSocket API the web app consumes. See also `refract-contracts` and
`refract-frontend`.

## Stack

- **Express** REST API + **ws** WebSocket feed
- **PostgreSQL** for policy / claim / pool snapshots (`src/db/schema.sql`)
- **Redis** (ioredis) for caching & pub-sub
- **@stellar/stellar-sdk** for Soroban interaction
- **Zod** for request validation, **Winston** for logging

## Layout

```
src/
├── oracle/                  # OracleScheduler, OracleService (data sources), publisher, oracle_events repository
├── claim/                   # ClaimScheduler, ClaimService (scan + evaluate), ClaimSettlementService, ops controller
├── policy/                  # policy purchase and lifecycle
├── pool/                    # pool stats, LP provide/withdraw
├── quote/                   # premium quoting and coverage types
├── tx/                      # signed-XDR submission
├── stellar/                 # Soroban RPC, contract interface, event indexer
└── db/schema.sql            # PostgreSQL schema
```

Some files under `src/` are empty or missing in parts of the tree; see the
snapshot caveat in
[`docs/oracle-trust-architecture.md`](./docs/oracle-trust-architecture.md).

## Quick start

Start the backend and its PostgreSQL and Redis dependencies with Docker
Compose; Docker Compose initializes the database schema on first startup:

```bash
docker compose up --build
```

`STELLAR_NETWORK` selects `testnet`, `futurenet`, or `mainnet`; the matching
Soroban RPC URL, Horizon URL, and network passphrase are selected together.
Set the network-suffixed contract IDs for the selected network (for example,
`REFRACT_POOL_CONTRACT_ID_TESTNET`) rather than overriding endpoint or
passphrase values independently. The backend checks the RPC passphrase and,
when a pool contract ID is configured, validates the live pool WASM contract
spec at startup. Startup fails with the specific interface mismatch if the
deployed contract differs from the backend's assumed interface.

### Soroban RPC endpoint pool

Set `SOROBAN_RPC_URLS` (comma-separated, in preference order) alongside
`SOROBAN_RPC_URL` to run against several RPC providers. All reads, event
polling, and oracle publish submissions share one health-checked pool
(`SorobanRpcPoolService`):

- A background `getHealth` probe runs every `SOROBAN_RPC_HEALTH_INTERVAL_MS`.
  An endpoint that reports a non-healthy status or fails the probe is marked
  `unhealthy`. One that trails the most advanced endpoint by more than
  `SOROBAN_RPC_MAX_LEDGER_LAG` ledgers is marked `lagging`.
- `SOROBAN_RPC_FAILURE_THRESHOLD` consecutive transient call failures also mark
  an endpoint `unhealthy`. It is skipped for `SOROBAN_RPC_COOLDOWN_MS`, then
  retried.
- Calls go to healthy endpoints first, then unknown, then lagging. Unhealthy
  endpoints are tried last rather than dropped, so a fully degraded pool still
  makes progress instead of stalling.
- Event polling stays on the endpoint that served the previous page while it is
  healthy, because paging cursors are only valid on the node that issued them.
- Re-sending a signed oracle publish to another endpoint after a transport
  error is safe: the hash and sequence number are the same, so it applies at
  most once.

### Network configuration validation

Before any module starts, the backend checks that the environment targets
exactly one network and lists every problem at once:

- `STELLAR_NETWORK` must be `testnet`, `futurenet` or `mainnet` (`public` is
  an alias for `mainnet`).
- No `*_TESTNET` / `*_FUTURENET` / `*_MAINNET` value may be set for any
  network other than the selected one. This covers `SOROBAN_RPC_URL`,
  `STELLAR_HORIZON_URL`, `STELLAR_NETWORK_PASSPHRASE`, and
  `REFRACT_{POOL,ORACLE,POLICY}_CONTRACT_ID`. A suffixed and an unsuffixed
  value for the same setting must match.
- The passphrase must match the network. RPC and Horizon URLs must not point
  at another network, and mainnet requires https.
- Contract IDs must be valid and must not repeat across roles.
- With `STELLAR_VALIDATE_ONCHAIN=true`, RPC `getNetwork` and Horizon `/` must
  report the expected passphrase.

Missing payout pieces (oracle ID, pool ID, relayer key) only produce a
warning, so read-only setups still boot. Run the same check before deploying:

```bash
npx ts-node scripts/check-network-config.ts --live
```

Example failure:

```
Stellar network configuration is inconsistent:
  - REFRACT_ORACLE_CONTRACT_ID_MAINNET is set for mainnet but STELLAR_NETWORK=testnet; remove it so only one network is configured
  - STELLAR_NETWORK_PASSPHRASE is the mainnet passphrase but STELLAR_NETWORK=testnet (expected "Test SDF Network ; September 2015")
```



For an existing database, apply
`src/db/migrations/001_soroban_pool_events.sql` to add idempotent storage and
checkpoints for Soroban pool events. Once `REFRACT_POOL_CONTRACT_ID` is set,
the backend polls the configured Soroban RPC endpoint every 10 seconds and
stores policy purchases, capital deposits/withdrawals, and settled claims in
`soroban_pool_events`. Set `SOROBAN_EVENT_START_LEDGER` to an RPC-retained
ledger for the first run; subsequent progress is checkpointed in Postgres.

For an e

For an existing database, apply
`src/db/migrations/001_soroban_pool_events.sql` to add idempotent storage and
checkpoints for Soroban pool events. Once `REFRACT_POOL_CONTRACT_ID` is set,
the backend polls the configured Soroban RPC endpoint every 10 seconds and
stores policy purchases, capital deposits/withdrawals, and settled claims in
`soroban_pool_events`. Set `SOROBAN_EVENT_START_LEDGER` to an RPC-retained
ledger for the first run; subsequent progress is checkpointed in Postgres.

For an existing database, apply
`src/db/migrations/001_soroban_pool_events.sql` to add idempotent storage and
checkpoints for Soroban pool events. Once `REFRACT_POOL_CONTRACT_ID` is set,
the backend polls the configured Soroban RPC endpoint every 10 seconds and
stores policy purchases, capital deposits/withdrawals, and settled claims in
`soroban_pool_events`. Set `SOROBAN_EVENT_START_LEDGER` to an RPC-retained
ledger for the first run; subsequent progress is checkpointed in Postgres.

For an existing database, apply
`src/db/migrations/002_oracle_trust_engine.sql` to add the oracle trust engine
tables: `oracle_sources`, append-only `oracle_readings`, `oracle_decisions` with
`oracle_decision_readings` linking each decision to the readings it used, and
`oracle_source_health`. The migration is idempotent and transactional, so it is
safe to re-run. Fresh installs get the same tables from `src/db/schema.sql`,
which Compose mounts on first startup.

Horizon-derived oracle readings carry their source ledger sequence and hash and
start `provisional`. They become `final` (and eligible for quorum) once the
ledger is `HORIZON_FINALITY_DEPTH` ledgers behind the latest observed one
(default 5; `HORIZON_FINALITY_POLICY=final_only` by default, or
`allow_provisional`). A ledger whose hash changes is treated as a reorg:
affected readings are marked `invalidated`, decisions built on them are marked
`superseded`, the resume checkpoint rewinds, and every correction is appended
to `oracle_evidence_ledger`. Apply `src/db/migrations/004_horizon_ledger_finality.sql`.

The API listens on http://localhost:4001. PostgreSQL and Redis are also
available on localhost ports 5432 and 6379. Compose uses the development-only
Postgres password `refract_dev` unless `POSTGRES_PASSWORD` is set in the
environment or `.env`; configure secrets and production service settings
separately before deployment. Contract IDs and the relayer key can be added to
`.env` when exercising configured on-chain operations.

To run the API directly on the host, start PostgreSQL and Redis yourself,
copy `.env.example` to `.env`, install Node.js 22 dependencies, apply
`src/db/schema.sql` once, and run `npm run dev`.

Stop the stack with `docker compose down`. Persistent database and Redis data
remain in Docker volumes; `docker compose down -v` removes them.
## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Hot-reloading dev server (ts-node + nodemon) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint over `src/` |

## Operator CLI

`scripts/operator-cli.ts` inspects feeds and applies audited overrides without
hand-written SQL. It needs only `DATABASE_URL` (apply
`migrations/002_operator_controls.sql` first). Read-only commands work while the
service is down.

```bash
npx ts-node scripts/operator-cli.ts feeds
npx ts-node scripts/operator-cli.ts readings market_crash --limit 30
npx ts-node scripts/operator-cli.ts decisions
npx ts-node scripts/operator-cli.ts pause market_crash --reason "CoinGecko spike" --operator alice --dry-run
npx ts-node scripts/operator-cli.ts pause market_crash --reason "CoinGecko spike" --operator alice --yes
npx ts-node scripts/operator-cli.ts quarantine CoinGecko --reason "bad prices" --operator alice --yes
npx ts-node scripts/operator-cli.ts audit
```

Mutating commands require `--reason` and an operator identity (`--operator` or
`OPERATOR_ID`). `pause` and `quarantine` also require `--yes` (or `--dry-run`).
Each mutation writes its state change and a row in `operator_audit_log` in one
transaction, then prints the before/after state. Any failure exits non-zero.

## API surface

Interactive OpenAPI documentation and the generated JSON document are served
at [`/api/docs`](http://localhost:4001/api/docs) and `/api/docs-json`.
Schemas are generated from the Nest controllers and request DTOs.

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness probe |
| `GET` | `/metrics` | Prometheus-format HTTP, scheduler, oracle, and Soroban RPC metrics |
| `GET` | `/api/v1/quotes/coverage-types` | List coverage types & rates |
| `POST` | `/api/v1/quotes/quote` | Quote a premium |
| `GET` | `/api/v1/policies/holder/:address` | Policies for a holder |
| `POST` | `/api/v1/policies/buy` | Build a buy-policy transaction |
| `GET` | `/api/v1/pool/stats` | Pool capital / utilization / APY |
| `GET` | `/api/v1/pool/positions` | Paginated LP positions sorted by committed capital |
| `POST` | `/api/v1/pool/provide` · `/withdraw` | LP capital flows |
| `GET` | `/api/v1/claims/dead-letter` | Triggered claims withheld after repeated failed settlement |
| `POST` | `/api/v1/tx/submit` | Submit signed XDR; confirmed policy buys return their on-chain ID |
| `WS` | `/` | Live oracle alert stream |
| `GET` | `/api/v1/admin/feeds` | Admin: latest version of every oracle feed definition |
| `GET` | `/api/v1/admin/feeds/:feedKey` | Admin: latest version of one feed |
| `GET` | `/api/v1/admin/feeds/:feedKey/versions` | Admin: full version history with previous definitions |
| `POST` | `/api/v1/admin/feeds` | Admin: create a feed (version 1) |
| `PATCH` | `/api/v1/admin/feeds/:feedKey` | Admin: update a feed; requires `expectedVersion` |

State-changing API attempts emit structured `security_audit` JSON lines to
stdout; route those events to the deployment's log aggregation or SIEM system.
See [`SECURITY.md`](./SECURITY.md) for the event fields and identity limitations.

Endpoints with the `@AdminOnly()` guard require `X-API-Key: $ADMIN_API_KEY`.
Set a strong, private `ADMIN_API_KEY` before enabling admin-only routes; if
it is unset, those routes fail closed with `503`. The admin feed routes also
require an `x-admin-actor` header on mutations; it is recorded in the audit
trail but is self-reported, because the shared admin key identifies no one.
Feed definitions are append-only versions in `oracle_feed_definitions`
(migration `004_oracle_feed_definitions.sql`). A PATCH must carry the version
it was based on (`expectedVersion`), or it is rejected with `409`. An enabled
feed whose non-quarantined source weight cannot reach `quorumThreshold` is
rejected with `400`. The monitor reads the latest definitions from an
in-process cache that reloads every `FEED_DEFINITIONS_RELOAD_MS` (default
`15000`), so a change takes effect within one interval on every instance. The
API has no dead-letter review or contract-override routes. API request
limits are applied per client IP and endpoint: 30/minute for quotes,
10/minute for policy buys, LP actions, oracle status, and on-chain coverage
reads, and 60/minute for coverage catalogs.

> ⚠️ **Oracle data sources**: `StablecoinDepeg`, `MarketCrash`, and
> `SmartContractRisk` now call real, keyless public APIs — CoinGecko
> (USDC/XLM price), Stellar Horizon testnet (chain context), and DeFiLlama
> (protocol TVL). No API key is required for any of them. `FlightDelay` has a live provider adapter in `src/oracle/sources/flightDelay.ts` (AviationStack free tier, selected with `FLIGHT_DELAY_PROVIDER=aviationstack` and `AVIATIONSTACK_API_KEY`), but the oracle refresh does not call it yet in this checkout, so no FlightDelay readings are produced until it is wired in. `LiquidationShield` has a confirmation-depth adapter (`src/oracle/sources/liquidationShield.ts`) for NEXUS Protocol on-chain liquidation events, but no live NEXUS feed is wired yet, so it produces no reading. See `src/oracle/oracle.service.ts` for details.
> **Claim settlement** invokes `pool.process_claim(policy_id: u64)` via
> `ClaimSettlementService` — a single u64 on-chain policy id (holder/payout
> are looked up on-chain). Policies start `pending` after `POST /buy`; once
> the holder submits the signed XDR through `POST /api/v1/tx/submit`, the
> buy_policy return value is stored as `onChainPolicyId` and the policy
> becomes `active` (only active policies are claim-scanned). Settlement
> refuses a null on-chain id without entering the retry loop. The signing key
> is fetched at runtime from AWS Secrets Manager using the workload's AWS
> credentials; configure `ORACLE_RELAYER_SECRET_ID` and grant the runtime IAM
> role `secretsmanager:GetSecretValue` on that secret. **The contract's exact
> function signature is an unverified best-effort guess** — this repo doesn't
> include the `refract-contracts` source, so it needs confirmation against the
> real deployed contract; see `src/claim/claim-settlement.service.ts` for
> details. A policy only
> deactivates once settlement actually confirms on-chain — a failed or
> unconfirmed payout leaves it active for the next scheduled retry.
>
> Claim settlement retries failed submissions for up to three scheduled
> scans, then exposes the claim and last error through
> `/api/v1/claims/dead-letter` and stops retrying it automatically. This
> dead-letter list is currently in memory and is cleared on process restart.
> The known `process_claim` argument mismatch is checked against the deployed
> contract spec at startup; this check intentionally prevents startup until
> the backend call matches the deployed interface. See
> `src/claim/claim-settlement.service.ts` and
> `src/stellar/pool-contract-interface.service.ts`.
>
> Relayer account sequences are serialized across replicas using PostgreSQL
> advisory locks; during key rotation, roll out the new key while old
> replicas drain.
>
> Every transaction signed by the relayer is also recorded in the dedicated
> PostgreSQL `relayer_transaction_audit` table with its lifecycle status,
> transaction hash, signing key's public address, and policy ID. Apply the
> current `src/db/schema.sql` before enabling relayer settlement.
>
> **Oracle publisher** (`OraclePublisherService`) pushes readings to
> `REFRACT_ORACLE_CONTRACT_ID` via `update_reading(u32, i128)` when the
> relayer secret is set. Degraded fail-safe readings are never published.
> Publish cadence is controlled by `ORACLE_PUBLISH_MODE` /
> `ORACLE_PUBLISH_MIN_INTERVAL_MS` (see `.env.example`).
>
> **Oracle trust modes** are set per coverage type with
> `ORACLE_TRUST_MODE_<COVERAGE>` (`single_source` by default, `corroborated`,
> or `decentralized`), with sources in `ORACLE_SOURCES_<COVERAGE>` and the
> quorum in `ORACLE_QUORUM_MIN`. `src/oracle/oracle-trust-policy.ts` validates
> them at startup (`src/main.ts`) and refuses to boot on unknown coverage
> types, unknown modes, or a non-default mode whose sources cannot meet the
> quorum. `ClaimService` refuses to pay out when a coverage's mode is not
> satisfied. Only one reader exists per coverage today, so `corroborated` and
> `decentralized` fail closed and never pay out until multi-source readers
> land.
>
> Staged rollout: keep every coverage on `single_source` until its sources
> are live, move one coverage at a time to `corroborated`, watch refusal logs
> (`Refusing payout ... quorum ... not met`), and only then consider
> `decentralized`. Roll back by unsetting the variable and redeploying.
>
> **Batched publishing** (`OracleBatchPublisherService`) is persist-then-publish:
> producers `enqueue` decisions into the durable `oracle_publish_queue` table
> (apply `src/db/migrations/004_oracle_publish_queue.sql`); a single-flight loop
> submits ordered batches (`ORACLE_PUBLISH_MAX_BATCH_SIZE`,
> `ORACLE_PUBLISH_MAX_IN_FLIGHT`, `ORACLE_PUBLISH_MAX_PER_FEED_PER_BATCH`). A feed
> never has two batches in flight, so decisions land in order. Failures retry with
> jittered backoff (`ORACLE_PUBLISH_BASE_BACKOFF_MS` / `_MAX_BACKOFF_MS`), size/fee
> errors split the batch, and ambiguous timeouts are reconciled by tx hash before
> any resubmission. When queue depth (`ORACLE_PUBLISH_BACKPRESSURE_QUEUE_DEPTH`)
> or RPC latency (`ORACLE_PUBLISH_BACKPRESSURE_RPC_LATENCY_MS`) is exceeded,
> `pollIntervalMultiplier("low")` slows low-priority polling (payout-triggering
> feeds are never slowed) and `refract_oracle_publish_*` gauges on `/metrics`
> show queue depth, backpressure, and RPC latency.
>
> **Confirmation polling** uses configurable exponential backoff + jitter
> (`CONFIRMATION_*` env vars) with distinct HTTP vs settlement deadlines.
>
> Before building a caller-signed policy purchase or pool-capital XDR, the
> backend checks via Horizon that the caller's account exists and has a
> positive native XLM balance, and returns a funding instruction if not.
> This README predates the NestJS migration in some other places (route
> layout, stack description) — a fuller pass is pending; see
> [`CONTRIBUTING.md`](./CONTRIBUTING.md).

### Oracle feed config validation

Oracle feeds, their sources, and their quorum policy are defined in JSON
(`ORACLE_FEEDS_FILE` or `ORACLE_FEEDS_JSON`; see
[`docs/oracle-feeds.example.json`](./docs/oracle-feeds.example.json)). The
config is validated in `main.ts` before the Nest app is created, so a bad
config stops the process before anything polls, publishes, or settles. The
same rules run as a standalone lint for CI:

```bash
npx ts-node scripts/oracle-config-lint.ts --file oracle-feeds.json --network mainnet [--strict] [--json]
# compiled image: node dist/oracle/config/oracle-config-lint.cli.js --help
# exit codes: 0 valid, 1 invalid, 2 usage error or malformed file
```

Errors (startup refuses to continue):

| Code | Meaning |
|---|---|
| `QUORUM_EXCEEDS_INDEPENDENT_SOURCES` | `quorum.minSources` is greater than the number of enabled sources with distinct `operator`s, so quorum can never be reached |
| `FRESHNESS_SHORTER_THAN_POLL` | `freshnessWindowMs` < `pollIntervalMs`, so every reading is stale before the next poll |
| `MISSING_TRUST_MODE` / `UNKNOWN_TRUST_MODE` | No valid `trustMode` on the feed or in `defaults` |
| `QUORUM_MODE_WITHOUT_QUORUM` | `median_quorum` / `weighted_quorum` with `minSources` < 2 |
| `TRUST_MODE_QUORUM_CONFLICT` | `single_source` with `minSources` > 1 |
| `SINGLE_SOURCE_ON_MAINNET` / `MOCK_SOURCE_ON_MAINNET` | A claim-settling feed on mainnet that trusts one source or uses synthetic data |
| `MISSING_SOURCE_WEIGHT` / `OPERATOR_CONTROLS_QUORUM` | `weighted_quorum` without positive weights, or one operator holding more than half the weight |
| `NO_FEEDS`, `NO_ENABLED_SOURCES`, `DUPLICATE_FEED_ID`, `DUPLICATE_SOURCE_ID`, `UNKNOWN_ADAPTER`, `UNKNOWN_COVERAGE_TYPE`, `POLL_INTERVAL_TOO_SHORT`, `DEVIATION_OUT_OF_RANGE` | Structural mistakes |

Warnings (logged, or fatal with `ORACLE_CONFIG_STRICT=true` / `--strict`):
`SINGLE_SOURCE`, `SHARED_OPERATOR`, `NO_QUORUM_HEADROOM`, `MINORITY_QUORUM`,
`FRESHNESS_WINDOW_TIGHT`, `PUBLISH_INTERVAL_EXCEEDS_FRESHNESS`,
`UNUSED_SOURCES`. Unknown keys in the file are rejected, so a typo such as
`freshnesWindowMs` fails instead of silently falling back to a default.

### Bootstrapping new oracle sources

A newly onboarded feed or source adapter has no history, so deviation checks
would either fire on every reading or need to be turned off. Bootstrapping
backfills recent history from the adapter and seeds:

- **Seed readings** (`oracle_seed_readings`). These are kept apart from
  `oracle_events` and never feed claim settlement.
- **A statistical baseline**: median, MAD, mean, stddev, and percentiles.
  `SourceBootstrapService.assess()` scores live readings against it with a
  robust z-score. It returns `ready: false` until the source is `warm`, so
  callers skip the check instead of firing on an empty reference.
- **An initial reputation** from history coverage and agreement with the
  feed's other sources. It is capped at 0.8, so new sources still have to
  earn full trust live.

Apply `src/db/migrations/004_oracle_source_bootstrap.sql`, then run:

```bash
npx ts-node scripts/oracle-bootstrap.ts --feed stablecoin-depeg \
  --source cg-usdc:coingecko:coinId=usd-coin \
  --source cg-usdt:coingecko:coinId=tether
# compiled image: node dist/oracle/bootstrap/bootstrap.cli.js --help
```

History providers exist for `coingecko` (`coinId`) and `defillama`
(`protocolSlug` for TVL, or `coinId` for prices). Runs are idempotent. Warm sources are skipped unless
`--force` is passed, and a forced re-run that fails keeps the previous
baseline.

## Offline oracle parameter simulation

Operators can replay stored `oracle_events` without contacting providers or
publishing transactions. The simulator compares recorded trigger decisions
with a candidate quorum, freshness window, thresholds, and anomaly tolerance.
It also estimates payout changes using the historical average settled payout
per coverage type; estimates are indicative, not settlement predictions.

Create a candidate JSON file, for example:

```json
{
  "schemaVersion": 1,
  "quorum": 2,
  "freshnessSeconds": 300,
  "anomalyDeviationPct": 10,
  "thresholds": {
    "StablecoinDepeg": 0.95,
    "MarketCrash": -30,
    "FlightDelay": 120
  }
}
```

Set `DATABASE_URL` to the database containing the historical readings and run:

```sh
npm run simulate:oracle -- candidate.json 2026-01-01T00:00:00Z 2026-02-01T00:00:00Z
```

Simulation windows are limited to 366 days and 50,000 readings per run. The
command is read-only and does not contact providers or alter policies, claims,
or on-chain state.

## Documentation

- [Oracle trust architecture](./docs/oracle-trust-architecture.md) — the path from source polling to on-chain publication, source inventory, corroboration status, evidence ledger, and operator authority.
- [Oracle incident runbooks](./docs/runbooks/oracle-incidents.md) — stale feeds, divergence, fail-safes, suspect sources, and restoring operation after a pause.
- [Threat model](./docs/threat-model.md) — transaction lifecycle STRIDE assessment and prioritized follow-ups.
- [Security policy](./SECURITY.md) — vulnerability reporting and HTTP security configuration.

## License

[MIT](./LICENSE)
