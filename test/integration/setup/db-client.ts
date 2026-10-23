import { readdirSync, readFileSync } from "fs";
import { join } from "path";
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
 * Tables introduced by the methodology, incident, and partitioning
 * migrations.  Truncating these between tests keeps the new integration
 * suites isolated from one another.
 */
export const METHODOLOGY_TABLES = [
  "source_methodology_versions",
  "source_methodology_attestations",
] as const;

export const INCIDENT_TABLES = [
  "incident_events",
  "incidents",
] as const;

/**
 * Partitioned tables.  `TRUNCATE` on a partitioned parent cascades to all
 * of its partitions, so callers only need to name the parents.
 */
export const PARTITIONED_TABLES = [
  "oracle_readings",
  "evidence_ledger",
] as const;

export const ALL_EXTENDED_TABLES = [
  ...METHODOLOGY_TABLES,
  ...INCIDENT_TABLES,
  ...PARTITIONED_TABLES,
] as const;

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

/**
 * Applies `src/db/schema.sql` followed by every numbered migration in
 * `src/db/migrations/` (in lexical order) to the ephemeral database.
 *
 * `schema.sql` is the canonical definition and already reflects the
 * partitioning and methodology tables, so migrations are applied with
 * `ON_ERROR_STOP` semantics but tolerate "already exists" style errors
 * (SQLSTATE 42P07, 42710, 42P16) so the harness works whether the schema
 * was applied fresh or the migrations are being layered on top.
 *
 * Returns the list of migration files that were applied.
 */
export async function applySchemaAndMigrations(): Promise<string[]> {
  const client = await connectTestClient();
  try {
    const schemaPath = join(__dirname, "..", "..", "..", "src", "db", "schema.sql");
    await client.query(readFileSync(schemaPath, "utf8"));

    const migrationsDir = join(__dirname, "..", "..", "..", "src", "db", "migrations");
    const migrations = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const applied: string[] = [];
    for (const file of migrations) {
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      try {
        await client.query(sql);
        applied.push(file);
      } catch (err) {
        const code = (err as { code?: string }).code;
        // Idempotency: schema.sql may already have created these objects.
        if (code === "42P07" || code === "42710" || code === "42P16") {
          applied.push(`${file} (skipped: already applied)`);
          continue;
        }
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return applied;
  } finally {
    await client.end();
  }
}

/**
 * Truncates the methodology, incident, and partitioned readings/evidence
 * tables.  Safe to call even if some tables are absent (e.g. when a suite
 * runs against a schema-only database).
 */
export async function truncateExtendedTables(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  );
  const existing = new Set(rows.map((r) => r.tablename));
  const present = ALL_EXTENDED_TABLES.filter((t) => existing.has(t));
  await truncateTables(pool, present);
}
