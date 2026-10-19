-- Apply to an existing database to store upstream observation time and payload
-- digest on oracle readings, and to dedupe replayed readings.
--   psql "$DATABASE_URL" -f src/db/migrations/004_oracle_reading_admission.sql

-- Nullable: rows written before this migration have no observation time.
-- The application rejects new readings that lack one (see oracle-timestamp.ts).
ALTER TABLE oracle_events
  ADD COLUMN IF NOT EXISTS observed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payload_digest CHAR(64);

-- Replay guard: one receipt per (source, observation time, payload digest).
-- Kept separate from the monthly-partitioned oracle_events, whose unique keys
-- must include recorded_at and therefore cannot enforce this globally.
CREATE TABLE IF NOT EXISTS oracle_reading_receipts (
  source          VARCHAR(40)   NOT NULL,
  observed_at     TIMESTAMPTZ   NOT NULL,
  payload_digest  CHAR(64)      NOT NULL,
  received_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source, observed_at, payload_digest)
);

-- Supports retention cleanup of old receipts.
CREATE INDEX IF NOT EXISTS idx_oracle_reading_receipts_received_at
  ON oracle_reading_receipts (received_at);
