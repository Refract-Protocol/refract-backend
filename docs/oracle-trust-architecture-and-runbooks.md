# Oracle Trust Architecture & Incident Runbooks

## 1. End-to-End Trust Pipeline Architecture

1. **Source Polling & Hardened HTTP Transport (`src/oracle/sources/`, `src/oracle/http/`)**:
   - Stateless `OracleSourceAdapter` implementations fetch upstream metrics through `HardenedProviderHttpClient` (bounded timeouts, jittered retries, token-bucket rate limits, and Redis response caching).
2. **Timestamp & Freshness Validation (`src/oracle/ingestion/`, `src/oracle/freshness/`)**:
   - Readings are validated against per-feed freshness windows, future clock-skew bounds, and payload-digest replay deduplication.
3. **Corroboration & Anomaly Circuit Breakers (`src/oracle/consensus/`, `src/oracle/anomaly/`)**:
   - Independent sources are combined via weighted median quorum (`minSources`, `independenceGroup` diversity). Jump-rate and MAD outlier circuit breakers trip before anomalous values can trigger payouts.
4. **Immutable Evidence Ledger & On-Chain Publication (`src/db/`, `src/oracle/encoding/`)**:
   - Every consensus decision persists participating reading IDs and quorum snapshots in PostgreSQL (`oracle_decisions`, `oracle_evidence_ledger`) and encodes provenance into `RefractOracle.publish_reading`.

---

## 2. Source Inventory Table

| Feed / Coverage Type | Providers | Live vs Mocked | Required Trust Mode |
| :--- | :--- | :--- | :--- |
| `USDC-DEPEG` | CoinGecko, DeFiLlama, Stellar Horizon | Live | `corroborated` |
| `PROTOCOL-TVL-DROP` | DeFiLlama, CoinGecko | Live | `corroborated` |
| `VALIDATOR-SLASHER` | Stellar Horizon | Live | `corroborated` |
| `LIQUIDATION-SHIELD` | Mocked Liquidation Adapter | Mocked (Dev Only) | `single` (Blocked on Mainnet) |
| `FLIGHT-DELAY` | Mocked Aviation Adapter | Mocked (Dev Only) | `single` (Blocked on Mainnet) |

---

## 3. Incident Runbooks

### Runbook 1: Feed Going Stale (`FEED_STALE`)
1. Inspect feed freshness and source heartbeats:
   ```bash
   npx tsx src/cli/oracleOperatorCli.ts readings:recent --feed USDC-DEPEG
   ```
2. If upstream provider is degraded, pause automatic claim settlement on the affected feed (requires confirmation):
   ```bash
   npx tsx src/cli/oracleOperatorCli.ts feed:pause --feed USDC-DEPEG --operator oncall@refract.finance --reason "Upstream staleness" --confirm
   ```

### Runbook 2: Sources Diverging Beyond Tolerance (`SOURCE_DIVERGENCE`)
1. Inspect recent readings grouped by source to identify the outlier:
   ```bash
   npx tsx src/cli/oracleOperatorCli.ts readings:recent --feed USDC-DEPEG
   ```
2. Quarantine the divergent source (dry-run first, then confirm):
   ```bash
   npx tsx src/cli/oracleOperatorCli.ts source:quarantine --feed USDC-DEPEG --source coingecko --operator oncall@refract.finance --reason "Divergence > 150 bps" --dry-run
   npx tsx src/cli/oracleOperatorCli.ts source:quarantine --feed USDC-DEPEG --source coingecko --operator oncall@refract.finance --reason "Divergence > 150 bps" --confirm
   ```

### Runbook 3: Automatic Circuit Breaker Tripping (`CIRCUIT_BREAKER_TRIP`)
1. Review recent consensus decisions and linked evidence ledger records:
   ```bash
   npx tsx src/cli/oracleOperatorCli.ts decisions:recent --feed USDC-DEPEG
   ```
2. Verify that automatic payout holds are active while corroboration evidence matures.

### Runbook 4: Suspected Compromised or Colluding Source (`COMPROMISED_SOURCE`)
1. Immediately quarantine the suspect source across all feeds:
   ```bash
   npx tsx src/cli/oracleOperatorCli.ts source:quarantine --feed USDC-DEPEG --source suspect-provider --operator secops@refract.finance --reason "Suspected compromise" --confirm
   ```
2. **Two-Person Review Required**: Before applying any manual oracle override, generate a non-mutating payout impact preview token and obtain second-operator sign-off.

### Runbook 5: Restoring Normal Operation After a Pause (`RESTORE_FROM_PAUSE`)
1. Confirm at least `minQuorumSources` independent sources are healthy and reporting within the freshness window:
   ```bash
   npx tsx src/cli/oracleOperatorCli.ts feeds:list
   ```
2. Unquarantine recovered sources if applicable and resume the feed:
   ```bash
   npx tsx src/cli/oracleOperatorCli.ts feed:resume --feed USDC-DEPEG --operator oncall@refract.finance --reason "Quorum restored and verified" --confirm
   ```
