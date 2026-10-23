-- Migration: archive manifest and dispute pins for oracle_events partitions
-- PostgreSQL 15+
--
-- Apply on top of src/db/migrations/001_idempotency_and_oracle_partitioning.sql:
--   psql "$DATABASE_URL" -f src/db/migrations/004_oracle_partition_archive_lifecycle.sql
--
-- Both tables are small and new, so this migration takes no lock on oracle_events.
-- See docs/oracle-data-retention.md for the retention matrix and restore runbook.

-- ─── Archive manifest ────────────────────────────────────────────────────────
-- One row per archived oracle_events partition. A partition is only eligible
-- to be dropped by OracleRetentionService once its row reaches status
-- 'verified', i.e. the exported artifact was re-read and matched this row's
-- checksum and row count.

CREATE TABLE IF NOT EXISTS oracle_partition_archives (
  partition_name TEXT         PRIMARY KEY,
  row_count      BIGINT       NOT NULL CHECK (row_count >= 0),
  sha256         CHAR(64)     NOT NULL,
  archive_path   TEXT         NOT NULL,
  status         TEXT         NOT NULL CHECK (status IN ('written', 'verified')),
  archived_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  verified_at    TIMESTAMPTZ,
  CHECK (status <> 'verified' OR verified_at IS NOT NULL)
);

-- ─── Dispute pins ────────────────────────────────────────────────────────────
-- A partition with an open pin (released_at IS NULL) must not be dropped while
-- a dispute that references its readings is open. Release by setting
-- released_at once the dispute window has elapsed.

CREATE TABLE IF NOT EXISTS oracle_partition_pins (
  id             BIGSERIAL    PRIMARY KEY,
  partition_name TEXT         NOT NULL,
  reason         TEXT         NOT NULL,
  pinned_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  released_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_oracle_partition_pins_open
  ON oracle_partition_pins (partition_name)
  WHERE released_at IS NULL;
