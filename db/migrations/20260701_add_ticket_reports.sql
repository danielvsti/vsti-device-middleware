-- Incident aggregation / multi-report cases
-- One operational ticket can accumulate many neighbor reports/testimonies.

ALTER TABLE mobile_events
  ADD COLUMN IF NOT EXISTS linked_ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS ticket_reports (
  id UUID PRIMARY KEY,
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  mobile_event_id TEXT REFERENCES mobile_events(id) ON DELETE SET NULL,
  reporter_user_id TEXT,
  reporter_name TEXT,
  reporter_phone TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  accuracy DOUBLE PRECISION,
  alert_type TEXT,
  title TEXT,
  description TEXT,
  source TEXT,
  confidence_score NUMERIC,
  match_score NUMERIC,
  distance_meters NUMERIC,
  is_primary_report BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_reports_ticket_created
  ON ticket_reports(ticket_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ticket_reports_mobile_event
  ON ticket_reports(mobile_event_id);

CREATE INDEX IF NOT EXISTS idx_mobile_events_linked_ticket
  ON mobile_events(linked_ticket_id);
