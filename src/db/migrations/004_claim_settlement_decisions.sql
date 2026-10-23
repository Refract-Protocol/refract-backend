-- Migration: durable per-decision settlement state machine (issue #198)
--
-- Every consensus decision maps to exactly one row keyed by decision_id
-- (see buildDecisionId in src/oracle/oracle-encoding.ts). Status moves:
--   pending → submitted → confirmed
--   pending → failed      (definitively rejected; a later decision may re-claim)
--
-- A row in pending/submitted/confirmed blocks any other decision for the same
-- policy through the partial unique index, so a policy can settle at most once
-- even if two distinct decision ids are produced for it.
--
-- "submitted" and "pending" are never retried blindly: their on-chain outcome
-- is unknown until reconciled against tx_hash.

BEGIN;

CREATE TABLE IF NOT EXISTS claim_settlements (
  decision_id  TEXT          PRIMARY KEY,
  policy_id    UUID          NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  amount       NUMERIC(38, 18) NOT NULL CHECK (amount > 0),
  status       TEXT          NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'submitted', 'confirmed', 'failed')
  ),
  tx_hash      VARCHAR(64),
  evidence     JSONB         NOT NULL DEFAULT '{}'::jsonb,
  last_error   TEXT,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_settlements_policy_open
  ON claim_settlements(policy_id)
  WHERE status IN ('pending', 'submitted', 'confirmed');

CREATE INDEX IF NOT EXISTS idx_claim_settlements_unresolved
  ON claim_settlements(status)
  WHERE status IN ('pending', 'submitted');

COMMIT;
