# Oracle source independence

Corroboration is only meaningful when sources have distinct upstream data.

The source of truth is the registry built by `createSourceRegistry()` in
`src/oracle/sources/source-registry.ts`. Each provider is a `SourceAdapter`
(`src/oracle/sources/`) registered there. `corroborate()` classifies a feed as
`corroborated`, `single_source`, `divergent` or `unavailable`. The coverage-to-source
mapping is the `ORACLE_SOURCES` env var, parsed by `SourceRegistry.fromConfig`.

Adding a source means implementing a `SourceAdapter` and registering it in
`createSourceRegistry`. Do not treat the table below as the authority: update it
in the same change as the registration.

The registry registers these adapters (source ids as used in `ORACLE_SOURCES`):

| Feed | Source id | Provider | Upstream origin | Cadence | Auth | Registered when |
|------|-----------|----------|-----------------|---------|------|-----------------|
| price | `coingecko` | CoinGecko | Volume-weighted aggregate across many exchanges | ~1–5 min cache | none | always |
| price | `kraken` | Kraken | Single-venue spot order book, last trade | real time | none | unless `KRAKEN_ENABLED=false` |
| tvl | `defillama` | DeFiLlama | Community adapters reading on-chain balances | ~hourly | none | always |
| tvl | `tokenterminal` | Token Terminal | Own indexing pipeline and TVL definition | daily, intraday on paid tiers | API key | only when `TOKENTERMINAL_API_KEY` is set |

Horizon is deliberately not counted as a second price source: its view is
derived from the same on-chain market the others describe.

Note: `src/oracle/adapters/` is a separate, metric-keyed pipeline
(`OracleSourceRegistry`, with `coingecko`, `defillama` and `horizon` adapters).
It is not constructed by the production startup path, and `horizon` appears only
there. Feed config validation (`KNOWN_ADAPTERS` in
`src/oracle/config/oracle-feed-config.ts`) accepts that adapter set, so the two
lists do not match yet.

## Metrics

Metric ids and their rules are defined in `src/oracle/adapters/metric-specs.ts`.
Values are rounded to `decimals` and rejected when outside `[min, max]` or older
than `maxAgeMs`.

| Metric id | Unit | Decimals | Min | Max | Max age | Provided by (`src/oracle/adapters/`) |
|-----------|------|----------|-----|-----|---------|--------------------------------------|
| `usdc.usd.price` | usd | 6 | 0 | 2 | 10 min | `coingecko` |
| `xlm.usd.change_24h_pct` | percent | 4 | -100 | 1000 | 10 min | `coingecko` |
| `protocol.tvl.change_24h_pct` | percent | 4 | -100 | 1000 | 6 h | `defillama` |
| `stellar.ledger.latest` | ledger | 0 | 1 | `Number.MAX_SAFE_INTEGER` | 2 min | `horizon` |

The price and TVL feeds in `createSourceRegistry` are keyed by feed kind
(`price`, `tvl`), not by these metric ids.

Example config: [`docs/oracle-feeds.example.json`](./oracle-feeds.example.json).

## Canonical values

Every adapter returns USD (price per unit, or total TVL) plus the provider's
own observation time. Adapters translate the provider-neutral subject (CoinGecko
coin id / DeFiLlama protocol slug) to their own symbols and reject non-finite
or non-positive values.

## Known benign divergence

- Price: Kraken is one venue; CoinGecko is an aggregate. A few bps of gap is
  normal, more for USDC in thin liquidity. Set the corroboration tolerance
  above that band.
- TVL: Token Terminal lags by hours and defines TVL differently; persistent
  single-digit-percent gaps are expected. Use a wide tolerance and do not
  treat a stable offset as an anomaly.
- Observations older than `maxAgeMs` are dropped, so reporting lag from a
  slower provider degrades to `single_source` rather than a false divergence.

## Configuration

All endpoints and credentials are environment variables (see `.env.example`):
`KRAKEN_ENABLED`, `KRAKEN_BASE_URL`, `TOKENTERMINAL_BASE_URL`,
`TOKENTERMINAL_API_KEY`. Without `TOKENTERMINAL_API_KEY` the TVL feed stays
single-source and is reported as such. Prefer keyed tiers in production; free
public endpoints may rate-limit the poll interval.
