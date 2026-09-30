-- Migration 001: add lp_position_events append-only ledger
-- Apply against an existing database that already has schema.sql applied:
--   psql "$DATABASE_URL" -f src/db/migrations/001_add_lp_position_events.sql

CREATE TABLE IF NOT EXISTS lp_position_events (
  id              BIGSERIAL       PRIMARY KEY,
  provider        VARCHAR(56)     NOT NULL,
  event_type      VARCHAR(20)     NOT NULL CHECK (event_type IN ('deposit', 'withdrawal', 'premium_accrual')),
  delta_shares    NUMERIC(30, 0)  NOT NULL,
  delta_usdc      NUMERIC(30, 0)  NOT NULL,
  tx_hash         VARCHAR(64),
  ledger_seq      BIGINT,
  recorded_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  CONSTRAINT lp_position_events_provider_fk
    FOREIGN KEY (provider) REFERENCES lp_positions(provider)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lp_events_provider ON lp_position_events(provider, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_lp_events_tx       ON lp_position_events(tx_hash) WHERE tx_hash IS NOT NULL;
