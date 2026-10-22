-- Migration: idempotency_keys table, oracle_events partitioning, and retention job
-- PostgreSQL 15+
--
-- Apply on top of src/db/schema.sql:
--   psql "$DATABASE_URL" -f src/db/migrations/001_idempotency_and_oracle_partitioning.sql

-- ─── Idempotency Keys ────────────────────────────────────────────────────────
-- Stores durable idempotency locks and committed responses for state-changing
-- endpoints (POST /policies/buy, POST /pool/provide, POST /pool/withdraw,
-- POST /tx/submit).  See src/common/idempotency.service.ts.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT          NOT NULL,
  endpoint      TEXT          NOT NULL,
  response_body JSONB,
  status_code   SMALLINT,
  committed     BOOLEAN       NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (key, endpoint)
);

-- Automatic cleanup: keys older than 24 hours are safe to discard (clients
-- are not expected to retry a write after 24 hours).
CREATE INDEX IF NOT EXISTS idx_idempotency_created_at
  ON idempotency_keys (created_at);

-- ─── Oracle Events — partitioned table ───────────────────────────────────────
--
-- The original oracle_events is dropped and replaced with a declarative
-- range-partition on recorded_at (monthly buckets).  Each partition is an
-- ordinary table and can be detached + archived independently.
--
-- If you have existing data you want to preserve, export it first:
--   \copy oracle_events TO '/tmp/oracle_events_backup.csv' CSV HEADER
-- Then re-import after this migration completes.

DROP TABLE IF EXISTS oracle_events;

CREATE TABLE oracle_events (
  id            BIGSERIAL,
  coverage_type coverage_type   NOT NULL,
  value         NUMERIC(20, 6)  NOT NULL,
  source        VARCHAR(40)     NOT NULL,
  severity      VARCHAR(10)     NOT NULL,  -- low | medium | high | triggered
  recorded_at   TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, recorded_at)            -- partition key must be in PK
) PARTITION BY RANGE (recorded_at);

-- ── Bootstrap partitions (current + next two months) ─────────────────────────
-- The maintenance job (OracleRetentionService) creates future partitions
-- automatically, but we seed three months here so the table is usable
-- immediately after applying this migration.

DO $$
DECLARE
  start_date  DATE := DATE_TRUNC('month', NOW())::DATE;
  i           INT;
  part_start  DATE;
  part_end    DATE;
  part_name   TEXT;
BEGIN
  FOR i IN 0..2 LOOP
    part_start := start_date + (i || ' months')::INTERVAL;
    part_end   := part_start + INTERVAL '1 month';
    part_name  := 'oracle_events_' || TO_CHAR(part_start, 'YYYY_MM');

    -- Skip if already exists (idempotent re-run).
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = part_name AND n.nspname = 'public'
    ) THEN
      EXECUTE FORMAT(
        'CREATE TABLE %I PARTITION OF oracle_events
           FOR VALUES FROM (%L) TO (%L)',
        part_name, part_start, part_end
      );

      -- Per-partition composite index — "recent readings for one type".
      EXECUTE FORMAT(
        'CREATE INDEX %I ON %I (coverage_type, recorded_at DESC)',
        'idx_' || part_name || '_type', part_name
      );

      RAISE NOTICE 'Created partition % (% → %)', part_name, part_start, part_end;
    END IF;
  END LOOP;
END;
$$;

-- ─── Alert Routing — incidents, transitions, acknowledgements, timeline ──────
-- Backing store for the alerting/routing layer (fingerprint → dedupe/group →
-- route → escalate → auto-resolve).  See src/observability/alert-routing.
--
-- An incident is keyed by a stable fingerprint (feed id + alert class +
-- source, excluding volatile fields).  At most one incident per fingerprint
-- may be open at a time; the partial unique index below enforces that so
-- duplicate emits from multiple worker processes cannot open parallel
-- incidents for the same condition.

