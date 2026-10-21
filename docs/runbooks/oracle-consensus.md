# Oracle consensus runbook

Operational procedures for the consensus evidence layer in
`src/oracle/consensus/`. All endpoints below live under
`/api/v1/ops/consensus` and need a bearer token:

| Role       | Token                                   | Access     |
|------------|-----------------------------------------|------------|
| `operator` | `OPS_API_TOKEN`                         | read/write |
| `auditor`  | any entry in `AUDITOR_API_TOKENS` (CSV) | read-only  |

## Storage

| Variable               | Purpose                                                        |
|------------------------|----------------------------------------------------------------|
| `EVIDENCE_LEDGER_PATH` | Append-only JSONL evidence ledger. Unset means in-memory only, so set it outside local dev. |
| `EVIDENCE_PAYLOAD_DIR` | Content-addressed raw payload bodies (one file per sha256).    |

The ledger is never edited in place. Every correction is a new event.

## Payout holds (issue #272)

When consensus says "pay" but the evidence behind the decision is incomplete,
the claim is not paid and not denied. It moves to `payout_held` with a
machine-readable gap list:

| Gap                    | Meaning                                                       | Closes when                                   |
|------------------------|---------------------------------------------------------------|-----------------------------------------------|
| `missing_raw_payload`  | Raw body was never captured or is missing from the store      | A newer decision is backed by stored payloads |
| `insufficient_sources` | Fewer contributors than the policy's `expectedSources`        | The missing source reports inside the window  |
| `source_in_warmup`     | A contributor was still in warm-up at decision time           | A decision is made after warm-up ends         |
| `signature_pending`    | A contributor's signature is not verified yet                 | `POST readings/:id/signature` records `verified` |

Settings:

| Variable                            | Default    | Meaning                                     |
|-------------------------------------|------------|---------------------------------------------|
| `CLAIM_HOLD_REEVALUATE_INTERVAL_MS` | `60000`    | How often held claims are re-evaluated      |
| `CLAIM_HOLD_MAX_DURATION_MS`        | `86400000` | How long a claim may stay held before escalation |

Every re-evaluation computes a fresh decision. A held claim is **released**
automatically once a decision has no gaps and is still triggered. It is
**escalated** to the operator queue when:

- `deadline_exceeded`: the evidence was still incomplete at the deadline.
- `verdict_contradicted`: newer evidence says "do not pay". The system never auto-denies.
- `policy_expired_while_held`: the policy expired while the claim was held. The trigger predates expiry, so a person decides.

Feeds without a quorum policy are not under consensus governance. Claims on
those feeds settle exactly as before.

### Resolving an escalated hold

1. List the queue:
   `GET /api/v1/ops/consensus/holds?status=escalated`
2. Inspect one hold. Check `gaps`, `escalation`, `decisionId` and
   `currentDecisionId`:
   `GET /api/v1/ops/consensus/holds/:holdId`
