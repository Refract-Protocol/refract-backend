-- Migration: idempotency_keys table, oracle_events partitioning, and retention job
-- PostgreSQL 15+
--
-- Apply on top of src/db/schema.sql:
--   psql "$DATABASE_URL" -f src/db/migrations/001_idempotency_and_oracle_partitioning.sql

-- ─── Idempotency Keys ────────────────────────────────────────────────────────
-- Stores durable idempotency locks and committed responses for state-changing
-- endpoints (POST /policies/buy, POST /pool/provide, POST /pool/withdraw,
-- POST /tx/submit).  See src/common/idempotency.service.ts.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT          NOT NULL,
  endpoint      TEXT          NOT NULL,
  response_body JSONB,
  status_code   SMALLINT,
  committed     BOOLEAN       NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (key, endpoint)
);

-- Automatic cleanup: keys older than 24 hours are safe to discard (clients
-- are not expected to retry a write after 24 hours).
CREATE INDEX IF NOT EXISTS idx_idempotency_created_at
  ON idempotency_keys (created_at);

-- ─── Oracle Events — partitioned table ───────────────────────────────────────
--
-- The original oracle_events is dropped and replaced with a declarative
-- range-partition on recorded_at (monthly buckets).  Each partition is an
-- ordinary table and can be detached + archived independently.
--
-- If you have existing data you want to preserve, export it first:
--   \copy oracle_events TO '/tmp/oracle_events_backup.csv' CSV HEADER
-- Then re-import after this migration completes.

DROP TABLE IF EXISTS oracle_events;

CREATE TABLE oracle_events (
  id            BIGSERIAL,
  coverage_type coverage_type   NOT NULL,
  value         NUMERIC(20, 6)  NOT NULL,
  source        VARCHAR(40)     NOT NULL,
  severity      VARCHAR(10)     NOT NULL,  -- low | medium | high | triggered
  recorded_at   TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, recorded_at)            -- partition key must be in PK
) PARTITION BY RANGE (recorded_at);

-- ── Bootstrap partitions (current + next two months) ─────────────────────────
-- The maintenance job (OracleRetentionService) creates future partitions
-- automatically, but we seed three months here so the table is usable
-- immediately after applying this migration.

DO $$
DECLARE
  start_date  DATE := DATE_TRUNC('month', NOW())::DATE;
  i           INT;
  part_start  DATE;
  part_end    DATE;
  part_name   TEXT;
BEGIN
  FOR i IN 0..2 LOOP
    part_start := start_date + (i || ' months')::INTERVAL;
    part_end   := part_start + INTERVAL '1 month';
    part_name  := 'oracle_events_' || TO_CHAR(part_start, 'YYYY_MM');

    -- Skip if already exists (idempotent re-run).
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = part_name AND n.nspname = 'public'
    ) THEN
      EXECUTE FORMAT(
        'CREATE TABLE %I PARTITION OF oracle_events
           FOR VALUES FROM (%L) TO (%L)',
        part_name, part_start, part_end
      );

      -- Per-partition composite index — "recent readings for one type".
      EXECUTE FORMAT(
        'CREATE INDEX %I ON %I (coverage_type, recorded_at DESC)',
        'idx_' || part_name || '_type', part_name
      );

      RAISE NOTICE 'Created partition % (% → %)', part_name, part_start, part_end;
    END IF;
  END LOOP;
END;
$$;
