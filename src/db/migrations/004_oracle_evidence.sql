-- Migration: append-only oracle evidence ledger (issue #176)
-- PostgreSQL 15+
--
-- Links source reading -> corroboration decision -> settlement so a payout
-- can be audited after the process that produced it has gone.
--
--   oracle_evidence   one row per oracle reading as ingested
--   oracle_decisions  one row per settlement decision, written BEFORE the
--                     payout transaction is submitted; only the settlement
--                     status/hash/timestamp columns may change afterwards
--
-- All writes go through src/oracle/evidenceStore.ts.
--
-- Safe to re-run: every statement is IF NOT EXISTS / CREATE OR REPLACE /
-- DROP TRIGGER IF EXISTS before CREATE TRIGGER.
--
-- Apply on top of src/db/schema.sql:
--   psql "$DATABASE_URL" -f src/db/migrations/004_oracle_evidence.sql

BEGIN;

-- ─── Readings ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oracle_evidence (
  id               UUID           PRIMARY KEY,
  source           VARCHAR(40)    NOT NULL,
  coverage_type    TEXT           NOT NULL,
  normalized_value NUMERIC(20, 6) NOT NULL,
  -- Size-capped by EvidenceStore before insert; secrets redacted there too.
  raw_payload      TEXT           NOT NULL,
  observed_at      TIMESTAMPTZ    NOT NULL,
  ingested_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oracle_evidence_coverage_observed
  ON oracle_evidence (coverage_type, observed_at);

-- ─── Decisions ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oracle_decisions (
  id                 UUID           PRIMARY KEY,
  reading_ids        UUID[]         NOT NULL,
  chosen_value       NUMERIC(20, 6) NOT NULL,
  rule               TEXT           NOT NULL,
  policy_id          TEXT           NOT NULL,
  payout_amount      NUMERIC(38, 18) NOT NULL,
  decided_at         TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  -- Backfilled after the settlement transaction resolves.
  settlement_status  TEXT           NOT NULL DEFAULT 'pending'
                       CHECK (settlement_status IN ('pending', 'confirmed', 'unconfirmed')),
  settlement_tx_hash TEXT,
  settled_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_oracle_decisions_policy
  ON oracle_decisions (policy_id, decided_at);

-- ─── Append-only guards ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION oracle_evidence_reject_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'oracle_evidence is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS oracle_evidence_no_update ON oracle_evidence;
CREATE TRIGGER oracle_evidence_no_update
  BEFORE UPDATE OR DELETE ON oracle_evidence
  FOR EACH ROW EXECUTE FUNCTION oracle_evidence_reject_mutation();

DROP TRIGGER IF EXISTS oracle_evidence_no_truncate ON oracle_evidence;
CREATE TRIGGER oracle_evidence_no_truncate
  BEFORE TRUNCATE ON oracle_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION oracle_evidence_reject_mutation();

-- Decisions: DELETE is always rejected; UPDATE may only touch the settlement
-- backfill columns. Everything that describes the decision itself is frozen.
CREATE OR REPLACE FUNCTION oracle_decisions_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'oracle_decisions is append-only: DELETE is not permitted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF (NEW.id, NEW.reading_ids, NEW.chosen_value, NEW.rule, NEW.policy_id,
      NEW.payout_amount, NEW.decided_at)
     IS DISTINCT FROM
     (OLD.id, OLD.reading_ids, OLD.chosen_value, OLD.rule, OLD.policy_id,
      OLD.payout_amount, OLD.decided_at) THEN
    RAISE EXCEPTION 'oracle_decisions: only settlement_status, settlement_tx_hash and settled_at may be updated'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS oracle_decisions_guard ON oracle_decisions;
CREATE TRIGGER oracle_decisions_guard
  BEFORE UPDATE OR DELETE ON oracle_decisions
  FOR EACH ROW EXECUTE FUNCTION oracle_decisions_guard();

COMMIT;
