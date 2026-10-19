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
    -- Degraded-mode reason code when status = 'blocked_degraded' (issue #195).
    block_reason      TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-feed degraded-mode state (issue #195). Fail-closed: only 'healthy' allows
-- publishing or settlement. See docs/threat-model.md section 4A.
CREATE TABLE IF NOT EXISTS oracle_feed_state (
    coverage_type         SMALLINT    PRIMARY KEY CHECK (coverage_type BETWEEN 0 AND 4),
    health                TEXT        NOT NULL DEFAULT 'healthy'
                                      CHECK (health IN ('healthy', 'degraded', 'paused')),
    reason                TEXT        CHECK (reason IN (
                                        'quorum_shortfall',
                                        'no_fresh_sources',
                                        'sources_divergent',
                                        'consensus_unavailable'
                                      )),
    consecutive_failures  INTEGER     NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    entered_at            TIMESTAMPTZ,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (health = 'healthy' OR reason IS NOT NULL)
);

-- Supports percentile (PERCENTILE_CONT) latency queries grouped by coverage type.
CREATE INDEX IF NOT EXISTS idx_claims_coverage_settled
    ON claims (coverage_type, settled_at)
    WHERE settled_at IS NOT NULL AND trigger_detected_at IS NOT NULL;

-- Supports loss-ratio aggregation (payouts vs. premiums) per coverage type.
CREATE INDEX IF NOT EXISTS idx_claims_coverage_status
    ON claims (coverage_type, status);
