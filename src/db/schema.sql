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

-- Oracle operator stake. Mirrors the confirmed on-chain bond held by the
-- staking contract; the backend never custodies funds.
CREATE TABLE IF NOT EXISTS operator_bonds (
    operator_id       TEXT PRIMARY KEY,
    bonded_amount     NUMERIC(38, 0) NOT NULL DEFAULT 0 CHECK (bonded_amount >= 0),
    -- Set on first bond; bond age gates eligibility to serve feeds.
    first_bonded_at   TIMESTAMPTZ,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unbonding requests. Amounts stay slashable until withdrawn.
CREATE TABLE IF NOT EXISTS unbond_requests (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id       TEXT NOT NULL REFERENCES operator_bonds(operator_id),
    amount            NUMERIC(38, 0) NOT NULL CHECK (amount > 0),
    requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    available_at      TIMESTAMPTZ NOT NULL,
    status            TEXT NOT NULL DEFAULT 'unbonding'
                      CHECK (status IN ('unbonding', 'withdrawn', 'slashed')),
    withdrawn_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_unbond_requests_operator_status
    ON unbond_requests (operator_id, status);

-- Durable slashing proposals. evidence_ids reference immutable evidence
-- records; evidence_key makes proposal creation idempotent per evidence set.
CREATE TABLE IF NOT EXISTS slashing_proposals (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id       TEXT NOT NULL REFERENCES operator_bonds(operator_id),
    reason            TEXT NOT NULL
                      CHECK (reason IN ('outside_tolerance', 'post_quarantine', 'equivocation')),
    evidence_ids      TEXT[] NOT NULL CHECK (cardinality(evidence_ids) > 0),
    evidence_key      TEXT NOT NULL UNIQUE,
    amount            NUMERIC(38, 0) NOT NULL CHECK (amount > 0),
    status            TEXT NOT NULL DEFAULT 'pending_review'
                      CHECK (status IN ('pending_review', 'pending_appeal', 'approved', 'rejected', 'executed')),
    -- Only set for bounded auto-slashes; the proposal is reviewable until this time.
    appeal_until      TIMESTAMPTZ,
    reviewed_by       TEXT,
    reviewed_at       TIMESTAMPTZ,
    execution_tx_hash TEXT,
    executed_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_slashing_proposals_operator_status
    ON slashing_proposals (operator_id, status);
