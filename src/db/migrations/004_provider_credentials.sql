-- Migration 004: Provider identity, versioned keys, revocation, and rotation tables
-- Implements first-class revocation path for oracle provider credentials.
-- All revocations are append-only; deletions are never performed.

-- ── oracle_providers ─────────────────────────────────────────────────────────
-- Stable identity record. A provider survives key rotation and revocation.
CREATE TABLE IF NOT EXISTS oracle_providers (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       VARCHAR(80)  NOT NULL UNIQUE,
    contact    VARCHAR(255) NOT NULL,
    is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ── provider_keys ────────────────────────────────────────────────────────────
-- Versioned child records. Revocation is key-level; the provider survives.
-- key_hash stores SHA-256(rawKey) — plaintext never persisted.
CREATE TABLE IF NOT EXISTS provider_keys (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id              UUID        NOT NULL REFERENCES oracle_providers(id),
    key_hash                 CHAR(64)    NOT NULL UNIQUE,  -- hex SHA-256
    version                  INTEGER     NOT NULL,
    status                   VARCHAR(12) NOT NULL DEFAULT 'active'
                                 CHECK (status IN ('active','rotating','revoked','superseded')),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    rotating_at              TIMESTAMPTZ,
    revoked_at               TIMESTAMPTZ,
    -- Ledger sequence from which this key is no longer accepted (set on revocation).
    effective_until_sequence BIGINT,
    UNIQUE (provider_id, version)
);

CREATE INDEX IF NOT EXISTS idx_provider_keys_provider_status
    ON provider_keys (provider_id, status);

-- ── provider_revocations ─────────────────────────────────────────────────────
-- Append-only audit log. A superseding record reverses an accidental revocation;
-- the original row is preserved for evidence retention.
CREATE TABLE IF NOT EXISTS provider_revocations (
    id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    key_id                   UUID        NOT NULL REFERENCES provider_keys(id),
    provider_id              UUID        NOT NULL REFERENCES oracle_providers(id),
    reason                   TEXT        NOT NULL,
    actor                    VARCHAR(80) NOT NULL,
    -- Ledger sequence from which submissions signed by this key are rejected.
    effective_from_sequence  BIGINT      NOT NULL,
    revoked_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Points to the revocation this record supersedes (for accidental-revocation reversal).
    supersedes_revocation_id UUID        REFERENCES provider_revocations(id)
);

CREATE INDEX IF NOT EXISTS idx_provider_revocations_key
    ON provider_revocations (key_id, revoked_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_revocations_provider
    ON provider_revocations (provider_id, revoked_at DESC);

-- ── provider_key_rotations ───────────────────────────────────────────────────
-- Tracks active key rotations. Both old and new keys are accepted during
-- the overlap window. completed_at is NULL while the rotation is in-progress.
CREATE TABLE IF NOT EXISTS provider_key_rotations (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id           UUID        NOT NULL REFERENCES oracle_providers(id),
    old_key_id            UUID        NOT NULL REFERENCES provider_keys(id),
    new_key_id            UUID        NOT NULL REFERENCES provider_keys(id),
    overlap_window_ends_at TIMESTAMPTZ NOT NULL,
    actor                 VARCHAR(80) NOT NULL,
    initiated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_provider_rotations_provider
    ON provider_key_rotations (provider_id, initiated_at DESC);
