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

Start the backend and its PostgreSQL and Redis dependencies with Docker
Compose; Docker Compose initializes the database schema on first startup:

```bash
docker compose up --build
```

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

## API surface

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness probe |
| `GET` | `/api/v1/quotes/coverage-types` | List coverage types & rates |
| `POST` | `/api/v1/quotes/quote` | Quote a premium |
| `GET` | `/api/v1/policies/holder/:address` | Policies for a holder |
| `POST` | `/api/v1/policies/buy` | Build a buy-policy transaction |
| `GET` | `/api/v1/pool/stats` | Pool capital / utilization / APY |
| `POST` | `/api/v1/pool/provide` · `/withdraw` | LP capital flows |
| `WS` | `/` | Live oracle alert stream |

> ⚠️ **Oracle data sources**: `StablecoinDepeg`, `MarketCrash`, and
> `SmartContractRisk` now call real, keyless public APIs — CoinGecko
> (USDC/XLM price), Stellar Horizon testnet (chain context), and DeFiLlama
> (protocol TVL). No API key is required for any of them. `LiquidationShield`
> and `FlightDelay` stay mocked: there's no public API for NEXUS Protocol
> liquidation events, and AviationStack (flight data) requires a paid key
> this project doesn't have. See `src/oracle/oracle.service.ts` for details.
> Claim settlement now builds, signs, and submits a real
> `pool.process_claim()` Soroban transaction via `ClaimSettlementService`
> (falls back to a safe no-op when `REFRACT_POOL_CONTRACT_ID` /
> `ORACLE_RELAYER_SECRET` aren't set). **The contract's exact function
> signature is an unverified best-effort guess** — this repo doesn't
> include the `refract-contracts` source, so it needs confirmation
> against the real deployed contract; see
> `src/claim/claim-settlement.service.ts` for details. A policy only
> deactivates once settlement actually confirms on-chain — a failed or
> unconfirmed payout leaves it active for the next scheduled retry.
> This README predates the NestJS migration in some other places (route
> layout, stack description) — a fuller pass is pending; see
> [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
