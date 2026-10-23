-- Migration: persisted oracle circuit breaker state (issue #178)
--
-- One row per coverage type. Automatic anomaly triggers open a breaker; only
-- the operator control endpoint may move it to half_open or closed. Storing
-- state here means a process restart cannot silently resume payouts.
-- Trigger reason and readings are kept on the row as the evidence snapshot.

BEGIN;

CREATE TABLE IF NOT EXISTS oracle_circuit_breakers (
  coverage_type     VARCHAR(40)   PRIMARY KEY,
  state             VARCHAR(16)   NOT NULL DEFAULT 'closed',
  trigger_reason    TEXT,
  trigger_readings  JSONB         NOT NULL DEFAULT '[]',
  opened_at         TIMESTAMPTZ,
  half_open_at      TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT oracle_circuit_breakers_state_check CHECK (state IN ('closed', 'open', 'half_open'))
);

COMMIT;
