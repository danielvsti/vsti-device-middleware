ALTER TABLE ticket_assignments
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

UPDATE ticket_assignments
SET updated_at = COALESCE(rejected_at, accepted_at, notified_at, created_at, NOW())
WHERE updated_at IS NULL;
