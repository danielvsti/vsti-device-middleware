-- QUELTU · Portal Profesional HSE
-- Extiende la investigación asociada a tickets sin crear una entidad paralela
-- ni alterar el flujo de aprobación del Supervisor HSE.

ALTER TABLE safety_incidents
  ADD COLUMN IF NOT EXISTS investigation_method VARCHAR(40) DEFAULT 'FIVE_WHYS';

ALTER TABLE safety_incidents
  ADD COLUMN IF NOT EXISTS problem_statement TEXT;

ALTER TABLE safety_incidents
  ADD COLUMN IF NOT EXISTS event_sequence JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE safety_incidents
  ADD COLUMN IF NOT EXISTS immediate_causes JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE safety_incidents
  ADD COLUMN IF NOT EXISTS contributing_factors JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE safety_incidents
  ADD COLUMN IF NOT EXISTS lessons_learned TEXT;

ALTER TABLE safety_incidents
  ADD COLUMN IF NOT EXISTS conclusion TEXT;

CREATE INDEX IF NOT EXISTS idx_safety_incidents_ticket_status
  ON safety_incidents(linked_ticket_id, investigation_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_safety_actions_source_status
  ON safety_actions(source_id, status, due_date);
