-- Migration: operator pause controls + append-only audit for oracle-driven payouts (issue #179)
-- Apply with: psql "$DATABASE_URL" -f src/db/migrations/004_oracle_pause_controls.sql

-- Current pause state. One row per scope: 'global' (override for every coverage
-- type) or a coverage type key from COVERAGE_TYPE_CODE. A missing row means "not paused".
CREATE TABLE IF NOT EXISTS oracle_pause_state (
  scope       VARCHAR(32)   PRIMARY KEY,
  paused      BOOLEAN       NOT NULL DEFAULT false,
  reason      TEXT,
  actor       VARCHAR(128),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Every pause/resume, with the state it replaced. Rows are never updated or deleted.
CREATE TABLE IF NOT EXISTS oracle_pause_audit (
  id            BIGSERIAL     PRIMARY KEY,
  scope         VARCHAR(32)   NOT NULL,
  action        VARCHAR(16)   NOT NULL CHECK (action IN ('pause', 'resume')),
  actor         VARCHAR(128)  NOT NULL CHECK (length(btrim(actor)) > 0),
  reason        TEXT          NOT NULL CHECK (length(btrim(reason)) > 0),
  prior_paused  BOOLEAN       NOT NULL,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oracle_pause_audit_scope_created ON oracle_pause_audit(scope, created_at);

CREATE OR REPLACE FUNCTION reject_oracle_pause_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'oracle_pause_audit is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS oracle_pause_audit_append_only ON oracle_pause_audit;
CREATE TRIGGER oracle_pause_audit_append_only
  BEFORE UPDATE OR DELETE ON oracle_pause_audit
  FOR EACH ROW EXECUTE FUNCTION reject_oracle_pause_audit_mutation();
