# Provider Adapter Conformance

Third-party data sources must pass the conformance checks in
`src/oracle/source-conformance.ts` before they can be assigned consensus
weight. The same module runs locally for providers and inside the backend
admission gate, so both use one definition of "compliant".

## Conformance checklist

1. Run the adapter checks with `runConformance` (see [Running the checks](#running-the-checks)).
2. Run the sandbox sign-reading harness against a sandbox deployment (see [Sandbox sign-reading harness](#sandbox-sign-reading-harness)).
3. Read the report's "does not prove" list and complete the manual checks it names.
4. Certify with `buildCertificationRecord` (see [Certification and expiry](#certification-and-expiry)).

## Running the checks

Implement the adapter contract:

```ts
import { ProviderAdapter, runConformance } from "./src/oracle/source-conformance";

const adapter: ProviderAdapter = {
  async fetch(coverageType) {
    // Return a submission for the coverage type, or reject with an Error.
    return { coverageType, value: 0.9998, timestamp: Date.now(), nonce: "n-1", signature: "..." };
  },
};

const report = await runConformance("my-source", adapter, {
  coverageTypes: ["StablecoinDepeg"],
  verifySignature: (submission) => verifyWithYourKey(submission),
  now: Date.now(),
});
```

The runner makes no network calls of its own. Requests go only to your
adapter, so you can run it offline against fixtures by returning canned
submissions.

## Checks

| id                    | What it enforces                                                              |
|-----------------------|-------------------------------------------------------------------------------|
| `adapter_timeout`     | `fetch` settles within the adapter timeout (default 5s)                       |
| `adapter_error`       | Rejections are `Error` instances                                              |
| `schema`              | Required fields present with the right types; `coverageType` echoes the request |
| `units_scale`         | Value scales to the on-chain integer via `scaleOracleValue` without silent rounding |
| `timestamp_not_future`| Timestamp is at most 5s ahead of the backend clock                            |
| `timestamp_fresh`     | Timestamp is at most 60s old (configurable)                                   |
| `signature`           | Signature passes the injected verifier                                        |
| `replay`              | Each nonce is used once across the run                                        |

A check passes only if it passes for every submission. The report lists the
first failure detail for each failing check.

## Sandbox sign-reading harness

`scripts/sandbox-sign-reading.ts` produces the signed payloads that the
oracle provider sandbox accepts. Use it to check that your key and signing
code produce submissions the sandbox API accepts. Set up the sandbox first
with [`docs/oracle-provider-sandbox.md`](./oracle-provider-sandbox.md).

The harness only signs. It does not call the sandbox, check values, or
verify signatures. The sandbox does all of that when it receives the
payload.

### Inputs

| Input | Meaning |
|---|---|
| `PROVIDER_SECRET` env var | Required. Your Stellar secret key (`S…`). Use a throwaway testnet key. |
| `register <name>` | Signs a registration. `name` defaults to `sandbox provider`. |
| `reading <feed> <value>` | Signs a reading. `value` is a decimal string such as `0.9998`. `observedAt` is the current time and `nonce` is random. |

```bash
PROVIDER_SECRET=S... npx ts-node scripts/sandbox-sign-reading.ts register "Acme Feeds"
PROVIDER_SECRET=S... npx ts-node scripts/sandbox-sign-reading.ts reading StablecoinDepeg 0.9998
```

### Output and exit codes

On success the script prints one line of JSON to stdout and exits `0`.

- `register` prints `{"providerId","name","signature"}`.
- `reading` prints `{"providerId","feed","value","observedAt","nonce","signature"}`.

| Exit code | Cause |
|---|---|
| `0` | Payload printed |
| `1` | `PROVIDER_SECRET` is unset, a `reading` argument is missing, or the command is unknown |
| `1` | `PROVIDER_SECRET` is not a valid secret key. Node prints an uncaught-exception stack trace. |

### What a passing run looks like

1. The script exits `0` and stdout is a single line of valid JSON with the
   fields above.
2. Piping the output to the sandbox API succeeds. `POST /readings` answers
   `202`, and its `status` is `awaiting_corroboration` or `decided`, not
   `rejected`. See [Rejection reasons](./oracle-provider-sandbox.md#rejection-reasons)
   if it is `rejected`.

### What the harness covers and what it does not

The harness is a signer, so the sandbox is what verifies. Use the harness
to confirm the signing path. Check these yourself:

- Value shape and precision. The harness does not validate `value`. A bad
  value is still signed, and the sandbox rejects it as `invalid_shape`.
- Feed names. The harness does not check the feed against the sandbox feed
  list. The sandbox rejects an unknown feed as `unknown_feed`.
- Accuracy of the value. The harness takes whatever number you pass.
- Corroboration. A single run never reaches `minProviders`. Test agreement
  and outlier handling with several registered providers, and check
  `GET /sandbox/oracle/decisions` and `/rejections`.
- Timing and rate limits. Readings from the harness use the current time,
  so the harness does not test staleness or per-minute rate limits.
- Production signing. Sandbox signatures use the `sandbox` domain and never
  verify on a production deployment. Production signing needs its own check.

## Report

`ConformanceReport` carries `reportVersion` and `specVersion`. Reports are
versioned so the gate can reject results produced under a spec it no longer
accepts.

## Certification and expiry

A passing report becomes a `CertificationRecord` via
`buildCertificationRecord`, valid for 30 days by default. The gate
(`assessAdmission`) fails closed: a source is admitted only with a passing,
unexpired record issued against the current `specVersion` and
`reportVersion`. Any breaking change to the spec bumps `specVersion`, which
requires re-certification.

## What a passing report proves

- The adapter returns well-formed submissions for the declared coverage types.
- Values convert to the on-chain integer scale without precision loss.
- Timestamps are not future-dated and are fresh at check time.
- Signatures verify under the key you supplied.
- Nonces are not reused within the run.

## What a passing report does not prove

- That the underlying data is accurate or was not manipulated upstream.
- Anything about the provider's infrastructure security.
- Rate-limit and backoff behaviour under sustained load.
- Stability over time. Certification is a point-in-time check that expires.
