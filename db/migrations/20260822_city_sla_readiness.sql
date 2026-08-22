BEGIN;

ALTER TABLE ticket_assignments
  ADD COLUMN IF NOT EXISTS accept_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_policy_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_ticket_assignments_pending_accept_due
  ON ticket_assignments(accept_due_at)
  WHERE state = 'PENDING' AND accept_due_at IS NOT NULL;

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS sla_policy_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS acknowledged_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS assigned_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_due_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tickets_open_sla_due
  ON tickets(control_center_id, assigned_due_at, resolved_due_at)
  WHERE state NOT IN ('CLOSED','CANCELLED','RESOLVED');

COMMIT;
