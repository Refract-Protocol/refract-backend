-- Refract database schema
-- NOTE: This file is provided as a partial view for issue #129.
-- The full schema is managed elsewhere; only the claims table is shown here
-- because the transparency API (settlement latency + loss ratio) depends on it.

CREATE TABLE IF NOT EXISTS claims (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id         UUID NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
    coverage_type     TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',
    -- When the oracle trigger was first detected for this claim.
    -- Tracked distinctly from settlement so latency (trigger -> payout) is measurable.
    trigger_detected_at TIMESTAMPTZ,
    -- When the payout was confirmed on-chain (settlement confirmed).
    settled_at        TIMESTAMPTZ,
    -- Legacy field retained for backwards compatibility; set after settlement.
    processed_at      TIMESTAMPTZ,
    payout_amount     NUMERIC(38, 18),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Supports percentile (PERCENTILE_CONT) latency queries grouped by coverage type.
CREATE INDEX IF NOT EXISTS idx_claims_coverage_settled
    ON claims (coverage_type, settled_at)
    WHERE settled_at IS NOT NULL AND trigger_detected_at IS NOT NULL;

-- Supports loss-ratio aggregation (payouts vs. premiums) per coverage type.
CREATE INDEX IF NOT EXISTS idx_claims_coverage_status
    ON claims (coverage_type, status);

-- Settlement state machine: one row per consensus decision (issue #198).
-- A non-failed row also blocks a second decision for the same policy.
CREATE TABLE IF NOT EXISTS claim_settlements (
    decision_id  TEXT PRIMARY KEY,
    policy_id    UUID NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
    amount       NUMERIC(38, 18) NOT NULL CHECK (amount > 0),
    status       TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'submitted', 'confirmed', 'failed')
    ),
    tx_hash      VARCHAR(64),
    evidence     JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_error   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_settlements_policy_open
    ON claim_settlements (policy_id)
    WHERE status IN ('pending', 'submitted', 'confirmed');

-- ─── Oracle trust engine ─────────────────────────────────────────────────────
-- Mirrors migrations/002_oracle_trust_engine.sql. Keep the two in sync.

-- Durable pending-decisions queue for batched oracle publishing
-- (persist-then-publish). Full definition and indexes:
-- src/db/migrations/004_oracle_publish_queue.sql
CREATE TABLE IF NOT EXISTS oracle_publish_queue (
    id              BIGSERIAL      PRIMARY KEY,
    decision_key    TEXT           NOT NULL UNIQUE,
    feed            TEXT           NOT NULL,
    value_scaled    NUMERIC(40, 0) NOT NULL,
    priority        SMALLINT       NOT NULL DEFAULT 0,
    status          TEXT           NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'inflight', 'published', 'failed')),
    attempts        INTEGER        NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ    NOT NULL DEFAULT now(),
    last_error      TEXT,
    tx_hash         TEXT,
    ledger          BIGINT,
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
    published_at    TIMESTAMPTZ
);

-- Oracle source registry metadata used for independence modeling (issue #206).
-- Sources sharing operator, upstream origin, or hosting ASN are clustered together
-- unless declared_cluster is set.
CREATE TABLE IF NOT EXISTS oracle_sources (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                TEXT          NOT NULL UNIQUE,
  coverage_types      TEXT[]        NOT NULL DEFAULT '{}',
  source_class        TEXT          NOT NULL,
  independence_group  TEXT          NOT NULL,
  enabled             BOOLEAN       NOT NULL DEFAULT true,
  trust_tier          SMALLINT      NOT NULL DEFAULT 0,
  operator_id         TEXT,
  upstream_origin     TEXT,
  hosting_asn         TEXT,
  -- Admin-declared independence cluster; NULL means inferred and unverified.
  declared_cluster    TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT chk_oracle_source_slug_nonempty
    CHECK (length(slug) > 0),
  CONSTRAINT chk_oracle_source_trust_tier_nonneg
    CHECK (trust_tier >= 0)
);

CREATE INDEX IF NOT EXISTS idx_oracle_sources_operator
    ON oracle_sources (operator_id)
    WHERE operator_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_oracle_sources_upstream
    ON oracle_sources (upstream_origin)
    WHERE upstream_origin IS NOT NULL;

-- Append-only ledger of cluster overrides. Reverting an override appends a new row
-- that restores previous_cluster, so the full history stays auditable.
CREATE TABLE IF NOT EXISTS source_cluster_overrides (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id         UUID NOT NULL REFERENCES oracle_sources(id) ON DELETE CASCADE,
    previous_cluster  TEXT,
    new_cluster       TEXT,
    actor             TEXT NOT NULL,
    reason            TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_source_cluster_overrides_source
    ON source_cluster_overrides (source_id, created_at);

CREATE TABLE IF NOT EXISTS oracle_readings (
  id                    UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id             UUID           NOT NULL REFERENCES oracle_sources(id),
  feed_key              TEXT           NOT NULL,
  raw_payload           JSONB          NOT NULL,
  normalized_value      NUMERIC(38, 18) NOT NULL,
  unit                  TEXT           NOT NULL,
  observed_at           TIMESTAMPTZ    NOT NULL,
  ingested_at           TIMESTAMPTZ    NOT NULL DEFAULT now(),
  submitter_ref         TEXT,
  signature             TEXT,
  CONSTRAINT chk_oracle_reading_payload_size
    CHECK (octet_length(raw_payload::text) <= 65536),
  CONSTRAINT chk_oracle_reading_ingested_after_observed
    CHECK (ingested_at >= observed_at - INTERVAL '5 minutes')
);

CREATE INDEX IF NOT EXISTS idx_oracle_readings_feed_observed
  ON oracle_readings (feed_key, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_oracle_readings_observed_at
  ON oracle_readings (observed_at DESC);

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

CREATE TABLE IF NOT EXISTS oracle_decisions (
  id                UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_key          TEXT            NOT NULL,
  chosen_value      NUMERIC(38, 18) NOT NULL,
  method            TEXT            NOT NULL,
  quorum_required   SMALLINT        NOT NULL,
  quorum_achieved   SMALLINT        NOT NULL,
  divergence_bps    INTEGER         NOT NULL,
  trust_mode        TEXT            NOT NULL,
  decided_at        TIMESTAMPTZ     NOT NULL DEFAULT now(),
  CONSTRAINT chk_oracle_decision_quorum_required_positive
    CHECK (quorum_required >= 1),
  CONSTRAINT chk_oracle_decision_quorum_achieved_nonneg
    CHECK (quorum_achieved >= 0),
  CONSTRAINT chk_oracle_decision_divergence_nonneg
    CHECK (divergence_bps >= 0)
);

CREATE INDEX IF NOT EXISTS idx_oracle_decisions_feed_decided
  ON oracle_decisions (feed_key, decided_at DESC);

CREATE TABLE IF NOT EXISTS oracle_decision_readings (
  decision_id       UUID  NOT NULL REFERENCES oracle_decisions(id) ON DELETE CASCADE,
  reading_id        UUID  NOT NULL REFERENCES oracle_readings(id),
  PRIMARY KEY (decision_id, reading_id)
);

CREATE INDEX IF NOT EXISTS idx_oracle_decision_readings_reading
  ON oracle_decision_readings (reading_id);

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
