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
-- Issue #289: Alert routing (dedup, grouping, escalation, auto-resolve)
-- ---------------------------------------------------------------------------

-- One row per grouped incident. The fingerprint excludes volatile fields
-- (feed id + alert class + source) so duplicate emits from multiple workers
-- collapse onto the same incident.
CREATE TABLE IF NOT EXISTS incidents (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fingerprint       TEXT NOT NULL,
    feed_id           TEXT,
    alert_class       TEXT NOT NULL,
    source            TEXT NOT NULL,
    severity          TEXT NOT NULL DEFAULT 'ticket',
    -- Explicit state machine: open -> acknowledged -> escalated -> resolved
    -- (or open -> resolved on auto-resolve). 'open' is the dedup anchor.
    status            TEXT NOT NULL DEFAULT 'open',
    -- Grouping: all alerts for one feed outage share a group key.
    group_key         TEXT,
    -- Escalation bookkeeping.
    escalation_level  INTEGER NOT NULL DEFAULT 0,
    next_escalation_at TIMESTAMPTZ,
    acknowledged_at   TIMESTAMPTZ,
    acknowledged_by   TEXT,
    resolved_at       TIMESTAMPTZ,
    resolution_reason TEXT,
    -- Free-form incident payload (latest alert detail, counts, etc.).
    details           JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dedup guarantee: at most one open incident per fingerprint, even when
-- multiple worker processes emit concurrently.
CREATE UNIQUE INDEX IF NOT EXISTS uq_incidents_fingerprint_open
    ON incidents (fingerprint)
    WHERE status = 'open';

-- Lookup by fingerprint + status (dedup/grouping queries).
CREATE INDEX IF NOT EXISTS idx_incidents_fingerprint_status
    ON incidents (fingerprint, status);

-- Grouping and storm-bounding queries by feed.
CREATE INDEX IF NOT EXISTS idx_incidents_group_key
    ON incidents (group_key, status);

-- Escalation sweeper scans for due escalations.
CREATE INDEX IF NOT EXISTS idx_incidents_next_escalation
    ON incidents (next_escalation_at)
    WHERE status IN ('open', 'acknowledged', 'escalated');

-- Time-ordered incident listing.
CREATE INDEX IF NOT EXISTS idx_incidents_created_at
    ON incidents (created_at);

-- Append-only state machine transition log (persisted so restarts do not
-- re-page or lose an open incident).
CREATE TABLE IF NOT EXISTS incident_transitions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id   UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    from_status   TEXT,
    to_status     TEXT NOT NULL,
    reason        TEXT,
    actor         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incident_transitions_incident
    ON incident_transitions (incident_id, created_at);

-- Acknowledgement tracking (who acked, when, at which escalation level).
CREATE TABLE IF NOT EXISTS incident_acknowledgements (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id     UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    acknowledged_by TEXT NOT NULL,
    escalation_level INTEGER NOT NULL DEFAULT 0,
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incident_acks_incident
    ON incident_acknowledgements (incident_id, created_at);

-- Incident timeline written to the audit log (emit, dedupe, route, escalate,
-- notify, resolve).
CREATE TABLE IF NOT EXISTS incident_timeline (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id   UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    event_type    TEXT NOT NULL,
    message       TEXT,
    payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incident_timeline_incident
    ON incident_timeline (incident_id, created_at);


-- ---------------------------------------------------------------------------
-- Issue #298: Versioned composite / derived feeds
-- ---------------------------------------------------------------------------

-- Declared, versioned formula for a composite feed. The expression is stored
-- as a non-Turing-complete AST (JSON) so evaluation is deterministic.
CREATE TABLE IF NOT EXISTS composite_feed_definitions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    output_feed_id    TEXT NOT NULL,
    version           INTEGER NOT NULL,
    -- Ordered upstream feed ids the formula reads from.
    input_feed_ids    TEXT[] NOT NULL,
    -- Versioned formula AST (JSON).
    expression        JSONB NOT NULL,
    -- Output unit and rounding policy.
    unit              TEXT NOT NULL,
    rounding_policy   JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Per-input freshness requirements (feed id -> max age seconds).
    freshness_requirements JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (output_feed_id, version)
);

CREATE INDEX IF NOT EXISTS idx_composite_feed_definitions_output
    ON composite_feed_definitions (output_feed_id, version);

-- One row per composite evaluation, linking the formula version in force and
-- the upstream decision ids used, so replay is reproducible.
CREATE TABLE IF NOT EXISTS composite_decisions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    output_feed_id    TEXT NOT NULL,
    formula_version   INTEGER NOT NULL,
    -- Upstream consensus decision ids consumed by this evaluation.
    input_decision_ids UUID[] NOT NULL,
    computed_value    NUMERIC(38, 18),
    -- Inherited weakest input state (e.g. 'ok', 'degraded', 'suspended').
    trust_state       TEXT NOT NULL DEFAULT 'ok',
    -- Link to the consensus-quality decision/evidence record.
    decision_id       UUID,
    evidence_id       UUID,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Replay lookup by output feed id and formula version.
CREATE INDEX IF NOT EXISTS idx_composite_decisions_output_version
    ON composite_decisions (output_feed_id, formula_version, created_at);

CREATE INDEX IF NOT EXISTS idx_composite_decisions_decision
    ON composite_decisions (decision_id);


-- ---------------------------------------------------------------------------
-- Issue #299: Manual override previews and applications
-- ---------------------------------------------------------------------------

-- Dry-run preview of a proposed manual override. Non-mutating: records only
-- the computed blast radius and a hash of its inputs.
CREATE TABLE IF NOT EXISTS override_previews (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Hash of the inputs (feed state snapshot, policy set) the preview ran on.
    input_hash        TEXT NOT NULL,
    feed_id           TEXT NOT NULL,
    -- Proposed value or suppressed state.
    proposed_value    NUMERIC(38, 18),
    suppressed        BOOLEAN NOT NULL DEFAULT false,
    effective_from    TIMESTAMPTZ,
    effective_to      TIMESTAMPTZ,
    actor             TEXT NOT NULL,
    rationale         TEXT,
    parameters        JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Aggregate exposure and per-policy breakdown.
    total_exposure    NUMERIC(38, 18) NOT NULL DEFAULT 0,
    affected_policies JSONB NOT NULL DEFAULT '[]'::jsonb,
    truncated         BOOLEAN NOT NULL DEFAULT false,
    -- Preview validity window; application must reference a fresh preview.
    expires_at        TIMESTAMPTZ NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_override_previews_feed
    ON override_previews (feed_id, created_at);

CREATE INDEX IF NOT EXISTS idx_override_previews_status
    ON override_previews (status, expires_at);

-- Applied (or abandoned) override, keyed to the preview id so mismatches
-- between reviewed and applied actions are detectable.
CREATE TABLE IF NOT EXISTS override_applications (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    preview_id        UUID NOT NULL REFERENCES override_previews(id),
    feed_id           TEXT NOT NULL,
    applied_value     NUMERIC(38, 18),
    suppressed        BOOLEAN NOT NULL DEFAULT false,
    actor             TEXT NOT NULL,
    rationale         TEXT,
    -- 'applied' or 'abandoned'.
    status            TEXT NOT NULL DEFAULT 'applied',
    -- Evidence ledger linkage for audit.
    evidence_id       UUID,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_override_applications_preview
    ON override_applications (preview_id);

CREATE INDEX IF NOT EXISTS idx_override_applications_feed
    ON override_applications (feed_id, created_at);
