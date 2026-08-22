BEGIN;

ALTER TABLE mobile_events
  ADD COLUMN IF NOT EXISTS client_request_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_events_user_client_request
  ON mobile_events(user_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

COMMIT;
