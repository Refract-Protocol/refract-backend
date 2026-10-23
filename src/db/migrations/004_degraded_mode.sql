-- Migration: per-feed degraded mode state and blocked-claim reason codes (issue #195)
--
-- Fail-closed policy: while a feed is not 'healthy', no payout-triggering value
-- is published and no claim on that feed is settled. Blocked claims stay
-- 'blocked_degraded' with a reason code so they are distinguishable from
-- 'not triggered' and are re-evaluated once quorum is restored.
--
-- Apply with: psql "$DATABASE_URL" -f src/db/migrations/004_degraded_mode.sql

BEGIN;

CREATE TABLE IF NOT EXISTS oracle_feed_state (
  coverage_type         SMALLINT     PRIMARY KEY CHECK (coverage_type BETWEEN 0 AND 4),
  health                TEXT         NOT NULL DEFAULT 'healthy'
                                     CHECK (health IN ('healthy', 'degraded', 'paused')),
  reason                TEXT         CHECK (reason IN (
                                       'quorum_shortfall',
                                       'no_fresh_sources',
                                       'sources_divergent',
                                       'consensus_unavailable'
                                     )),
  consecutive_failures  INTEGER      NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  entered_at            TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- A non-healthy feed must carry the reason it entered that state.
  CHECK (health = 'healthy' OR reason IS NOT NULL)
);

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS block_reason TEXT;

COMMENT ON COLUMN claims.block_reason IS
  'Degraded-mode reason code (oracle_feed_state.reason) when status = blocked_degraded';

COMMIT;
