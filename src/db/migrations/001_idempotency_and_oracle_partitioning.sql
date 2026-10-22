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

-- ─── Versioned Reference Data Registry ───────────────────────────────────────
--
-- Reference data (airports, routes, carriers, protocols, markets, chains,
-- asset identifiers) is IMMUTABLE per dataset version.  A dataset row is
-- created in status 'draft', populated by the importer, then promoted to
-- 'published' exactly once.  Once published, neither the dataset row nor its
-- entities/aliases may be mutated — corrections are made by importing a new
-- version.  This guarantees that a reading interpreted against dataset
-- version N is interpreted identically when re-examined years later.
--
-- Effective date semantics:
--   effective_from  — the instant from which the dataset is authoritative.
--   effective_to    — exclusive upper bound; NULL means "still current".
--   A feed pins a dataset version (feed_reference_pins).  Ingestion resolves
--   entities against the pinned version only, never "latest", so promoting a
--   new dataset cannot retroactively change how a past reading was judged.
--
-- See src/oracle/referenceData/ and scripts/import-reference-data.ts.

CREATE TABLE IF NOT EXISTS reference_datasets (
  id              BIGSERIAL     PRIMARY KEY,
  name            VARCHAR(80)   NOT NULL,   -- e.g. 'aviation', 'defi-protocols', 'assets'
  version         VARCHAR(40)   NOT NULL,   -- e.g. '2024.11.1'
  status          VARCHAR(16)   NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'published', 'superseded')),
  effective_from  TIMESTAMPTZ   NOT NULL,
  effective_to    TIMESTAMPTZ,              -- NULL = open-ended
  description     TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  published_at    TIMESTAMPTZ,
  CONSTRAINT reference_datasets_version_unique UNIQUE (name, version),
  CONSTRAINT reference_datasets_effective_range
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX IF NOT EXISTS idx_reference_datasets_name_status
  ON reference_datasets (name, status);

-- Immutability guard: a published dataset's identity columns are frozen and
-- published rows cannot be deleted.  Content tables (entities/aliases) are
-- guarded separately below.
CREATE OR REPLACE FUNCTION reference_datasets_guard() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'published' THEN
      RAISE EXCEPTION 'reference_datasets: cannot delete published dataset %', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'published' THEN
    IF NEW.name <> OLD.name
       OR NEW.version <> OLD.version
       OR NEW.effective_from <> OLD.effective_from
       OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
       OR NEW.status = 'draft' THEN
      RAISE EXCEPTION
        'reference_datasets: published dataset % is immutable (import a new version)',
        OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reference_datasets_guard ON reference_datasets;
CREATE TRIGGER trg_reference_datasets_guard
  BEFORE UPDATE OR DELETE ON reference_datasets
  FOR EACH ROW EXECUTE FUNCTION reference_datasets_guard();

-- ── Reference entities ───────────────────────────────────────────────────────
-- One row per canonical entity within a dataset version.  `canonical_id` is
-- the stable, human-readable identifier used in evidence records (e.g.
-- 'airport:EGLL', 'protocol:aave-v3', 'asset:eip155:1:0xA0b8…eB48').
-- `attributes` carries entity-type-specific fields (name, country, chain id,
-- contract address, decimals, …).  `retired_at` marks entities that existed
-- in the dataset but are no longer active (e.g. a delisted protocol); such
-- entities still resolve for historical readings but are rejected for new
-- ones.

CREATE TABLE IF NOT EXISTS reference_entities (
  id            BIGSERIAL     PRIMARY KEY,
  dataset_id    BIGINT        NOT NULL REFERENCES reference_datasets (id) ON DELETE CASCADE,
  canonical_id  VARCHAR(160)  NOT NULL,
  entity_type   VARCHAR(40)   NOT NULL,  -- airport | route | carrier | protocol | market | chain | asset
  attributes    JSONB         NOT NULL DEFAULT '{}'::jsonb,
  retired_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT reference_entities_canonical_unique UNIQUE (dataset_id, canonical_id)
);

CREATE INDEX IF NOT EXISTS idx_reference_entities_dataset_type
  ON reference_entities (dataset_id, entity_type);
CREATE INDEX IF NOT EXISTS idx_reference_entities_attributes
  ON reference_entities USING GIN (attributes);

-- ── Provider-native alias resolution ─────────────────────────────────────────
-- Maps provider-specific IDs to canonical entities.  Many-to-one is allowed
-- (several provider IDs may resolve to one canonical entity).  `is_ambiguous`
-- marks provider IDs that collide within a dataset (e.g. ticker 'USDC' that
-- cannot be disambiguated without chain+contract); ambiguous aliases are
-- rejected at ingestion rather than guessed.  The unique constraint prevents
-- two rows for the same provider-native ID within one dataset version.

