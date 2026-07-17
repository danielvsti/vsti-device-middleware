#!/usr/bin/env node
/**
 * SOS Municipal - Demo Olmué
 * Crea 30 vecinos demo, 5 resolutores demo, limpia tickets abiertos de la central,
 * despierta/reubica resolutores y genera 10 tickets demo usando /public/mobile/sos.
 *
 * Uso recomendado desde ~/API-TEST:
 *   DATABASE_URL="..." SOS_API_BASE="https://api.queltu.com" node scripts/olmue_demo_setup.js --all
 *
 * Variables útiles:
 *   CENTER_CODE=CC-OLMUE
 *   CENTER_NAME="Central Comunal Olmué"
 *   SOS_API_BASE=https://api.queltu.com
 *   ADMIN_TOKEN=<opcional>
 *   AUTO_ASSIGN=false
 *   DRY_RUN=false
 *   CLEAN_SCOPE=open_cc   # open_cc | demo_only
 *   CREATE_MODE=api_then_db # api | db | api_then_db
 *   DEBUG_API=true    # imprime cuerpo del error API 403/500
 */
'use strict';

const crypto = require('crypto');

const ENV = {
  DATABASE_URL: process.env.DATABASE_URL || '',
  SOS_API_BASE: (process.env.SOS_API_BASE || process.env.API_BASE || 'https://api.queltu.com').replace(/\/$/, ''),
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || process.env.SOS_ADMIN_TOKEN || '',
  CENTER_CODE: process.env.CENTER_CODE || 'CC-OLMUE',
  CENTER_NAME: process.env.CENTER_NAME || 'Central Comunal Olmué',
  MUNICIPALITY_NAME: process.env.MUNICIPALITY_NAME || 'Ilustre Municipalidad de Olmué',
  AUTO_ASSIGN: /^true|1|yes$/i.test(process.env.AUTO_ASSIGN || 'false'),
  DRY_RUN: /^true|1|yes$/i.test(process.env.DRY_RUN || 'false'),
  CLEAN_SCOPE: (process.env.CLEAN_SCOPE || 'open_cc').toLowerCase(),
  CREATE_MODE: (process.env.CREATE_MODE || process.env.TICKET_CREATE_MODE || 'api_then_db').toLowerCase(),
  DEBUG_API: /^true|1|yes$/i.test(process.env.DEBUG_API || process.env.VERBOSE_API || 'false'),
  DEMO_PASSWORD: process.env.DEMO_PASSWORD || 'Demo1234!',
};

const argv = new Set(process.argv.slice(2));
if (argv.has('--dry-run')) ENV.DRY_RUN = true;
if (argv.has('--auto-assign')) ENV.AUTO_ASSIGN = true;

const wants = {
  seedUsers: argv.has('--all') || argv.has('--seed-users'),
  cleanTickets: argv.has('--all') || argv.has('--clean-tickets'),
  wakeResolvers: argv.has('--all') || argv.has('--wake-resolvers'),
  createTickets: argv.has('--all') || argv.has('--create-tickets'),
};
if (!Object.values(wants).some(Boolean) || argv.has('--help') || argv.has('-h')) {
  printHelp();
  process.exit(argv.has('--help') || argv.has('-h') ? 0 : 1);
}

const ZONES = [
  { zone_id: 'OLMUE-UV-01', zone_name: 'Unidad Vecinal 1', uv_num: 1, lat: -32.988191, lon: -71.209090 },
  { zone_id: 'OLMUE-UV-02', zone_name: 'Unidad Vecinal 2', uv_num: 2, lat: -32.982382, lon: -71.192841 },
  { zone_id: 'OLMUE-UV-03', zone_name: 'Unidad Vecinal 3', uv_num: 3, lat: -33.001738, lon: -71.191157 },
  { zone_id: 'OLMUE-UV-04', zone_name: 'Unidad Vecinal 4', uv_num: 4, lat: -32.982512, lon: -71.182467 },
  { zone_id: 'OLMUE-UV-05', zone_name: 'Unidad Vecinal 5', uv_num: 5, lat: -32.997510, lon: -71.172306 },
  { zone_id: 'OLMUE-UV-06', zone_name: 'Unidad Vecinal 6', uv_num: 6, lat: -32.981330, lon: -71.170891 },
  { zone_id: 'OLMUE-UV-07', zone_name: 'Unidad Vecinal 7', uv_num: 7, lat: -32.984112, lon: -71.155040 },
  { zone_id: 'OLMUE-UV-08', zone_name: 'Unidad Vecinal 8', uv_num: 8, lat: -32.990101, lon: -71.115745 },
  { zone_id: 'OLMUE-UV-09', zone_name: 'Unidad Vecinal 9', uv_num: 9, lat: -33.047513, lon: -71.171078 },
  { zone_id: 'OLMUE-UV-10', zone_name: 'Unidad Vecinal 10', uv_num: 10, lat: -33.009749, lon: -71.170316 },
  { zone_id: 'OLMUE-UV-11', zone_name: 'Unidad Vecinal 11', uv_num: 11, lat: -33.064445, lon: -71.118633 },
  { zone_id: 'OLMUE-UV-12', zone_name: 'Unidad Vecinal 12', uv_num: 12, lat: -33.013524, lon: -71.057606 },
  { zone_id: 'OLMUE-UV-13', zone_name: 'Unidad Vecinal 13', uv_num: 13, lat: -33.045079, lon: -71.043904 },
  { zone_id: 'OLMUE-UV-14', zone_name: 'Unidad Vecinal 14', uv_num: 14, lat: -33.073736, lon: -71.047987 },
];

