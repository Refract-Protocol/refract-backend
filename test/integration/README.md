# Integration Test Harness

Tests in this directory run against a **real, ephemeral Postgres 15** instance
and are intentionally kept out of the default `npm test` (unit) run.

## Prerequisites

- Docker must be running (used to spin up the Postgres container).
- Alternatively, set `TEST_DATABASE_URL` to point at an existing Postgres
  instance; the harness will use it as-is and skip the container lifecycle.

## Running

```bash
npm run test:integration
```

The command uses `--runInBand` so tests share the single container; parallel
workers would each need their own schema which defeats the purpose.

## How it works

| File | Role |
|------|------|
| `setup/global-setup.ts`   | Starts Docker container, waits for ready, applies `src/db/schema.sql` |
| `setup/global-teardown.ts`| Stops and removes the container |
| `setup/db-client.ts`      | Shared `createTestPool()` / `truncateTables()` helpers |
| `*.ispec.ts`              | Test suites; each `beforeEach` truncates only the tables it owns |

## CI (GitHub Actions)

The workflow sets `TEST_DATABASE_URL` via a service container so no Docker
socket is needed inside the runner:

```yaml
services:
  postgres:
    image: postgres:15-alpine
    env:
      POSTGRES_USER: refract_test
      POSTGRES_PASSWORD: refract_test
      POSTGRES_DB: refract_test
    ports: ["5432:5432"]
    options: >-
      --health-cmd pg_isready
      --health-interval 5s
      --health-timeout 5s
      --health-retries 10
env:
  TEST_DATABASE_URL: postgres://refract_test:refract_test@localhost:5432/refract_test
```
