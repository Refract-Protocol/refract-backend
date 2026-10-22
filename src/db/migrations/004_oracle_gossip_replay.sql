CREATE TABLE IF NOT EXISTS oracle_peer_sequences (
  peer_id text PRIMARY KEY,
  last_sequence bigint NOT NULL CHECK (last_sequence > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oracle_gossip_replays (
  peer_id text NOT NULL REFERENCES oracle_peer_sequences(peer_id) ON DELETE CASCADE,
  round_id text NOT NULL,
  expires_at_ms bigint NOT NULL,
  PRIMARY KEY (peer_id, round_id)
);

CREATE INDEX IF NOT EXISTS idx_oracle_gossip_replays_expiry
  ON oracle_gossip_replays (expires_at_ms);
