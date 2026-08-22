BEGIN;

CREATE TABLE IF NOT EXISTS resolver_action_receipts (
  client_action_id TEXT PRIMARY KEY,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  result_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resolver_action_receipts_ticket
  ON resolver_action_receipts(ticket_id, created_at DESC);

COMMIT;