const NEIGHBOR_NAMES = [
  'Vecino Demo Olmué 01', 'Vecina Demo Olmué 02', 'Vecino Demo Olmué 03', 'Vecina Demo Olmué 04',
  'Vecino Demo Olmué 05', 'Vecina Demo Olmué 06', 'Vecino Demo Olmué 07', 'Vecina Demo Olmué 08',
  'Vecino Demo Olmué 09', 'Vecina Demo Olmué 10', 'Vecino Demo Olmué 11', 'Vecina Demo Olmué 12',
  'Vecino Demo Olmué 13', 'Vecina Demo Olmué 14', 'Vecino Demo Olmué 15', 'Vecina Demo Olmué 16',
  'Vecino Demo Olmué 17', 'Vecina Demo Olmué 18', 'Vecino Demo Olmué 19', 'Vecina Demo Olmué 20',
  'Vecino Demo Olmué 21', 'Vecina Demo Olmué 22', 'Vecino Demo Olmué 23', 'Vecina Demo Olmué 24',
  'Vecino Demo Olmué 25', 'Vecina Demo Olmué 26', 'Vecino Demo Olmué 27', 'Vecina Demo Olmué 28',
  'Vecino Demo Olmué 29', 'Vecina Demo Olmué 30',
];

const RESOLVER_NAMES = [
  'Patrulla Municipal Olmué 1',
  'Patrulla Municipal Olmué 2',
  'Seguridad Ciudadana Olmué',
  'Emergencia Rural Olmué',
  'Coordinador Terreno Olmué',
];

const TICKET_BLUEPRINTS = [
  { category: 'SEGURIDAD', label: 'Actividad sospechosa', zone: 5, priority: 'HIGH', detail: 'Vecino reporta personas rondando vehículo estacionado.' },
  { category: 'SALUD', label: 'Adulto mayor requiere asistencia', zone: 8, priority: 'HIGH', detail: 'Adulto mayor solicita apoyo municipal preventivo.' },
  { category: 'INCENDIO', label: 'Humo en sector rural', zone: 11, priority: 'CRITICAL', detail: 'Se observa columna de humo cercana a zona de vegetación.' },
  { category: 'VIF', label: 'Alerta por violencia intrafamiliar', zone: 3, priority: 'CRITICAL', detail: 'Solicitud silenciosa de apoyo, priorizar contacto reservado.' },
  { category: 'SEGURIDAD', label: 'Ruidos molestos / alteración', zone: 2, priority: 'MEDIUM', detail: 'Vecinos reportan alteración del orden público.' },
  { category: 'MUNICIPAL', label: 'Apoyo municipal en vía pública', zone: 7, priority: 'MEDIUM', detail: 'Obstáculo en camino requiere revisión de equipo municipal.' },
  { category: 'SALUD', label: 'Emergencia médica menor', zone: 10, priority: 'HIGH', detail: 'Persona con malestar requiere orientación y derivación.' },
  { category: 'SEGURIDAD', label: 'Botón SOS activado', zone: 1, priority: 'HIGH', detail: 'Activación manual desde App Vecino en sector residencial.' },
  { category: 'INCENDIO', label: 'Quema no autorizada', zone: 12, priority: 'HIGH', detail: 'Posible quema en zona rural, requiere verificación.' },
  { category: 'SEGURIDAD', label: 'Solicitud de patrullaje preventivo', zone: 14, priority: 'LOW', detail: 'Solicitud de presencia preventiva en sector periférico.' },
];

