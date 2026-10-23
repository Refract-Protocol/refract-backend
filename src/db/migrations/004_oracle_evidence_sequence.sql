-- Migration: ordered, gap-aware oracle evidence trail
-- Apply with: psql "$DATABASE_URL" -f src/db/migrations/004_oracle_evidence_sequence.sql
--
-- OracleEvidenceBuffer assigns every oracle reading and consensus decision
-- a strictly increasing `seq`, spools it locally, and replays it into
-- Postgres in seq order once the database is reachable. These columns make
-- that replay idempotent and let auditors detect holes in the trail.

ALTER TABLE oracle_events
  ADD COLUMN IF NOT EXISTS seq         BIGINT,
  ADD COLUMN IF NOT EXISTS kind        VARCHAR(16) NOT NULL DEFAULT 'reading',  -- reading | decision
  ADD COLUMN IF NOT EXISTS payload     JSONB,
  ADD COLUMN IF NOT EXISTS ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- recorded_at is now the time the evidence was produced (it may be well
-- before ingested_at after an outage). The partition key must be part of
-- any unique index on a partitioned table; seq alone is unique in practice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_oracle_events_seq ON oracle_events (seq, recorded_at);

-- MarketCrash and SmartContractRisk values are percent changes and are
-- negative exactly when they matter. The old non-negative check rejected
-- those rows, which would wedge the ordered replay.
ALTER TABLE oracle_events DROP CONSTRAINT IF EXISTS chk_oracle_value_nonneg;

ALTER TABLE oracle_events DROP CONSTRAINT IF EXISTS chk_oracle_kind_values;
ALTER TABLE oracle_events
  ADD CONSTRAINT chk_oracle_kind_values CHECK (kind IN ('reading', 'decision'));

-- Runs of seqs that could not be made durable (e.g. local disk full while
-- Postgres was also down). Written as soon as durability returns, so a hole
-- in oracle_events.seq is always explained by a row here.
CREATE TABLE IF NOT EXISTS oracle_evidence_gaps (
  seq         BIGINT       PRIMARY KEY,
  first_seq   BIGINT       NOT NULL,
  last_seq    BIGINT       NOT NULL,
  lost_count  INTEGER      NOT NULL CHECK (lost_count > 0),
  opened_at   TIMESTAMPTZ  NOT NULL,
  closed_at   TIMESTAMPTZ  NOT NULL,
  reason      TEXT         NOT NULL,
  ingested_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CHECK (last_seq >= first_seq)
);
