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
├── index.ts                 # Express + WebSocket server, service loop
├── services/
│   ├── oracleMonitor.ts     # polls data sources (depeg, crash, TVL, flight)
│   └── claimProcessor.ts    # scans policies, settles triggered claims
├── routes/
│   ├── quotes.ts            # POST /quote, GET /coverage-types
│   ├── policies.ts          # policy CRUD + buy-tx builder
│   └── pool.ts              # pool stats, provide/withdraw
└── db/schema.sql            # PostgreSQL schema
```

## Quick start

```bash
cp .env.example .env         # then fill in DATABASE_URL, contract IDs, etc.
npm install
psql "$DATABASE_URL" -f src/db/schema.sql   # one-time schema apply
npm run dev                  # http://localhost:4001
```

`STELLAR_NETWORK` selects `testnet`, `futurenet`, or `mainnet`; the matching
Soroban RPC URL, Horizon URL, and network passphrase are selected together.
Set the network-suffixed contract IDs for the selected network (for example,
`REFRACT_POOL_CONTRACT_ID_TESTNET`) rather than overriding endpoint or
passphrase values independently. The backend checks the RPC passphrase and,
when a pool contract ID is configured, validates the live pool WASM contract
spec at startup. Startup fails with the specific interface mismatch if the
deployed contract differs from the backend's assumed interface.

For an existing database, apply
`src/db/migrations/001_soroban_pool_events.sql` to add idempotent storage and
checkpoints for Soroban pool events. Once `REFRACT_POOL_CONTRACT_ID` is set,
the backend polls the configured Soroban RPC endpoint every 10 seconds and
stores policy purchases, capital deposits/withdrawals, and settled claims in
`soroban_pool_events`. Set `SOROBAN_EVENT_START_LEDGER` to an RPC-retained
ledger for the first run; subsequent progress is checkpointed in Postgres.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Hot-reloading dev server (ts-node + nodemon) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint over `src/` |

## API surface

Interactive OpenAPI documentation and the generated JSON document are served
at [`/api/docs`](http://localhost:4001/api/docs) and `/api/docs-json`.
Schemas are generated from the Nest controllers and request DTOs.

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness probe |
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

Endpoints with the `@AdminOnly()` guard require `X-API-Key: $ADMIN_API_KEY`.
Set a strong, private `ADMIN_API_KEY` before enabling admin-only routes; if
it is unset, those routes fail closed with `503`. The current API has no
admin CRUD, dead-letter review, or contract-override routes. API request
limits are applied per client IP and endpoint: 30/minute for quotes,
10/minute for policy buys, LP actions, oracle status, and on-chain coverage
reads, and 60/minute for coverage catalogs.

> ⚠️ **Oracle data sources**: `StablecoinDepeg`, `MarketCrash`, and
> `SmartContractRisk` now call real, keyless public APIs — CoinGecko
> (USDC/XLM price), Stellar Horizon testnet (chain context), and DeFiLlama
> (protocol TVL). No API key is required for any of them. `LiquidationShield`
> and `FlightDelay` stay mocked: there's no public API for NEXUS Protocol
> liquidation events, and AviationStack (flight data) requires a paid key
> this project doesn't have. See `src/oracle/oracle.service.ts` for details.
> **Claim settlement** invokes `pool.process_claim(policy_id: u64)` via
> `ClaimSettlementService` — a single u64 on-chain policy id (holder/payout
> are looked up on-chain). Policies start `pending` after `POST /buy`; once
> the holder submits the signed XDR through `POST /api/v1/tx/submit`, the
> buy_policy return value is stored as `onChainPolicyId` and the policy
> becomes `active` (only active policies are claim-scanned). Settlement
> refuses a null on-chain id without entering the retry loop. A policy only
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
> **Confirmation polling** uses configurable exponential backoff + jitter
> (`CONFIRMATION_*` env vars) with distinct HTTP vs settlement deadlines.
>
> Before building a caller-signed policy purchase or pool-capital XDR, the
> backend checks via Horizon that the caller's account exists and has a
> positive native XLM balance, and returns a funding instruction if not.
> This README predates the NestJS migration in some other places (route
> layout, stack description) — a fuller pass is pending; see
> [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
