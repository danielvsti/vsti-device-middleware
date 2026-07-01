-- v0.19 Configurador Plataforma por Centro de Control

CREATE TABLE IF NOT EXISTS control_center_settings (
  control_center_id UUID PRIMARY KEY REFERENCES control_centers(id) ON DELETE CASCADE,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS control_center_settings_audit (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  control_center_id UUID REFERENCES control_centers(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  old_settings JSONB,
  new_settings JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE sirens
  ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS activation_mode TEXT DEFAULT 'MANUAL_ONLY',
  ADD COLUMN IF NOT EXISTS default_duration_seconds INTEGER DEFAULT 60,
  ADD COLUMN IF NOT EXISTS max_duration_seconds INTEGER DEFAULT 180,
  ADD COLUMN IF NOT EXISTS cooldown_seconds INTEGER DEFAULT 120;

CREATE INDEX IF NOT EXISTS idx_sirens_control_center_enabled
  ON sirens(control_center_id, enabled);

INSERT INTO control_center_settings (control_center_id, settings)
SELECT
  id,
  jsonb_build_object(
    'features', jsonb_build_object(
      'mobile_app_enabled', true,
      'resolver_app_enabled', true,
      'physical_sos_buttons_enabled', true,
      'sirens_enabled', true,
      'secure_voice_enabled', true,
      'multi_report_incidents_enabled', true,
      'resolver_auto_assignment_enabled', true
    ),
    'siren_policy', jsonb_build_object(
      'activation_mode', 'MANUAL_ONLY',
      'auto_activate_on_ticket', false,
      'auto_categories', jsonb_build_array('FIRE','SECURITY'),
      'default_duration_seconds', 60,
      'max_duration_seconds', 180,
      'cooldown_seconds', 120,
      'operator_manual_control_enabled', true
    ),
    'voice_policy', jsonb_build_object(
      'recording_enabled', false,
      'supervision_enabled', true,
      'max_call_minutes', 30,
      'expires_minutes', 15
    ),
    'notification_policy', jsonb_build_object(
      'nearby_neighbor_notifications_enabled', false,
      'radius_meters', 300,
      'categories', jsonb_build_array('FIRE','TRAFFIC_ACCIDENT','URBAN_RISK'),
      'channels', jsonb_build_array('PUSH'),
      'privacy_mode', 'SAFE_AREA_ONLY'
    ),
    'incident_policy', jsonb_build_object(
      'dedup_enabled', true,
      'dedup_radius_meters', 120,
      'dedup_window_minutes', 120
    ),
    'resolver_policy', jsonb_build_object(
      'auto_assignment_enabled', true,
      'max_location_age_seconds', 180,
      'max_active_tickets', 1
    )
  )
FROM control_centers cc
WHERE NOT EXISTS (
  SELECT 1
  FROM control_center_settings s
  WHERE s.control_center_id = cc.id
);