CREATE TABLE IF NOT EXISTS alert_incidents (
  id                BIGSERIAL     PRIMARY KEY,
  fingerprint       TEXT          NOT NULL,
  feed_id           TEXT          NOT NULL,
  alert_class       TEXT          NOT NULL,
  source            TEXT          NOT NULL,
  severity          TEXT          NOT NULL,  -- page | ticket
  state             TEXT          NOT NULL DEFAULT 'open',
    -- open | acknowledged | escalated | resolved
  group_key         TEXT,
  opened_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  last_notified_at  TIMESTAMPTZ,
  notify_count      INTEGER       NOT NULL DEFAULT 0,
  escalated_at      TIMESTAMPTZ,
  resolved_at       TIMESTAMPTZ,
  resolution_reason TEXT,
  metadata          JSONB         NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT alert_incidents_severity_chk
    CHECK (severity IN ('page', 'ticket')),
  CONSTRAINT alert_incidents_state_chk
    CHECK (state IN ('open', 'acknowledged', 'escalated', 'resolved'))
);

-- One open incident per fingerprint (resolved incidents are excluded so a
-- condition that clears and recurs opens a fresh incident).
CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_incidents_open_fingerprint
  ON alert_incidents (fingerprint)
  WHERE state <> 'resolved';

CREATE INDEX IF NOT EXISTS idx_alert_incidents_feed_open
  ON alert_incidents (feed_id, opened_at DESC)
  WHERE state <> 'resolved';

CREATE INDEX IF NOT EXISTS idx_alert_incidents_group
  ON alert_incidents (group_key)
  WHERE state <> 'resolved';

