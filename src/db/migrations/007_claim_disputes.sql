-- Migration: bonded dispute and challenge workflow for payout decisions (issue #207)
--
-- A dispute challenges a confirmed settlement (claim_settlements.decision_id)
-- inside a bounded window that starts when the settlement was created, measured
-- on the database clock. Status moves:
--   open → under_review → upheld | reversed
--   open | under_review → withdrawn
--
-- Bond accounting is recorded here and is contract-ready: posted at open,
-- forfeited on upheld, returned on reversed or withdrawn.
--
-- At most one non-withdrawn dispute may exist per decision. That rejects
-- duplicate challenges and any challenge against an already-resolved decision.
--
-- Reversal never edits the original settlement or its evidence. It links a
-- recomputed replacement decision (replacement_decision_id, which supersedes
-- decision_id) and books exactly one settlement_reversals row per decision,
-- so the compensating reconciliation cannot be recorded twice.

BEGIN;

CREATE TABLE IF NOT EXISTS claim_disputes (
  id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id             TEXT          NOT NULL REFERENCES claim_settlements(decision_id),
  policy_id               UUID          NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  status                  TEXT          NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'under_review', 'upheld', 'reversed', 'withdrawn')
  ),
  reason                  TEXT          NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 2000),
  bond_reference          TEXT          NOT NULL,
  bond_status             TEXT          NOT NULL DEFAULT 'posted' CHECK (
    bond_status IN ('posted', 'forfeited', 'returned')
  ),
  opened_by               TEXT          NOT NULL,
  window_closes_at        TIMESTAMPTZ   NOT NULL,
  resolution_note         TEXT,
  replacement_decision_id TEXT          UNIQUE,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
  resolved_at             TIMESTAMPTZ,
  CHECK (replacement_decision_id IS NULL OR replacement_decision_id <> decision_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_disputes_live_decision
  ON claim_disputes(decision_id)
  WHERE status <> 'withdrawn';

CREATE INDEX IF NOT EXISTS idx_claim_disputes_open
  ON claim_disputes(status)
  WHERE status IN ('open', 'under_review');

CREATE TABLE IF NOT EXISTS settlement_reversals (
  dispute_id   UUID           PRIMARY KEY REFERENCES claim_disputes(id),
  decision_id  TEXT           NOT NULL UNIQUE REFERENCES claim_settlements(decision_id),
  policy_id    UUID           NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  amount       NUMERIC(38, 18) NOT NULL CHECK (amount > 0),
  status       TEXT           NOT NULL DEFAULT 'owed' CHECK (status IN ('owed', 'reconciled')),
  created_at   TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ    NOT NULL DEFAULT now()
);

COMMIT;
