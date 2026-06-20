const pool = require("../db");

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mobile_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT,
      phone TEXT,

      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      accuracy DOUBLE PRECISION,

      battery INTEGER,

      state TEXT NOT NULL,
      acknowledged BOOLEAN DEFAULT FALSE,
      acknowledged_at TIMESTAMP,
      cancelled BOOLEAN DEFAULT FALSE,
      cancelled_at TIMESTAMP,

      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log("Tabla mobile_events creada.");

  process.exit(0);
}

init().catch(err => {
  console.error(err);
  process.exit(1);
});
