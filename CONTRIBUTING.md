# Contributing to Refract Backend

Thanks for helping build Refract's off-chain services! This guide gets you from
clone to merged PR.

## Ground rules

- Be respectful — see the [Code of Conduct](./CODE_OF_CONDUCT.md).
- Open an issue to discuss anything non-trivial before you build it.
- Keep the build green: lint, typecheck, and build must pass.
- Report vulnerabilities privately per [`SECURITY.md`](./SECURITY.md).

## Getting set up

```bash
cp .env.example .env
npm install
npm run dev
```

Postgres and Redis are optional for most local work because the data layer is
currently mocked; they become required as you wire real persistence.

## Local gate (matches CI)

```bash
npm run lint
npm run typecheck
npm run build
```

## Coding standards

- **TypeScript strict mode** is on; no `// @ts-ignore` without a comment explaining why.
- Validate every request body with a **Zod** schema; never trust client input.
- Money is handled as **BigInt** in 1e7 fixed-point — do not use `number` for on-chain amounts.
- Log through the shared Winston `logger`, not `console.log`.
- Prefix intentionally-unused variables with `_`.

## What we'd love help with

- Replace the mocked oracle sources with real integrations (CoinGecko, Stellar
  Horizon, DeFiLlama, AviationStack).
- Implement Soroban transaction building/submission in the route `txXdr` stubs
  and `ClaimProcessor.processPayout`.
- Wire the Postgres layer (`src/db/schema.sql`) behind the in-memory stores.
- Add integration tests (supertest) for the REST routes.

## Commit & PR conventions

- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `chore:`.
- One logical change per PR; reference the issue it closes and fill in the template.
