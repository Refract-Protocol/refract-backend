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

-- Oracle evidence ledger (issue #176). Append-only guards (triggers) are
-- installed by src/db/migrations/004_oracle_evidence.sql.
CREATE TABLE IF NOT EXISTS oracle_evidence (
    id               UUID           PRIMARY KEY,
    source           VARCHAR(40)    NOT NULL,
    coverage_type    TEXT           NOT NULL,
    normalized_value NUMERIC(20, 6) NOT NULL,
    raw_payload      TEXT           NOT NULL,
    observed_at      TIMESTAMPTZ    NOT NULL,
    ingested_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oracle_decisions (
    id                 UUID            PRIMARY KEY,
    reading_ids        UUID[]          NOT NULL,
    chosen_value       NUMERIC(20, 6)  NOT NULL,
    rule               TEXT            NOT NULL,
    policy_id          TEXT            NOT NULL,
    payout_amount      NUMERIC(38, 18) NOT NULL,
    decided_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    settlement_status  TEXT            NOT NULL DEFAULT 'pending'
                         CHECK (settlement_status IN ('pending', 'confirmed', 'unconfirmed')),
    settlement_tx_hash TEXT,
    settled_at         TIMESTAMPTZ
);
