-- Migration: freshness validity state on oracle readings (issue #186)
-- PostgreSQL 15+
--
-- Apply after 001_idempotency_and_oracle_partitioning.sql:
--   psql "$DATABASE_URL" -f src/db/migrations/004_oracle_reading_validity.sql
--
-- Readings that fail the ingestion freshness guard (src/oracle/freshnessPolicy.ts)
-- are still persisted, marked usable = false with a rejection reason, and are
-- excluded from corroboration. Existing rows default to usable = true.

ALTER TABLE oracle_events
  ADD COLUMN IF NOT EXISTS usable           BOOLEAN     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS rejection_reason VARCHAR(32);

-- Rejection reasons: missing_timestamp | future_dated | too_old | heartbeat_gap
ALTER TABLE oracle_events
  ADD CONSTRAINT oracle_events_rejection_reason_check
  CHECK (rejection_reason IS NULL OR rejection_reason IN
    ('missing_timestamp', 'future_dated', 'too_old', 'heartbeat_gap'));

-- An unusable reading must always carry the reason it was rejected.
ALTER TABLE oracle_events
  ADD CONSTRAINT oracle_events_usable_reason_check
  CHECK (usable OR rejection_reason IS NOT NULL);
