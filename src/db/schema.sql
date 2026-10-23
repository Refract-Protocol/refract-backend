-- Oracle schema
-- (existing tables omitted from this diff view; append the drift tables below)

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

-- Schema drift detection (issue #279)
-- Records every structural validation result for a provider fetch so operators
-- can query a per-source drift report and inspect the last known-good sample.
CREATE TABLE IF NOT EXISTS oracle_schema_drift_events (
    id              BIGSERIAL PRIMARY KEY,
    source          TEXT        NOT NULL,
    classification  TEXT        NOT NULL CHECK (classification IN ('ok', 'drift', 'breaking')),
    reason          TEXT,
    -- redacted, size-limited sample of the offending payload
    sample          JSONB,
    -- redacted, size-limited sample of the last payload that validated cleanly
    last_known_good JSONB,
    ingestion_id    BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oracle_schema_drift_events_source_created
    ON oracle_schema_drift_events (source, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_oracle_schema_drift_events_classification
    ON oracle_schema_drift_events (classification)
    WHERE classification <> 'ok';

-- Quarantine state per source. A `breaking` classification flips this on and
-- blocks publication until an operator clears it.
CREATE TABLE IF NOT EXISTS oracle_source_quarantine (
    source          TEXT        PRIMARY KEY,
    quarantined     BOOLEAN     NOT NULL DEFAULT FALSE,
    reason          TEXT,
    last_event_id   BIGINT      REFERENCES oracle_schema_drift_events (id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Operator reward accrual and distribution (issue #281)
-- Accruals are derived from the committed evidence ledger, not from live
-- submission events, so they are recomputable and auditable after the fact.
-- The idempotency key makes accrual exactly-once under retries and re-orgs.
CREATE TABLE IF NOT EXISTS oracle_reward_accruals (
    id                BIGSERIAL PRIMARY KEY,
    -- deterministic key: consensus round + operator + reading evidence id
    idempotency_key   TEXT        NOT NULL UNIQUE,
    operator_id       TEXT        NOT NULL,
    consensus_round   BIGINT      NOT NULL,
    evidence_id       BIGINT      NOT NULL,
    -- snapshot of the weighting inputs at accrual time
    stake_weight      NUMERIC(38, 18) NOT NULL DEFAULT 0,
    reputation_score  NUMERIC(10, 6)  NOT NULL DEFAULT 0,
    consensus_weight  NUMERIC(10, 6)  NOT NULL DEFAULT 0,
    -- base pool share before the per-operator cap is applied
    raw_amount        NUMERIC(38, 18) NOT NULL DEFAULT 0,
    -- amount actually credited after the cap (may be less than raw_amount)
    amount            NUMERIC(38, 18) NOT NULL DEFAULT 0,
    -- 'accrued' | 'invalidated' | 'paid' | 'adjusted'
    status            TEXT        NOT NULL DEFAULT 'accrued'
        CHECK (status IN ('accrued', 'invalidated', 'paid', 'adjusted')),
    -- set when remediation invalidates a previously accepted reading
    invalidated_at    TIMESTAMPTZ,
    invalidation_reason TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oracle_reward_accruals_operator
    ON oracle_reward_accruals (operator_id, status);

CREATE INDEX IF NOT EXISTS idx_oracle_reward_accruals_round
    ON oracle_reward_accruals (consensus_round);

-- Durable ledger of adjustments and payouts against accruals. Every row is
-- append-only; balances are derived by summing accruals minus p
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oracle_reward_accruals_operator
    ON oracle_reward_accruals (operator_id, status);

CREATE INDEX IF NOT EXISTS idx_oracle_reward_accruals_round
    ON oracle_reward_accruals (consensus_round);

-- Durable ledger of adjustments and payouts against accruals. Every row is
-- append-only; balances are derived by summing accruals minus payouts.
CREATE TABLE IF NOT EXISTS oracle_reward_ledger (
    id                BIGSERIAL PRIMARY KEY,
    -- deterministic key: payout batch + operator, or adjustment + accrual
    idempotency_key   TEXT        NOT NULL UNIQUE,
    operator_id       TEXT        NOT NULL,
    accrual_id        BIGINT      REFERENCES oracle_reward_accruals (id),
    payout_id         BIGINT,
    -- 'accrual' | 'adjustment' | 'payout'
    entry_type        TEXT        NOT NULL
        CHECK (entry_type IN ('accrual', 'adjustment', 'payout')),
    -- signed: positive credits the operator, negative debits
    amount            NUMERIC(38, 18) NOT NULL,
    memo              TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oracle_reward_ledger_operator
    ON oracle_reward_ledger (operator_id, created_at DESC);

-- Scheduled distribution batches. Funds move only after the dispute window
-- closes and only when the operator balance meets the minimum threshold.
CREATE TABLE IF NOT EXISTS oracle_reward_payouts (
    id                BIGSERIAL PRIMARY KEY,
    -- deterministic key: distribution schedule slot + operator
    idempotency_key   TEXT        NOT NULL UNIQUE,
    operator_id       TEXT        NOT NULL,
    amount            NUMERIC(38, 18) NOT NULL,
    -- 'pending' | 'disputed' | 'paid' | 'voided'
    status            TEXT        NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'disputed', 'paid', 'voided')),
    -- funds may not move before this timestamp (dispute window)
    dispute_window_ends_at TIMESTAMPTZ NOT NULL,
    paid_at           TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oracle_reward_payouts_operator
    ON oracle_reward_payouts (operator_id, status);

CREATE INDEX IF NOT EXISTS idx_oracle_reward_payouts_pending
    ON oracle_reward_payouts (dispute_window_ends_at)
    WHERE status = 'pending';

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

-- Versioned oracle feed definitions (issue #196). See migrations/004_oracle_feed_definitions.sql.
CREATE TABLE IF NOT EXISTS oracle_feed_definitions (
  feed_key            TEXT          NOT NULL,
  version             INTEGER       NOT NULL CHECK (version >= 1),
  definition          JSONB         NOT NULL,
  previous_definition JSONB,
  change_type         TEXT          NOT NULL CHECK (change_type IN ('create', 'update')),
  changed_by          TEXT          NOT NULL,
  changed_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (feed_key, version)
);

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

