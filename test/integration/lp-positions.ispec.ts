import { Pool } from "pg";
import { createTestPool, truncateTables } from "./setup/db-client";

/**
 * Integration tests for the `lp_positions` table.
 *
 * Covers:
 *  - INSERT + SELECT round-trip
 *  - provider UNIQUE constraint (upsert semantics expected by PoolService)
 *  - INSERT ... ON CONFLICT (provider) DO UPDATE actually upserts
 *  - NUMERIC(30,0) shares and usdc_deposited round-trip without precision loss
 */

describe("lp_positions table", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createTestPool();
  });

  afterAll(() => pool.end());

  beforeEach(() => truncateTables(pool, ["lp_positions"]));

  const PROVIDER = "GCKFBEIYTKP6RSBULG6SNDJ3DHMFAZRXSVXFBKIPZXKQHDQIQTEXAMPLE";

  async function upsertPosition(
    provider: string,
    shares: string,
    usdcDeposited: string,
    premiumEarned: string
  ) {
    await pool.query(
      `INSERT INTO lp_positions (provider, shares, usdc_deposited, premium_earned)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider)
       DO UPDATE SET
         shares         = EXCLUDED.shares,
         usdc_deposited = EXCLUDED.usdc_deposited,
         premium_earned = EXCLUDED.premium_earned,
         last_updated   = NOW()`,
      [provider, shares, usdcDeposited, premiumEarned]
    );
  }

  it("inserts and retrieves an lp_position", async () => {
    await upsertPosition(PROVIDER, "300000000000", "300000000000", "0");
    const { rows } = await pool.query(`SELECT * FROM lp_positions WHERE provider = $1`, [PROVIDER]);
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe(PROVIDER);
  });

  it("round-trips NUMERIC(30,0) shares without precision loss", async () => {
    const bigShares = "12345678901234567890123456789";
    await upsertPosition(PROVIDER, bigShares, "1", "0");
    const { rows } = await pool.query(`SELECT shares::text FROM lp_positions WHERE provider = $1`, [PROVIDER]);
    expect(rows[0].shares).toBe(bigShares);
  });

  it("upserts — second write updates shares, not inserts a new row", async () => {
    await upsertPosition(PROVIDER, "100000", "100000", "0");
    await upsertPosition(PROVIDER, "250000", "250000", "5000");

    const { rows } = await pool.query(`SELECT * FROM lp_positions WHERE provider = $1`, [PROVIDER]);
    expect(rows).toHaveLength(1);
    expect(rows[0].shares).toBe("250000");
    expect(rows[0].usdc_deposited).toBe("250000");
    expect(rows[0].premium_earned).toBe("5000");
  });

  it("rejects a second INSERT without ON CONFLICT (UNIQUE constraint)", async () => {
    await pool.query(
      `INSERT INTO lp_positions (provider, shares, usdc_deposited, premium_earned) VALUES ($1,1,1,0)`,
      [PROVIDER]
    );
    await expect(
      pool.query(
        `INSERT INTO lp_positions (provider, shares, usdc_deposited, premium_earned) VALUES ($1,2,2,0)`,
        [PROVIDER]
      )
    ).rejects.toThrow(/unique/i);
  });
});
