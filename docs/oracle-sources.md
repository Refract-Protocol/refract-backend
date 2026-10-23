# Oracle source independence

Corroboration is only meaningful when sources have distinct upstream data.
Each provider is a `SourceAdapter` (`src/oracle/sources/`) registered in the
source registry (`createSourceRegistry`); `corroborate()` classifies a feed as
`corroborated`, `single_source`, `divergent` or `unavailable`. Feed-to-source
mapping lives in `COVERAGE_FEED_SOURCES` (`src/common/coverage-catalog.ts`).

| Feed | Provider | Upstream origin | Cadence | Auth |
|------|----------|-----------------|---------|------|
| price | CoinGecko | Volume-weighted aggregate across many exchanges | ~1–5 min cache | none |
| price | Kraken | Single-venue spot order book, last trade | real time | none |
| TVL | DeFiLlama | Community adapters reading on-chain balances | ~hourly | none |
| TVL | Token Terminal | Own indexing pipeline and TVL definition | daily, intraday on paid tiers | API key |

Horizon is deliberately not counted as a second price source: its view is
derived from the same on-chain market the others describe.

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
