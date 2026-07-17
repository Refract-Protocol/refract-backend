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
> Claim settlement (the actual Soroban payout transaction) is still a
> logged stub — real transaction building is tracked as follow-up work.
> This README predates the NestJS migration in some other places (route
> layout, stack description) — a fuller pass is pending; see
> [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
