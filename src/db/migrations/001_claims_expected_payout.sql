-- Migration: add expected_payout (+ discrepancy flag) to claims for
-- reconciling process_claim's on-chain i128 return against the locally
-- expected coverage amount (issue #40).
-- Apply with: psql "$DATABASE_URL" -f src/db/migrations/001_claims_expected_payout.sql

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS expected_payout NUMERIC(30, 0);

-- Backfill existing rows: treat historical payout as both actual and expected.
UPDATE claims
SET expected_payout = payout
WHERE expected_payout IS NULL;

ALTER TABLE claims
  ALTER COLUMN expected_payout SET NOT NULL;

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS payout_discrepancy BOOLEAN NOT NULL DEFAULT false;
