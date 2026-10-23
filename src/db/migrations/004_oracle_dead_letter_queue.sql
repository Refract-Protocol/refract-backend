-- Migration: dead-letter queue for failed oracle ingestions
-- PostgreSQL 15+
--
-- Apply on top of src/db/schema.sql and 001_idempotency_and_oracle_partitioning.sql:
--   psql "$DATABASE_URL" -f src/db/migrations/004_oracle_dead_letter_queue.sql
--
-- Readings that fail validation (unknown coverage type) or persistence are
-- written here instead of being dropped. Replay re-runs a row through the
-- normal oracle_events insert path; replayed rows are tagged so they can never
-- be confused with first-pass readings.

-- ─── Dead-letter queue ───────────────────────────────────────────────────────
-- coverage_type is stored raw (as received) because a validation failure may
-- be exactly an unrecognised coverage type; it is mapped at replay time.
CREATE TABLE IF NOT EXISTS oracle_dead_letters (
  id              BIGSERIAL     PRIMARY KEY,
  coverage_type   TEXT          NOT NULL,
  source          VARCHAR(40)   NOT NULL,
  window_start    TIMESTAMPTZ   NOT NULL,
  window_end      TIMESTAMPTZ   NOT NULL,
  error_class     VARCHAR(64)   NOT NULL,
  error_message   TEXT,
  payload         JSONB,        -- NULL when the reading was unavailable
  attempts        INT           NOT NULL DEFAULT 1,
  replay_outcome  VARCHAR(16)   CHECK (replay_outcome IN ('inserted', 'duplicate')),
  replayed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CHECK (window_end >= window_start)
);

-- Pending depth and replay ordering: only unreplayed rows are scanned.
CREATE INDEX IF NOT EXISTS idx_oracle_dead_letters_pending
  ON oracle_dead_letters (id)
  WHERE replayed_at IS NULL;

-- Retention sweep: purge replayed rows older than the cutoff.
CREATE INDEX IF NOT EXISTS idx_oracle_dead_letters_replayed_at
  ON oracle_dead_letters (replayed_at)
  WHERE replayed_at IS NOT NULL;

-- ─── Replay provenance on oracle_events ──────────────────────────────────────
-- Non-NULL only for readings inserted by a dead-letter replay. Added to the
-- partitioned parent, so it propagates to every monthly partition.
ALTER TABLE oracle_events
  ADD COLUMN IF NOT EXISTS replayed_from_dead_letter_id BIGINT;
