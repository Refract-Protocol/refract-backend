# Provider Adapter Conformance

Third-party data sources must pass the conformance checks in
`src/oracle/source-conformance.ts` before they can be assigned consensus
weight. The same module runs locally for providers and inside the backend
admission gate, so both use one definition of "compliant".

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
