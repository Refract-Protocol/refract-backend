-- 004_oracle_consensus_windows.sql
-- Adds event-time consensus windows and late-arrival tracking columns for
-- deterministic watermark-based oracle consensus (#285).

CREATE TABLE IF NOT EXISTS oracle_consensus_windows (
  window_id                 TEXT PRIMARY KEY,
  feed_id                   TEXT NOT NULL,
  window_start_ms           BIGINT NOT NULL,
  window_end_ms             BIGINT NOT NULL,
  allowed_lateness_ms       BIGINT NOT NULL DEFAULT 0,
  quorum_size               INTEGER NOT NULL,
  late_policy               TEXT NOT NULL CHECK (late_policy IN ('drop', 'carry_next')),
  status                    TEXT NOT NULL CHECK (status IN ('open', 'quorum_reached', 'insufficient_quorum', 'empty_window')),
  median_value              NUMERIC,
  participating_sources     JSONB NOT NULL DEFAULT '[]'::jsonb,
  readings_hash             TEXT,
  evaluated_at_watermark_ms BIGINT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_oracle_consensus_window_bounds CHECK (window_end_ms > window_start_ms)
);

CREATE INDEX IF NOT EXISTS idx_oracle_consensus_windows_feed_bounds
  ON oracle_consensus_windows (feed_id, window_start_ms DESC);

ALTER TABLE IF EXISTS oracle_events
  ADD COLUMN IF NOT EXISTS window_id TEXT,
  ADD COLUMN IF NOT EXISTS is_late BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS late_policy_action TEXT NOT NULL DEFAULT 'on_time',
  ADD COLUMN IF NOT EXISTS carried_from_window_id TEXT;

CREATE INDEX IF NOT EXISTS idx_oracle_events_window_id
  ON oracle_events (window_id)
  WHERE window_id IS NOT NULL;
