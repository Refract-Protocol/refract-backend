-- Migration: versioned oracle feed definitions + append-only audit trail (issue #196)
-- PostgreSQL 15+
--
-- Feed definitions (coverage type, source roster and weights, quorum threshold,
-- freshness window, trust mode, enabled flag) are stored as immutable rows keyed
-- by (feed_key, version). Each change inserts a new version, so the policy that
-- was in force for any past consensus decision can always be recovered.
--
-- Apply on top of src/db/schema.sql:
--   psql "$DATABASE_URL" -f src/db/migrations/004_oracle_feed_definitions.sql

CREATE TABLE IF NOT EXISTS oracle_feed_definitions (
  feed_key            TEXT          NOT NULL,
  version             INTEGER       NOT NULL CHECK (version >= 1),
  definition          JSONB         NOT NULL,
  -- Definition at version - 1 (NULL for version 1). Makes before/after explicit.
  previous_definition JSONB,
  change_type         TEXT          NOT NULL CHECK (change_type IN ('create', 'update')),
  changed_by          TEXT          NOT NULL,
  changed_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- The primary key doubles as the optimistic-concurrency guard: two writers
  -- racing for the same next version cannot both insert it.
  PRIMARY KEY (feed_key, version)
);

-- Versions are append-only: an audit row must never be rewritten or removed.
CREATE OR REPLACE FUNCTION oracle_feed_definitions_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'oracle_feed_definitions is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_oracle_feed_definitions_append_only ON oracle_feed_definitions;
CREATE TRIGGER trg_oracle_feed_definitions_append_only
  BEFORE UPDATE OR DELETE ON oracle_feed_definitions
  FOR EACH ROW EXECUTE FUNCTION oracle_feed_definitions_append_only();
