-- Refract Protocol Database Schema
-- PostgreSQL 15+

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Coverage Types ──────────────────────────────────────────────────────────

CREATE TYPE coverage_type AS ENUM (
  'stablecoin_depeg',
  'market_crash',
  'liquidation_shield',
  'smart_contract_risk',
  'flight_delay'
);

-- ─── Risk Pool Snapshots ─────────────────────────────────────────────────────

CREATE TABLE pool_snapshots (
  id              BIGSERIAL       PRIMARY KEY,
  total_usdc      NUMERIC(30, 0)  NOT NULL,
  total_shares    NUMERIC(30, 0)  NOT NULL,
  locked_usdc     NUMERIC(30, 0)  NOT NULL,
  premium_accrued NUMERIC(30, 0)  NOT NULL,
  share_price     NUMERIC(20, 7)  NOT NULL,
  utilization_bps SMALLINT        NOT NULL,
  apy_bps         SMALLINT        NOT NULL,
  snapshotted_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ─── Policies ────────────────────────────────────────────────────────────────

CREATE TABLE policies (
  id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  policy_id       VARCHAR(32)     UNIQUE,             -- on-chain policy ID
  holder          VARCHAR(56)     NOT NULL,            -- Stellar address
  coverage_type   coverage_type   NOT NULL,
  coverage_amount NUMERIC(30, 0)  NOT NULL,            -- 1e7 USDC
  premium         NUMERIC(30, 0)  NOT NULL,
  duration_days   SMALLINT        NOT NULL,
  expires_at      TIMESTAMPTZ     NOT NULL,
  trigger_params  JSONB           NOT NULL DEFAULT '{}',
  is_active       BOOLEAN         NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_policies_holder  ON policies(holder);
CREATE INDEX idx_policies_type    ON policies(coverage_type);
CREATE INDEX idx_policies_active  ON policies(is_active, expires_at);

-- ─── Claims ──────────────────────────────────────────────────────────────────

CREATE TABLE claims (
  id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  policy_id       UUID            NOT NULL REFERENCES policies(id),
  holder          VARCHAR(56)     NOT NULL,
  coverage_type   coverage_type   NOT NULL,
  payout          NUMERIC(30, 0)  NOT NULL,
  trigger_value   NUMERIC(20, 6)  NOT NULL,    -- oracle value that triggered
  trigger_source  VARCHAR(40)     NOT NULL,
  tx_hash         VARCHAR(64),
  processed_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_claims_holder ON claims(holder);
CREATE INDEX idx_claims_policy ON claims(policy_id);

-- ─── Oracle Events ───────────────────────────────────────────────────────────

CREATE TABLE oracle_events (
  id              BIGSERIAL       PRIMARY KEY,
  coverage_type   coverage_type   NOT NULL,
  value           NUMERIC(20, 6)  NOT NULL,
  source          VARCHAR(40)     NOT NULL,
  severity        VARCHAR(10)     NOT NULL,  -- low | medium | high | triggered
  recorded_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_oracle_type ON oracle_events(coverage_type, recorded_at DESC);

-- ─── LP Positions ────────────────────────────────────────────────────────────

CREATE TABLE lp_positions (
  id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider        VARCHAR(56)     NOT NULL UNIQUE,
  shares          NUMERIC(30, 0)  NOT NULL DEFAULT 0,
  usdc_deposited  NUMERIC(30, 0)  NOT NULL DEFAULT 0,
  premium_earned  NUMERIC(30, 0)  NOT NULL DEFAULT 0,
  first_deposit   TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  last_updated    TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ─── Premium Revenue ─────────────────────────────────────────────────────────

CREATE TABLE premium_revenue (
  id              BIGSERIAL       PRIMARY KEY,
  policy_id       UUID            NOT NULL REFERENCES policies(id),
  amount          NUMERIC(30, 0)  NOT NULL,
  coverage_type   coverage_type   NOT NULL,
  collected_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
