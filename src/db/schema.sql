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

-- ---------------------------------------------------------------------------
-- Versioned reference data registry (issue #287)
--
-- NOTE: the migration under src/db/migrations/ is the authoritative source for
-- existing databases. The DDL below mirrors it so fresh installs and the
-- canonical schema stay in sync. Reference data is immutable per dataset
-- version; feeds pin a dataset version so a refresh cannot retroactively
-- change how a past reading was interpreted.
-- ---------------------------------------------------------------------------

-- A versioned snapshot of reference data for a given entity domain
-- (e.g. 'flightdelay.airports', 'liquidation.protocols', 'price.assets').
CREATE TABLE IF NOT EXISTS reference_datasets (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Stable logical name for the dataset across versions.
    dataset_key       TEXT NOT NULL,
    -- Monotonically increasing version per dataset_key.
    version           INTEGER NOT NULL,
    -- Domain of entities covered, e.g. 'airport', 'route', 'carrier',
    -- 'protocol', 'market', 'chain', 'asset'.
    entity_type       TEXT NOT NULL,
    -- Validity window of the dataset version itself.
    effective_from    TIMESTAMPTZ NOT NULL,
    effective_to      TIMESTAMPTZ,
    -- Provenance of the imported data (source name, URI, checksum, etc.).
    source            TEXT,
    metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT reference_datasets_version_positive CHECK (version > 0),
    CONSTRAINT reference_datasets_effective_window
        CHECK (effective_to IS NULL OR effective_to > effective_from),
    CONSTRAINT reference_datasets_key_version_unique UNIQUE (dataset_key, version)
);

CREATE INDEX IF NOT EXISTS idx_reference_datasets_key_effective
    ON reference_datasets (dataset_key, effective_from DESC);

-- Canonical entities belonging to a dataset version.
CREATE TABLE IF NOT EXISTS reference_entities (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_id        UUID NOT NULL REFERENCES reference_datasets(id) ON DELETE CASCADE,
    -- Canonical identifier used in evidence records (e.g. 'KJFK', 'aave-v3').
    canonical_id      TEXT NOT NULL,
    entity_type       TEXT NOT NULL,
    -- Human-readable name; may change between versions (entity renames).
    display_name      TEXT,
    -- Chain/contract disambiguation for ticker collisions (e.g. USDC on
    -- multiple chains). NULL for entity types that do not need it.
    chain_id          TEXT,
    contract_address  TEXT,
    -- Per-entity validity window; retired entities keep historical rows so
    -- delayed historical readings can still be resolved.
    effective_from    TIMESTAMPTZ NOT NULL,
    effective_to      TIMESTAMPTZ,
    -- 'active' | 'retired' | 'delisted' etc. Retired entities are rejected
    -- for new readings but remain resolvable for historical evidence.
    status            TEXT NOT NULL DEFAULT 'active',
    attributes        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT reference_entities_effective_window
        CHECK (effective_to IS NULL OR effective_to > effective_from),
    CONSTRAINT reference_entities_dataset_canonical_unique
        UNIQUE (dataset_id, canonical_id)
);

CREATE INDEX IF NOT EXISTS idx_reference_entities_dataset_type
    ON reference_entities (dataset_id, entity_type);

CREATE INDEX IF NOT EXISTS idx_reference_entities_canonical
    ON reference_entities (canonical_id);

-- Maps provider-native IDs (and provider-specific aliases) to canonical IDs.
-- Supports many-to-one: several provider IDs may resolve to one canonical
-- entity, and the same provider ID may differ per provider.
CREATE TABLE IF NOT EXISTS reference_entity_aliases (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_id        UUID NOT NULL REFERENCES reference_datasets(id) ON DELETE CASCADE,
    entity_id         UUID NOT NULL REFERENCES reference_entities(id) ON DELETE CASCADE,
    -- Provider namespace, e.g. 'nexus', 'aviationstack', 'coingecko'.
    provider          TEXT NOT NULL,
    -- Provider-native identifier or alias.
    alias             TEXT NOT NULL,
    -- Optional chain/contract scoping to disambiguate ticker collisions.
    chain_id          TEXT,
    contract_address  TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- An alias must be unambiguous within a provider + dataset + scope;
    -- ambiguous matches are rejected at resolution time.
    CONSTRAINT reference_entity_aliases_unique
        UNIQUE (dataset_id, provider, alias, chain_id, contract_address)
);

CREATE INDEX IF NOT EXISTS idx_reference_entity_aliases_lookup
    ON reference_entity_aliases (dataset_id, provider, alias);

CREATE INDEX IF NOT EXISTS idx_reference_entity_aliases_entity
    ON reference_entity_aliases (entity_id);

-- Pins a feed to a specific dataset version so updates are promoted
-- deliberately and past readings keep their original interpretation.
CREATE TABLE IF NOT EXISTS feed_reference_pins (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    feed_id           TEXT NOT NULL,
    dataset_key       TEXT NOT NULL,
    dataset_id        UUID NOT NULL REFERENCES reference_datasets(id) ON DELETE RESTRICT,
    pinned_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    pinned_by         TEXT,
    CONSTRAINT feed_reference_pins_unique UNIQUE (feed_id, dataset_key)
);

CREATE INDEX IF NOT EXISTS idx_feed_reference_pins_dataset
    ON feed_reference_pins (dataset_id);

-- Readings rejected at ingestion (unknown/retired/ambiguous entity) are
-- diverted here with a reason and never counted toward quorum.
CREATE TABLE IF NOT EXISTS dead_letter_readings (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    feed_id           TEXT NOT NULL,
    -- Original reading payload as received from the provider.
    payload           JSONB NOT NULL,
    -- Machine-readable rejection reason, e.g. 'unknown_entity',
    -- 'retired_entity', 'ambiguous_entity', 'unpinned_dataset'.
    reason            TEXT NOT NULL,
    detail            TEXT,
    -- Provider-native entity reference that failed resolution, if any.
    provider          TEXT,
    provider_entity_id TEXT,
    dataset_id        UUID REFERENCES reference_datasets(id) ON DELETE SET NULL,
    received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_readings_feed_reason
    ON dead_letter_readings (feed_id, reason, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_dead_letter_readings_received
    ON dead_letter_readings (received_at DESC);
