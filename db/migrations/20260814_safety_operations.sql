-- QUELTU Safety Operations
-- Esquema común para CITY, MINING e INDUSTRY. Toda entidad queda segregada
-- por control_center_id; no introduce Tenant ni bases separadas por vertical.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS safety_incidents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
  linked_ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,
  title VARCHAR(180) NOT NULL,
  event_type VARCHAR(80) NOT NULL DEFAULT 'ACCIDENT',
  severity VARCHAR(32) NOT NULL DEFAULT 'MEDIUM',
  potential_severity VARCHAR(32),
  occurred_at TIMESTAMP NOT NULL DEFAULT NOW(),
  area VARCHAR(180),
  description TEXT,
  investigation_status VARCHAR(32) NOT NULL DEFAULT 'OPEN',
  immediate_actions TEXT,
  root_causes JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_safety_incidents_cc_date ON safety_incidents(control_center_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS safety_actions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
  source_type VARCHAR(40) NOT NULL DEFAULT 'GENERAL',
  source_id UUID,
  title VARCHAR(180) NOT NULL,
  description TEXT,
  action_type VARCHAR(24) NOT NULL DEFAULT 'CORRECTIVE',
  priority VARCHAR(20) NOT NULL DEFAULT 'MEDIUM',
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  owner_name VARCHAR(180),
  due_date DATE,
  status VARCHAR(24) NOT NULL DEFAULT 'OPEN',
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_safety_actions_cc_status ON safety_actions(control_center_id, status, due_date);

CREATE TABLE IF NOT EXISTS safety_inspection_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
  name VARCHAR(180) NOT NULL,
  inspection_type VARCHAR(80) NOT NULL,
  description TEXT,
  checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS safety_inspections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
  template_id UUID REFERENCES safety_inspection_templates(id) ON DELETE SET NULL,
  title VARCHAR(180) NOT NULL,
  inspection_type VARCHAR(80) NOT NULL,
  area VARCHAR(180),
  scheduled_at TIMESTAMP,
  completed_at TIMESTAMP,
  status VARCHAR(24) NOT NULL DEFAULT 'PLANNED',
  result VARCHAR(24) NOT NULL DEFAULT 'NOT_EVALUATED',
  score NUMERIC(5,2),
  responses JSONB NOT NULL DEFAULT '[]'::jsonb,
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT,
  inspector_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_safety_inspections_cc_date ON safety_inspections(control_center_id, COALESCE(scheduled_at, created_at) DESC);

CREATE TABLE IF NOT EXISTS safety_critical_controls (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
  code VARCHAR(50) NOT NULL,
  hazard VARCHAR(180) NOT NULL,
  name VARCHAR(180) NOT NULL,
  control_type VARCHAR(32),
  work_area VARCHAR(180),
  verification_question TEXT NOT NULL,
  performance_standard TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(control_center_id, code)
);

CREATE TABLE IF NOT EXISTS safety_control_verifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
  control_id UUID NOT NULL REFERENCES safety_critical_controls(id) ON DELETE CASCADE,
  inspection_id UUID REFERENCES safety_inspections(id) ON DELETE SET NULL,
  result VARCHAR(24) NOT NULL,
  area VARCHAR(180),
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT,
  verified_by UUID REFERENCES users(id) ON DELETE SET NULL,
  verified_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_safety_control_verifications_cc_date ON safety_control_verifications(control_center_id, verified_at DESC);

CREATE TABLE IF NOT EXISTS safety_behavior_observations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
  observation_type VARCHAR(20) NOT NULL,
  category VARCHAR(100) NOT NULL,
  area VARCHAR(180),
  description TEXT NOT NULL,
  feedback TEXT,
  anonymous BOOLEAN NOT NULL DEFAULT FALSE,
  observed_at TIMESTAMP NOT NULL DEFAULT NOW(),
  observer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_safety_behavior_cc_date ON safety_behavior_observations(control_center_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS safety_camera_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
  provider VARCHAR(80) NOT NULL DEFAULT 'MANUAL_DEMO',
  external_event_id VARCHAR(180),
  event_type VARCHAR(100) NOT NULL,
  confidence NUMERIC(5,4),
  camera_id VARCHAR(120),
  camera_name VARCHAR(180),
  area VARCHAR(180),
  occurred_at TIMESTAMP NOT NULL DEFAULT NOW(),
  media_url TEXT,
  status VARCHAR(24) NOT NULL DEFAULT 'NEW',
  linked_ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_safety_camera_cc_provider_event
  ON safety_camera_events(control_center_id, provider, external_event_id)
  WHERE external_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_safety_camera_cc_date ON safety_camera_events(control_center_id, occurred_at DESC);

ALTER TABLE users ADD COLUMN IF NOT EXISTS work_area VARCHAR(180);

CREATE TABLE IF NOT EXISTS safety_pnr_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
  code VARCHAR(80) NOT NULL,
  title VARCHAR(220) NOT NULL,
  document_type VARCHAR(24) NOT NULL DEFAULT 'PROCEDURE',
  work_area VARCHAR(180),
  version VARCHAR(40) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'PUBLISHED',
  summary TEXT,
  effective_from DATE,
  effective_until DATE,
  file_name VARCHAR(255),
  mime_type VARCHAR(100),
  document_data BYTEA,
  document_url TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(control_center_id, code, version),
  CHECK (document_data IS NOT NULL OR document_url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_safety_pnr_cc_area ON safety_pnr_documents(control_center_id, work_area, active, status);

CREATE TABLE IF NOT EXISTS safety_ticket_risk_assessments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  phase VARCHAR(20) NOT NULL DEFAULT 'INITIAL',
  severity SMALLINT NOT NULL CHECK (severity BETWEEN 1 AND 5),
  frequency SMALLINT NOT NULL CHECK (frequency BETWEEN 1 AND 5),
  score SMALLINT NOT NULL CHECK (score BETWEEN 1 AND 25),
  risk_level VARCHAR(20) NOT NULL,
  frequency_source VARCHAR(40) NOT NULL DEFAULT 'PROFESSIONAL_ESTIMATE',
  suggestion_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  assessed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  assessed_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_safety_ticket_risk_ticket ON safety_ticket_risk_assessments(ticket_id, assessed_at DESC);

ALTER TABLE safety_incidents ADD COLUMN IF NOT EXISTS investigation_notes TEXT;
ALTER TABLE safety_incidents ADD COLUMN IF NOT EXISTS recommendations TEXT;
ALTER TABLE safety_incidents ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE safety_inspections ADD COLUMN IF NOT EXISTS linked_ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL;
ALTER TABLE safety_critical_controls ADD COLUMN IF NOT EXISTS control_type VARCHAR(32);
ALTER TABLE safety_critical_controls ADD COLUMN IF NOT EXISTS work_area VARCHAR(180);
ALTER TABLE safety_control_verifications ADD COLUMN IF NOT EXISTS ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_safety_critical_controls_cc_filters ON safety_critical_controls(control_center_id, work_area, control_type, active);
CREATE INDEX IF NOT EXISTS idx_safety_inspections_ticket ON safety_inspections(linked_ticket_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_safety_control_verifications_ticket ON safety_control_verifications(ticket_id, verified_at DESC);

CREATE TABLE IF NOT EXISTS safety_ticket_closure_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  incident_id UUID REFERENCES safety_incidents(id) ON DELETE SET NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'REQUESTED',
  request_summary TEXT NOT NULL,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_at TIMESTAMP NOT NULL DEFAULT NOW(),
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMP,
  decision_notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_safety_closure_requests_cc_status
  ON safety_ticket_closure_requests(control_center_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_safety_closure_requests_ticket
  ON safety_ticket_closure_requests(ticket_id, requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_safety_closure_request_pending_ticket
  ON safety_ticket_closure_requests(ticket_id) WHERE status='REQUESTED';
