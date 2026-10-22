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
