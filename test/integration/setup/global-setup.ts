import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Client } from "pg";

/**
 * Jest globalSetup — runs once before any test worker starts.
 *
 * Strategy
 * --------
 * 1. Try to reuse a running Postgres if TEST_DATABASE_URL is already set
 *    (useful for CI services that pre-provision Postgres).
 * 2. Otherwise, start an ephemeral Docker container via `docker run`.
 *    We avoid the `testcontainers` npm package to keep the harness lean;
 *    a plain `docker run -d --rm` is sufficient for CI and local use.
 *
 * The resolved connection URL is written to
 * `process.env.INTEGRATION_DATABASE_URL` so individual test files can
 * read it without re-discovering the container.  A container ID file is
 * written to /tmp so globalTeardown can stop it.
 */

const CONTAINER_ID_FILE = "/tmp/refract-test-pg-container-id";
const PG_IMAGE = "postgres:15-alpine";
const PG_PORT_HOST = 15432;
const PG_USER = "refract_test";
const PG_PASSWORD = "refract_test";
const PG_DB = "refract_test";

export default async function globalSetup(): Promise<void> {
  // ── 1. Honour pre-provisioned URL (CI service containers) ──────────────
  if (process.env.TEST_DATABASE_URL) {
    process.env.INTEGRATION_DATABASE_URL = process.env.TEST_DATABASE_URL;
    await applySchema(process.env.TEST_DATABASE_URL);
    return;
  }

  // ── 2. Start ephemeral Docker container ────────────────────────────────
  console.log("[integration] Starting ephemeral Postgres container...");

  const containerId = execSync(
    `docker run -d --rm \
      -e POSTGRES_USER=${PG_USER} \
      -e POSTGRES_PASSWORD=${PG_PASSWORD} \
      -e POSTGRES_DB=${PG_DB} \
      -p ${PG_PORT_HOST}:5432 \
      ${PG_IMAGE}`,
    { encoding: "utf8" }
  ).trim();

  fs.writeFileSync(CONTAINER_ID_FILE, containerId);

  const dbUrl = `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT_HOST}/${PG_DB}`;
  process.env.INTEGRATION_DATABASE_URL = dbUrl;

  // ── 3. Wait until Postgres is ready ────────────────────────────────────
  await waitForPostgres(dbUrl);

  // ── 4. Apply schema ─────────────────────────────────────────────────────
  await applySchema(dbUrl);

  console.log("[integration] Postgres ready at", dbUrl);
}

/** Poll until the server accepts connections (max 30 s). */
async function waitForPostgres(url: string, maxMs = 30_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const client = new Client({ connectionString: url });
      await client.connect();
      await client.end();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Postgres did not become ready within ${maxMs} ms`);
}

/** Apply src/db/schema.sql to the target database. */
async function applySchema(url: string): Promise<void> {
  const schemaPath = path.resolve(__dirname, "../../../src/db/schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}
