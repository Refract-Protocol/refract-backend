# Contributing

Thanks for your interest in contributing! This guide will help you get set up quickly.

## Getting set up

### Sandbox mode (recommended first run)

The fastest way to get the full API running locally is **sandbox mode**. It swaps every
real backing service (Postgres repositories, Redis cache, and Soroban RPC calls) for
lightweight in-memory/mocked equivalents, so you can run the app immediately after
`npm install` with **no other setup** — no Postgres, no Redis, and no Soroban testnet
configuration required.

```bash
npm install
SANDBOX_MODE=true npm run dev
```

Or set it in your `.env`:

```bash
SANDBOX_MODE=true
```

When sandbox mode is active the app prints a prominent startup banner so it is never
mistaken for a real environment. Sandbox data lives entirely in memory and resets
cleanly on every restart — nothing is persisted.

> **Sandbox mode is a local contributor-onboarding tool only.** It is explicitly
disallowed outside local development: the app refuses to start in sandbox mode when
`NODE_ENV=production`.

### Running against real infrastructure

For work that needs real persistence or live Soroban calls, provide the usual
configuration instead of `SANDBOX_MODE`:

- `DATABASE_URL` — Postgres connection string
- `REDIS_URL` — Redis connection string
- Soroban RPC configuration (see `.env.example`)

With these set (and `SANDBOX_MODE` unset or `false`), the app uses the real backing
services.

## Development workflow

1. Fork the repository and create a feature branch.
2. Make your changes, keeping them focused and scoped.
3. Run the test suite before opening a pull request.
4. Open a pull request describing what you changed and why.

## Consumer-driven contract tests

The trust-facing payloads produced by `refract-backend` (consensus decisions,
provenance attestations, trust-status responses, and the encoded on-chain reading) are
pinned by consumer-driven contracts. The **consumer owns the expectation** and the
**producer verifies it** in CI.

### Where contracts live

- `test/contracts/consumers/refract-frontend/` — expectations of the frontend for
  decision records, provenance, and trust-status responses.
- `test/contracts/consumers/refract-contracts/` — expectations of the contracts repo
  for the encoded on-chain reading.
- `test/contracts/verify.ts` — the generated verifier that replays each contract
  against the backend's actual responses and encodings. It runs without a live
  database or network (sandbox mode / in-memory fixtures).

### Who bumps a contract

The **consumer team** (frontend or contracts) bumps a contract. Producers never edit a
consumer's contract to make their build pass — that inverts the dependency and defeats
the purpose.

### How a consumer verifies

1. Update the contract fixture in your consumer directory to the shape you now expect.
2. Bump the contract `version` field (see below).
3. Run `npm run test:contracts` locally — the producer verifier replays your contract
   against the backend and reports any mismatch by **named field**.
4. Open the PR. Backend CI runs `npm run test:contracts` and fails on any mismatch.

### Additive vs. breaking changes

- **Additive changes** (new optional fields, new enum members consumers ignore) pass
  without ceremony: add the field to the contract and bump the minor version.
- **Breaking changes** (renamed/removed fields, changed units or encodings) require an
  **explicit major version bump** and **consumer opt-in**: the consumer must update
  their contract to the new major version in the same release window. The producer
  keeps serving the old shape until every consumer has opted in. A breaking change
  without a version bump fails CI with a readable message naming the offending field.

### Proof the mechanism works

`test/contracts/breaking-change.test.ts` deliberately renames a field and asserts the
verifier fails with a message naming that field. If this test ever passes silently, the
contract mechanism is broken.

## Attack-cost model

`scripts/attack-cost.ts` implements the analytical attack-cost model from
`docs/threat-model.md` as a pure function library (`scripts/attack-cost-model.ts`) plus
a CLI. It estimates the cost of corrupting a feed's consensus via source bribery,
collusion among N sources, or compromise of K operator keys, and derives the minimum
operator bond and quorum thresholds for the coverage exposure a feed supports.

### Reproducing the published numbers

The reference scenario is checked in as a regression fixture. To reproduce the numbers
quoted in `docs/threat-model.md`:

```bash
npm run attack-cost -- --feed fixtures/feeds/reference-feed.json \
  --quorum fixtures/quorum/reference-quorum.json \
  --safety-factor 10
```

The CLI prints the attack cost, the maximum payout exposure the feed can support at the
configured safety factor, and the implied minimum bond. The same pure functions are
reused at configuration-validation time: startup is refused when a payout-triggering
feed's exposure exceeds the modeled attack cost by the configured safety factor.

Model versioning: the model is versioned alongside the quorum policy it validates, so a
reviewer can always reproduce a historical number by checking out the matching model
version.

## Questions

If anything is unclear, open an issue or start a discussion — we're happy to help new
contributors get started.