function uuidFromKey(key) {
  const hex = crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

function jitter(base, i, factor = 0.0022) {
  const a = ((i * 37) % 11) - 5;
  const b = ((i * 53) % 13) - 6;
  return { lat: +(base.lat + a * factor / 10).toFixed(6), lon: +(base.lon + b * factor / 10).toFixed(6) };
}

function buildNeighbors() {
  return NEIGHBOR_NAMES.map((name, idx) => {
    const n = idx + 1;
    const zone = ZONES[idx % ZONES.length];
    const p = jitter(zone, n, 0.0024);
    return {
      id: uuidFromKey(`sos-demo-olmue-vecino-${String(n).padStart(3, '0')}`),
      external_id: `DEMO-OLMUE-VECINO-${String(n).padStart(3, '0')}`,
      name,
      email: `vecino.olmue.${String(n).padStart(3, '0')}@demo.sos.local`,
      phone: `+5695803${String(n).padStart(4, '0')}`,
      role: 'NEIGHBOR',
      address: `Dirección demo ${zone.zone_name}, Olmué`,
      zone_id: zone.zone_id,
      zone_name: zone.zone_name,
      uv_num: zone.uv_num,
      lat: p.lat,
      lon: p.lon,
    };
  });
}

function buildResolvers() {
  const resolverZones = [5, 8, 10, 11, 12];
  return RESOLVER_NAMES.map((name, idx) => {
    const n = idx + 1;
    const zone = ZONES.find(z => z.uv_num === resolverZones[idx]) || ZONES[idx];
    const p = jitter(zone, n + 100, 0.0030);
    return {
      id: uuidFromKey(`sos-demo-olmue-resolutor-${String(n).padStart(2, '0')}`),
      external_id: `DEMO-OLMUE-RESOLUTOR-${String(n).padStart(2, '0')}`,
      name,
      email: `resolutor.olmue.${String(n).padStart(2, '0')}@demo.sos.local`,
      phone: `+5695804${String(n).padStart(4, '0')}`,
      role: 'RESOLVER',
      address: `Base móvil demo ${zone.zone_name}, Olmué`,
      zone_id: zone.zone_id,
      zone_name: zone.zone_name,
      uv_num: zone.uv_num,
      lat: p.lat,
      lon: p.lon,
      status: 'AVAILABLE',
    };
  });
}

function buildTickets(neighbors) {
  return TICKET_BLUEPRINTS.map((bp, idx) => {
    const zone = ZONES.find(z => z.uv_num === bp.zone) || ZONES[idx % ZONES.length];
    const p = jitter(zone, idx + 201, 0.0030);
    const neighbor = neighbors[(idx * 3) % neighbors.length];
    return {
      external_id: `DEMO-OLMUE-TICKET-${String(idx + 1).padStart(2, '0')}`,
      title: `Demo - ${bp.label}`,
      category: bp.category,
      emergency_type: bp.category,
      label: bp.label,
      priority: bp.priority,
      description: `${bp.detail} [DEMO_OLMUE]`,
      message: `${bp.label}. ${bp.detail} [DEMO_OLMUE]`,
      address: `Punto demo ${zone.zone_name}, Olmué`,
      zone_id: zone.zone_id,
      zone_name: zone.zone_name,
      uv_num: zone.uv_num,
      lat: p.lat,
      lon: p.lon,
      user_id: neighbor.id,
      citizen_name: neighbor.name,
      citizen_phone: neighbor.phone,
    };
  });
}

let pgClient = null;
async function getDb() {
  if (!ENV.DATABASE_URL) throw new Error('Falta DATABASE_URL. Ejemplo: DATABASE_URL="postgres://..." node scripts/olmue_demo_setup.js --all');
  if (!pgClient) {
    let Client;
    try {
      Client = require('pg').Client;
    } catch (err) {
      throw new Error('No encontré el módulo "pg". Ejecuta este script dentro de ~/API-TEST o instala dependencias con npm install.');
    }
    pgClient = new Client({ connectionString: ENV.DATABASE_URL, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false } });
    await pgClient.connect();
  }
  return pgClient;
}

async function tableExists(db, table) {
  const r = await db.query(`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1) AS ok`, [table]);
  return !!r.rows[0].ok;
}

async function getColumns(db, table) {
  if (!(await tableExists(db, table))) return new Set();
  const r = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [table]);
  return new Set(r.rows.map(x => x.column_name));
}

function pickCol(cols, candidates) {
  return candidates.find(c => cols.has(c));
}

function addIf(cols, row, col, value) {
  if (cols.has(col) && value !== undefined) row[col] = value;
}

async function findOrCreateControlCenter(db) {
  const table = 'control_centers';
  const cols = await getColumns(db, table);
  if (!cols.size) {
    console.log('⚠️  No existe tabla control_centers; seguiré usando control_center_code solamente.');
    return null;
  }
  const codeCol = pickCol(cols, ['code', 'control_center_code', 'slug']);
  const idCol = pickCol(cols, ['id', 'control_center_id']);
  if (!codeCol) return null;
  const found = await db.query(`SELECT ${idCol ? idCol : '*'} FROM ${table} WHERE ${codeCol}=$1 LIMIT 1`, [ENV.CENTER_CODE]);
  if (found.rows.length && idCol) return found.rows[0][idCol];

  const id = uuidFromKey(`sos-demo-control-center-${ENV.CENTER_CODE}`);
  const row = {};
  addIf(cols, row, 'id', id);
  addIf(cols, row, 'control_center_id', id);
  addIf(cols, row, 'code', ENV.CENTER_CODE);
  addIf(cols, row, 'control_center_code', ENV.CENTER_CODE);
  addIf(cols, row, 'slug', 'cc-olmue');
  addIf(cols, row, 'name', ENV.CENTER_NAME);
  addIf(cols, row, 'display_name', ENV.CENTER_NAME);
  addIf(cols, row, 'municipality_name', ENV.MUNICIPALITY_NAME);
  addIf(cols, row, 'municipality', ENV.MUNICIPALITY_NAME);
  addIf(cols, row, 'comuna', 'Olmué');
  addIf(cols, row, 'region', 'Valparaíso');
  addIf(cols, row, 'province', 'Marga Marga');
  addIf(cols, row, 'lat', -33.035485);
  addIf(cols, row, 'lon', -71.110313);
  addIf(cols, row, 'latitude', -33.035485);
  addIf(cols, row, 'longitude', -71.110313);
  addIf(cols, row, 'is_active', true);
  addIf(cols, row, 'active', true);
  addIf(cols, row, 'created_at', new Date());
  addIf(cols, row, 'updated_at', new Date());
  await insertFlexible(db, table, cols, row, idCol || codeCol);
  return idCol ? id : null;
}

