-- Migration: add idempotency index for claim settlement (issue #23)
--
-- After the on-chain payout confirms, the service must atomically:
--   1. deactivate the policy
--   2. insert the claim record
--
-- A crash between those two writes can produce two outcomes:
--   A. deactivate succeeded, claim insert not yet run
--      → next scheduler scan sees policy inactive, skips it safely.
--   B. deactivate not yet run, claim insert succeeded
--      → next scan sees policy still active and may attempt a second payout.
--
-- The wrapping database transaction (added via DatabaseModule.withTransaction
-- in the Postgres migration PR) prevents both races. This index is a belt-
-- and-suspenders guard against outcome B surviving even a mid-transaction
-- crash: a second INSERT for the same policy_id will raise a unique violation
-- rather than silently creating a duplicate settlement record.
--
-- The partial filter (WHERE payout > 0) is consistent with the CHECK
-- constraint added in 001; a zero-payout row can never represent a real
-- settlement so it is excluded from uniqueness consideration.

BEGIN;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_claims_policy_id_settled
  ON claims(policy_id)
  WHERE payout > 0;

COMMIT;
