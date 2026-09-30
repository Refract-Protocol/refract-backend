import { Client, Pool } from "pg";

/**
 * Shared helpers for integration test files.
 *
 * Usage
 * -----
 * ```ts
 * import { createTestPool, truncateTables } from "../setup/db-client";
 *
 * let pool: Pool;
 * beforeAll(() => { pool = createTestPool(); });
 * afterAll(() => pool.end());
 * beforeEach(() => truncateTables(pool, ["policies", "claims"]));
 * ```
 */

/**
 * Returns a pg.Pool connected to the ephemeral database whose URL was
 * injected by global-setup into INTEGRATION_DATABASE_URL.
 */
export function createTestPool(): Pool {
  const url = process.env.INTEGRATION_DATABASE_URL;
  if (!url) {
    throw new Error(
      "INTEGRATION_DATABASE_URL is not set. " +
        "Run tests via `npx jest --config test/integration/jest.integration.config.ts`."
    );
  }
  return new Pool({ connectionString: url, max: 5 });
}

/**
 * Truncates the given tables in a single statement (RESTART IDENTITY so
 * BIGSERIAL counters reset between tests) and cascades FK references.
 */
export async function truncateTables(pool: Pool, tables: string[]): Promise<void> {
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t}"`).join(", ");
  await pool.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * Returns a one-shot Client for operations that must run outside a
 * transaction (e.g. DDL checks).  Caller is responsible for `client.end()`.
 */
export async function connectTestClient(): Promise<Client> {
  const url = process.env.INTEGRATION_DATABASE_URL;
  if (!url) throw new Error("INTEGRATION_DATABASE_URL is not set");
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}
