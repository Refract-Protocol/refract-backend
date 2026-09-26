-- Migration: on-chain policy id + explicit policy state machine
-- Apply after src/db/schema.sql (or against an existing policies table).
--
-- policy_id holds the u64 returned by buy_policy() as a decimal string
-- (up to 20 digits). Status makes the pending → active → inactive
-- lifecycle explicit; only `active` rows are claim-scanned.

ALTER TABLE policies
  ALTER COLUMN policy_id TYPE VARCHAR(20);

ALTER TABLE policies
  ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'pending';

ALTER TABLE policies
  ADD COLUMN IF NOT EXISTS pending_tx_hash VARCHAR(64);

ALTER TABLE policies
  ADD COLUMN IF NOT EXISTS pending_expires_at TIMESTAMPTZ;

-- Backfill: rows that already look "live" stay active; others pending.
UPDATE policies
SET status = CASE WHEN is_active AND policy_id IS NOT NULL THEN 'active'
                  WHEN is_active THEN 'pending'
                  ELSE 'inactive' END
WHERE status = 'pending' AND created_at < NOW(); -- only touch ambiguous defaults carefully

CREATE UNIQUE INDEX IF NOT EXISTS idx_policies_pending_tx_hash
  ON policies(pending_tx_hash)
  WHERE pending_tx_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_policies_status_active
  ON policies(status, expires_at)
  WHERE status = 'active';

COMMENT ON COLUMN policies.policy_id IS 'On-chain u64 policy id as decimal string (buy_policy return value)';
COMMENT ON COLUMN policies.status IS 'pending | active | inactive';
