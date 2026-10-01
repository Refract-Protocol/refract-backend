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

## Questions

If anything is unclear, open an issue or start a discussion — we're happy to help new
contributors get started.
