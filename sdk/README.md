# Refract Submission SDK

`sdk/submission-client.ts` is a minimal Node.js client for submitting oracle
readings to the Refract backend (`POST /api/v1/oracle/submissions`).

## Requirements

- Node.js 18 or later (uses the global `fetch`)
- An Ed25519 key pair registered as a provider on the backend

## Constructor options

```ts
new RefractSubmissionClient(options: SubmissionClientOptions)
```

| Option | Type | Description |
|---|---|---|
| `baseUrl` | `string` | Backend origin, e.g. `https://api.refract.example`. No trailing slash. |
| `providerId` | `string` | Provider id exactly as registered in `ORACLE_SUBMISSION_PROVIDERS` on the backend. |
| `privateKeyPem` | `string` | PKCS#8 PEM-encoded Ed25519 private key. Load from an environment variable or secret manager — never commit it to source. |

## Methods

### `client.submit(reading): Promise<unknown>`

Signs the reading and POSTs it to `{baseUrl}/api/v1/oracle/submissions`.
Throws `SubmissionRejectedError` on any non-2xx response; the error includes
the HTTP status and the backend's `code` and `message` fields.

### `client.sign(reading): SignedSubmission`

Builds and signs the request body without sending it. Useful for offline
signing, testing, or preparing a batch before sending.

## Usage example

Start the backend in sandbox mode so it accepts submissions without
real on-chain state:

```bash
SANDBOX_MODE=true npm run dev
```

Then submit a reading:

```ts
import { RefractSubmissionClient } from './submission-client';

const client = new RefractSubmissionClient({
  baseUrl: 'http://localhost:4001',
  providerId: 'my-provider',
  privateKeyPem: process.env.ORACLE_PROVIDER_PRIVATE_KEY!,
});

// Submit one reading (signs and sends):
await client.submit({
  coverageType: 'StablecoinDepeg',
  value: '0.9998',              // exact decimal string, never a JS number
  observedAt: new Date(),       // defaults to now if omitted
});

// Sign offline without sending (useful for tests):
const signed = client.sign({
  coverageType: 'MarketCrash',
  value: '-12.5',
});
console.log(signed);
// {
//   provider_id: 'my-provider',
//   coverage_type: 'MarketCrash',
//   value: '-12.5',
//   unit: 'percent',
//   observed_at: '2024-06-01T12:00:00.000Z',
//   nonce: '<base64url-random>',
//   signature: '<base64-ed25519-sig>',
// }
```

## ReadingInput fields

| Field | Type | Required | Description |
|---|---|---|---|
| `coverageType` | `CoverageTypeName` | ✓ | Coverage type, e.g. `"StablecoinDepeg"`. |
| `value` | `string` | ✓ | Canonical decimal string, e.g. `"0.9998"`. Never a JS number. |
| `unit` | `string` | — | Defaults to the unit the server expects for this coverage type. |
| `observedAt` | `Date` | — | Defaults to `new Date()`. |
| `nonce` | `string` | — | Defaults to 16 random bytes, base64url-encoded. |

## Error handling

```ts
import { SubmissionRejectedError } from './submission-client';

try {
  await client.submit({ coverageType: 'StablecoinDepeg', value: '0.9995' });
} catch (err) {
  if (err instanceof SubmissionRejectedError) {
    console.error(`HTTP ${err.status} — code: ${err.code} — ${err.message}`);
  }
}
```

## Signing protocol

Each submission is signed with Ed25519 over the canonical payload produced by
`canonicalizeSubmission` (see `src/oracle/submission-canonical.ts`). The
canonical form covers `provider_id`, `coverage_type`, `value`, `unit`,
`observed_at`, and `nonce` in a deterministic order. Full details are in
`docs/oracle-submissions.md`.
