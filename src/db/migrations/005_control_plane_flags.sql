-- Migration 005: durable control-plane flag store
--
-- Used by ContractSpecRevalidator to persist the contract spec validation
-- state (valid / mismatch / unknown) across restarts. The block survives
-- a process restart and clears only after a successful revalidation or
-- an explicit operator override.

CREATE TABLE IF NOT EXISTS control_plane_flags (
    key        VARCHAR(80) PRIMARY KEY,
    value      JSONB       NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
