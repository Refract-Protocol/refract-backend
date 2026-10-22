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


-- ===========================================================================
-- Oracle methodology registry (issue #294)
-- ===========================================================================
-- Methodology records are immutable: edits create a new version row rather
-- than mutating history, mirroring quorum policy snapshots. There is no
-- UPDATE path; a correction is a new (source_id, version) with the previous
-- row's superseded_at set by the application (append-only semantics).
CREATE TABLE IF NOT EXISTS oracle_methodology_versions (
    id                     UUID NOT NULL DEFAULT gen_random_uuid(),
    source_id              TEXT NOT NULL,
    version                INTEGER NOT NULL,
    -- How the source derives the values it publishes (aggregation method).
    derivation_description TEXT NOT NULL,
    -- What is counted / excluded (e.g. staked-but-locked assets).
    sampling_universe      TEXT NOT NULL,
    -- Revision / late-correction policy.
    revision_policy        TEXT NOT NULL,
    -- Expected latency profile (e.g. 'p95 45s').
    expected_latency       TEXT NOT NULL,
    -- Known failure modes (JSONB array of strings).
    known_failure_modes    JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Approval + explicit sign-off flags required for activation.
    approved               BOOLEAN NOT NULL DEFAULT FALSE,
    approved_by            TEXT,
    approved_at            TIMESTAMPTZ,
    signoff_independence   BOOLEAN NOT NULL DEFAULT FALSE,
    signoff_evidence       BOOLEAN NOT NULL DEFAULT FALSE,
    -- Re-attestation schedule (provider may silently change methodology).
    attested_at            TIMESTAMPTZ,
    reattest_due_at        TIMESTAMPTZ,
    -- Set when observed behavior diverges from the description.
    divergence_flagged     BOOLEAN NOT NULL DEFAULT FALSE,
    divergence_notes       TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    superseded_at          TIMESTAMPTZ,
    PRIMARY KEY (id),
    CONSTRAINT uq_methodology_source_version UNIQUE (source_id, version)
);

CREATE INDEX IF NOT EXISTS idx_methodology_source_current
    ON oracle_methodology_versions (source_id, version DESC)
    WHERE superseded_at IS NULL;

-- Source registry with activation gated on an approved methodology version.
CREATE TABLE IF NOT EXISTS oracle_sources (
    source_id                TEXT PRIMARY KEY,
    display_name             TEXT NOT NULL,
    -- The exact methodology version a source is activated against.
    active_methodology_id    UUID REFERENCES oracle_methodology_versions(id),
    activated                BOOLEAN NOT NULL DEFAULT FALSE,
    activated_at             TIMESTAMPTZ,
    -- Sources with no publishable methodology are barred from higher
    -- independence weight.
    independence_weight      NUMERIC(6, 4) NOT NULL DEFAULT 0,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===========================================================================
-- Oracle readings + consensus decisions + evidence ledger (issues #294/#295)
-- ===========================================================================
-- Per-source readings are declaratively RANGE partitioned by month on
-- observed_at. The partition key is part of every primary/unique key.
CREATE TABLE IF NOT EXISTS oracle_readings (
    id             UUID NOT NULL DEFAULT gen_random_uuid(),
    feed_id        TEXT NOT NULL,
    source_id      TEXT NOT NULL,
    observed_at    TIMESTAMPTZ NOT NULL,
    value          NUMERIC(38, 18) NOT NULL,
    health         TEXT NOT NULL DEFAULT 'ok',
    -- Methodology version(s) in force when this reading was captured.
    methodology_version_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, observed_at)
) PARTITION BY RANGE (observed_at);

-- Consensus decisions: one row per feed per consensus round.
CREATE TABLE IF NOT EXISTS oracle_consensus_decisions (
    id             UUID NOT NULL DEFAULT gen_random_uuid(),
    feed_id        TEXT NOT NULL,
    decided_at     TIMESTAMPTZ NOT NULL,
    outcome        TEXT NOT NULL,
    reason         TEXT,
    trust_mode     TEXT,
    -- Exact methodology version(s) used to reach this decision.
    methodology_version_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, decided_at)
) PARTITION BY RANGE (decided_at);

-- Append-only evidence ledger. Partitioned by month on decided_at so audit
-- range queries touch only the expected partitions.
CREATE TABLE IF NOT EXISTS oracle_evidence (
    id             UUID NOT NULL DEFAULT gen_random_uuid(),
    decision_id    UUID NOT NULL,
    payout_id      UUID,
    feed_id        TEXT NOT NULL,
    decided_at     TIMESTAMPTZ NOT NULL,
    kind           TEXT NOT NULL,
    -- Redacted payload only; never raw provider secrets.
    payload_redacted JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Exact methodology version(s) referenced by this evidence record.
    methodology_version_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, decided_at)
) PARTITION BY RANGE (decided_at);

-- Covering indexes for the hot query shapes.
-- Consensus window per (feed, source, observed_at).
CREATE INDEX IF NOT EXISTS idx_readings_feed_source_observed
    ON oracle_readings (feed_id, source_id, observed_at DESC)
    INCLUDE (value, health);

-- Evidence lookup by decision id.
CREATE INDEX IF NOT EXISTS idx_evidence_decision
    ON oracle_evidence (decision_id, decided_at DESC);

-- Evidence lookup by payout id.
CREATE INDEX IF NOT EXISTS idx_evidence_payout
    ON oracle_evidence (payout_id, decided_at DESC)
    WHERE payout_id IS NOT NULL;

-- Trust-status queries by feed.
CREATE INDEX IF NOT EXISTS idx_evidence_feed_decided
    ON oracle_evidence (feed_id, decided_at DESC)
    INCLUDE (kind);

-- Consensus decision lookup by feed.
CREATE INDEX IF NOT EXISTS idx_decisions_feed_decided
    ON oracle_consensus_decisions (feed_id, decided_at DESC)
    INCLUDE (outcome, trust_mode);

-- ===========================================================================
-- Incidents + incident event links (issue #297)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS incidents (
    id             UUID NOT NULL DEFAULT gen_random_uuid(),
    -- Stable public id for the drafted artifact.
    public_id      TEXT NOT NULL,
    trigger_class  TEXT NOT NULL,
    feed_id        TEXT,
    status         TEXT NOT NULL DEFAULT 'open',
    opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at      TIMESTAMPTZ,
    -- Bumped whenever events are appended; keys the rendered doc cache.
    version        INTEGER NOT NULL DEFAULT 1,
    -- Rendered markdown draft (deterministic from stored events).
    postmortem_md  TEXT,
    PRIMARY KEY (id),
    CONSTRAINT uq_incidents_public_id UNIQUE (public_id)
);

CREATE INDEX IF NOT EXISTS idx_incidents_feed_opened
    ON incidents (feed_id, opened_at DESC);

-- Event-sourced timeline links. Events are appended as they happen so the
-- timeline survives a crash mid-incident.
CREATE TABLE IF NOT EXISTS incident_events (
    id             UUID NOT NULL DEFAULT gen_random_uuid(),
    incident_id    UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    event_type     TEXT NOT NULL,
    -- Reference into the evidence ledger / decisions / readings.
    ledger_ref     UUID,
    -- Redacted payload only; sensitive provider fields stripped.
    payload_redacted JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_incident_events_incident_time
    ON incident_events (incident_id, occurred_at);
