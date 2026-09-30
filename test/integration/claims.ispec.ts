import { Pool } from "pg";
import { createTestPool, truncateTables } from "./setup/db-client";

/**
 * Integration tests for the `claims` table.
 *
 * Covers:
 *  - INSERT with a valid policy FK and SELECT round-trip
 *  - NUMERIC(20,6) trigger_value precision
 *  - FK constraint: inserting a claim for a non-existent policy_id fails
 *  - Cascading DELETE: removing a policy removes its claims
 *  - holder index path (idx_claims_holder)
 */

describe("claims table", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createTestPool();
  });

  afterAll(() => pool.end());

  beforeEach(() => truncateTables(pool, ["claims", "premium_revenue", "policies"]));

  // ── helpers ────────────────────────────────────────────────────────────

  const HOLDER = "GCKFBEIYTKP6RSBULG6SNDJ3DHMFAZRXSVXFBKIPZXKQHDQIQTEXAMPLE";

  async function insertPolicy(policyId = "POL-001"): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO policies
         (policy_id, holder, coverage_type, coverage_amount, premium,
          duration_days, expires_at, trigger_params, is_active)
       VALUES ($1,$2,'stablecoin_depeg','1000000','50000',30,$3,'{}',true)
       RETURNING id`,
      [policyId, HOLDER, new Date(Date.now() + 30 * 86400 * 1000).toISOString()]
    );
    return rows[0].id;
  }

  async function insertClaim(policyUuid: string, overrides: Record<string, unknown> = {}) {
    const defaults = {
      policy_id: policyUuid,
      holder: HOLDER,
      coverage_type: "stablecoin_depeg",
      payout: "1000000",
      trigger_value: "0.942000",
      trigger_source: "coingecko",
      tx_hash: "abc123",
    };
    const row = { ...defaults, ...overrides };
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO claims
         (policy_id, holder, coverage_type, payout, trigger_value, trigger_source, tx_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [
        row.policy_id,
        row.holder,
        row.coverage_type,
        row.payout,
        row.trigger_value,
        row.trigger_source,
        row.tx_hash,
      ]
    );
    return rows[0].id;
  }

  // ── tests ──────────────────────────────────────────────────────────────

  it("inserts and retrieves a claim row", async () => {
    const policyUuid = await insertPolicy();
    const claimId = await insertClaim(policyUuid);

    const { rows } = await pool.query(`SELECT * FROM claims WHERE id = $1`, [claimId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].holder).toBe(HOLDER);
    expect(rows[0].coverage_type).toBe("stablecoin_depeg");
    expect(rows[0].tx_hash).toBe("abc123");
  });

  it("round-trips NUMERIC(20,6) trigger_value with full precision", async () => {
    const policyUuid = await insertPolicy();
    await insertClaim(policyUuid, { trigger_value: "0.942137" });

    const { rows } = await pool.query(`SELECT trigger_value::text FROM claims WHERE policy_id = $1`, [policyUuid]);
    expect(rows[0].trigger_value).toBe("0.942137");
  });

  it("rejects a claim referencing a non-existent policy (FK constraint)", async () => {
    const fakeUuid = "00000000-0000-0000-0000-000000000000";
    await expect(insertClaim(fakeUuid)).rejects.toThrow(/foreign key/i);
  });

  it("cascades DELETE: removing a policy removes its claims", async () => {
    const policyUuid = await insertPolicy();
    const claimId = await insertClaim(policyUuid);

    // Verify claim exists before deletion
    const before = await pool.query(`SELECT id FROM claims WHERE id = $1`, [claimId]);
    expect(before.rows).toHaveLength(1);

    await pool.query(`DELETE FROM policies WHERE id = $1`, [policyUuid]);

    const after = await pool.query(`SELECT id FROM claims WHERE id = $1`, [claimId]);
    expect(after.rows).toHaveLength(0);
  });

  it("filters claims by holder — idx_claims_holder path", async () => {
    const policyA = await insertPolicy("POL-A");
    const policyB = await insertPolicy("POL-B");

    const OTHER_HOLDER = "GDIFFERENTADDRESSEXAMPLE000000000000000000000000000000000";
    await insertClaim(policyA); // HOLDER
    await insertClaim(policyB, { holder: OTHER_HOLDER }); // OTHER_HOLDER

    const { rows } = await pool.query(`SELECT id FROM claims WHERE holder = $1`, [HOLDER]);
    expect(rows).toHaveLength(1);
  });
});
