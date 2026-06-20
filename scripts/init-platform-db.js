const pool = require("../db");

async function init() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS control_centers (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      municipality TEXT,
      region TEXT,
      country TEXT DEFAULT 'CL',
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      control_center_id UUID REFERENCES control_centers(id),
      role TEXT NOT NULL,
      validation_status TEXT DEFAULT 'PROVISIONAL_ACTIVE',
      full_name TEXT NOT NULL,
      rut TEXT,
      phone TEXT,
      email TEXT,
      declared_address TEXT,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS emergency_contacts (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      relationship TEXT,
      phone TEXT NOT NULL,
      priority INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      control_center_id UUID REFERENCES control_centers(id),
      name TEXT,
      type TEXT,
      platform_id TEXT,
      last_latitude DOUBLE PRECISION,
      last_longitude DOUBLE PRECISION,
      last_seen TIMESTAMP,
      status TEXT DEFAULT 'OFFLINE',
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sirens (
      id TEXT PRIMARY KEY,
      control_center_id UUID REFERENCES control_centers(id),
      name TEXT NOT NULL,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      location TEXT,
      state TEXT DEFAULT 'OFF',
      relay BOOLEAN DEFAULT FALSE,
      last_seen TIMESTAMP,
      rssi INTEGER,
      firmware TEXT,
      uptime INTEGER,
      remote_ip TEXT,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      control_center_id UUID REFERENCES control_centers(id),
      citizen_user_id UUID REFERENCES users(id),
      source_type TEXT NOT NULL,
      source_event_id TEXT,
      alert_type TEXT NOT NULL,
      title TEXT,
      description TEXT,
      state TEXT DEFAULT 'ACTIVE',
      priority INTEGER DEFAULT 3,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      accuracy DOUBLE PRECISION,
      assigned_operator_id UUID REFERENCES users(id),
      assigned_resolver_id UUID REFERENCES users(id),
      nearest_siren_id TEXT REFERENCES sirens(id),
      created_at TIMESTAMP DEFAULT NOW(),
      acknowledged_at TIMESTAMP,
      assigned_at TIMESTAMP,
      resolved_at TIMESTAMP,
      closed_at TIMESTAMP,
      cancelled_at TIMESTAMP,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_actions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      ticket_id UUID REFERENCES tickets(id) ON DELETE CASCADE,
      actor_user_id UUID REFERENCES users(id),
      actor_role TEXT,
      action_type TEXT NOT NULL,
      description TEXT,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_notes (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      ticket_id UUID REFERENCES tickets(id) ON DELETE CASCADE,
      author_user_id UUID REFERENCES users(id),
      note TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_attachments (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      ticket_id UUID REFERENCES tickets(id) ON DELETE CASCADE,
      uploaded_by UUID REFERENCES users(id),
      file_type TEXT NOT NULL,
      file_url TEXT NOT NULL,
      file_name TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_users_control_center
    ON users(control_center_id);

    CREATE INDEX IF NOT EXISTS idx_tickets_control_center
    ON tickets(control_center_id);

    CREATE INDEX IF NOT EXISTS idx_tickets_state
    ON tickets(state);

    CREATE INDEX IF NOT EXISTS idx_tickets_created_at
    ON tickets(created_at);

    CREATE INDEX IF NOT EXISTS idx_sirens_control_center
    ON sirens(control_center_id);

    CREATE INDEX IF NOT EXISTS idx_devices_control_center
    ON devices(control_center_id);
  `);

  await pool.query(`
    INSERT INTO control_centers (
      code, name, municipality, region, latitude, longitude
    )
    VALUES (
      'CC-VINA',
      'Centro de Control Viña del Mar',
      'Viña del Mar',
      'Valparaíso',
      -33.01895,
      -71.55090
    )
    ON CONFLICT (code) DO NOTHING;
  `);

  await pool.query(`
    INSERT INTO sirens (
      id, control_center_id, name, latitude, longitude, location
    )
    SELECT
      'LAB-001',
      id,
      'Sirena Libertad / 5 Norte',
      -33.01895,
      -71.55090,
      'Libertad con 5 Norte, Viña del Mar'
    FROM control_centers
    WHERE code = 'CC-VINA'
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      latitude = EXCLUDED.latitude,
      longitude = EXCLUDED.longitude,
      location = EXCLUDED.location,
      updated_at = NOW();
  `);

  console.log("Base plataforma SOS inicializada correctamente.");
  process.exit(0);
}

init().catch(err => {
  console.error(err);
  process.exit(1);
});
