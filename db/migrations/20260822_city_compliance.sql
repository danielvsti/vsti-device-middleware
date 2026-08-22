-- Esquema base para inventario geoespacial, factores criminógenos e interoperabilidad auditada.
-- Las tablas también se crean idempotentemente al iniciar el módulo city-compliance.
CREATE TABLE IF NOT EXISTS city_security_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('CAMERA','IOT','LPR')),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  owner_organization TEXT,
  sharing_status TEXT NOT NULL DEFAULT 'INTERNAL',
  retention_days INTEGER,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(control_center_id, code)
);

CREATE INDEX IF NOT EXISTS idx_city_assets_cc_type
  ON city_security_assets(control_center_id, asset_type, status);

CREATE TABLE IF NOT EXISTS city_criminogenic_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
  factor_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  severity INTEGER NOT NULL DEFAULT 3 CHECK (severity BETWEEN 1 AND 5),
  status TEXT NOT NULL DEFAULT 'OPEN',
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  sector_code TEXT,
  source_type TEXT NOT NULL DEFAULT 'OPERATOR_OBSERVATION',
  ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_city_factors_cc_date
  ON city_criminogenic_observations(control_center_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS city_external_api_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
  agency_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  active BOOLEAN NOT NULL DEFAULT true,
  expires_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS city_external_api_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES city_external_api_clients(id) ON DELETE SET NULL,
  control_center_id UUID REFERENCES control_centers(id) ON DELETE SET NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  result_count INTEGER,
  request_ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_city_external_audit_cc_date
  ON city_external_api_audit(control_center_id, created_at DESC);
