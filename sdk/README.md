# Refract Submission SDK

Minimal client for `POST /api/v1/oracle/submissions` — signs each reading
with the provider's Ed25519 private key over the canonical payload. See
[`docs/oracle-submissions.md`](../docs/oracle-submissions.md) for provider
registration and the full submission protocol. Requires Node 18+ (global
`fetch`).

## Usage

```ts
import { RefractSubmissionClient } from "./submission-client";

const client = new RefractSubmissionClient({
  baseUrl: "YOUR_URL", // e.g. https://api.refract.example
  providerId: "YOUR_PROVIDER_ID", // as registered in ORACLE_SUBMISSION_PROVIDERS
  privateKeyPem: "YOUR_PRIVATE_KEY_PEM", // PKCS#8 PEM-encoded Ed25519 key; load from a secret store, never hardcode
});

const result = await client.submit({
  coverageType: "StablecoinDepeg",
  value: "0.9998", // canonical decimal string, never a JS number
});
```

`submit` signs and POSTs the reading, resolving with the parsed response body
on success. It throws `SubmissionRejectedError` (with `status` and, if the
server provided one, `code`) on any non-2xx response.

To sign a reading without sending it (for tests or offline signing), call
`client.sign(reading)` instead — it returns the same signed payload `submit`
would POST, without making a network request.
