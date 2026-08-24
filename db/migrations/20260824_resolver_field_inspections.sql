BEGIN;

ALTER TABLE safety_inspections
  ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS accuracy DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS source_vertical VARCHAR(24),
  ADD COLUMN IF NOT EXISTS alert_requested BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_safety_inspections_field_history
  ON safety_inspections(control_center_id, inspector_user_id, created_at DESC)
  WHERE source_vertical IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_safety_inspections_linked_ticket
  ON safety_inspections(control_center_id, linked_ticket_id)
  WHERE linked_ticket_id IS NOT NULL;

COMMIT;
