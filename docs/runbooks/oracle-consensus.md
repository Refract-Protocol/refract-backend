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
3. Check the decision's contributing readings in the evidence ledger.
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
