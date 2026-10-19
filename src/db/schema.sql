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

-- Oracle source registry metadata used for independence modeling (issue #206).
-- Sources sharing operator, upstream origin, or hosting ASN are clustered together
-- unless declared_cluster is set.
CREATE TABLE IF NOT EXISTS oracle_sources (
    id                TEXT PRIMARY KEY,
    operator_id       TEXT,
    upstream_origin   TEXT,
    hosting_asn       TEXT,
    -- Admin-declared independence cluster; NULL means inferred and unverified.
    declared_cluster  TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
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
    source_id         TEXT NOT NULL REFERENCES oracle_sources(id) ON DELETE CASCADE,
    previous_cluster  TEXT,
    new_cluster       TEXT,
    actor             TEXT NOT NULL,
    reason            TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_source_cluster_overrides_source
    ON source_cluster_overrides (source_id, created_at);
