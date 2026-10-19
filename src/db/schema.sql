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
