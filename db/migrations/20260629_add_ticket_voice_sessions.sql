CREATE TABLE IF NOT EXISTS ticket_voice_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,
  mobile_event_id TEXT REFERENCES mobile_events(id) ON DELETE SET NULL,
  requested_by TEXT NOT NULL,
  target_type TEXT NOT NULL,
  neighbor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  resolver_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  operator_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  external_reference TEXT NOT NULL,
  wa_center_session_id TEXT,
  wa_center_call_id TEXT,
  wa_center_bridge_id TEXT,
  status TEXT NOT NULL DEFAULT 'REQUESTED',
  party_a_role TEXT,
  party_b_role TEXT,
  party_a_webrtc JSONB,
  party_b_webrtc JSONB,
  recording_id TEXT,
  recording_url TEXT,
  started_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  failure_reason TEXT,
  raw_request JSONB DEFAULT '{}'::jsonb,
  raw_response JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_voice_sessions_ticket_created
  ON ticket_voice_sessions(ticket_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ticket_voice_sessions_wa_center
  ON ticket_voice_sessions(wa_center_session_id);

CREATE TABLE IF NOT EXISTS ticket_voice_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  voice_session_id UUID REFERENCES ticket_voice_sessions(id) ON DELETE SET NULL,
  ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,
  wa_center_session_id TEXT,
  external_reference TEXT,
  event TEXT NOT NULL,
  participant_role TEXT,
  duration_seconds INTEGER,
  failure_reason TEXT,
  payload JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_voice_events_session_created
  ON ticket_voice_events(wa_center_session_id, created_at DESC);
