-- Migration 002: oracle trust engine storage (issue #185)
-- Registered oracle sources, immutable per-source readings, consensus decisions
-- with their participating readings, and per-source health state.
-- Apply against an existing database that already has schema.sql applied:
--   psql "$DATABASE_URL" -f src/db/migrations/002_oracle_trust_engine.sql

BEGIN;

-- ─── oracle_sources ──────────────────────────────────────────────────────────
-- Registry of feeds the trust engine may draw from. Sources in the same
-- independence_group are treated as one voice during quorum counting.

CREATE TABLE IF NOT EXISTS oracle_sources (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                TEXT          NOT NULL UNIQUE,
  coverage_types      TEXT[]        NOT NULL DEFAULT '{}',
  source_class        TEXT          NOT NULL,
  independence_group  TEXT          NOT NULL,
  enabled             BOOLEAN       NOT NULL DEFAULT true,
  trust_tier          SMALLINT      NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT chk_oracle_source_slug_nonempty
    CHECK (length(slug) > 0),
  CONSTRAINT chk_oracle_source_trust_tier_nonneg
    CHECK (trust_tier >= 0)
);

-- ─── oracle_readings ─────────────────────────────────────────────────────────
-- Append-only. Rows are immutable (see trigger below) so a decision can always
-- be re-derived from the readings it references. Payloads are capped at 64 KiB
-- to keep JSONB growth bounded.

CREATE TABLE IF NOT EXISTS oracle_readings (
  id                    UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id             UUID           NOT NULL REFERENCES oracle_sources(id),
  feed_key              TEXT           NOT NULL,
  raw_payload           JSONB          NOT NULL,
  normalized_value      NUMERIC(38, 18) NOT NULL,
  unit                  TEXT           NOT NULL,
  -- Timestamp the source reports for the observation.
  observed_at           TIMESTAMPTZ    NOT NULL,
  -- When this backend received and stored the reading.
  ingested_at           TIMESTAMPTZ    NOT NULL DEFAULT now(),
  -- Signature or submitter reference proving who produced the reading.
  submitter_ref         TEXT,
  signature             TEXT,
  CONSTRAINT chk_oracle_reading_payload_size
    CHECK (octet_length(raw_payload::text) <= 65536),
  CONSTRAINT chk_oracle_reading_ingested_after_observed
    CHECK (ingested_at >= observed_at - INTERVAL '5 minutes')
);

-- Latest reading per feed: WHERE feed_key = $1 ORDER BY observed_at DESC LIMIT 1.
CREATE INDEX IF NOT EXISTS idx_oracle_readings_feed_observed
  ON oracle_readings (feed_key, observed_at DESC);

-- Readings-by-time-range scans across all feeds.
CREATE INDEX IF NOT EXISTS idx_oracle_readings_observed_at
  ON oracle_readings (observed_at DESC);

-- FK lookup and per-source health reconstruction.
CREATE INDEX IF NOT EXISTS idx_oracle_readings_source
  ON oracle_readings (source_id, observed_at DESC);

CREATE OR REPLACE FUNCTION oracle_readings_reject_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'oracle_readings is append-only; % is not permitted', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_oracle_readings_immutable ON oracle_readings;
CREATE TRIGGER trg_oracle_readings_immutable
  BEFORE UPDATE OR DELETE ON oracle_readings
  FOR EACH ROW EXECUTE FUNCTION oracle_readings_reject_mutation();

-- ─── oracle_decisions ────────────────────────────────────────────────────────
-- One row per consensus outcome. The participating readings are recorded in
-- oracle_decision_readings so the decision is reproducible from its id alone.

CREATE TABLE IF NOT EXISTS oracle_decisions (
  id                UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_key          TEXT            NOT NULL,
  chosen_value      NUMERIC(38, 18) NOT NULL,
  method            TEXT            NOT NULL,
  quorum_required   SMALLINT        NOT NULL,
  quorum_achieved   SMALLINT        NOT NULL,
  -- Spread between participating readings, in basis points of chosen_value.
  divergence_bps    INTEGER         NOT NULL,
  -- Trust engine mode in force when the decision was made.
  trust_mode        TEXT            NOT NULL,
  decided_at        TIMESTAMPTZ     NOT NULL DEFAULT now(),
  CONSTRAINT chk_oracle_decision_quorum_required_positive
    CHECK (quorum_required >= 1),
  CONSTRAINT chk_oracle_decision_quorum_achieved_nonneg
    CHECK (quorum_achieved >= 0),
  CONSTRAINT chk_oracle_decision_divergence_nonneg
    CHECK (divergence_bps >= 0)
);

-- Decisions-by-feed: WHERE feed_key = $1 ORDER BY decided_at DESC.
CREATE INDEX IF NOT EXISTS idx_oracle_decisions_feed_decided
  ON oracle_decisions (feed_key, decided_at DESC);

-- ─── oracle_decision_readings ────────────────────────────────────────────────
-- Join table: the exact readings a decision was built from. reading_id is not
-- cascaded because readings are immutable and must never be removed while a
-- decision references them.

CREATE TABLE IF NOT EXISTS oracle_decision_readings (
  decision_id       UUID  NOT NULL REFERENCES oracle_decisions(id) ON DELETE CASCADE,
  reading_id        UUID  NOT NULL REFERENCES oracle_readings(id),
  PRIMARY KEY (decision_id, reading_id)
);

-- Reverse lookup: which decisions used a given reading.
CREATE INDEX IF NOT EXISTS idx_oracle_decision_readings_reading
  ON oracle_decision_readings (reading_id);

-- ─── oracle_source_health ────────────────────────────────────────────────────
-- Rolling health state per source. Quarantine is active while quarantined_at
-- is set; clearing it returns the source to consideration.

CREATE TABLE IF NOT EXISTS oracle_source_health (
  source_id             UUID          PRIMARY KEY REFERENCES oracle_sources(id) ON DELETE CASCADE,
  consecutive_failures  INTEGER       NOT NULL DEFAULT 0,
  failures_window       INTEGER       NOT NULL DEFAULT 0,
  successes_window      INTEGER       NOT NULL DEFAULT 0,
  last_success_at       TIMESTAMPTZ,
  last_failure_at       TIMESTAMPTZ,
  quarantined_at        TIMESTAMPTZ,
  quarantine_reason     TEXT,
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT chk_oracle_health_consecutive_failures_nonneg
    CHECK (consecutive_failures >= 0),
  CONSTRAINT chk_oracle_health_failures_window_nonneg
    CHECK (failures_window >= 0),
  CONSTRAINT chk_oracle_health_successes_window_nonneg
    CHECK (successes_window >= 0),
  CONSTRAINT chk_oracle_health_quarantine_reason
    CHECK (quarantined_at IS NULL OR quarantine_reason IS NOT NULL)
);

COMMIT;