CREATE TABLE IF NOT EXISTS reference_entity_aliases (
  id                  BIGSERIAL     PRIMARY KEY,
  dataset_id          BIGINT        NOT NULL REFERENCES reference_datasets (id) ON DELETE CASCADE,
  provider            VARCHAR(60)   NOT NULL,  -- e.g. 'nexus', 'flightaware', 'coingecko'
  provider_native_id  VARCHAR(200)  NOT NULL,
  canonical_entity_id BIGINT        REFERENCES reference_entities (id) ON DELETE CASCADE,
  is_ambiguous        BOOLEAN       NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT reference_entity_aliases_unique
    UNIQUE (dataset_id, provider, provider_native_id),
  CONSTRAINT reference_entity_aliases_target
    CHECK (is_ambiguous OR canonical_entity_id IS NOT NULL)
);

-- Primary resolution lookup: (dataset, provider, native id) → canonical.
CREATE INDEX IF NOT EXISTS idx_reference_aliases_resolution
  ON reference_entity_aliases (dataset_id, provider, provider_native_id);
CREATE INDEX IF NOT EXISTS idx_reference_aliases_canonical
  ON reference_entity_aliases (canonical_entity_id);

-- Content immutability guard: entities and aliases belonging to a published
-- dataset are frozen (no INSERT/UPDATE/DELETE).  Importers must write into a
-- draft dataset and promote it atomically.
CREATE OR REPLACE FUNCTION reference_content_guard() RETURNS TRIGGER AS $$
DECLARE
  ds_id   BIGINT;
  ds_stat VARCHAR(16);
BEGIN
  ds_id := COALESCE(NEW.dataset_id, OLD.dataset_id);
  SELECT status INTO ds_stat FROM reference_datasets WHERE id = ds_id;
  IF ds_stat = 'published' OR ds_stat = 'superseded' THEN
    RAISE EXCEPTION
      'reference data for dataset % is immutable (status %)', ds_id, ds_stat;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reference_entities_guard ON reference_entities;
CREATE TRIGGER trg_reference_entities_guard
  BEFORE INSERT OR UPDATE OR DELETE ON reference_entities
  FOR EACH ROW EXECUTE FUNCTION reference_content_guard();

DROP TRIGGER IF EXISTS trg_reference_aliases_guard ON reference_entity_aliases;
CREATE TRIGGER trg_reference_aliases_guard
  BEFORE INSERT OR UPDATE OR DELETE ON reference_entity_aliases
  FOR EACH ROW EXECUTE FUNCTION reference_content_guard();

-- ── Feed → dataset version pins ──────────────────────────────────────────────
-- Each feed pins exactly one dataset version per dataset name.  Ingestion
-- resolves against the pinned version only; promoting a new version requires
-- an explicit UPDATE here (a deliberate, auditable act).

CREATE TABLE IF NOT EXISTS feed_reference_pins (
  feed_name     VARCHAR(80)   NOT NULL,   -- e.g. 'flightdelay', 'liquidationshield', 'price'
  dataset_name  VARCHAR(80)   NOT NULL,
  dataset_id    BIGINT        NOT NULL REFERENCES reference_datasets (id),
  pinned_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  pinned_by     VARCHAR(120),
  PRIMARY KEY (feed_name, dataset_name)
);

CREATE INDEX IF NOT EXISTS idx_feed_reference_pins_dataset
  ON feed_reference_pins (dataset_id);

-- ── Dead-letter readings ─────────────────────────────────────────────────────
-- Readings rejected at ingestion (unknown entity, retired entity, ambiguous
-- alias, malformed payload) land here with a machine-readable reason and the
-- raw payload.  Dead-lettered readings NEVER count toward quorum.  The
-- (feed_name, reason, received_at) index supports rate-limited alert
-- aggregation so an unknown-entity storm does not flood alerting.

CREATE TABLE IF NOT EXISTS dead_letter_readings (
  id            BIGSERIAL     PRIMARY KEY,
  feed_name     VARCHAR(80)   NOT NULL,
  reason        VARCHAR(60)   NOT NULL,  -- unknown_entity | retired_entity | ambiguous_alias | invalid_payload | …
  detail        TEXT,
  dataset_id    BIGINT        REFERENCES reference_datasets (id),
  raw_payload   JSONB         NOT NULL,
  received_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_feed_reason_time
  ON dead_letter_readings (feed_name, reason, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_dead_letter_received_at
  ON dead_letter_readings (received_at);
