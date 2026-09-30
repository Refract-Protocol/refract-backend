/**
 * Migration 001 — Baseline schema
 *
 * Derived verbatim from src/db/schema.sql (the hand-maintained DDL that
 * existed before node-pg-migrate was introduced).  Every subsequent
 * schema change MUST go in a new, numbered migration — never edit this
 * file after the first deployment.
 */
import type { MigrationBuilder, ColumnDefinitions } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // ── Extensions ────────────────────────────────────────────────────────────
  pgm.createExtension("uuid-ossp", { ifNotExists: true });

  // ── Enum ──────────────────────────────────────────────────────────────────
  pgm.createType("coverage_type", [
    "stablecoin_depeg",
    "market_crash",
    "liquidation_shield",
    "smart_contract_risk",
    "flight_delay",
  ]);

  // ── pool_snapshots ────────────────────────────────────────────────────────
  pgm.createTable("pool_snapshots", {
    id: { type: "bigserial", primaryKey: true },
    total_usdc: { type: "numeric(30,0)", notNull: true },
    total_shares: { type: "numeric(30,0)", notNull: true },
    locked_usdc: { type: "numeric(30,0)", notNull: true },
    premium_accrued: { type: "numeric(30,0)", notNull: true },
    share_price: { type: "numeric(20,7)", notNull: true },
    utilization_bps: { type: "smallint", notNull: true },
    apy_bps: { type: "smallint", notNull: true },
    snapshotted_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  // ── policies ──────────────────────────────────────────────────────────────
  pgm.createTable("policies", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("uuid_generate_v4()") },
    policy_id: { type: "varchar(32)", unique: true }, // on-chain policy ID
    holder: { type: "varchar(56)", notNull: true }, // Stellar address
    coverage_type: { type: "coverage_type", notNull: true },
    coverage_amount: { type: "numeric(30,0)", notNull: true },
    premium: { type: "numeric(30,0)", notNull: true },
    duration_days: { type: "smallint", notNull: true },
    expires_at: { type: "timestamptz", notNull: true },
    trigger_params: { type: "jsonb", notNull: true, default: pgm.func("'{}'::jsonb") },
    is_active: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.createIndex("policies", "holder", { name: "idx_policies_holder" });
  pgm.createIndex("policies", "coverage_type", { name: "idx_policies_type" });
  pgm.createIndex("policies", ["is_active", "expires_at"], { name: "idx_policies_active" });

  // ── claims ────────────────────────────────────────────────────────────────
  pgm.createTable("claims", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("uuid_generate_v4()") },
    policy_id: { type: "uuid", notNull: true, references: '"policies"' },
    holder: { type: "varchar(56)", notNull: true },
    coverage_type: { type: "coverage_type", notNull: true },
    payout: { type: "numeric(30,0)", notNull: true },
    trigger_value: { type: "numeric(20,6)", notNull: true },
    trigger_source: { type: "varchar(40)", notNull: true },
    tx_hash: { type: "varchar(64)" },
    processed_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.createIndex("claims", "holder", { name: "idx_claims_holder" });
  pgm.createIndex("claims", "policy_id", { name: "idx_claims_policy" });

  // ── oracle_events ─────────────────────────────────────────────────────────
  pgm.createTable("oracle_events", {
    id: { type: "bigserial", primaryKey: true },
    coverage_type: { type: "coverage_type", notNull: true },
    value: { type: "numeric(20,6)", notNull: true },
    source: { type: "varchar(40)", notNull: true },
    severity: { type: "varchar(10)", notNull: true }, // low | medium | high | triggered
    recorded_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.createIndex("oracle_events", ["coverage_type", "recorded_at"], {
    name: "idx_oracle_type",
    order: { recorded_at: "DESC" },
  });

  // ── lp_positions ──────────────────────────────────────────────────────────
  pgm.createTable("lp_positions", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("uuid_generate_v4()") },
    provider: { type: "varchar(56)", notNull: true, unique: true },
    shares: { type: "numeric(30,0)", notNull: true, default: 0 },
    usdc_deposited: { type: "numeric(30,0)", notNull: true, default: 0 },
    premium_earned: { type: "numeric(30,0)", notNull: true, default: 0 },
    first_deposit: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    last_updated: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  // ── premium_revenue ───────────────────────────────────────────────────────
  pgm.createTable("premium_revenue", {
    id: { type: "bigserial", primaryKey: true },
    policy_id: { type: "uuid", notNull: true, references: '"policies"' },
    amount: { type: "numeric(30,0)", notNull: true },
    coverage_type: { type: "coverage_type", notNull: true },
    collected_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("premium_revenue");
  pgm.dropTable("lp_positions");
  pgm.dropTable("oracle_events");
  pgm.dropTable("claims");
  pgm.dropTable("policies");
  pgm.dropTable("pool_snapshots");
  pgm.dropType("coverage_type");
  pgm.dropExtension("uuid-ossp");
}
