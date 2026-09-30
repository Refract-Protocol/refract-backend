-- Migration: settlement attempt tracking + dead-letter queue (issue #48)
-- Apply with: psql "$DATABASE_URL" -f migrations/001_settlement_attempts.sql

CREATE TYPE settlement_error_class AS ENUM (
  'transient',
  'permanent',
  'indeterminate'
);

CREATE TABLE IF NOT EXISTS settlement_attempts (
  policy_id         UUID            PRIMARY KEY REFERENCES policies(id),
  holder            VARCHAR(56)     NOT NULL,
  attempt_count     INTEGER         NOT NULL DEFAULT 0,
  first_attempt_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  last_attempt_at   TIMESTAMPTZ,
  last_error        TEXT,
  last_error_class  settlement_error_class,
  pending_tx_hash   VARCHAR(64),
  dead_lettered     BOOLEAN         NOT NULL DEFAULT false,
  dead_lettered_at  TIMESTAMPTZ,
  error_history     JSONB           NOT NULL DEFAULT '[]',
  updated_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settlement_attempts_dead ON settlement_attempts(dead_lettered)
  WHERE dead_lettered = true;
