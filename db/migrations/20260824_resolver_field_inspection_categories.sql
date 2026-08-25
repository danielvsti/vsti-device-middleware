BEGIN;

ALTER TABLE safety_inspections
  ADD COLUMN IF NOT EXISTS category_type VARCHAR(80);

CREATE INDEX IF NOT EXISTS idx_safety_inspections_cc_category
  ON safety_inspections(control_center_id, category_type, created_at DESC)
  WHERE category_type IS NOT NULL;

COMMIT;