async function passwordHash() {
  try {
    const bcrypt = require('bcryptjs');
    return await bcrypt.hash(ENV.DEMO_PASSWORD, 10);
  } catch (_) {
    try {
      const bcrypt = require('bcrypt');
      return await bcrypt.hash(ENV.DEMO_PASSWORD, 10);
    } catch (_) {
      return ENV.DEMO_PASSWORD;
    }
  }
}

async function insertFlexible(db, table, cols, row, conflictCol = 'id') {
  const keys = Object.keys(row).filter(k => cols.has(k));
  if (!keys.length) return;
  const values = keys.map(k => row[k]);
  const params = keys.map((_, i) => `$${i + 1}`);
  const updateKeys = keys.filter(k => k !== conflictCol && !['created_at'].includes(k));
  const updateSql = updateKeys.length
    ? `DO UPDATE SET ${updateKeys.map(k => `${k}=EXCLUDED.${k}`).join(', ')}`
    : 'DO NOTHING';
  const conflictSql = cols.has(conflictCol) ? `ON CONFLICT (${conflictCol}) ${updateSql}` : 'ON CONFLICT DO NOTHING';
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${params.join(', ')}) ${conflictSql}`;
  if (ENV.DRY_RUN) {
    console.log(`[DRY_RUN] ${sql}`);
    return;
  }
  await db.query(sql, values);
}

async function seedUsers(neighbors, resolvers) {
  console.log(`\n👥 Creando/actualizando 30 vecinos y 5 resolutores para ${ENV.CENTER_CODE}...`);
  const db = await getDb();
  const userCols = await getColumns(db, 'users');
  if (!userCols.size) throw new Error('No encontré tabla users en la base de datos.');
  const centerId = await findOrCreateControlCenter(db);
  const hash = await passwordHash();

  let inserted = 0;
  for (const u of [...neighbors, ...resolvers]) {
    const row = {};
    addIf(userCols, row, 'id', u.id);
    addIf(userCols, row, 'external_id', u.external_id);
    addIf(userCols, row, 'demo_id', u.external_id);
    addIf(userCols, row, 'name', u.name);
    addIf(userCols, row, 'full_name', u.name);
    addIf(userCols, row, 'display_name', u.name);
    addIf(userCols, row, 'email', u.email);
    addIf(userCols, row, 'phone', u.phone);
    addIf(userCols, row, 'phone_number', u.phone);
    addIf(userCols, row, 'role', u.role);
    addIf(userCols, row, 'user_role', u.role);
    addIf(userCols, row, 'type', u.role);
    addIf(userCols, row, 'control_center_code', ENV.CENTER_CODE);
    addIf(userCols, row, 'cc_code', ENV.CENTER_CODE);
    addIf(userCols, row, 'control_center_id', centerId);
    addIf(userCols, row, 'municipality_name', ENV.MUNICIPALITY_NAME);
    addIf(userCols, row, 'municipality', ENV.MUNICIPALITY_NAME);
    addIf(userCols, row, 'comuna', 'Olmué');
    addIf(userCols, row, 'commune', 'Olmué');
    addIf(userCols, row, 'address', u.address);
    addIf(userCols, row, 'sector', u.zone_name);
    addIf(userCols, row, 'zone_id', u.zone_id);
    addIf(userCols, row, 'zone_name', u.zone_name);
    addIf(userCols, row, 'uv_num', u.uv_num);
    addIf(userCols, row, 'lat', u.lat);
    addIf(userCols, row, 'lon', u.lon);
    addIf(userCols, row, 'latitude', u.lat);
    addIf(userCols, row, 'longitude', u.lon);
    addIf(userCols, row, 'password_hash', hash);
    addIf(userCols, row, 'password', ENV.DEMO_PASSWORD);
    addIf(userCols, row, 'is_active', true);
    addIf(userCols, row, 'active', true);
    addIf(userCols, row, 'enabled', true);
    addIf(userCols, row, 'status', u.role === 'RESOLVER' ? 'AVAILABLE' : 'ACTIVE');
    addIf(userCols, row, 'created_at', new Date());
    addIf(userCols, row, 'updated_at', new Date());
    await insertFlexible(db, 'users', userCols, row, 'id');
    inserted += 1;
  }
  console.log(`✅ Usuarios demo listos: ${inserted} registros upsert.`);
}

async function cleanTickets() {
  console.log(`\n🧹 Limpiando tickets abiertos de ${ENV.CENTER_CODE}...`);
  const db = await getDb();
  const ticketCols = await getColumns(db, 'tickets');
  if (!ticketCols.size) {
    console.log('⚠️  No existe tabla tickets; saltando limpieza SQL.');
    return;
  }

  const where = [];
  const params = [];
  const addParam = (v) => { params.push(v); return `$${params.length}`; };

  const ccCol = pickCol(ticketCols, ['control_center_code', 'cc_code']);
  if (ccCol) where.push(`${ccCol}=${addParam(ENV.CENTER_CODE)}`);

  if (ticketCols.has('state')) where.push(`COALESCE(state,'') NOT IN ('CLOSED','CANCELLED')`);
  else if (ticketCols.has('status')) where.push(`COALESCE(status,'') NOT IN ('CLOSED','CANCELLED')`);

  if (ENV.CLEAN_SCOPE === 'demo_only') {
    const demoClauses = [];
    if (ticketCols.has('title')) demoClauses.push(`title ILIKE 'Demo - %'`);
    if (ticketCols.has('description')) demoClauses.push(`description ILIKE '%DEMO_OLMUE%'`);
    if (ticketCols.has('external_id')) demoClauses.push(`external_id ILIKE 'DEMO-OLMUE-%'`);
    if (ticketCols.has('external_reference')) demoClauses.push(`external_reference ILIKE 'DEMO-OLMUE-%'`);
    if (demoClauses.length) where.push(`(${demoClauses.join(' OR ')})`);
  }

  const sets = [];
  if (ticketCols.has('state')) sets.push(`state='CLOSED'`);
  if (ticketCols.has('status')) sets.push(`status='CLOSED'`);
  if (ticketCols.has('closed_at')) sets.push(`closed_at=NOW()`);
  if (ticketCols.has('resolved_at')) sets.push(`resolved_at=COALESCE(resolved_at,NOW())`);
  if (ticketCols.has('updated_at')) sets.push(`updated_at=NOW()`);
  if (ticketCols.has('closed_reason')) sets.push(`closed_reason='Demo Olmué reset'`);

  if (!sets.length || !where.length) {
    console.log('⚠️  No pude construir UPDATE seguro para tickets; revisa columnas.');
    return;
  }
  const sql = `UPDATE tickets SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`;
  if (ENV.DRY_RUN) console.log(`[DRY_RUN] ${sql}`, params);
  else {
    const r = await db.query(sql, params);
    console.log(`✅ Tickets cerrados/limpiados: ${r.rowCount}`);
  }

  await cleanMobileEvents(db);
}

async function cleanMobileEvents(db) {
  const cols = await getColumns(db, 'mobile_events');
  if (!cols.size) return;
  const where = [];
  const params = [];
  const addParam = (v) => { params.push(v); return `$${params.length}`; };
  const ccCol = pickCol(cols, ['control_center_code', 'cc_code']);
  if (ccCol) where.push(`${ccCol}=${addParam(ENV.CENTER_CODE)}`);
  if (cols.has('status')) where.push(`COALESCE(status,'') NOT IN ('CLOSED','CANCELLED')`);
  if (ENV.CLEAN_SCOPE === 'demo_only') {
    const demoClauses = [];
    if (cols.has('description')) demoClauses.push(`description ILIKE '%DEMO_OLMUE%'`);
    if (cols.has('message')) demoClauses.push(`message ILIKE '%DEMO_OLMUE%'`);
    if (demoClauses.length) where.push(`(${demoClauses.join(' OR ')})`);
  }
  const sets = [];
  if (cols.has('status')) sets.push(`status='CLOSED'`);
  if (cols.has('state')) sets.push(`state='CLOSED'`);
  if (cols.has('updated_at')) sets.push(`updated_at=NOW()`);
  if (!sets.length || !where.length) return;
  const sql = `UPDATE mobile_events SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`;
  if (ENV.DRY_RUN) console.log(`[DRY_RUN] ${sql}`, params);
  else {
    const r = await db.query(sql, params);
    console.log(`✅ Mobile events sincronizados/cerrados: ${r.rowCount}`);
  }
}

async function wakeResolvers(resolvers) {
  console.log(`\n📡 Despertando/reubicando 5 resolutores de ${ENV.CENTER_CODE}...`);
  if (ENV.DATABASE_URL) {
    try { await wakeResolversDb(resolvers); } catch (err) { console.log(`⚠️  Wake DB omitido: ${err.message}`); }
  }
  await wakeResolversApi(resolvers);
}

async function wakeResolversDb(resolvers) {
  const db = await getDb();
  const cols = await getColumns(db, 'resolver_locations');
  if (!cols.size) return;
  const idCol = pickCol(cols, ['user_id', 'resolver_id']);
  if (!idCol) return;
  const deleteSql = `DELETE FROM resolver_locations WHERE ${idCol}=ANY($1::uuid[])`;
  if (ENV.DRY_RUN) console.log(`[DRY_RUN] ${deleteSql}`, resolvers.map(r => r.id));
  else await db.query(deleteSql, [resolvers.map(r => r.id)]);

  for (const r of resolvers) {
    const row = {};
    addIf(cols, row, 'id', uuidFromKey(`resolver-location-${r.id}`));
    addIf(cols, row, 'user_id', r.id);
    addIf(cols, row, 'resolver_id', r.id);
    addIf(cols, row, 'control_center_code', ENV.CENTER_CODE);
    addIf(cols, row, 'cc_code', ENV.CENTER_CODE);
    addIf(cols, row, 'lat', r.lat);
    addIf(cols, row, 'lon', r.lon);
    addIf(cols, row, 'latitude', r.lat);
    addIf(cols, row, 'longitude', r.lon);
    addIf(cols, row, 'status', 'AVAILABLE');
    addIf(cols, row, 'is_available', true);
    addIf(cols, row, 'available', true);
    addIf(cols, row, 'updated_at', new Date());
    addIf(cols, row, 'created_at', new Date());
    await insertFlexible(db, 'resolver_locations', cols, row, pickCol(cols, ['id', 'user_id', 'resolver_id']) || 'id');
  }
  console.log('✅ Resolver_locations DB actualizado.');
}

async function wakeResolversApi(resolvers) {
  for (const r of resolvers) {
    const payload = {
      user_id: r.id,
      resolver_id: r.id,
      control_center_code: ENV.CENTER_CODE,
      lat: r.lat,
      lon: r.lon,
      latitude: r.lat,
      longitude: r.lon,
      status: 'AVAILABLE',
      available: true,
      source: 'DEMO_OLMUE_WAKE',
    };
    try {
      await postJson('/resolver/location', payload, { allowFail: true });
    } catch (_) {}
  }
  console.log('✅ Señal wake enviada a /resolver/location.');
}

async function createTickets(tickets) {
  const mode = ['api', 'db', 'api_then_db'].includes(ENV.CREATE_MODE) ? ENV.CREATE_MODE : 'api_then_db';

  if (mode === 'db') {
    await createTicketsDb(tickets, { reason: 'CREATE_MODE=db' });
    return;
  }

  console.log(`\n🚨 Creando 10 tickets demo vía /public/mobile/sos para ${ENV.CENTER_CODE}...`);
  let ok = 0;
  const createdIds = [];
  const failed = [];
  let firstErrorPrinted = false;

  for (const t of tickets) {
    const payload = buildMobileSosPayload(t);
    const result = await postJson('/public/mobile/sos', payload, { allowFail: true });
    if (result.ok) {
      ok += 1;
      const id = result.body?.ticket_id || result.body?.id || result.body?.ticket?.id || result.body?.data?.id;
      if (id) createdIds.push(id);
      console.log(`  ✅ ${t.external_id}: ${t.title}${id ? ` (${id})` : ''}`);
    } else {
      failed.push(t);
      console.log(`  ⚠️  ${t.external_id}: no creado por API (${result.status || 'sin status'}).`);
      if (ENV.DEBUG_API || !firstErrorPrinted) {
        console.log(`     ↳ respuesta API: ${safeJson(result.body)}`);
        firstErrorPrinted = true;
      }
    }
  }
  console.log(`✅ Tickets creados por API: ${ok}/10.`);

  if (failed.length && mode === 'api_then_db') {
    console.log(`\n🛟 Fallback activo: crearé por DB los ${failed.length} tickets que rechazó la API.`);
    await createTicketsDb(failed, { reason: 'fallback API -> DB' });
  }

  if (ENV.AUTO_ASSIGN && createdIds.length) {
    for (const id of createdIds) await postJson(`/tickets/${id}/auto-assign`, { control_center_code: ENV.CENTER_CODE }, { allowFail: true });
    console.log(`✅ Auto-assign solicitado para ${createdIds.length} tickets.`);
  } else {
    console.log('ℹ️  AUTO_ASSIGN=false: los tickets quedan en cola para asignación manual en la demo.');
  }
}

function buildMobileSosPayload(t) {
  return {
    user_id: t.user_id,
    control_center_code: ENV.CENTER_CODE,
    category: t.category,
    emergency_type: t.emergency_type,
    type: t.category,
    title: t.title,
    message: t.message,
    description: t.description,
    priority: t.priority,
    address: t.address,
    sector: t.zone_name,
    zone_id: t.uv_num,
    zone_code: t.zone_id,
    zone_name: t.zone_name,
    uv_num: t.uv_num,
    lat: t.lat,
    lon: t.lon,
    latitude: t.lat,
    longitude: t.lon,
    external_reference: t.external_id,
    metadata: buildTicketMetadata(t),
  };
}

function buildTicketMetadata(t) {
  return {
    demo: true,
    demo_tag: 'DEMO_OLMUE',
    center_code: ENV.CENTER_CODE,
    zone_id: t.uv_num,
    zone_code: t.zone_id,
    zone_name: t.zone_name,
    uv_num: t.uv_num,
    citizen_name: t.citizen_name,
    citizen_phone: t.citizen_phone,
  };
}

function safeJson(value) {
  try {
    const txt = JSON.stringify(value);
    return txt && txt.length > 600 ? `${txt.slice(0, 600)}...` : txt;
  } catch (_) {
    return String(value);
  }
}

async function createTicketsDb(tickets, opts = {}) {
  console.log(`\n🧱 Creando ${tickets.length} tickets demo directamente por DB (${opts.reason || 'direct db'})...`);
  const db = await getDb();
  const cols = await getColumns(db, 'tickets');
  if (!cols.size) throw new Error('No encontré tabla tickets para fallback DB.');

  const centerId = await findOrCreateControlCenter(db).catch(() => null);
  let ok = 0;
  for (const t of tickets) {
    const ticketId = uuidFromKey(`sos-demo-ticket-${ENV.CENTER_CODE}-${t.external_id}`);
    const row = buildTicketDbRow(cols, t, ticketId, centerId);
    try {
      await insertFlexible(db, 'tickets', cols, row, cols.has('id') ? 'id' : pickCol(cols, ['ticket_id', 'external_reference', 'external_id']) || 'id');
      await createMobileEventDb(db, t, ticketId);
      ok += 1;
      console.log(`  ✅ ${t.external_id}: creado/actualizado por DB (${ticketId})`);
    } catch (err) {
      console.log(`  ❌ ${t.external_id}: DB no pudo crear ticket: ${err.message}`);
      if (ENV.DEBUG_API) console.log(`     ↳ columnas enviadas: ${Object.keys(row).join(', ')}`);
    }
  }
  console.log(`✅ Tickets creados/actualizados por DB: ${ok}/${tickets.length}.`);
}

function buildTicketDbRow(cols, t, ticketId, centerId) {
  const row = {};
  const meta = buildTicketMetadata(t);
  const location = { lat: t.lat, lon: t.lon, latitude: t.lat, longitude: t.lon, address: t.address, sector: t.zone_name };

  addIf(cols, row, 'id', ticketId);
  addIf(cols, row, 'ticket_id', ticketId);
  addIf(cols, row, 'external_id', t.external_id);
  addIf(cols, row, 'external_reference', t.external_id);
  addIf(cols, row, 'reference', t.external_id);

  addIf(cols, row, 'control_center_code', ENV.CENTER_CODE);
  addIf(cols, row, 'cc_code', ENV.CENTER_CODE);
  addIf(cols, row, 'center_code', ENV.CENTER_CODE);
  addIf(cols, row, 'control_center_id', centerId);

  addIf(cols, row, 'user_id', t.user_id);
  addIf(cols, row, 'citizen_id', t.user_id);
  addIf(cols, row, 'requester_id', t.user_id);
  addIf(cols, row, 'created_by_user_id', t.user_id);

  addIf(cols, row, 'title', t.title);
  addIf(cols, row, 'description', t.description);
  addIf(cols, row, 'message', t.message);
  addIf(cols, row, 'category', t.category);
  addIf(cols, row, 'emergency_type', t.emergency_type);
  addIf(cols, row, 'type', t.category);
  addIf(cols, row, 'sos_type', t.category);
  addIf(cols, row, 'priority', t.priority);
  addIf(cols, row, 'severity', t.priority);

  // Dejamos el ticket vivo, no asignado, para mostrar cola y asignación manual.
  addIf(cols, row, 'status', 'OPEN');
  addIf(cols, row, 'state', 'ACTIVE');
  addIf(cols, row, 'ticket_status', 'OPEN');
  addIf(cols, row, 'assignment_status', 'UNASSIGNED');
  addIf(cols, row, 'assigned_status', 'UNASSIGNED');
  addIf(cols, row, 'is_demo', true);
  addIf(cols, row, 'active', true);
  addIf(cols, row, 'is_active', true);

  addIf(cols, row, 'address', t.address);
  addIf(cols, row, 'sector', t.zone_name);
  addIf(cols, row, 'zone_id', t.zone_id);
  addIf(cols, row, 'zone_name', t.zone_name);
  addIf(cols, row, 'uv_num', t.uv_num);
  addIf(cols, row, 'lat', t.lat);
  addIf(cols, row, 'lon', t.lon);
  addIf(cols, row, 'latitude', t.lat);
  addIf(cols, row, 'longitude', t.lon);

  addIf(cols, row, 'citizen_name', t.citizen_name);
  addIf(cols, row, 'citizen_phone', t.citizen_phone);
  addIf(cols, row, 'source', 'DEMO_OLMUE');
  addIf(cols, row, 'channel', 'MOBILE_APP');
  addIf(cols, row, 'metadata', meta);
  addIf(cols, row, 'meta', meta);
  addIf(cols, row, 'payload', buildMobileSosPayload(t));
  addIf(cols, row, 'location', location);

  addIf(cols, row, 'created_at', new Date());
  addIf(cols, row, 'updated_at', new Date());
  addIf(cols, row, 'opened_at', new Date());
  addIf(cols, row, 'reported_at', new Date());
  addIf(cols, row, 'requested_at', new Date());
  return row;
}

async function createMobileEventDb(db, t, ticketId) {
  const cols = await getColumns(db, 'mobile_events');
  if (!cols.size) return;
  const eventId = uuidFromKey(`sos-demo-mobile-event-${ENV.CENTER_CODE}-${t.external_id}`);
  const row = {};
  addIf(cols, row, 'id', eventId);
  addIf(cols, row, 'event_id', eventId);
  addIf(cols, row, 'ticket_id', ticketId);
  addIf(cols, row, 'user_id', t.user_id);
  addIf(cols, row, 'control_center_code', ENV.CENTER_CODE);
  addIf(cols, row, 'cc_code', ENV.CENTER_CODE);
  addIf(cols, row, 'external_id', t.external_id);
  addIf(cols, row, 'external_reference', t.external_id);
  addIf(cols, row, 'type', t.category);
  addIf(cols, row, 'category', t.category);
  addIf(cols, row, 'emergency_type', t.emergency_type);
  addIf(cols, row, 'title', t.title);
  addIf(cols, row, 'description', t.description);
  addIf(cols, row, 'message', t.message);
  addIf(cols, row, 'status', 'OPEN');
  addIf(cols, row, 'state', 'ACTIVE');
  addIf(cols, row, 'priority', t.priority);
  addIf(cols, row, 'address', t.address);
  addIf(cols, row, 'sector', t.zone_name);
  addIf(cols, row, 'zone_id', t.zone_id);
  addIf(cols, row, 'zone_name', t.zone_name);
  addIf(cols, row, 'lat', t.lat);
  addIf(cols, row, 'lon', t.lon);
  addIf(cols, row, 'latitude', t.lat);
  addIf(cols, row, 'longitude', t.lon);
  addIf(cols, row, 'metadata', buildTicketMetadata(t));
  addIf(cols, row, 'payload', buildMobileSosPayload(t));
  addIf(cols, row, 'created_at', new Date());
  addIf(cols, row, 'updated_at', new Date());
  await insertFlexible(db, 'mobile_events', cols, row, cols.has('id') ? 'id' : pickCol(cols, ['event_id', 'external_reference', 'external_id']) || 'id');
}

async function postJson(path, payload, opts = {}) {
  const url = `${ENV.SOS_API_BASE}${path}`;
  if (ENV.DRY_RUN) {
    console.log(`[DRY_RUN] POST ${url}`, JSON.stringify(payload));
    return { ok: true, status: 0, body: { dry_run: true } };
  }
  const headers = { 'Content-Type': 'application/json' };
  if (ENV.ADMIN_TOKEN) headers.Authorization = `Bearer ${ENV.ADMIN_TOKEN}`;
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = { raw: text }; }
    if (!res.ok && !opts.allowFail) throw new Error(`${res.status}: ${text}`);
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    if (!opts.allowFail) throw err;
    return { ok: false, status: 0, body: { error: err.message } };
  }
}

async function main() {
  const neighbors = buildNeighbors();
  const resolvers = buildResolvers();
  const tickets = buildTickets(neighbors);

  console.log('SOS Municipal - Demo Olmué');
  console.log(`Centro: ${ENV.CENTER_CODE} / ${ENV.CENTER_NAME}`);
  console.log(`API: ${ENV.SOS_API_BASE}`);
  console.log(`DRY_RUN=${ENV.DRY_RUN} AUTO_ASSIGN=${ENV.AUTO_ASSIGN} CLEAN_SCOPE=${ENV.CLEAN_SCOPE} CREATE_MODE=${ENV.CREATE_MODE}`);

  if (wants.seedUsers) await seedUsers(neighbors, resolvers);
  if (wants.cleanTickets) await cleanTickets();
  if (wants.wakeResolvers) await wakeResolvers(resolvers);
  if (wants.createTickets) await createTickets(tickets);

  if (pgClient) await pgClient.end();
  console.log('\n🎯 Demo Olmué lista. Abre Dashboard/SOS-MAP filtrado por CC-OLMUE.');
}

function printHelp() {
  console.log(`\nSOS Municipal - Demo Olmué\n\nUso:\n  node scripts/olmue_demo_setup.js --all\n  node scripts/olmue_demo_setup.js --seed-users\n  node scripts/olmue_demo_setup.js --clean-tickets --wake-resolvers --create-tickets\n\nVariables:\n  DATABASE_URL       Requerida para crear usuarios y limpiar tickets por SQL.\n  SOS_API_BASE       Base API. Default: https://api.queltu.com\n  CENTER_CODE        Default: CC-OLMUE\n  AUTO_ASSIGN        true/false. Default: false\n  CLEAN_SCOPE        open_cc | demo_only. Default: open_cc\n  DRY_RUN            true/false. También puedes usar --dry-run\n\nEjemplo seguro:\n  DATABASE_URL=\"$DATABASE_URL\" DRY_RUN=true node scripts/olmue_demo_setup.js --all\n\nEjemplo ejecución real:\n  DATABASE_URL=\"$DATABASE_URL\" SOS_API_BASE=\"https://api.queltu.com\" node scripts/olmue_demo_setup.js --all\n`);
}

main().catch(async err => {
  console.error('\n❌ Error demo Olmué:', err.message);
  if (pgClient) await pgClient.end().catch(() => {});
  process.exit(1);
});
