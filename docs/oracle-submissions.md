# Signed Third-Party Oracle Submissions

Independent data providers can push oracle readings to Refract with
`POST /api/v1/oracle/submissions`. Each submission is signed with the
provider's Ed25519 key and attributed to a registered provider id. This is the
first step away from the single-fetcher model: readings are no longer only
those the backend fetches with its own credentials.

Scope: provider registration is operator-managed (environment config). Staking,
slashing, reputation, and a self-service portal are out of scope.

## Operator setup

1. Generate an Ed25519 key pair for the provider and send only the public key.

   ```bash
   openssl genpkey -algorithm ed25519 -out provider.pem
   openssl pkey -in provider.pem -pubout -outform DER | tail -c 32 | base64
   ```

   The last command prints the raw 32-byte public key, base64-encoded. This is
   the `publicKey` value below.

2. Register the provider in `ORACLE_SUBMISSION_PROVIDERS`. It is a JSON array:

   ```json
   [
     {
       "id": "acme-feeds",
       "publicKey": "<base64 raw Ed25519 public key>",
       "coverageTypes": ["StablecoinDepeg", "FlightDelay"]
     }
   ]
   ```

   Provider ids are lowercase alphanumerics and hyphens (max 64 characters).
   `coverageTypes` limits which products the provider may submit for. The
   server refuses to start if this variable is malformed.

3. Apply `migrations/002_oracle_submissions.sql`.

## Request

`POST /api/v1/oracle/submissions`, `Content-Type: application/json`. No API key
is needed. The signature is the authentication.

| Field          | Type   | Rule |
|----------------|--------|------|
| `provider_id`  | string | Registered provider id. |
| `coverage_type`| string | One of `StablecoinDepeg`, `MarketCrash`, `LiquidationShield`, `SmartContractRisk`, `FlightDelay`, and in the provider's `coverageTypes`. |
| `value`        | string | Canonical decimal (see below). |
| `unit`         | string | Must equal the unit for the coverage type (see below). |
| `observed_at`  | string | RFC 3339 UTC, e.g. `2026-10-19T12:00:00.000Z`. Must be within 5 minutes in the past and 30 seconds in the future. |
| `nonce`        | string | 16-64 characters from `[A-Za-z0-9_-]`. Unique per provider. |
| `signature`    | string | Base64 of the 64-byte detached Ed25519 signature over the canonical payload. |

Unknown fields are rejected.

### Units and sanity bounds

| `coverage_type`    | `unit`    | Accepted `value` range |
|--------------------|-----------|------------------------|
| `StablecoinDepeg`  | `usd`     | 0 to 2 (USDC price) |
| `MarketCrash`      | `percent` | -100 to 1000 (24h change) |
| `LiquidationShield`| `ratio`   | 0 to 1 |
| `SmartContractRisk`| `percent` | -100 to 100 (TVL change) |
| `FlightDelay`      | `minutes` | 0 to 10080 |

## Canonical payload (normative)

Third parties must sign exactly these bytes. The server rebuilds them from the
request and verifies the signature against them.

1. Take the six fields `provider_id`, `coverage_type`, `value`, `unit`,
   `observed_at`, `nonce`. Do not include `signature`.
2. Serialize them as a JSON object with **keys sorted in ascending order**,
   **no whitespace**, and **every value a JSON string**. `value` is written as
   the decimal string itself, never a JSON number.
3. Encode the resulting string as UTF-8. Sign these bytes with Ed25519
   (RFC 8032, pure EdDSA, no pre-hash). The signature is 64 bytes.
4. Base64-encode the signature (standard alphabet, padded) into `signature`.

Example, with `value` `"0.9998"`:

```
{"coverage_type":"StablecoinDepeg","nonce":"q3nV7x0bR2mWcLh9ZkAe5A","observed_at":"2026-10-19T12:00:00.000Z","provider_id":"acme-feeds","unit":"usd","value":"0.9998"}
```

### Canonical decimal `value`

