-- Oracle source bootstrap: seeded history and statistical baselines.
--
-- When a feed or source adapter is onboarded, SourceBootstrapService pulls
-- the adapter's recent history, stores it here, and records a baseline and
-- seeded reputation. Anomaly thresholds, reputation scoring, and
-- corroboration then have a reference point from the first live poll
-- instead of starting cold.
--
-- Seed readings are kept apart from oracle_events on purpose: they are
-- backfilled third-party history, not readings this backend observed or
-- published, so they must never feed claim settlement.

BEGIN;

CREATE TABLE IF NOT EXISTS oracle_source_baselines (
  feed_id               TEXT          NOT NULL,
  source_id             TEXT          NOT NULL,
  adapter               TEXT          NOT NULL,
  status                TEXT          NOT NULL
                        CHECK (status IN ('cold', 'bootstrapping', 'warm', 'insufficient_history', 'failed')),
  -- SourceBaseline: sampleCount, window, mean/stddev, median/MAD, min/max, p05/p95.
  baseline              JSONB,
  reputation            NUMERIC(6, 4) CHECK (reputation IS NULL OR (reputation >= 0 AND reputation <= 1)),
  coverage              NUMERIC(6, 4) CHECK (coverage IS NULL OR (coverage >= 0 AND coverage <= 1)),
  corroboration         NUMERIC(6, 4) CHECK (corroboration IS NULL OR (corroboration >= 0 AND corroboration <= 1)),
  corroborated_buckets  INTEGER       NOT NULL DEFAULT 0,
  lookback_ms           BIGINT        NOT NULL,
  expected_interval_ms  BIGINT        NOT NULL,
  error                 TEXT,
  requested_by          TEXT,
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (feed_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_oracle_source_baselines_status
  ON oracle_source_baselines (status);

CREATE TABLE IF NOT EXISTS oracle_seed_readings (
  feed_id      TEXT              NOT NULL,
  source_id    TEXT              NOT NULL,
  observed_at  TIMESTAMPTZ       NOT NULL,
  value        DOUBLE PRECISION  NOT NULL,
  PRIMARY KEY (feed_id, source_id, observed_at)
);

COMMIT;
