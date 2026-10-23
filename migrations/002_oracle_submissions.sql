-- Migration: signed third-party oracle submissions (issue #183)
-- Apply with: psql "$DATABASE_URL" -f migrations/002_oracle_submissions.sql
-- Requires the coverage_type enum from the baseline schema.

-- Replay protection. Rows expire at observed_at + freshness window, after which
-- the submission would be rejected as stale anyway, so they can be pruned.
CREATE TABLE IF NOT EXISTS oracle_submission_nonces (
  provider_id  VARCHAR(64)  NOT NULL,
  nonce        VARCHAR(64)  NOT NULL,
  expires_at   TIMESTAMPTZ  NOT NULL,
  PRIMARY KEY (provider_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_oracle_submission_nonces_expiry
  ON oracle_submission_nonces(expires_at);

-- Evidence ledger: every accepted submission, attributed to its provider.
CREATE TABLE IF NOT EXISTS oracle_submissions (
  id             BIGSERIAL      PRIMARY KEY,
  provider_id    VARCHAR(64)    NOT NULL,
  nonce          VARCHAR(64)    NOT NULL,
  coverage_type  coverage_type  NOT NULL,
  value          NUMERIC(20,6)  NOT NULL,
  unit           VARCHAR(16)    NOT NULL,
  observed_at    TIMESTAMPTZ    NOT NULL,
  signature      VARCHAR(128)   NOT NULL,
  received_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oracle_submissions_type_observed
  ON oracle_submissions(coverage_type, observed_at DESC);