- Optional leading `-`. Never `-0`.
- No leading zeros in the integer part, except a single `0`.
- No `+` sign, no exponent, no thousands separators.
- The fraction, if present, has 1 to 6 digits and does not end in `0`.

Valid: `0.9998`, `-12.5`, `247`, `0`. Invalid: `0.99980`, `1e-4`, `.5`, `-0`, `00.1`.

## Verification order

The server checks in this order and stops at the first failure. Nothing is
written to the database until every check passes.

1. Body matches the schema (`INVALID_SUBMISSION`).
2. `provider_id` is registered (`UNKNOWN_PROVIDER`).
3. The provider is within its budget of 60 submissions per minute, counted per
   process (`RATE_LIMITED`).
4. Signature verifies against the provider's public key (`INVALID_SIGNATURE`).
5. `observed_at` is inside the freshness window (`STALE_OBSERVED_AT`).
6. Coverage type is supported and allowed for this provider
   (`UNSUPPORTED_COVERAGE_TYPE`).
7. `unit` matches the expected unit (`UNIT_MISMATCH`).
8. `value` is inside the sanity bounds (`VALUE_OUT_OF_BOUNDS`).
9. The `(provider_id, nonce)` pair is unused. The nonce is claimed and the
   submission written in a single transaction (`REPLAYED_NONCE`).

## Responses

Success is `201 Created`:

```json
{
  "accepted": true,
  "providerId": "acme-feeds",
  "coverageType": "StablecoinDepeg",
  "observedAt": "2026-10-19T12:00:00.000Z",
  "nonce": "q3nV7x0bR2mWcLh9ZkAe5A"
}
```

Errors return `{ "code": "...", "error": "..." }`:

| HTTP | `code`                       | Meaning |
|------|------------------------------|---------|
| 400  | `INVALID_SUBMISSION`         | Schema or format error. |
| 401  | `UNKNOWN_PROVIDER`           | Provider id not registered. |
| 401  | `INVALID_SIGNATURE`          | Signature does not verify. |
| 409  | `REPLAYED_NONCE`             | Nonce already used by this provider. |
| 422  | `STALE_OBSERVED_AT`          | `observed_at` outside the window. |
| 422  | `UNSUPPORTED_COVERAGE_TYPE`  | Unknown coverage type, or not allowed for this provider. |
| 422  | `UNIT_MISMATCH`              | Unit does not match the coverage type. |
| 422  | `VALUE_OUT_OF_BOUNDS`        | Value outside the sanity bounds. |
| 429  | `RATE_LIMITED`               | Provider exceeded its per-minute budget. |

A provider that sees `REPLAYED_NONCE` should generate a fresh nonce and
resubmit. It should not reuse the old one.

## Storage and replay protection

- Accepted submissions are written to `oracle_submissions`, attributed by
  `provider_id`. This is the evidence input for downstream corroboration.
- Nonces are kept in `oracle_submission_nonces` with
  `expires_at = observed_at + 5 minutes`. After that the submission would be
  stale, so the nonce no longer needs to be remembered. Expired rows are pruned
  on each insert.

## Security notes

- The signature is the only authentication. Keep provider private keys out of
  source control and rotate them by updating the registry entry.
- Signature verification is performed by OpenSSL's Ed25519 implementation. The
  path handles only public data. No secret is compared in the verifier.
- The per-provider rate counter and the freshness window are per process. For
  strict limits across replicas, add a shared store. Replay protection is
  already shared, because it is in Postgres.

## SDK example

`sdk/submission-client.ts` implements the canonical payload and the HTTP call.

