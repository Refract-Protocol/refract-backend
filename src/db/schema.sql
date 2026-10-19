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

-- Per-source reliability state for oracle feeds. Updated in one batch per
-- polling cycle; state transitions are computed by src/oracle/sourceHealth.ts.
CREATE TABLE IF NOT EXISTS oracle_source_health (
    feed                  TEXT NOT NULL,
    source                TEXT NOT NULL,
    state                 TEXT NOT NULL DEFAULT 'healthy'
                          CHECK (state IN ('healthy', 'degraded', 'quarantined')),
    consecutive_failures  INTEGER NOT NULL DEFAULT 0,
    consecutive_successes INTEGER NOT NULL DEFAULT 0,
    -- Trailing-window rates, 0..1. Recomputed from the window each cycle.
    error_rate            NUMERIC(5, 4) NOT NULL DEFAULT 0,
    timeout_rate          NUMERIC(5, 4) NOT NULL DEFAULT 0,
    divergence_rate       NUMERIC(5, 4) NOT NULL DEFAULT 0,
    sample_count          INTEGER NOT NULL DEFAULT 0,
    last_value            NUMERIC(38, 18),
    last_success_at       TIMESTAMPTZ,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (feed, source)
);

-- Operator overrides (force quarantine / force clear). Append-only audit trail.
CREATE TABLE IF NOT EXISTS oracle_source_health_overrides (
    id          BIGSERIAL PRIMARY KEY,
    feed        TEXT NOT NULL,
    source      TEXT NOT NULL,
    action      TEXT NOT NULL CHECK (action IN ('force_quarantine', 'force_clear')),
    actor       TEXT NOT NULL,
    reason      TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oracle_source_health_overrides_feed_source
    ON oracle_source_health_overrides (feed, source, created_at);
