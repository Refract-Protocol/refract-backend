# Oracle provider sandbox

The provider sandbox lets a data provider outside the core team try the
provider submission API end to end. You submit signed readings and then see
how corroboration treated them: which consensus decisions were made, and
which readings were rejected and why. Nothing reaches production feeds and
nothing is published on-chain.

## Running a sandbox deployment

```bash
ORACLE_SANDBOX_MODE=true STELLAR_NETWORK=testnet npm run start
```

Startup fails in either of these cases:

- `ORACLE_RELAYER_SECRET` or `ORACLE_RELAYER_SECRET_ID` is set. A sandbox
  must not hold a key that can publish.
- `STELLAR_NETWORK` is `mainnet` / `public`.

## Isolation and retention

- All sandbox state lives in memory inside `OracleSandboxService`. The
  module has no Postgres, Redis, Soroban or relayer dependency, so no
  production code path can read sandbox data and nothing can be published.
- Readings older than the corroboration window are dropped. Decisions and
  rejections are purged after `ORACLE_SANDBOX_RETENTION_MS` (24h by
  default). A restart clears everything, including registered providers.

| Variable | Default | Meaning |
|---|---|---|
| `ORACLE_SANDBOX_MIN_PROVIDERS` | `3` | Distinct providers that must agree before a decision is made |
| `ORACLE_SANDBOX_MAX_DEVIATION_RATIO` | `0.02` | Allowed relative distance from the median |
| `ORACLE_SANDBOX_WINDOW_MS` | `300000` | Corroboration window; older readings are `stale` |
| `ORACLE_SANDBOX_MAX_FUTURE_SKEW_MS` | `30000` | How far ahead of server time `observedAt` may be |
| `ORACLE_SANDBOX_MAX_PROVIDERS` | `500` | Registry size cap |
| `ORACLE_SANDBOX_MAX_SUBMISSIONS_PER_MINUTE` | `60` | Per-provider rate limit (rolling minute) |
| `ORACLE_SANDBOX_RETENTION_MS` | `86400000` | Decisions and rejections are purged after this (24h) |

Each feed also has an absolute tolerance floor (for example 0.5 percentage
points for `MarketCrash`), so feeds whose value sits near zero still
corroborate. `GET /sandbox/oracle` returns the policy that is in effect.

## Signing

Providers sign with a Stellar ed25519 keypair. The provider id is the public
key (`G…`). Signatures are base64 over the UTF-8 bytes of these messages,
with lines joined by `\n`:

```
refract-oracle-reading:v1
sandbox
<providerId>
<feed>
<value>          # decimal string, e.g. 0.9998 or -30.12
<observedAt>     # ISO-8601
<nonce>          # 8-128 chars [A-Za-z0-9_-], never reused
```

```
refract-oracle-provider-registration:v1
sandbox
<providerId>
<name>
```

The second line is the deployment domain. A signature made for the sandbox
therefore never verifies on a production deployment.

`scripts/sandbox-sign-reading.ts` produces both payloads.

## Walkthrough

```bash
export PROVIDER_SECRET=S...   # a throwaway testnet key
API=http://localhost:4001

# 1. Register (the signature proves you own the key)
npx ts-node scripts/sandbox-sign-reading.ts register "Acme Feeds" |
  curl -s -XPOST $API/sandbox/oracle/providers -H 'content-type: application/json' -d @-

# 2. Submit a reading
npx ts-node scripts/sandbox-sign-reading.ts reading StablecoinDepeg 0.9998 |
  curl -s -XPOST $API/sandbox/oracle/readings -H 'content-type: application/json' -d @-

# 3. Inspect
curl -s $API/sandbox/oracle/feeds/StablecoinDepeg
curl -s "$API/sandbox/oracle/decisions?feed=StablecoinDepeg"
curl -s "$API/sandbox/oracle/rejections?providerId=G..."
```

`POST /readings` always answers `202` with a trace:

| `status` | Meaning |
|---|---|
| `rejected` | Failed a check before corroboration; see `rejection.reason` |
| `awaiting_corroboration` | Accepted into the window; `corroboration.providers` of `required` so far |
| `decided` | Triggered a decision (`decision`). If your reading was an outlier, `rejection` is set too |

## How corroboration decides

1. Keep each provider's latest reading in the window. A provider never counts twice.
2. Once `minProviders` distinct providers have reported, take the median.
3. Readings further than `max(|median| × ratio, feed floor)` from the median are outliers.
4. If the readings that agree still meet `minProviders`, the decision is
   `accepted` and its value is their median. Otherwise it is `rejected`
   with reason `insufficient_agreement`.

Every decision has `published: false`.

## Rejection reasons

| Reason | Cause |
|---|---|
| `invalid_shape` | Missing or malformed field (all problems are listed) |
| `unknown_feed` | Feed not one of the sandbox feeds |
| `unregistered_provider` | Register the key first |
| `from_future` / `stale` | `observedAt` outside the accepted time range |
| `bad_signature` | Signature does not verify for `providerId` and domain `sandbox` |
| `rate_limited` | Over `ORACLE_SANDBOX_MAX_SUBMISSIONS_PER_MINUTE` for this provider |
| `replayed_nonce` | Nonce already used by this provider |
| `outlier` | Too far from the median in a decision (links `decisionId`) |
| `insufficient_agreement` | Not enough providers agreed (feed-level, links `decisionId`) |

The signature is checked before the nonce is recorded. A forged request
therefore cannot use up a real provider's nonce.

This is separate from `SANDBOX_MODE`, the contributor mode that replaces
Postgres, Redis and RPC with mocks. The two flags can be combined.
