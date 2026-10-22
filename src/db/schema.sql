-- Oracle schema
-- (existing tables omitted from this diff view; append the drift tables below)

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
