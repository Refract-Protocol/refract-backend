-- Apply to an existing database to enable Soroban pool event ingestion.
CREATE TABLE IF NOT EXISTS soroban_pool_events (
  event_id           VARCHAR(128)    NOT NULL,
  cursor             TEXT            NOT NULL UNIQUE,
  contract_id        VARCHAR(56)     NOT NULL,
  event_type         VARCHAR(32)     NOT NULL CHECK (
    event_type IN ('POLICY_PURCHASED', 'CAPITAL_PROVIDED', 'CAPITAL_WITHDRAWN', 'CLAIM_SETTLED')
  ),
  ledger             BIGINT          NOT NULL,
  tx_hash            VARCHAR(64)     NOT NULL,
  ledger_closed_at   TIMESTAMPTZ     NOT NULL,
  holder             VARCHAR(56),
  on_chain_policy_id NUMERIC(20, 0),
  amount             NUMERIC(30, 0),
  secondary_amount   NUMERIC(30, 0),
  expires_at         BIGINT,
  payload            JSONB           NOT NULL,
  ingested_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contract_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_soroban_pool_events_type_ledger
  ON soroban_pool_events(event_type, ledger DESC);
CREATE INDEX IF NOT EXISTS idx_soroban_pool_events_holder_ledger
  ON soroban_pool_events(holder, ledger DESC);
CREATE INDEX IF NOT EXISTS idx_soroban_pool_events_policy
  ON soroban_pool_events(on_chain_policy_id);

CREATE TABLE IF NOT EXISTS soroban_event_cursors (
  contract_id        VARCHAR(56)     PRIMARY KEY,
  cursor             TEXT,
  next_start_ledger  BIGINT          NOT NULL CHECK (next_start_ledger > 0),
  updated_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
