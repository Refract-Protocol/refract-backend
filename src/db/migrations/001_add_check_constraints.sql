-- Migration: add CHECK constraints to enforce financial invariants at the DB level
-- Issue: #21
-- Without these, a migration script, direct psql session, or future code path
-- could store logically invalid data that every downstream consumer trusts.
--
-- Applied constraints
-- ─────────────────────────────────────────────────────────────────────────────
-- pool_snapshots
--   • all monetary columns ≥ 0
--   • locked_usdc ≤ total_usdc (can't lock more than you have)
--   • utilization_bps in [0, 10000] (0–100%, prevents the 500% bug cited in #21)
--   • apy_bps ≥ 0 (negative yield is a separate product feature, not a default)
--   • share_price > 0 (a zero or negative NAV is nonsensical)
--
-- policies
--   • coverage_amount > 0  (mirrors policy.service.ts:311-313 rejection)
--   • premium > 0
--   • duration_days in [1, 365] (mirrors buy-policy.dto.ts:@Min(1)/@Max(365))
--   • expires_at > created_at (a policy that has already expired at birth is a bug)
--
-- claims
--   • payout > 0 (a zero-payout claim settlement is meaningless)
--   • trigger_value ≥ 0
--
-- oracle_events
--   • value ≥ 0
--   • severity is one of the four documented levels
--
-- lp_positions
--   • shares, usdc_deposited, premium_earned all ≥ 0
--
-- premium_revenue
--   • amount > 0

BEGIN;

-- ─── pool_snapshots ───────────────────────────────────────────────────────────

ALTER TABLE pool_snapshots
  ADD CONSTRAINT chk_pool_total_usdc_nonneg
    CHECK (total_usdc >= 0),
  ADD CONSTRAINT chk_pool_total_shares_nonneg
    CHECK (total_shares >= 0),
  ADD CONSTRAINT chk_pool_locked_usdc_nonneg
    CHECK (locked_usdc >= 0),
  ADD CONSTRAINT chk_pool_locked_lte_total
    CHECK (locked_usdc <= total_usdc),
  ADD CONSTRAINT chk_pool_premium_accrued_nonneg
    CHECK (premium_accrued >= 0),
  ADD CONSTRAINT chk_pool_share_price_positive
    CHECK (share_price > 0),
  ADD CONSTRAINT chk_pool_utilization_bps_range
    CHECK (utilization_bps BETWEEN 0 AND 10000),
  ADD CONSTRAINT chk_pool_apy_bps_nonneg
    CHECK (apy_bps >= 0);

-- ─── policies ────────────────────────────────────────────────────────────────

ALTER TABLE policies
  ADD CONSTRAINT chk_policy_coverage_amount_positive
    CHECK (coverage_amount > 0),
  ADD CONSTRAINT chk_policy_premium_positive
    CHECK (premium > 0),
  ADD CONSTRAINT chk_policy_duration_days_range
    CHECK (duration_days BETWEEN 1 AND 365),
  ADD CONSTRAINT chk_policy_expires_after_created
    CHECK (expires_at > created_at);

-- ─── claims ──────────────────────────────────────────────────────────────────

ALTER TABLE claims
  ADD CONSTRAINT chk_claim_payout_positive
    CHECK (payout > 0),
  ADD CONSTRAINT chk_claim_trigger_value_nonneg
    CHECK (trigger_value >= 0);

-- ─── oracle_events ───────────────────────────────────────────────────────────

ALTER TABLE oracle_events
  ADD CONSTRAINT chk_oracle_value_nonneg
    CHECK (value >= 0),
  ADD CONSTRAINT chk_oracle_severity_values
    CHECK (severity IN ('low', 'medium', 'high', 'triggered'));

-- ─── lp_positions ────────────────────────────────────────────────────────────

ALTER TABLE lp_positions
  ADD CONSTRAINT chk_lp_shares_nonneg
    CHECK (shares >= 0),
  ADD CONSTRAINT chk_lp_usdc_deposited_nonneg
    CHECK (usdc_deposited >= 0),
  ADD CONSTRAINT chk_lp_premium_earned_nonneg
    CHECK (premium_earned >= 0);

-- ─── premium_revenue ─────────────────────────────────────────────────────────

ALTER TABLE premium_revenue
  ADD CONSTRAINT chk_premium_revenue_amount_positive
    CHECK (amount > 0);

COMMIT;
