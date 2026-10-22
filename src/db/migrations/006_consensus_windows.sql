-- Migration 006: per-feed consensus windows, windowed readings, and decisions
--
-- Implements deterministic event-time windowing for oracle consensus.
-- Every reading is assigned to a window at ingest time; consensus is
-- evaluated only over closed windows so replay is exact.

-- ── consensus_windows ─────────────────────────────────────────────────────────
-- One row per (feed_id, window_id). window_id is globally unique
-- (format: "<feedId>:<windowStart.toISOString()>").
CREATE TABLE IF NOT EXISTS consensus_windows (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    feed_id      VARCHAR(40) NOT NULL,
    window_id    TEXT        NOT NULL UNIQUE,
    window_start TIMESTAMPTZ NOT NULL,
    window_end   TIMESTAMPTZ NOT NULL,
    status       VARCHAR(12) NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','closed','evaluated')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at    TIMESTAMPTZ,
    evaluated_at TIMESTAMPTZ,
    CONSTRAINT chk_window_bounds CHECK (window_end > window_start)
);

CREATE INDEX IF NOT EXISTS idx_consensus_windows_feed_status
    ON consensus_windows (feed_id, status, window_start ASC);

-- ── consensus_window_readings ─────────────────────────────────────────────────
-- One row per (window_id, source). Duplicate submissions from the same source
-- within a window are suppressed via the UNIQUE constraint.
CREATE TABLE IF NOT EXISTS consensus_window_readings (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    window_id          TEXT        NOT NULL REFERENCES consensus_windows(window_id),
    feed_id            VARCHAR(40) NOT NULL,
    source             VARCHAR(40) NOT NULL,
    value              NUMERIC(20,6) NOT NULL,
    severity           VARCHAR(10) NOT NULL,
    source_timestamp   TIMESTAMPTZ NOT NULL,
    arrival_timestamp  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- True when arrival_timestamp > window_end (but <= watermark).
    is_late            BOOLEAN     NOT NULL DEFAULT false,
    -- True when late and lateArrivalPolicy = 'drop'.
    is_dropped         BOOLEAN     NOT NULL DEFAULT false,
    -- Populated by trigger; true when ON CONFLICT suppressed this row.
    is_duplicate       BOOLEAN     NOT NULL DEFAULT false,
    UNIQUE (window_id, source)
);

CREATE INDEX IF NOT EXISTS idx_cwr_window_id
    ON consensus_window_readings (window_id, is_dropped, source ASC);

-- ── consensus_decisions ───────────────────────────────────────────────────────
-- One row per window_id. Immutable after first write (upsert replaces on retry).
-- input_hash = SHA-256 of sorted reading IDs — replay must produce the same hash.
CREATE TABLE IF NOT EXISTS consensus_decisions (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    feed_id            VARCHAR(40) NOT NULL,
    window_id          TEXT        NOT NULL UNIQUE REFERENCES consensus_windows(window_id),
    window_start       TIMESTAMPTZ NOT NULL,
    window_end         TIMESTAMPTZ NOT NULL,
    reading_count      INTEGER     NOT NULL DEFAULT 0,
    late_reading_count INTEGER     NOT NULL DEFAULT 0,
    value              NUMERIC(20,6) NOT NULL,
    severity           VARCHAR(10) NOT NULL,
    decided_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    input_hash         CHAR(64)    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consensus_decisions_feed_decided
    ON consensus_decisions (feed_id, decided_at DESC);
