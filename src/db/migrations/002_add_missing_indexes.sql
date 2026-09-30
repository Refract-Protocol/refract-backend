-- Migration: add missing indexes for actual query patterns
-- Issue: #22
--
-- Query-to-index mapping
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. claims(processed_at DESC)
--      GET /api/v1/claims/recent → ClaimService.getRecentSettlements()
--        ORDER BY processedAt DESC
--      GET /api/v1/claims/holder/:address → ClaimService.getHistoryForHolder()
--        ORDER BY processedAt DESC
--    Both are sequential scans without this index because the existing
--    idx_claims_holder and idx_claims_policy do not cover the sort column.
--    A single-column DESC index on processed_at covers both sorts; the
--    holder filter is already served by idx_claims_holder (Postgres will
--    merge an index scan + bitmap as needed), so no composite is required.
--
-- 2. pool_snapshots(snapshotted_at DESC)
--    The "latest snapshot" query (SELECT … ORDER BY snapshotted_at DESC LIMIT 1)
--    that pool stats will run on every GET /api/v1/pool/stats request would
--    full-scan the table without an index — and pool_snapshots is the
--    fastest-growing table because a background scheduler writes to it
--    continuously. This is a partial+covering pattern modeled after the
--    existing idx_oracle_type (created WITH (fillfactor=90) to reduce
--    bloat from frequent inserts).
--
-- 3. premium_revenue(policy_id)
--    FK lookups when joining premium_revenue → policies for a given holder's
--    revenue attribution. Without this, every FK lookup is a seqscan.
--
-- 4. premium_revenue(collected_at DESC)
--    Aggregation queries that bucket revenue by day:
--      SELECT date_trunc('day', collected_at) AS day, SUM(amount) …
--      GROUP BY day ORDER BY day DESC
--    Supports both the sort and the date-trunc range filter.
--
-- Model: idx_oracle_type ON oracle_events(coverage_type, recorded_at DESC)
--   — already correct in schema.sql; used here as the pattern to follow.

BEGIN;

-- ─── claims ──────────────────────────────────────────────────────────────────

-- Covers ORDER BY processed_at DESC in getRecentSettlements() and
-- getHistoryForHolder(). DESC matches the natural read direction so
-- Postgres can serve these queries with a forward index scan rather than
-- a sort step.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_claims_processed_at
  ON claims(processed_at DESC);

-- ─── pool_snapshots ───────────────────────────────────────────────────────────

-- Covers ORDER BY snapshotted_at DESC LIMIT 1 ("latest snapshot") and any
-- time-range window over recent snapshots. fillfactor=90 leaves 10% of
-- each leaf page free for HOT updates and reduces bloat from the high
-- insert rate of the snapshot writer.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pool_snapshots_snapshotted_at
  ON pool_snapshots(snapshotted_at DESC)
  WITH (fillfactor = 90);

-- ─── premium_revenue ─────────────────────────────────────────────────────────

-- Covers FK lookups premium_revenue → policies (policy_id is an FK but
-- Postgres does not auto-index foreign keys).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_premium_revenue_policy_id
  ON premium_revenue(policy_id);

-- Covers day-bucket aggregation queries (date_trunc('day', collected_at)).
-- DESC matches the typical "most recent N days" read pattern.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_premium_revenue_collected_at
  ON premium_revenue(collected_at DESC);

COMMIT;
