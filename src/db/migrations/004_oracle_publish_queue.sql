-- Migration: durable pending-decisions queue for batched on-chain oracle publishing
-- PostgreSQL 15+
--
-- Persist-then-publish: decisions are inserted as 'pending' before any
-- submission and only marked 'published' once the tx is confirmed, so batching
-- and RPC outages can never lose a decision. `id` is the global publish order;
-- per-feed ordering is derived from it.

CREATE TABLE IF NOT EXISTS oracle_publish_queue (
  id              BIGSERIAL      PRIMARY KEY,
  -- Idempotency key / on-chain decision id; duplicate enqueues are ignored.
  decision_key    TEXT           NOT NULL UNIQUE,
  feed            TEXT           NOT NULL,
  value_scaled    NUMERIC(40, 0) NOT NULL,
  -- 1 = payout-triggering (kept at the head of the queue), 0 = low priority.
  priority        SMALLINT       NOT NULL DEFAULT 0,
  status          TEXT           NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'inflight', 'published', 'failed')),
  attempts        INTEGER        NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ    NOT NULL DEFAULT now(),
  last_error      TEXT,
  tx_hash         TEXT,
  ledger          BIGINT,
  created_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
  published_at    TIMESTAMPTZ
);

-- Drain scan: eligible rows by priority then publish order.
CREATE INDEX IF NOT EXISTS idx_oracle_publish_queue_drain
  ON oracle_publish_queue (priority DESC, id)
  WHERE status IN ('pending', 'inflight');

-- Per-feed head-of-line / ordering checks.
CREATE INDEX IF NOT EXISTS idx_oracle_publish_queue_feed
  ON oracle_publish_queue (feed, id)
  WHERE status IN ('pending', 'inflight');
