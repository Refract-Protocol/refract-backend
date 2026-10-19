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

-- ─── Oracle node operator registry (issue #191) ─────────────────────────────
-- The on-chain registry is the source of truth; this table is the Postgres
-- cache of it plus the local audit trail.

CREATE TABLE IF NOT EXISTS operators (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Stellar ed25519 public key (G...) that signs readings for this operator.
    submission_key    TEXT NOT NULL UNIQUE,
    supported_feeds   TEXT[] NOT NULL DEFAULT '{}',
    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'active', 'suspended', 'exited')),
    registered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Replay protection for signed registration requests. A nonce is only needed
-- while its request timestamp is inside the accepted window.
CREATE TABLE IF NOT EXISTS operator_registration_nonces (
    submission_key    TEXT NOT NULL,
    nonce             TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (submission_key, nonce)
);

CREATE TABLE IF NOT EXISTS operator_audit (
    id                BIGSERIAL PRIMARY KEY,
    operator_id       UUID NOT NULL REFERENCES operators(id),
    event             TEXT NOT NULL,
    from_status       TEXT,
    to_status         TEXT NOT NULL,
    actor             TEXT NOT NULL,
    reason            TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
