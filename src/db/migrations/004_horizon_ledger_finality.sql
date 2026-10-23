-- Migration: ledger finality and reorg tracking for Horizon-derived readings.
--
-- Readings record the source ledger sequence and hash. Reorgs are detected by
-- comparing the stored hash for a sequence with the hash Horizon now reports,
-- never by trusting a boolean flag. Corrections are appended to the evidence
-- ledger; readings and decisions are marked invalidated/superseded, not deleted.

BEGIN;

CREATE TABLE IF NOT EXISTS horizon_ledgers (
  sequence     BIGINT        PRIMARY KEY,
  hash         VARCHAR(64)   NOT NULL,
  prev_hash    VARCHAR(64),
  closed_at    TIMESTAMPTZ,
  observed_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oracle_decisions (
  id                BIGSERIAL     PRIMARY KEY,
  coverage_type     VARCHAR(32)   NOT NULL,
  status            VARCHAR(16)   NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'superseded')),
  decided_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  superseded_at     TIMESTAMPTZ,
  superseded_reason TEXT
);

CREATE TABLE IF NOT EXISTS horizon_readings (
  id               BIGSERIAL     PRIMARY KEY,
  coverage_type    VARCHAR(32)   NOT NULL,
  source           VARCHAR(40)   NOT NULL DEFAULT 'Horizon',
  value            NUMERIC       NOT NULL,
  ledger_sequence  BIGINT        NOT NULL,
  ledger_hash      VARCHAR(64)   NOT NULL,
  finality         VARCHAR(16)   NOT NULL DEFAULT 'provisional'
                     CHECK (finality IN ('provisional', 'final', 'invalidated')),
  decision_id      BIGINT        REFERENCES oracle_decisions(id),
  recorded_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  finalized_at     TIMESTAMPTZ,
  invalidated_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_horizon_readings_ledger
  ON horizon_readings(ledger_sequence);
CREATE INDEX IF NOT EXISTS idx_horizon_readings_type_finality
  ON horizon_readings(coverage_type, finality);

-- Append-only correction trail.
CREATE TABLE IF NOT EXISTS oracle_evidence_ledger (
  id               BIGSERIAL     PRIMARY KEY,
  event_type       VARCHAR(32)   NOT NULL CHECK (
    event_type IN ('LEDGER_REORG', 'READING_INVALIDATED', 'DECISION_SUPERSEDED')
  ),
  ledger_sequence  BIGINT,
  reading_id       BIGINT        REFERENCES horizon_readings(id),
  decision_id      BIGINT        REFERENCES oracle_decisions(id),
  old_hash         VARCHAR(64),
  new_hash         VARCHAR(64),
  detail           JSONB         NOT NULL DEFAULT '{}'::jsonb,
  recorded_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Safe resume point: last ledger that reached the confirmation depth.
CREATE TABLE IF NOT EXISTS horizon_ingest_checkpoints (
  checkpoint_key     VARCHAR(64)  PRIMARY KEY,
  last_final_ledger  BIGINT       NOT NULL CHECK (last_final_ledger >= 0),
  last_final_hash    VARCHAR(64),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMIT;