```ts
import { readFileSync } from "node:fs";
import { RefractSubmissionClient, SubmissionRejectedError } from "./sdk/submission-client";

const client = new RefractSubmissionClient({
  baseUrl: "https://api.refract.example",
  providerId: "acme-feeds",
  privateKeyPem: readFileSync(process.env.PROVIDER_KEY_PATH!, "utf8"),
});

async function publishUsdcPrice(price: number): Promise<void> {
  try {
    const result = await client.submit({
      coverageType: "StablecoinDepeg",
      value: price.toFixed(6).replace(/0+$/, "").replace(/\.$/, ""),
    });
    console.log("accepted", result);
  } catch (err) {
    if (err instanceof SubmissionRejectedError) {
      console.error(`rejected (${err.status} ${err.code}): ${err.message}`);
      return;
    }
    throw err;
  }
}

await publishUsdcPrice(0.9998);
```

`unit` and `observed_at` are filled in automatically. Pass `observedAt` and
`nonce` to control them explicitly. Use `client.sign(...)` to build the signed
body without sending it.

## Rejection reasons (reading pipeline admission)

Accepted submissions pass the nine-step verification above and are written to
`oracle_submissions`. Before a reading reaches corroboration it also passes
through the ingestion-side admission pipeline, which can mark it unusable.
This section documents the admission schema and freshness-guard outcomes.

### Admission schema

`src/db/migrations/004_oracle_reading_admission.sql` adds two columns to
`oracle_events` and a replay-guard table:

- **`observed_at TIMESTAMPTZ`** — the upstream observation timestamp. Nullable
  for rows written before this migration. New readings that omit it are rejected
  with `missing_timestamp`.
- **`payload_digest CHAR(64)`** — SHA-256 hex of the raw payload.
- **`oracle_reading_receipts`** — a separate table with primary key
  `(source, observed_at, payload_digest)`. One receipt per distinct observation
  prevents replayed readings from being re-admitted even across monthly
  partitions. Old receipts are pruned by `received_at`.

`src/db/migrations/004_oracle_reading_validity.sql` adds usability columns to
`oracle_events`:

- **`usable BOOLEAN NOT NULL DEFAULT true`** — `false` for readings that failed
  the freshness guard. Existing rows default to `true`.
- **`rejection_reason VARCHAR(32)`** — constrained to `NULL`,
  `'missing_timestamp'`, `'future_dated'`, `'too_old'`, or `'heartbeat_gap'`.
  A row with `usable = false` must have a non-null `rejection_reason`
  (enforced by a check constraint). Unusable readings are excluded from
  corroboration but remain in the table for audit purposes.

### Freshness-guard rejection reasons

The freshness guard (`src/oracle/freshnessPolicy.ts`) evaluates readings in
this order and stops at the first failure. Per-feed policy values
(`freshnessWindowSeconds`, `maxClockSkewSeconds`, `heartbeatIntervalSeconds`)
come from the coverage catalog and can be overridden per environment with
`ORACLE_FRESHNESS_<FEED>_*` variables.

| `rejection_reason` | Condition | Effect |
|---|---|---|
| `missing_timestamp` | Source sent no `observed_at`. Ingestion time is used as a stand-in for diagnostics only. | Reading is unusable. An ingestion-time stamp always looks fresh and would hide outages. |
| `future_dated` | `observed_at` is more than `maxClockSkewSeconds` ahead of ingestion time. | Reading is unusable. Timestamps within the skew allowance are accepted and treated as age 0. |
| `too_old` | Ingestion time minus `observed_at` exceeds `freshnessWindowSeconds`. | Reading is unusable. Replayed backlogs after an outage are rejected here, so recovery never produces a burst of "fresh" readings. |
| `heartbeat_gap` | The source was silent for longer than `heartbeatIntervalSeconds`. The first reading after the silence is quarantined; the feed recovers once the source resumes a contiguous heartbeat. | Reading is unusable. |

Rejected readings are logged at `WARN` level as `oracle_reading_rejected` JSON
events. The feed's stale state (`oracle_feed_stale` / `oracle_feed_recovered`)
is emitted separately by `FreshnessGuard.sweep()`, which is called on each
poll cycle to catch sources that stop reporting entirely.

For the broader admission controls and per-feed pause behaviour, see
[Oracle safety controls](./oracle-safety-controls.md).
