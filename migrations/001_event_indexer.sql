-- Event indexer persistence (issue #43).
-- Apply after src/db/schema.sql:
--   psql "$DATABASE_URL" -f migrations/001_event_indexer.sql
--
-- IMPORTANT: Only ONE replica should run the event indexer (leader election /
-- singleton deployment). Multiple concurrent indexers race on cursor updates
-- and can project the same events twice before idempotency keys settle.

-- ─── Indexer cursor ──────────────────────────────────────────────────────────
-- Persisted resume point: last fully-processed ledger + event id.
-- Cursor advances only after a page is fully processed; a handler failure
-- leaves the cursor at the last successful event so restarts have no gaps.

CREATE TABLE IF NOT EXISTS indexer_cursors (
  cursor_key      TEXT            PRIMARY KEY,
  last_ledger     BIGINT          NOT NULL DEFAULT 0,
  last_event_id   TEXT            NOT NULL DEFAULT '',
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

INSERT INTO indexer_cursors (cursor_key, last_ledger, last_event_id)
VALUES ('soroban_events', 0, '')
ON CONFLICT (cursor_key) DO NOTHING;

-- ─── Processed events (idempotency) ──────────────────────────────────────────
-- Unique on-chain event id so duplicate delivery / reprocessing is a no-op.

CREATE TABLE IF NOT EXISTS processed_events (
  event_id        TEXT            PRIMARY KEY,
  ledger          BIGINT          NOT NULL,
  topic           TEXT            NOT NULL,
  contract_id     TEXT,
  tx_hash         TEXT,
  processed_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processed_events_ledger
  ON processed_events (ledger);
