# Oracle source independence

Corroboration is only meaningful when sources have distinct upstream data.
Each provider is an `OracleSourceAdapter` (`src/oracle/adapters/source-adapter.ts`)
registered via `OracleSourceRegistry.register()` (`src/oracle/adapters/source-registry.ts`).
`corroborate()` classifies a feed as `corroborated`, `single_source`, `divergent`
or `unavailable`. Feed-to-source mapping lives in `COVERAGE_FEED_SOURCES`
(`src/common/coverage-catalog.ts`).

## Registered adapters

| Adapter class | File | `id` | Metrics provided | Auth |
|---|---|---|---|---|
| `CoinGeckoAdapter` | `src/oracle/adapters/coingecko.adapter.ts` | `coingecko` | `usdc.usd.price`, `xlm.usd.change_24h_pct` | none |
| `DefiLlamaAdapter` | `src/oracle/adapters/defillama.adapter.ts` | `defillama` | `protocol.tvl.change_24h_pct` | none |
| `HorizonAdapter` | `src/oracle/adapters/horizon.adapter.ts` | `horizon` | `stellar.ledger.latest` | none |

Horizon supplies on-chain context for `MarketCrash` readings (latest closed
ledger sequence) rather than a price signal. It is deliberately not counted as
a second price source.

## Canonical values

Every adapter returns values in the unit specified by `METRIC_SPECS`
(`src/oracle/adapters/metric-specs.ts`): USD for prices, percent for 24h
changes, and ledger sequence number for chain context. Adapters translate the
provider-neutral subject (CoinGecko coin id / DeFiLlama protocol slug) to their
own symbols and reject non-finite or non-positive values.

## Known benign divergence

- **Price** (`usdc.usd.price`): CoinGecko is a volume-weighted aggregate across
  many exchanges. Set the corroboration tolerance to cover normal bid/ask spread.
- **TVL** (`protocol.tvl.change_24h_pct`): DeFiLlama community adapters read
  on-chain balances and may lag by hours. Use a wide tolerance and do not treat
  a stable offset as an anomaly.
- Observations older than `maxAgeMs` (from `METRIC_SPECS`) are dropped, so
  reporting lag from a slower provider degrades to `single_source` rather than
  producing a false divergence.

## Metric bounds and freshness

Bounds and maximum allowed age for each metric are defined in `METRIC_SPECS`:

| Metric | Unit | Decimals | Min | Max | Max age |
|---|---|---|---|---|---|
| `usdc.usd.price` | usd | 6 | 0 | 2 | 10 min |
| `xlm.usd.change_24h_pct` | percent | 4 | -100 | 1 000 | 10 min |
| `protocol.tvl.change_24h_pct` | percent | 4 | -100 | 1 000 | 6 h |
| `stellar.ledger.latest` | ledger | 0 | 1 | MAX_SAFE_INTEGER | 2 min |

## Configuration

All endpoints are environment variables (see `.env.example`). No adapter
currently requires an API key.