3. Reconstruct what the system knew at the decision time. See
   [Point-in-time reconstruction](#point-in-time-reconstruction-issue-271).
4. Record a disposition. `actor` and `note` are required and are written to
   the audit log:

   ```http
   POST /api/v1/ops/consensus/holds/:holdId/disposition
   { "disposition": "approve_payout", "actor": "jane@ops", "note": "payload recovered from provider archive, hash matches" }
   ```

   | Disposition      | Effect                                                         |
   |------------------|----------------------------------------------------------------|
   | `approve_payout` | The next claim scan settles the payout                         |
   | `deny`           | The payout is blocked permanently for this policy              |
   | `extend_hold`    | Back to `payout_held` with a new deadline (`extendMs` required) |

`POST /api/v1/ops/consensus/holds/reevaluate` forces a re-evaluation pass
without waiting for the scheduler.

## Point-in-time reconstruction (issue #271)

This answers "what did the system know and believe about feed F at moment T",
built only from the persisted ledger. It never uses live config, caches or
provider calls.

```http
GET /api/v1/ops/consensus/feeds/:feedId/state?at=2026-10-21T14:00:03.002Z
GET /api/v1/ops/consensus/feeds/:feedId/state?ledger=51234501
```

```sh
npm run oracle:ops -- reconstruct --feed StablecoinDepeg --at 2026-10-21T14:00:03.002Z \
  --ledger-file "$EVIDENCE_LEDGER_PATH"
```

Both `operator` and `auditor` tokens may call it. The API and the CLI run the
same function and the same canonical serialiser, so their output is
byte-identical.

How T is resolved:

- `at`: only events recorded at or before T are visible. Config rows apply
  only once their `effectiveFrom` has passed. Ledger timestamps are strictly
  increasing, so T is an exact cut through the ledger.
- `ledger=L`: T is the time the last event stamped with ledger ≤ L was
  recorded. Events stamped with a later ledger are excluded.

The response contains:

| Field                  | Meaning                                                           |
|------------------------|-------------------------------------------------------------------|
| `quorumPolicy`         | The policy version in force at T                                  |
| `sources`              | Per-source version, status, eligibility and reason at T           |
| `contributingReadings` | Values, payload hashes and signature status as known at T         |
| `decision`             | Consensus recomputed from that evidence, or `no_decision` with a reason |
| `recordedDecision`     | The decision the system had recorded and was acting on at T       |
| `consistency`          | `matches_recorded` or `differs_from_recorded` when a decision was recorded at exactly T; `no_decision_recorded_at_t` otherwise |

The output does not change as the ledger grows. It also does not change
after raw payload bodies are purged, because hashes and values live in the
ledger.

Possible `no_decision` reasons:

- `no_quorum_policy`: T is before the feed existed.
- `no_sources_registered_at_t`
- `quorum_not_met: …` and `weight_not_met: …`
- `no_evidence_at_or_before_ledger_L`

`npm run oracle:ops -- holds --status escalated` prints the hold queue from
the same ledger file.

## Mirrored-source detection (issue #273)

Two "independent" sources that publish the same numbers, for example a paid
provider reselling a free feed, should not count as two confirmations. A batch
scan, run off the consensus hot path, compares every source pair on each
feed:

1. **Fingerprint.** Each normalised reading is stored with
   `sha256(feedId, canonical value, time bucket)`. The canonical value is
   rounded to 12 significant digits, so formatting and float noise don't
   matter.
2. **Align.** Each source contributes its last value per `MIRROR_BUCKET_MS`
   bucket. The pair is compared at every lag up to `MIRROR_MAX_LAG_BUCKETS`,
   so delaying a copied value does not hide it.
3. **Count only movement.** A bucket is *informative* only if one of the two
   series moved since its previous bucket. Agreeing on a flat market proves
   nothing.
4. **Flag** the pair when, at the best lag, all of these hold:
   - informative buckets ≥ `MIRROR_MIN_INFORMATIVE_SAMPLES`
   - match ratio ≥ `MIRROR_MIN_MATCH_RATIO`, where a match means the values
     are within `MIRROR_RELATIVE_TOLERANCE`
   - the matched values span ≥ `MIRROR_MIN_DISTINCT_VALUES` levels, which
     guards low-cardinality and categorical feeds

| Variable                          | Default            | Notes                                     |
|-----------------------------------|--------------------|-------------------------------------------|
| `MIRROR_WINDOW_MS`                | `21600000` (6 h)   | Sliding window per scan                   |
| `MIRROR_BUCKET_MS`                | `60000`            | Coarse time bucket                        |
| `MIRROR_RELATIVE_TOLERANCE`       | `0.00005` (0.5 bp) | Near-match tolerance                      |
| `MIRROR_MAX_LAG_BUCKETS`          | `2`                | Delay tolerated                           |
| `MIRROR_MIN_INFORMATIVE_SAMPLES`  | `8`                | Sustained overlap, not one coincidence    |
| `MIRROR_MIN_MATCH_RATIO`          | `0.9`              |                                           |
| `MIRROR_MIN_DISTINCT_VALUES`      | `3`                |                                           |
| `MIRROR_PENALTY_FACTOR`           | `0.25`             | Weight multiplier for the shadowed source |
| `MIRROR_SCAN_INTERVAL_MS`         | `300000`           |                                           |

A flagged pair gets a persisted `independence_penalty` with the window, lag,
match statistics and up to 10 matched reading pairs as evidence. From then
on, consensus treats the lighter source as a suspected mirror:

- its weight is multiplied by the penalty factor;
- it does not count toward `minSources`;
- it does not count toward a payout's `expectedSources`.

The penalty is cleared, with an audit entry, once the pair diverges over at
least the minimum number of informative buckets, or when one of the two
sources is retired. A quiet market never clears a penalty.

Limits:

- A mirror that adds noise larger than the tolerance looks independent. Raise
  `MIRROR_RELATIVE_TOLERANCE` for feeds where honest sources are much
  noisier than that.
- A delay longer than the lag window also escapes detection.

Surfaces:

| Surface | Use |
|---------|-----|
| `GET /api/v1/ops/consensus/trust-status` (operator, auditor) | Sources, declared upstream and suspected pairs with evidence. Use it to cross-check on-chain provenance and licences. |
| `POST /api/v1/ops/consensus/mirror-scan` | Run a scan now |
| `refract_oracle_suspected_mirror_pairs{feed}` | Metric: pairs currently penalised per feed |
| `refract_oracle_mirror_penalty_changes_total{feed,action}` | Metric: penalties applied or cleared |

Before you tighten thresholds or onboard a new source, run a backtest. It
replays detection over the whole ledger and writes nothing:

```sh
npm run oracle:ops -- mirror-backtest --ledger-file "$EVIDENCE_LEDGER_PATH"
```
