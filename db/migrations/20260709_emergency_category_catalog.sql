CREATE TABLE IF NOT EXISTS emergency_category_catalog (
  category_type TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '🆘',
  color TEXT DEFAULT '#2563eb',
  priority INTEGER NOT NULL DEFAULT 3,
  enabled BOOLEAN NOT NULL DEFAULT true,
  display_order INTEGER NOT NULL DEFAULT 100,
  sensitive BOOLEAN NOT NULL DEFAULT false,
  allow_voice BOOLEAN NOT NULL DEFAULT true,
  allow_evidence BOOLEAN NOT NULL DEFAULT true,
  allow_nearby_notifications BOOLEAN NOT NULL DEFAULT false,
  allow_sirens BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO emergency_category_catalog (
  category_type,
  title,
  icon,
  color,
  priority,
  enabled,
  display_order,
  sensitive,
  allow_voice,
  allow_evidence,
  allow_nearby_notifications,
  allow_sirens
) VALUES
  ('SOS_MANUAL', 'SOS General', '🚨', '#ef4444', 1, true, 10, false, true, true, false, false),
  ('MEDICAL', 'Médica', '🚑', '#22c55e', 1, true, 20, false, true, true, false, false),
  ('FIRE', 'Incendio', '🔥', '#f97316', 1, true, 30, false, true, true, true, true),
  ('SECURITY', 'Seguridad', '👮', '#8b5cf6', 2, true, 40, false, true, true, false, false),
  ('VIF', 'VIF', '🏠', '#a855f7', 1, true, 50, true, true, true, false, false),
  ('TRAFFIC_ACCIDENT', 'Accidente', '🚗', '#3b82f6', 2, true, 60, false, true, true, true, false),
  ('URBAN_RISK', 'Riesgo', '⚠️', '#eab308', 3, true, 70, false, true, true, true, false),
  ('OTHER', 'Otro', '📝', '#64748b', 3, true, 80, false, true, true, false, false)
ON CONFLICT (category_type) DO NOTHING;
