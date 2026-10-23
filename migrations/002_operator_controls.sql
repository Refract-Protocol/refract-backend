-- Migration: operator controls (feed pause/resume, source quarantine, audit log) — issue #201
-- Apply with: psql "$DATABASE_URL" -f migrations/002_operator_controls.sql

CREATE TABLE IF NOT EXISTS oracle_feed_controls (
  coverage_type coverage_type PRIMARY KEY,
  paused        BOOLEAN       NOT NULL DEFAULT false,
  reason        TEXT,
  updated_by    VARCHAR(80)   NOT NULL,
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oracle_source_quarantine (
  source        VARCHAR(40)   PRIMARY KEY,
  quarantined   BOOLEAN       NOT NULL DEFAULT false,
  reason        TEXT,
  updated_by    VARCHAR(80)   NOT NULL,
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS operator_audit_log (
  id          BIGSERIAL     PRIMARY KEY,
  operator    VARCHAR(80)   NOT NULL,
  action      VARCHAR(40)   NOT NULL,
  target      VARCHAR(80)   NOT NULL,
  reason      TEXT          NOT NULL,
  before      JSONB,
  after       JSONB,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operator_audit_created
  ON operator_audit_log (created_at DESC);
