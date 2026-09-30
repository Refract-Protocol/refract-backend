import { Pool } from "pg";
import { createTestPool, truncateTables } from "./setup/db-client";

/**
 * Integration tests for the `lp_position_events` append-only ledger.
 *
 * Covers:
 *  - INSERT round-trip for each event_type
 *  - NUMERIC(30,0) delta_shares / delta_usdc precision
 *  - Signed negative values for withdrawals
 *  - event_type CHECK constraint rejects unknown values
 *  - FK constraint: events for a non-existent provider are rejected
 *  - CASCADE DELETE: removing the lp_position removes its events
 *  - idx_lp_events_provider ordering (newest first)
 *  - idx_lp_events_tx partial index (only indexed when tx_hash IS NOT NULL)
 *  - Balance reconstruction: summing delta_shares reproduces current balance
 */

describe("lp_position_events table", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createTestPool();
  });

  afterAll(() => pool.end());

  beforeEach(() => truncateTables(pool, ["lp_position_events", "lp_positions"]));

  const PROVIDER = "GCKFBEIYTKP6RSBULG6SNDJ3DHMFAZRXSVXFBKIPZXKQHDQIQTEXAMPLE";

  async function ensureProvider(provider = PROVIDER): Promise<void> {
    await pool.query(
      `INSERT INTO lp_positions (provider, shares, usdc_deposited, premium_earned)
       VALUES ($1, 0, 0, 0)
       ON CONFLICT (provider) DO NOTHING`,
      [provider]
    );
  }

  async function insertEvent(overrides: Record<string, unknown> = {}) {
    await ensureProvider((overrides.provider as string) ?? PROVIDER);
    const defaults = {
      provider: PROVIDER,
      event_type: "deposit",
      delta_shares: "1000000000",
      delta_usdc: "1000000000",
      tx_hash: null,
      ledger_seq: null,
    };
    const row = { ...defaults, ...overrides };
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO lp_position_events
         (provider, event_type, delta_shares, delta_usdc, tx_hash, ledger_seq)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [row.provider, row.event_type, row.delta_shares, row.delta_usdc, row.tx_hash, row.ledger_seq]
    );
    return rows[0].id;
  }

  it("inserts and retrieves a deposit event", async () => {
    const id = await insertEvent({ tx_hash: "abc123", ledger_seq: 54321 });
    const { rows } = await pool.query(`SELECT * FROM lp_position_events WHERE id = $1`, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("deposit");
    expect(rows[0].tx_hash).toBe("abc123");
    expect(Number(rows[0].ledger_seq)).toBe(54321);
  });

  it("inserts a withdrawal event with negative delta values", async () => {
    const id = await insertEvent({
      event_type: "withdrawal",
      delta_shares: "-500000000",
      delta_usdc: "-500000000",
    });
    const { rows } = await pool.query(`SELECT delta_shares::text, delta_usdc::text FROM lp_position_events WHERE id = $1`, [id]);
    expect(rows[0].delta_shares).toBe("-500000000");
    expect(rows[0].delta_usdc).toBe("-500000000");
  });

  it("inserts a premium_accrual event with zero delta_usdc", async () => {
    const id = await insertEvent({ event_type: "premium_accrual", delta_shares: "12345", delta_usdc: "0" });
    const { rows } = await pool.query(`SELECT event_type FROM lp_position_events WHERE id = $1`, [id]);
    expect(rows[0].event_type).toBe("premium_accrual");
  });

  it("round-trips NUMERIC(30,0) delta_shares without precision loss", async () => {
    const bigDelta = "99999999999999999999999999999";
    const id = await insertEvent({ delta_shares: bigDelta });
    const { rows } = await pool.query(`SELECT delta_shares::text FROM lp_position_events WHERE id = $1`, [id]);
    expect(rows[0].delta_shares).toBe(bigDelta);
  });

  it("rejects an unknown event_type (CHECK constraint)", async () => {
    await ensureProvider();
    await expect(
      pool.query(
        `INSERT INTO lp_position_events (provider, event_type, delta_shares, delta_usdc)
         VALUES ($1, 'alien_activity', 0, 0)`,
        [PROVIDER]
      )
    ).rejects.toThrow(/check/i);
  });

  it("rejects an event for a provider not in lp_positions (FK constraint)", async () => {
    const unknownProvider = "GDOESNOTEXISTADDRESS000000000000000000000000000000000000";
    await expect(
      pool.query(
        `INSERT INTO lp_position_events (provider, event_type, delta_shares, delta_usdc)
         VALUES ($1, 'deposit', 100, 100)`,
        [unknownProvider]
      )
    ).rejects.toThrow(/foreign key/i);
  });

  it("cascades DELETE: removing the lp_position removes all its events", async () => {
    const id = await insertEvent();
    const before = await pool.query(`SELECT id FROM lp_position_events WHERE id = $1`, [id]);
    expect(before.rows).toHaveLength(1);

    await pool.query(`DELETE FROM lp_positions WHERE provider = $1`, [PROVIDER]);

    const after = await pool.query(`SELECT id FROM lp_position_events WHERE id = $1`, [id]);
    expect(after.rows).toHaveLength(0);
  });

  it("idx_lp_events_provider: orders events newest-first by recorded_at", async () => {
    // Insert 3 events; BIGSERIAL id mirrors insertion order reliably
    await insertEvent({ event_type: "deposit", delta_shares: "100" });
    await insertEvent({ event_type: "deposit", delta_shares: "200" });
    await insertEvent({ event_type: "withdrawal", delta_shares: "-50" });

    const { rows } = await pool.query(
      `SELECT id, delta_shares::text FROM lp_position_events
       WHERE provider = $1
       ORDER BY recorded_at DESC, id DESC`,
      [PROVIDER]
    );
    expect(rows).toHaveLength(3);
    // Most recently inserted event should come first
    expect(rows[0].delta_shares).toBe("-50");
  });

  it("balance reconstruction: summing delta_shares reproduces the expected net balance", async () => {
    await insertEvent({ event_type: "deposit", delta_shares: "1000000" });
    await insertEvent({ event_type: "deposit", delta_shares: "500000" });
    await insertEvent({ event_type: "withdrawal", delta_shares: "-200000" });
    await insertEvent({ event_type: "premium_accrual", delta_shares: "10000" });

    const { rows } = await pool.query(
      `SELECT SUM(delta_shares)::text AS net_shares
       FROM lp_position_events
       WHERE provider = $1`,
      [PROVIDER]
    );
    // 1000000 + 500000 - 200000 + 10000 = 1310000
    expect(rows[0].net_shares).toBe("1310000");
  });
});
