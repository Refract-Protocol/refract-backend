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

-- TEE attestation tier for provider readings (issue #293).
-- 'base' is the default for unattested readings; higher tiers indicate a
-- verified hardware attestation bound to the submitted reading.
CREATE TABLE IF NOT EXISTS provider_readings (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id         UUID NOT NULL,
    payload           JSONB NOT NULL,
    -- Attestation tier assigned by the verifier/policy. Existing and
    -- unattested readings remain valid at the base tier.
    attestation_tier  TEXT NOT NULL DEFAULT 'base',
    -- Policy version recorded with the weighting decision.
    policy_version    TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provider_readings_source_tier
    ON provider_readings (source_id, attestation_tier);

-- Attestation failures are recorded as evidence with the specific reason;
-- they are never silently downgraded to "unsigned ok".
CREATE TABLE IF NOT EXISTS attestation_evidence (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reading_id        UUID NOT NULL REFERENCES provider_readings(id) ON DELETE CASCADE,
    tee_type          TEXT,
    status            TEXT NOT NULL,
    failure_reason    TEXT,
    policy_version    TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attestation_evidence_reading
    ON attestation_evidence (reading_id);
