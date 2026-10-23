# Oracle Replay & Fault-Injection Harness

Deterministically replays recorded provider data through the oracle decision
pipeline (ingestion → freshness → corroboration → decision) with injected
faults. No Postgres, Redis, or network is needed.

Code lives in `src/oracle/replay/`. The pipeline takes an injected `Clock`,
`ProviderClient`, and seeded `Random`, so the same fixture + seed + start time
always yields byte-identical decisions. Time only moves when the harness (or a
retry back-off `clock.sleep`) advances the `ManualClock`.

## Run a scenario

```bash
npx ts-node scripts/oracle-scenario.ts --list
npx ts-node scripts/oracle-scenario.ts silent-source
```

The command prints the decisions as JSON and exits non-zero on an unknown
scenario name, a corrupted fixture (checksum mismatch), or a decision that
differs from the scenario's `expect` list.

Sample output (`diverging-source`, abridged):

```json
{ "scenario": "diverging-source", "seed": 42,
  "decisions": [{ "action": "pause", "reason": "sources_diverged", "value": 150 }] }
```

## Record a fixture

```bash
ORACLE_RECORD_SOURCES='{"provider-a":"https://...","provider-b":"https://..."}' \
  npx ts-node scripts/oracle-record.ts my-fixture-v1 --feed rainfall-mm-24h --samples 3
```

Only `value` and `observedAt` are kept; URLs and credentials (passed through
`ORACLE_RECORD_HEADERS_<source>` env vars) are never written. Fixtures are
versioned (`version: 1`) and carry a sha256 checksum; do not hand-edit them.
Review the file before committing.

## Add a scenario

Drop a JSON file in `test/oracle/replay/scenarios/<name>.json` — no test code
needed:

```json
{
  "name": "my-scenario",
  "fixture": "sample-v1.json",
  "seed": 42,
  "startMs": 1767225600000,
  "config": { "sources": ["provider-a", "provider-b", "provider-c"], "maxAgeMs": 90000,
              "maxFutureSkewMs": 5000, "toleranceBps": 500, "minSources": 2,
              "triggerThreshold": 140, "maxRetries": 1, "retryBaseMs": 1000 },
  "faults": [{ "kind": "timeout", "source": "provider-a", "fromMs": 100000, "toMs": 200000 }],
  "ticks": [120000],
  "expect": ["pay"]
}
```

Fault kinds: `timeout`, `http_5xx`, `malformed`, `diverge` (`param` = value
multiplier), `all_down` (no `source`), `delay` (`param` = ms the observation
lags), `clock_skew` (`param` = ms added to the observation timestamp). Fault
windows and `ticks` are offsets in ms from `startMs`.
