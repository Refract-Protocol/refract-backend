import { Pool } from "pg";
import { createTestPool, truncateTables } from "./setup/db-client";

/**
 * Integration tests for the `policies` table.
 *
 * Covers:
 *  - Basic INSERT and SELECT round-trip
 *  - NUMERIC(30,0) round-trips as a string without precision loss
 *  - policy_id UNIQUE constraint rejects a duplicate
 *  - coverage_type CHECK (enum) rejects an unknown value
 *  - is_active / expires_at index path (idx_policies_active) — verified
 *    by using a filtered query that the index is designed to accelerate
 *  - Partial deactivation via UPDATE does not affect other rows
 */

describe("policies table", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createTestPool();
  });

  afterAll(() => pool.end());

  beforeEach(() => truncateTables(pool, ["claims", "premium_revenue", "policies"]));

  // ── helpers ────────────────────────────────────────────────────────────

  async function insertPolicy(overrides: Record<string, unknown> = {}) {
    const defaults = {
      policy_id: "POL-001",
      holder: "GCKFBEIYTKP6RSBULG6SNDJ3DHMFAZRXSVXFBKIPZXKQHDQIQTEXAMPLE",
      coverage_type: "stablecoin_depeg",
      coverage_amount: "100000000000", // 10,000 USDC in 1e7 units
      premium: "500000000",
      duration_days: 30,
      expires_at: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      trigger_params: JSON.stringify({}),
      is_active: true,
    };
    const row = { ...defaults, ...overrides };
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO policies
         (policy_id, holder, coverage_type, coverage_amount, premium,
          duration_days, expires_at, trigger_params, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        row.policy_id,
        row.holder,
        row.coverage_type,
        row.coverage_amount,
        row.premium,
        row.duration_days,
        row.expires_at,
        row.trigger_params,
        row.is_active,
      ]
    );
    return rows[0].id;
  }

  // ── tests ──────────────────────────────────────────────────────────────

  it("inserts and retrieves a policy row", async () => {
    const id = await insertPolicy();
    const { rows } = await pool.query(`SELECT * FROM policies WHERE id = $1`, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].holder).toBe("GCKFBEIYTKP6RSBULG6SNDJ3DHMFAZRXSVXFBKIPZXKQHDQIQTEXAMPLE");
    expect(rows[0].coverage_type).toBe("stablecoin_depeg");
    expect(rows[0].is_active).toBe(true);
  });

  it("round-trips NUMERIC(30,0) coverage_amount without precision loss", async () => {
    // Use a value that exceeds JS Number precision to confirm pg doesn't
    // silently coerce it through float64.
    const bigAmount = "99999999999999999999999999999"; // 29 digits
    const id = await insertPolicy({ coverage_amount: bigAmount, policy_id: "POL-BIG" });
    const { rows } = await pool.query(`SELECT coverage_amount::text FROM policies WHERE id = $1`, [id]);
    expect(rows[0].coverage_amount).toBe(bigAmount);
  });

  it("rejects a duplicate policy_id (UNIQUE constraint)", async () => {
    await insertPolicy({ policy_id: "POL-DUP" });
    await expect(insertPolicy({ policy_id: "POL-DUP" })).rejects.toThrow(/unique/i);
  });

  it("rejects an unknown coverage_type (ENUM constraint)", async () => {
    await expect(
      insertPolicy({ coverage_type: "alien_abduction", policy_id: "POL-BAD" })
    ).rejects.toThrow(/invalid input value for enum/i);
  });

  it("filters active unexpired policies — the idx_policies_active path", async () => {
    const futureExpiry = new Date(Date.now() + 86400 * 1000).toISOString();
    const pastExpiry = new Date(Date.now() - 86400 * 1000).toISOString();

    await insertPolicy({ policy_id: "POL-ACTIVE", is_active: true, expires_at: futureExpiry });
    await insertPolicy({ policy_id: "POL-EXPIRED", is_active: true, expires_at: pastExpiry });
    await insertPolicy({ policy_id: "POL-INACTIVE", is_active: false, expires_at: futureExpiry });

    const { rows } = await pool.query(
      `SELECT policy_id FROM policies WHERE is_active = true AND expires_at > NOW()`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].policy_id).toBe("POL-ACTIVE");
  });

  it("deactivates a single policy without affecting others", async () => {
    const id1 = await insertPolicy({ policy_id: "POL-A" });
    await insertPolicy({ policy_id: "POL-B" });

    await pool.query(`UPDATE policies SET is_active = false WHERE id = $1`, [id1]);

    const { rows } = await pool.query(`SELECT policy_id, is_active FROM policies ORDER BY policy_id`);
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.policy_id === "POL-A");
    const b = rows.find((r) => r.policy_id === "POL-B");
    expect(a!.is_active).toBe(false);
    expect(b!.is_active).toBe(true);
  });

  it("filters by coverage_type — the idx_policies_type path", async () => {
    await insertPolicy({ policy_id: "POL-DEPEG", coverage_type: "stablecoin_depeg" });
    await insertPolicy({ policy_id: "POL-CRASH", coverage_type: "market_crash" });

    const { rows } = await pool.query(
      `SELECT policy_id FROM policies WHERE coverage_type = 'market_crash'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].policy_id).toBe("POL-CRASH");
  });
});