-- Explicit state machine transitions, persisted so a restart can rebuild
-- incident state without re-paging.
CREATE TABLE IF NOT EXISTS alert_incident_transitions (
  id           BIGSERIAL   PRIMARY KEY,
  incident_id  BIGINT      NOT NULL REFERENCES alert_incidents (id) ON DELETE CASCADE,
  from_state   TEXT,
  to_state     TEXT        NOT NULL,
  reason       TEXT,
  actor        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_incident_transitions_incident
  ON alert_incident_transitions (incident_id, created_at);

-- Acknowledgement tracking used by the escalation policy (re-notify and
-- escalate to secondary on-call after a configured delay).
CREATE TABLE IF NOT EXISTS alert_incident_acknowledgements (
  id           BIGSERIAL   PRIMARY KEY,
  incident_id  BIGINT      NOT NULL REFERENCES alert_incidents (id) ON DELETE CASCADE,
  acknowledged_by TEXT     NOT NULL,
  note         TEXT,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_incident_acks_incident
  ON alert_incident_acknowledgements (incident_id, acknowledged_at);

-- Human-readable incident timeline mirrored into the audit log.
CREATE TABLE IF NOT EXISTS alert_incident_timeline (
  id           BIGSERIAL   PRIMARY KEY,
  incident_id  BIGINT      NOT NULL REFERENCES alert_incidents (id) ON DELETE CASCADE,
  event_type   TEXT        NOT NULL,  -- opened | notified | acked | escalated | resolved
  detail       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  actor        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_incident_timeline_incident
  ON alert_incident_timeline (incident_id, created_at);

-- ─── Composite / Derived Feeds ───────────────────────────────────────────────
-- Versioned composite feed definitions and their evaluation decisions.
-- A composite is computed deterministically from upstream consensus outputs
-- via a small, versioned, non-Turing-complete formula AST.  The formula
-- version is stored with every decision so replay uses the version in force
-- at evaluation time.

CREATE TABLE IF NOT EXISTS composite_feed_definitions (
  id              BIGSERIAL     PRIMARY KEY,
  feed_id         TEXT          NOT NULL,
  version         INTEGER       NOT NULL,
  input_feed_ids  TEXT[]        NOT NULL,
  formula         JSONB         NOT NULL,  -- serialized formula AST
  unit            TEXT          NOT NULL,
  rounding        JSONB         NOT NULL DEFAULT '{}'::jsonb,
  freshness       JSONB         NOT NULL DEFAULT '{}'::jsonb,  -- per-input max age
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT composite_feed_definitions_version_chk CHECK (version > 0),
  CONSTRAINT composite_feed_definitions_inputs_chk  CHECK (cardinality(input_feed_ids) > 0),
  CONSTRAINT composite_feed_definitions_unique    UNIQUE (feed_id, version)
);

CREATE INDEX IF NOT EXISTS idx_composite_feed_definitions_feed
  ON composite_feed_definitions (feed_id, version DESC);

CREATE TABLE IF NOT EXISTS composite_decisions (
  id                    BIGSERIAL     PRIMARY KEY,
  feed_id               TEXT          NOT NULL,
  formula_version       INTEGER       NOT NULL,
  input_decision_ids    BIGINT[]      NOT NULL,
  computed_value        NUMERIC(38, 18),
  state                 TEXT          NOT NULL,  -- ok | degraded | suspended
  evidence_id           BIGINT,
  evaluated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  metadata              JSONB         NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT composite_decisions_state_chk
    CHECK (state IN ('ok', 'degraded', 'suspended')),
  CONSTRAINT composite_decisions_inputs_chk
    CHECK (cardinality(input_decision_ids) > 0),
  CONSTRAINT composite_decisions_definition_fk
    FOREIGN KEY (feed_id, formula_version)
    REFERENCES composite_feed_definitions (feed_id, version)
);

CREATE INDEX IF NOT EXISTS idx_composite_decisions_feed
  ON composite_decisions (feed_id, evaluated_at DESC);

-- ─── Manual Override Preview / Apply ─────────────────────────────────────────
-- Dry-run impact previews for manual oracle overrides and the applications
-- that consume them.  An override may only be applied against a preview id
-- generated within a short validity window, and the applied override is
-- keyed to that preview so mismatches are detectable.

CREATE TABLE IF NOT EXISTS override_previews (
  id              BIGSERIAL     PRIMARY KEY,
  preview_id      TEXT          NOT NULL UNIQUE,
  feed_id         TEXT          NOT NULL,
  proposed_value  NUMERIC(38, 18),
  suppressed      BOOLEAN       NOT NULL DEFAULT false,
  effective_from  TIMESTAMPTZ   NOT NULL,
  effective_to    TIMESTAMPTZ,
  input_hash      TEXT          NOT NULL,  -- hash of snapshot inputs
  affected_policies JSONB      NOT NULL DEFAULT '[]'::jsonb,
  total_exposure  NUMERIC(38, 18) NOT NULL DEFAULT 0,
  truncated       BOOLEAN       NOT NULL DEFAULT false,
  actor           TEXT          NOT NULL,
  rationale       TEXT,
  evidence_id     BIGINT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ   NOT NULL,
  CONSTRAINT override_previews_window_chk
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT override_previews_expiry_chk
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_override_previews_feed
  ON override_previews (feed_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_override_previews_expires
  ON override_previews (expires_at);

CREATE TABLE IF NOT EXISTS override_applications (
  id              BIGSERIAL     PRIMARY KEY,
  preview_id      TEXT          NOT NULL REFERENCES override_previews (preview_id),
  feed_id         TEXT          NOT NULL,
  applied_value   NUMERIC(38, 18),
  suppressed      BOOLEAN       NOT NULL DEFAULT false,
  input_hash      TEXT          NOT NULL,
  status          TEXT          NOT NULL DEFAULT 'applied',
    -- applied | abandoned
  actor           TEXT          NOT NULL,
  rationale       TEXT,
  evidence_id     BIGINT,
  applied_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT override_applications_status_chk
    CHECK (status IN ('applied', 'abandoned'))
);

CREATE INDEX IF NOT EXISTS idx_override_applications_preview
  ON override_applications (preview_id);

CREATE INDEX IF NOT EXISTS idx_override_applications_feed
  ON override_applications (feed_id, applied_at DESC);
