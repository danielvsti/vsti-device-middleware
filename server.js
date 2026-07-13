/*
   =========================================================
   VSTI DEVICE MIDDLEWARE
   =========================================================

Arquitectura:

RF-V51
↓
Plataforma de comunicaciones
↓
VSTI Middleware
↓
SayVU

Funciones:

- Recepción de eventos dispositivos
- Normalización de datos
- Inventario de dispositivos
- Gestión de sirenas
- Integración con SayVU

=========================================================
 */

const pool = require("./db");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

console.log(
  "DATABASE_URL configurada:",
  !!process.env.DATABASE_URL
);

const express = require("express");
const mqtt = require("mqtt");
const cors = require("cors");
const app = express();

app.set("trust proxy", true);
const SECURITY_DEMO_MODE = process.env.SOS_SECURITY_DEMO_MODE === "true" || process.env.OTP_DEMO_MODE === "true";
const CORS_ALLOWED_ORIGINS = String(process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);
const SOS_PUBLIC_ORIGINS = [process.env.SOS_PUBLIC_BASE_URL, "https://sos.vsti.cl"]
  .filter(Boolean)
  .map((value) => {
    try { return new URL(value).origin; } catch (_) { return ""; }
  })
  .filter(Boolean);

function corsOriginAllowed(origin) {
  if (!origin) return true;
  if (SECURITY_DEMO_MODE && CORS_ALLOWED_ORIGINS.length === 0) return true;
  const normalizedOrigin = String(origin).replace(/\/+$/, "");
  return CORS_ALLOWED_ORIGINS.includes(normalizedOrigin) || SOS_PUBLIC_ORIGINS.includes(normalizedOrigin);
}

app.use(cors((req, callback) => {
  const isPublicLocationSubmission = req.method === "POST"
    && /^\/public\/location-request\/[^/]+\/position$/.test(req.path);
  callback(null, {
    origin(origin, originCallback) {
      if (isPublicLocationSubmission && origin === "null") return originCallback(null, true);
      if (corsOriginAllowed(origin)) return originCallback(null, true);
      const error = new Error("Origen no autorizado por CORS");
      error.status = 403;
      return originCallback(error);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "X-Admin-Token", "X-SOS-Token", "X-Request-Id"],
    maxAge: 86400
  });
}));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});
app.use(express.json({ limit: "30mb" }));

const securityRateBuckets = new Map();
function rateLimit({ windowMs, max, key = (req) => req.ip, message }) {
  return (req, res, next) => {
    const now = Date.now();
    const bucketKey = `${req.path}:${key(req) || "unknown"}`;
    const current = securityRateBuckets.get(bucketKey);
    if (!current || current.resetAt <= now) {
      securityRateBuckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
      return next();
    }
    current.count += 1;
    if (current.count <= max) return next();
    res.setHeader("Retry-After", String(Math.ceil((current.resetAt - now) / 1000)));
    return res.status(429).json({
      status: "error",
      message: message || "Demasiadas solicitudes. Intenta nuevamente más tarde."
    });
  };
}

const authRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX || 20),
  key: (req) => `${req.ip}:${String(req.body?.phone || "").replace(/\s+/g, "")}`,
  message: "Demasiados intentos de autenticación. Espera unos minutos."
});
const qrVisitRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.QR_VISIT_RATE_LIMIT_MAX || 60),
  key: (req) => getRemoteIp(req),
  message: "Demasiados accesos QR desde este dispositivo. Intenta nuevamente en un minuto."
});
const locationRequestRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.LOCATION_REQUEST_RATE_LIMIT_MAX || 20),
  key: (req) => getRemoteIp(req),
  message: "Demasiados intentos de ubicación. Espera un minuto e intenta nuevamente."
});

function requireDebugAccess(req, res) {
  if (process.env.SOS_DEBUG_ENDPOINTS_ENABLED !== "true") {
    res.status(404).json({ status: "error", message: "Not found" });
    return false;
  }
  const expected = process.env.ADMIN_TOKEN || "";
  const provided = req.headers["x-admin-token"] || req.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
  if (!expected || provided !== expected) {
    res.status(401).json({ status: "error", message: "Debug access denied" });
    return false;
  }
  return true;
}

const UPLOAD_DIR = process.env.SOS_UPLOAD_DIR || "/tmp/sos_uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOAD_DIR));


app.get("/debug/db", async (req, res) => {
  if (!requireDebugAccess(req, res)) return;
  try {
    const result = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.get("/debug/tickets", async (req, res) => {
  if (!requireDebugAccess(req, res)) return;
  try {
    const result = await pool.query(`
      SELECT
        t.id,
        cc.code AS control_center,
        t.source_type,
        t.alert_type,
        t.state,
        t.priority,
        t.created_at
      FROM tickets t
      JOIN control_centers cc
        ON cc.id = t.control_center_id
      ORDER BY t.created_at DESC
      LIMIT 20
    `);

    res.json(result.rows);

  } catch (error) {
    console.error("[DEBUG TICKETS ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.VSTI_TOKEN
  || (SECURITY_DEMO_MODE ? "VSTI_MIDDLEWARE_DEMO_ONLY" : crypto.randomBytes(32).toString("hex"));
if (!process.env.VSTI_TOKEN && !SECURITY_DEMO_MODE) {
  console.warn("[SECURITY] VSTI_TOKEN no configurado: integraciones de dispositivos usarán una clave efímera.");
}

const SAYVU_API_URL = process.env.SAYVU_API_URL || "";
const SAYVU_TOKEN = process.env.SAYVU_TOKEN || "";
const FLESPI_TOKEN = process.env.FLESPI_TOKEN || "";
const FLESPI_MQTT_URL = "mqtts://mqtt.flespi.io:8883";

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

const WA_CENTER_BASE_URL = String(process.env.WA_CENTER_BASE_URL || "https://wa-center.vsti.cl").replace(/\/+$/, "");
const WA_CENTER_API_TOKEN = process.env.WA_CENTER_API_TOKEN || "";
const WA_CENTER_VOICE_ENABLED = envFlag("WA_CENTER_VOICE_ENABLED", false);
const WA_CENTER_VOICE_RECORDING = envFlag("WA_CENTER_VOICE_RECORDING", true);
const WA_CENTER_VOICE_SUPERVISION = envFlag("WA_CENTER_VOICE_SUPERVISION", true);
const WA_CENTER_WEBHOOK_SECRET = process.env.WA_CENTER_WEBHOOK_SECRET || "";
const WA_CENTER_CALLBACK_URL_OVERRIDE = envFlag("WA_CENTER_CALLBACK_URL_OVERRIDE", false);
const SOS_PUBLIC_BASE_URL = String(process.env.SOS_PUBLIC_BASE_URL || "").replace(/\/+$/, "");

const gpsDevices = {};
const mobileEvents = {};

const devices = {};
const sirenStates = {};


const SOS_ACTIVE_MS = 5 * 60 * 1000;
const SOS_RECENT_MS = 20 * 60 * 1000;

function nowChile() {
	return new Date().toLocaleString("sv-SE", { timeZone: "America/Santiago" });
}

function checkToken(req, res) {
	const token = req.headers["x-vsti-token"];
	if (token !== TOKEN) {
		res.status(401).json({ status: "error", message: "Unauthorized" });
		return false;
	}
	return true;
}

function getRemoteIp(req) {
	return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
		.split(",")[0]
		.trim();
}


/*
   =========================================================
   CONTROL CENTER PLATFORM SETTINGS
   =========================================================

   Configuración multi-municipal por centro de control. Evita dejar
   políticas de operación hardcodeadas por ambiente y permite que cada
   municipalidad habilite/deshabilite funcionalidades propias.
*/

let controlCenterSettingsSchemaReady = false;
let emergencyCategoryCatalogSchemaReady = false;
let municipalQrSchemaReady = false;
let communicationsSchemaReady = false;

const DEFAULT_NEIGHBOR_EMERGENCY_CATEGORIES = Object.freeze([
  { type: 'SOS_MANUAL', title: 'SOS General', icon: '🚨', color: '#dc2626', priority: 1, enabled: true, order: 10, sensitive: false, allow_voice: true, allow_evidence: true, allow_nearby_notifications: false, allow_sirens: false },
  { type: 'MEDICAL', title: 'Médica', icon: '🚑', color: '#16a34a', priority: 1, enabled: true, order: 20, sensitive: false, allow_voice: true, allow_evidence: true, allow_nearby_notifications: false, allow_sirens: false },
  { type: 'FIRE', title: 'Incendio', icon: '🔥', color: '#f97316', priority: 1, enabled: true, order: 30, sensitive: false, allow_voice: true, allow_evidence: true, allow_nearby_notifications: true, allow_sirens: true },
  { type: 'SECURITY', title: 'Seguridad', icon: '👮', color: '#7c3aed', priority: 2, enabled: true, order: 40, sensitive: false, allow_voice: true, allow_evidence: true, allow_nearby_notifications: false, allow_sirens: true },
  { type: 'VIF', title: 'VIF', icon: '🏠', color: '#8b5cf6', priority: 1, enabled: true, order: 50, sensitive: true, allow_voice: true, allow_evidence: true, allow_nearby_notifications: false, allow_sirens: false },
  { type: 'TRAFFIC_ACCIDENT', title: 'Accidente', icon: '🚗', color: '#2563eb', priority: 2, enabled: true, order: 60, sensitive: false, allow_voice: true, allow_evidence: true, allow_nearby_notifications: true, allow_sirens: false },
  { type: 'URBAN_RISK', title: 'Riesgo', icon: '⚠️', color: '#eab308', priority: 3, enabled: true, order: 70, sensitive: false, allow_voice: true, allow_evidence: true, allow_nearby_notifications: true, allow_sirens: false },
  { type: 'OTHER', title: 'Otro', icon: '📝', color: '#64748b', priority: 3, enabled: true, order: 80, sensitive: false, allow_voice: true, allow_evidence: true, allow_nearby_notifications: false, allow_sirens: false }
]);

let emergencyCategoryCatalogCache = DEFAULT_NEIGHBOR_EMERGENCY_CATEGORIES.map(category => ({ ...category }));
const AUTOMATIC_MOBILE_ALERT_TYPES = new Set(['VIF_SILENT_SHAKE', 'FALL_DETECTED']);

const DEFAULT_CONTROL_CENTER_SETTINGS = Object.freeze({
  features: {
    mobile_app_enabled: true,
    resolver_app_enabled: true,
    physical_sos_buttons_enabled: true,
    sirens_enabled: true,
    secure_voice_enabled: true,
    multi_report_incidents_enabled: true,
    resolver_auto_assignment_enabled: true
  },
  siren_policy: {
    activation_mode: 'MANUAL_ONLY',
    auto_activate_on_ticket: false,
    auto_categories: ['FIRE', 'SECURITY'],
    default_duration_seconds: 60,
    max_duration_seconds: 180,
    cooldown_seconds: 120,
    operator_manual_control_enabled: true
  },
  voice_policy: {
    recording_enabled: WA_CENTER_VOICE_RECORDING,
    supervision_enabled: WA_CENTER_VOICE_SUPERVISION,
    max_call_minutes: 30,
    expires_minutes: Math.max(1, Math.round(Number(process.env.WA_CENTER_VOICE_EXPIRES_SECONDS || 900) / 60))
  },
  notification_policy: {
    nearby_neighbor_notifications_enabled: false,
    radius_meters: 300,
    categories: ['FIRE', 'TRAFFIC_ACCIDENT', 'URBAN_RISK'],
    channels: ['PUSH'],
    privacy_mode: 'SAFE_AREA_ONLY'
  },
  communications_module: {
    enabled: false,
    municipal_broadcasts: true,
    personal_notifications: false,
    surveys: false,
    video: true,
    push_delivery: false,
    max_active_announcements: 20,
    storage_limit_mb: 2048
  },
  incident_policy: {
    dedup_enabled: true,
    dedup_radius_meters: 120,
    dedup_window_minutes: 120
  },
  resolver_policy: {
    auto_assignment_enabled: true,
    max_location_age_seconds: 180,
    max_active_tickets: 1
  },
  operator_tools: {
    dashboard_roles: ['OPERATOR', 'ADMIN', 'SUPER_ADMIN'],
    emergency_contacts: [
      { key: 'AMBULANCE', label: 'Ambulancia / SAMU', phone: '131', icon: '🚑', enabled: true, order: 10 },
      { key: 'FIRE_DEPARTMENT', label: 'Bomberos', phone: '132', icon: '🚒', enabled: true, order: 20 },
      { key: 'POLICE', label: 'Carabineros', phone: '133', icon: '🚓', enabled: true, order: 30 },
      { key: 'MUNICIPAL_SECURITY', label: 'Seguridad Municipal', phone: '', icon: '🛡️', enabled: false, order: 40 }
    ]
  },
  neighbor_app: {
    emergency_categories: DEFAULT_NEIGHBOR_EMERGENCY_CATEGORIES
  }
});

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function deepMergeSettings(base, override) {
  const output = Array.isArray(base) ? [...base] : { ...(base || {}) };
  if (!isPlainObject(override)) return output;

  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(output[key])) {
      output[key] = deepMergeSettings(output[key], value);
    } else if (Array.isArray(value)) {
      output[key] = value.map(item => item);
    } else if (value !== undefined) {
      output[key] = value;
    }
  }

  return output;
}

function normalizePolicyBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (['true','yes','si','sí','on'].includes(lower)) return true;
    if (['false','no','off'].includes(lower)) return false;
  }
  return fallback;
}

function clampPolicyNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function currentEmergencyCategoryCatalog() {
  return Array.isArray(emergencyCategoryCatalogCache) && emergencyCategoryCatalogCache.length
    ? emergencyCategoryCatalogCache
    : DEFAULT_NEIGHBOR_EMERGENCY_CATEGORIES;
}

function normalizeEmergencyCategoryCatalogItem(raw = {}, fallback = {}) {
  const type = String(raw.type || raw.category_type || fallback.type || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 48);
  const title = String(raw.title || raw.label || fallback.title || type || 'Categoría').trim().slice(0, 48);
  const icon = String(raw.icon || fallback.icon || '🆘').trim().slice(0, 12);
  const color = String(raw.color || fallback.color || '#2563eb').trim().slice(0, 24);

  return {
    type,
    title: title || type,
    icon: icon || '🆘',
    color,
    priority: clampPolicyNumber(raw.priority, fallback.priority || 3, 1, 5),
    enabled: normalizePolicyBoolean(raw.enabled, fallback.enabled !== false),
    order: clampPolicyNumber(raw.order ?? raw.display_order, fallback.order || 100, 1, 9999),
    sensitive: normalizePolicyBoolean(raw.sensitive, fallback.sensitive === true),
    allow_voice: normalizePolicyBoolean(raw.allow_voice, fallback.allow_voice !== false),
    allow_evidence: normalizePolicyBoolean(raw.allow_evidence, fallback.allow_evidence !== false),
    allow_nearby_notifications: normalizePolicyBoolean(raw.allow_nearby_notifications, fallback.allow_nearby_notifications === true),
    allow_sirens: normalizePolicyBoolean(raw.allow_sirens, fallback.allow_sirens === true)
  };
}

function normalizeEmergencyCategoryCatalog(input = []) {
  const byType = new Map(DEFAULT_NEIGHBOR_EMERGENCY_CATEGORIES.map(category => [category.type, { ...category }]));
  const source = Array.isArray(input) ? input : [];

  for (const raw of source) {
    if (!isPlainObject(raw)) continue;
    const fallbackType = String(raw.type || raw.category_type || '').trim().toUpperCase();
    const fallback = byType.get(fallbackType) || {};
    const item = normalizeEmergencyCategoryCatalogItem(raw, fallback);
    if (!item.type) continue;
    byType.set(item.type, item);
  }

  return Array.from(byType.values()).sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.title.localeCompare(b.title, 'es');
  });
}

function normalizeNeighborEmergencyCategories(input = [], catalog = currentEmergencyCategoryCatalog()) {
  const availableCatalog = normalizeEmergencyCategoryCatalog(catalog).filter(category => category.enabled !== false);
  const byType = new Map(availableCatalog.map(category => [category.type, {
    type: category.type,
    title: category.title,
    icon: category.icon,
    color: category.color,
    priority: category.priority,
    enabled: category.enabled !== false,
    order: category.order,
    title_override: null
  }]));
  const source = Array.isArray(input) ? input : [];

  for (const [index, raw] of source.entries()) {
    if (!isPlainObject(raw)) continue;
    const type = String(raw.type || raw.alert_type || raw.code || '').trim().toUpperCase();
    if (!byType.has(type)) continue;

    const fallback = byType.get(type);
    const titleOverride = String(raw.title_override || raw.alias || '').trim().slice(0, 48) || null;
    const title = String(raw.title || raw.label || titleOverride || fallback.title || type).trim().slice(0, 48);
    const icon = String(raw.icon || fallback.icon || '🆘').trim().slice(0, 8);

    byType.set(type, {
      type,
      title: title || fallback.title,
      title_override: titleOverride,
      icon: icon || fallback.icon,
      color: String(raw.color || fallback.color || '#2563eb').trim().slice(0, 24),
      priority: clampPolicyNumber(raw.priority, fallback.priority, 1, 5),
      enabled: normalizePolicyBoolean(raw.enabled, fallback.enabled !== false),
      order: clampPolicyNumber(raw.order, fallback.order || ((index + 1) * 10), 1, 999)
    });
  }

  const categories = Array.from(byType.values()).sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.title.localeCompare(b.title, 'es');
  });

  if (!categories.some(category => category.enabled)) {
    const sos = categories.find(category => category.type === 'SOS_MANUAL');
    if (sos) sos.enabled = true;
  }

  return categories;
}

function isNeighborEmergencyCategoryEnabled(settings, alertType) {
  const type = String(alertType || 'SOS_MANUAL').trim().toUpperCase();
  if (AUTOMATIC_MOBILE_ALERT_TYPES.has(type)) return true;
  const normalized = normalizeControlCenterSettings(settings || {});
  const categories = normalized.neighbor_app?.emergency_categories || DEFAULT_NEIGHBOR_EMERGENCY_CATEGORIES;
  return categories.some(category => category.type === type && category.enabled !== false);
}

async function ensureEmergencyCategoryCatalogSchema() {
  if (emergencyCategoryCatalogSchemaReady) return;

  await pool.query(`
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
    )
  `);

  for (const category of DEFAULT_NEIGHBOR_EMERGENCY_CATEGORIES) {
    await pool.query(
      `
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
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (category_type) DO NOTHING
      `,
      [
        category.type,
        category.title,
        category.icon,
        category.color,
        category.priority,
        category.enabled !== false,
        category.order,
        category.sensitive === true,
        category.allow_voice !== false,
        category.allow_evidence !== false,
        category.allow_nearby_notifications === true,
        category.allow_sirens === true
      ]
    );
  }

  await refreshEmergencyCategoryCatalogCache();
  emergencyCategoryCatalogSchemaReady = true;
}

async function refreshEmergencyCategoryCatalogCache() {
  const result = await pool.query(`
    SELECT
      category_type AS type,
      title,
      icon,
      color,
      priority,
      enabled,
      display_order AS "order",
      sensitive,
      allow_voice,
      allow_evidence,
      allow_nearby_notifications,
      allow_sirens,
      metadata
    FROM emergency_category_catalog
    ORDER BY display_order ASC, title ASC
  `);

  emergencyCategoryCatalogCache = normalizeEmergencyCategoryCatalog(result.rows);
  return emergencyCategoryCatalogCache;
}

async function loadEmergencyCategoryCatalog({ includeDisabled = true } = {}) {
  await ensureEmergencyCategoryCatalogSchema();
  const catalog = emergencyCategoryCatalogCache || DEFAULT_NEIGHBOR_EMERGENCY_CATEGORIES;
  return includeDisabled ? catalog : catalog.filter(category => category.enabled !== false);
}

function normalizeControlCenterSettings(input = {}) {
  const merged = deepMergeSettings(DEFAULT_CONTROL_CENTER_SETTINGS, input || {});

  merged.features = merged.features || {};
  for (const key of Object.keys(DEFAULT_CONTROL_CENTER_SETTINGS.features)) {
    merged.features[key] = normalizePolicyBoolean(
      merged.features[key],
      DEFAULT_CONTROL_CENTER_SETTINGS.features[key]
    );
  }

  merged.siren_policy = merged.siren_policy || {};
  const validSirenModes = ['MANUAL_ONLY', 'AUTO_BY_CATEGORY', 'AUTO_ALL'];
  merged.siren_policy.activation_mode = validSirenModes.includes(String(merged.siren_policy.activation_mode || '').toUpperCase())
    ? String(merged.siren_policy.activation_mode).toUpperCase()
    : DEFAULT_CONTROL_CENTER_SETTINGS.siren_policy.activation_mode;
  merged.siren_policy.auto_activate_on_ticket = normalizePolicyBoolean(merged.siren_policy.auto_activate_on_ticket, false);
  merged.siren_policy.operator_manual_control_enabled = normalizePolicyBoolean(merged.siren_policy.operator_manual_control_enabled, true);
  merged.siren_policy.default_duration_seconds = clampPolicyNumber(merged.siren_policy.default_duration_seconds, 60, 5, 600);
  merged.siren_policy.max_duration_seconds = clampPolicyNumber(merged.siren_policy.max_duration_seconds, 180, 10, 900);
  merged.siren_policy.cooldown_seconds = clampPolicyNumber(merged.siren_policy.cooldown_seconds, 120, 0, 3600);
  if (!Array.isArray(merged.siren_policy.auto_categories)) merged.siren_policy.auto_categories = [];

  merged.voice_policy = merged.voice_policy || {};
  merged.voice_policy.recording_enabled = normalizePolicyBoolean(merged.voice_policy.recording_enabled, WA_CENTER_VOICE_RECORDING);
  merged.voice_policy.supervision_enabled = normalizePolicyBoolean(merged.voice_policy.supervision_enabled, WA_CENTER_VOICE_SUPERVISION);
  merged.voice_policy.max_call_minutes = clampPolicyNumber(merged.voice_policy.max_call_minutes, 30, 1, 240);
  merged.voice_policy.expires_minutes = clampPolicyNumber(merged.voice_policy.expires_minutes, 15, 1, 240);

  merged.notification_policy = merged.notification_policy || {};
  merged.notification_policy.nearby_neighbor_notifications_enabled = normalizePolicyBoolean(merged.notification_policy.nearby_neighbor_notifications_enabled, false);
  merged.notification_policy.radius_meters = clampPolicyNumber(merged.notification_policy.radius_meters, 300, 50, 5000);
  if (!Array.isArray(merged.notification_policy.categories)) merged.notification_policy.categories = [];
  if (!Array.isArray(merged.notification_policy.channels)) merged.notification_policy.channels = ['PUSH'];

  merged.communications_module = merged.communications_module || {};
  merged.communications_module.enabled = normalizePolicyBoolean(merged.communications_module.enabled, false);
  merged.communications_module.municipal_broadcasts = normalizePolicyBoolean(merged.communications_module.municipal_broadcasts, true);
  merged.communications_module.personal_notifications = normalizePolicyBoolean(merged.communications_module.personal_notifications, false);
  merged.communications_module.surveys = normalizePolicyBoolean(merged.communications_module.surveys, false);
  merged.communications_module.video = normalizePolicyBoolean(merged.communications_module.video, true);
  merged.communications_module.push_delivery = normalizePolicyBoolean(merged.communications_module.push_delivery, false);
  merged.communications_module.max_active_announcements = clampPolicyNumber(merged.communications_module.max_active_announcements, 20, 1, 500);
  merged.communications_module.storage_limit_mb = clampPolicyNumber(merged.communications_module.storage_limit_mb, 2048, 0, 102400);

  merged.incident_policy = merged.incident_policy || {};
  merged.incident_policy.dedup_enabled = normalizePolicyBoolean(merged.incident_policy.dedup_enabled, true);
  merged.incident_policy.dedup_radius_meters = clampPolicyNumber(
    merged.incident_policy.dedup_radius_meters,
    Number(process.env.INCIDENT_DEDUP_RADIUS_METERS || 120),
    10,
    2000
  );
  merged.incident_policy.dedup_window_minutes = clampPolicyNumber(
    merged.incident_policy.dedup_window_minutes,
    Number(process.env.INCIDENT_DEDUP_WINDOW_MINUTES || 30),
    1,
    1440
  );

  merged.resolver_policy = merged.resolver_policy || {};
  merged.resolver_policy.auto_assignment_enabled = normalizePolicyBoolean(merged.resolver_policy.auto_assignment_enabled, true);
  merged.resolver_policy.max_location_age_seconds = clampPolicyNumber(merged.resolver_policy.max_location_age_seconds, 180, 30, 86400);
  merged.resolver_policy.max_active_tickets = clampPolicyNumber(merged.resolver_policy.max_active_tickets, 1, 1, 20);

  merged.operator_tools = merged.operator_tools || {};
  const defaultDashboardRoles = DEFAULT_CONTROL_CENTER_SETTINGS.operator_tools.dashboard_roles;
  merged.operator_tools.dashboard_roles = Array.isArray(merged.operator_tools.dashboard_roles)
    ? merged.operator_tools.dashboard_roles.map(role => String(role || '').trim().toUpperCase()).filter(Boolean)
    : [...defaultDashboardRoles];
  const contactSource = Array.isArray(merged.operator_tools.emergency_contacts)
    ? merged.operator_tools.emergency_contacts
    : DEFAULT_CONTROL_CENTER_SETTINGS.operator_tools.emergency_contacts;
  merged.operator_tools.emergency_contacts = contactSource.map((contact, index) => ({
    key: String(contact?.key || `CONTACT_${index + 1}`).trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 48),
    label: String(contact?.label || contact?.name || `Contacto ${index + 1}`).trim().slice(0, 80),
    phone: String(contact?.phone || '').trim().slice(0, 32),
    icon: String(contact?.icon || '☎️').trim().slice(0, 12),
    enabled: normalizePolicyBoolean(contact?.enabled, true),
    order: clampPolicyNumber(contact?.order, (index + 1) * 10, 1, 999)
  })).sort((a, b) => a.order - b.order);

  merged.neighbor_app = merged.neighbor_app || {};
  merged.neighbor_app.emergency_categories = normalizeNeighborEmergencyCategories(merged.neighbor_app.emergency_categories);

  return merged;
}

async function ensureControlCenterSettingsSchema() {
  if (controlCenterSettingsSchemaReady) return;

  await ensureEmergencyCategoryCatalogSchema();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS control_center_settings (
      control_center_id UUID PRIMARY KEY REFERENCES control_centers(id) ON DELETE CASCADE,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS control_center_settings_audit (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      control_center_id UUID REFERENCES control_centers(id) ON DELETE CASCADE,
      actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      old_settings JSONB,
      new_settings JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE sirens
      ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS activation_mode TEXT DEFAULT 'MANUAL_ONLY',
      ADD COLUMN IF NOT EXISTS default_duration_seconds INTEGER DEFAULT 60,
      ADD COLUMN IF NOT EXISTS max_duration_seconds INTEGER DEFAULT 180,
      ADD COLUMN IF NOT EXISTS cooldown_seconds INTEGER DEFAULT 120
  `);

  await pool.query(`
    INSERT INTO control_center_settings (control_center_id, settings)
    SELECT id, $1::jsonb
    FROM control_centers cc
    WHERE NOT EXISTS (
      SELECT 1 FROM control_center_settings s WHERE s.control_center_id = cc.id
    )
  `, [JSON.stringify(DEFAULT_CONTROL_CENTER_SETTINGS)]);

  controlCenterSettingsSchemaReady = true;
}

async function getControlCenterSettingsById(controlCenterId) {
  await ensureControlCenterSettingsSchema();
  const result = await pool.query(
    `
    SELECT
      cc.id AS control_center_id,
      cc.code AS control_center_code,
      cc.name AS control_center_name,
      COALESCE(s.settings, '{}'::jsonb) AS settings,
      s.updated_at,
      s.updated_by
    FROM control_centers cc
    LEFT JOIN control_center_settings s ON s.control_center_id = cc.id
    WHERE cc.id = $1
    LIMIT 1
    `,
    [controlCenterId]
  );

  if (!result.rows.length) return null;
  const row = result.rows[0];
  return {
    ...row,
    settings: normalizeControlCenterSettings(row.settings || {})
  };
}

async function getControlCenterSettingsByCode(controlCenterCode = 'CC-VINA') {
  await ensureControlCenterSettingsSchema();
  const result = await pool.query(
    `
    SELECT
      cc.id AS control_center_id,
      cc.code AS control_center_code,
      cc.name AS control_center_name,
      COALESCE(s.settings, '{}'::jsonb) AS settings,
      s.updated_at,
      s.updated_by
    FROM control_centers cc
    LEFT JOIN control_center_settings s ON s.control_center_id = cc.id
    WHERE cc.code = $1
    LIMIT 1
    `,
    [controlCenterCode]
  );

  if (!result.rows.length) return null;
  const row = result.rows[0];
  return {
    ...row,
    settings: normalizeControlCenterSettings(row.settings || {})
  };
}

function publicSettingsPayload(settings) {
  const normalized = normalizeControlCenterSettings(settings || {});
  return {
    features: {
      mobile_app_enabled: normalized.features.mobile_app_enabled,
      resolver_app_enabled: normalized.features.resolver_app_enabled,
      physical_sos_buttons_enabled: normalized.features.physical_sos_buttons_enabled,
      sirens_enabled: normalized.features.sirens_enabled,
      secure_voice_enabled: normalized.features.secure_voice_enabled,
      multi_report_incidents_enabled: normalized.features.multi_report_incidents_enabled,
      resolver_auto_assignment_enabled: normalized.features.resolver_auto_assignment_enabled
    },
    siren_policy: normalized.siren_policy,
    voice_policy: {
      recording_enabled: normalized.voice_policy.recording_enabled,
      max_call_minutes: normalized.voice_policy.max_call_minutes,
      expires_minutes: normalized.voice_policy.expires_minutes
    },
    notification_policy: normalized.notification_policy,
    communications_module: normalized.communications_module,
    incident_policy: normalized.incident_policy,
    resolver_policy: normalized.resolver_policy,
    operator_tools: normalized.operator_tools,
    neighbor_app: {
      emergency_categories: normalized.neighbor_app.emergency_categories
    }
  };
}

function adminSettingsPayload(row) {
  return {
    status: 'ok',
    control_center: {
      id: row.control_center_id,
      code: row.control_center_code,
      name: row.control_center_name
    },
    settings: normalizeControlCenterSettings(row.settings || {}),
    updated_at: row.updated_at || null,
    updated_by: row.updated_by || null
  };
}

async function ensureMunicipalQrSchema() {
  if (municipalQrSchemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS municipal_qr_points (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_municipal_qr_points_cc ON municipal_qr_points(control_center_id, enabled, created_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS municipal_qr_visits (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      qr_point_id UUID NOT NULL REFERENCES municipal_qr_points(id) ON DELETE CASCADE,
      visit_token TEXT,
      ip_hash TEXT,
      user_agent TEXT,
      referrer TEXT,
      visited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_municipal_qr_visits_point_date ON municipal_qr_visits(qr_point_id, visited_at DESC)`);
  await pool.query(`
    ALTER TABLE mobile_events
      ADD COLUMN IF NOT EXISTS qr_point_id UUID REFERENCES municipal_qr_points(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS qr_visit_id UUID REFERENCES municipal_qr_visits(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS qr_context JSONB
  `);
  municipalQrSchemaReady = true;
}

function municipalQrPublicPayload(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description || null,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    enabled: row.enabled !== false,
    control_center_code: row.control_center_code || null,
    control_center_name: row.control_center_name || null,
    pwa_url: `${process.env.SOS_PWA_BASE_URL || 'https://sos-pwa.onrender.com'}/?qr=${encodeURIComponent(row.code)}&lat=${encodeURIComponent(Number(row.latitude).toFixed(6))}&lng=${encodeURIComponent(Number(row.longitude).toFixed(6))}&cc=${encodeURIComponent(row.control_center_code || '')}`,
    visit_count: Number(row.visit_count || 0),
    unique_visitors: Number(row.unique_visitors || 0),
    last_visit_at: row.last_visit_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

async function loadSirensForControlCenter(controlCenterId, settings) {
  await ensureControlCenterSettingsSchema();
  const normalized = normalizeControlCenterSettings(settings || {});
  if (!normalized.features.sirens_enabled) return [];

  const result = await pool.query(
    `
    SELECT
      id,
      name,
      latitude,
      longitude,
      location,
      COALESCE(enabled, true) AS enabled,
      COALESCE(activation_mode, 'MANUAL_ONLY') AS activation_mode,
      COALESCE(default_duration_seconds, 60) AS default_duration_seconds,
      COALESCE(max_duration_seconds, 180) AS max_duration_seconds,
      COALESCE(cooldown_seconds, 120) AS cooldown_seconds,
      state,
      relay,
      last_seen,
      rssi,
      firmware,
      uptime,
      remote_ip,
      metadata,
      updated_at
    FROM sirens
    WHERE control_center_id = $1
      AND COALESCE(enabled, true) = true
    ORDER BY name ASC
    `,
    [controlCenterId]
  );

  return result.rows || [];
}

async function findSirenByIdForPublicControlCenter(sirenId, controlCenterCode = 'CC-VINA') {
  const settingsRow = await getControlCenterSettingsByCode(controlCenterCode);
  if (!settingsRow) return { settingsRow: null, siren: null };
  const sirens = await loadSirensForControlCenter(settingsRow.control_center_id, settingsRow.settings);
  const siren = sirens.find(item => String(item.id) === String(sirenId));
  return { settingsRow, siren };
}


/*
   =========================================================
   PANEL ACCESS SESSIONS
   =========================================================

   Control de acceso para paneles operacionales:
   - SOS-MAP / Central: OPERATOR o ADMIN
   - SOS-ADMIN: ADMIN

   En esta etapa el login es por teléfono registrado y activo. En producción
   puede conectarse al mismo flujo OTP usado por vecinos.
   =========================================================
*/

const SESSION_SECRET = process.env.SOS_SESSION_SECRET
  || process.env.ADMIN_TOKEN
  || (SECURITY_DEMO_MODE ? (process.env.VSTI_TOKEN || TOKEN) : crypto.randomBytes(48).toString("hex"));
if (!process.env.SOS_SESSION_SECRET && !process.env.ADMIN_TOKEN && !SECURITY_DEMO_MODE) {
  console.warn("[SECURITY] SOS_SESSION_SECRET no configurado: se usará una clave efímera y las sesiones expirarán al reiniciar.");
}
const PANEL_SESSION_TTL_HOURS = Number(process.env.PANEL_SESSION_TTL_HOURS || 12);

function base64UrlEncode(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(value) {
  const normalized = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function signSessionPayload(encodedPayload) {
  return crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(encodedPayload)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function createPanelSessionToken(user, panelType = "CONTROL_CENTER") {
  const now = Date.now();
  const payload = {
    typ: "sos-panel-session",
    sub: user.id,
    name: user.full_name,
    phone: user.phone,
    role: user.role,
    control_center_id: user.control_center_id,
    control_center_code: user.control_center_code,
    panel_type: panelType,
    iat: now,
    exp: now + PANEL_SESSION_TTL_HOURS * 60 * 60 * 1000
  };

  const encodedPayload = base64UrlEncode(payload);
  const signature = signSessionPayload(encodedPayload);
  return `sos.${encodedPayload}.${signature}`;
}

function getBearerOrPanelToken(req) {
  const auth = req.headers["authorization"] || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }

  return req.headers["x-sos-token"] || "";
}

function verifyPanelSessionToken(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3 || parts[0] !== "sos") return null;

    const [, encodedPayload, signature] = parts;
    const expectedSignature = signSessionPayload(encodedPayload);

    const a = Buffer.from(signature);
    const b = Buffer.from(expectedSignature);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return null;
    }

    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (!payload || payload.typ !== "sos-panel-session") return null;
    if (payload.exp && Date.now() > Number(payload.exp)) return null;

    return payload;
  } catch (error) {
    return null;
  }
}

function panelSessionFromRequest(req) {
  return verifyPanelSessionToken(getBearerOrPanelToken(req));
}

function isSuperAdminSession(session) {
  return String(session?.role || "").toUpperCase() === "SUPER_ADMIN";
}

function roleHasAccess(role, allowedRoles = []) {
  const normalizedRole = String(role || "").toUpperCase();
  const allowed = allowedRoles.map((item) => String(item || "").toUpperCase());
  if (normalizedRole === "SUPER_ADMIN") {
    return allowed.includes("SUPER_ADMIN") || allowed.includes("ADMIN") || allowed.includes("OPERATOR");
  }
  return allowed.includes(normalizedRole);
}

function checkRoleAccess(req, res, allowedRoles, message = "Unauthorized panel request") {
  const session = panelSessionFromRequest(req);

  if (!session || !roleHasAccess(session.role, allowedRoles)) {
    res.status(401).json({
      status: "error",
      message
    });
    return false;
  }

  req.panel_session = session;
  return true;
}

function checkAuthenticatedAccess(req, res, allowedRoles, message = "Sesión requerida") {
  return checkRoleAccess(req, res, allowedRoles, message);
}

function checkIdentityAccess(req, res, allowedRoles, claimedUserId, message = "No autorizado para este usuario") {
  if (!checkRoleAccess(req, res, allowedRoles, message)) return false;
  if (isSuperAdminSession(req.panel_session) || ["ADMIN", "OPERATOR"].includes(String(req.panel_session.role || "").toUpperCase())) {
    return true;
  }
  if (!claimedUserId || String(req.panel_session.sub) !== String(claimedUserId)) {
    res.status(403).json({ status: "error", message });
    return false;
  }
  return true;
}

async function checkTicketParticipantAccess(req, res, ticketId) {
  const session = panelSessionFromRequest(req);
  if (!session) {
    res.status(401).json({ status: "error", message: "Sesión requerida" });
    return false;
  }
  req.panel_session = session;
  await ensureIncidentAggregationSchema();
  const role = String(session.role || "").toUpperCase();
  const result = await pool.query(
    `
    SELECT
      t.citizen_user_id,
      t.assigned_resolver_id,
      t.control_center_id,
      EXISTS (
        SELECT 1
        FROM ticket_reports tr
        JOIN mobile_events me ON me.id = tr.mobile_event_id
        WHERE tr.ticket_id = t.id AND me.user_id = $2
      ) AS is_reporting_neighbor
    FROM tickets t
    WHERE t.id = $1
    LIMIT 1
    `,
    [ticketId, session.sub]
  );
  if (!result.rows.length) {
    res.status(404).json({ status: "error", message: "Ticket not found" });
    return false;
  }
  const ticket = result.rows[0];
  if (role === "SUPER_ADMIN") return true;
  if (["ADMIN", "OPERATOR"].includes(role)) {
    if (String(ticket.control_center_id) === String(session.control_center_id)) return true;
    res.status(403).json({ status: "error", message: "Ticket de otro centro de control" });
    return false;
  }
  const allowed = (role === "NEIGHBOR" && (String(ticket.citizen_user_id) === String(session.sub) || ticket.is_reporting_neighbor === true))
    || (role === "RESOLVER" && String(ticket.assigned_resolver_id) === String(session.sub));
  if (!allowed) {
    res.status(403).json({ status: "error", message: "No autorizado para este ticket" });
    return false;
  }
  return true;
}

function allowedRolesForPanel(panelType) {
  const normalized = String(panelType || "CONTROL_CENTER").toUpperCase();

  if (normalized === "SUPER_ADMIN") return ["SUPER_ADMIN"];
  if (normalized === "ADMIN") return ["ADMIN", "SUPER_ADMIN"];
  if (normalized === "CONTROL_CENTER") return ["OPERATOR", "ADMIN", "SUPER_ADMIN"];
  if (normalized === "RESOLVER") return ["RESOLVER", "ADMIN", "SUPER_ADMIN"];

  return ["OPERATOR", "ADMIN", "SUPER_ADMIN"];
}


/*
   =========================================================
   MUNICIPAL GEOFENCING / JURISDICTION
   =========================================================

   Cada centro de control puede tener un polígono GeoJSON oficial.
   Un SOS móvil de vecino solo se transforma en ticket operacional
   si cae dentro del polígono de su centro de control, con un buffer
   configurable para tolerancia GPS cerca del límite comunal.
*/

let geofenceSchemaReady = false;
let neighborProvisioningSchemaReady = false;

async function ensureGeofenceSchema() {
  if (geofenceSchemaReady) return;

  await pool.query(`
    ALTER TABLE control_centers
      ADD COLUMN IF NOT EXISTS boundary_geojson JSONB,
      ADD COLUMN IF NOT EXISTS geofence_buffer_meters INTEGER DEFAULT 100,
      ADD COLUMN IF NOT EXISTS map_center_lat DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS map_center_lon DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS map_zoom INTEGER DEFAULT 13,
      ADD COLUMN IF NOT EXISTS municipality_logo_url TEXT,
      ADD COLUMN IF NOT EXISTS product_logo_url TEXT,
      ADD COLUMN IF NOT EXISTS brand_primary_color TEXT,
      ADD COLUMN IF NOT EXISTS brand_secondary_color TEXT
  `);

  await pool.query(`
    ALTER TABLE tickets
      ADD COLUMN IF NOT EXISTS jurisdiction_status TEXT DEFAULT 'IN_JURISDICTION',
      ADD COLUMN IF NOT EXISTS jurisdiction_reason TEXT
  `);

  await pool.query(`
    ALTER TABLE mobile_events
      ADD COLUMN IF NOT EXISTS jurisdiction_status TEXT DEFAULT 'IN_JURISDICTION',
      ADD COLUMN IF NOT EXISTS jurisdiction_reason TEXT
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tickets_cc_jurisdiction
    ON tickets(control_center_id, jurisdiction_status, created_at DESC)
  `);

  geofenceSchemaReady = true;
}

async function ensureNeighborProvisioningSchema() {
  if (neighborProvisioningSchemaReady) return;

  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS provisional_expires_at TIMESTAMPTZ
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_users_neighbor_validation_review
    ON users(control_center_id, validation_status, provisional_expires_at)
    WHERE role = 'NEIGHBOR'
  `);

  neighborProvisioningSchemaReady = true;
}

function normalizeGeoJsonGeometry(input) {
  if (!input) return null;
  if (input.type === 'Feature') return normalizeGeoJsonGeometry(input.geometry);
  if (input.type === 'FeatureCollection') {
    const first = (input.features || []).find(f => f && f.geometry);
    return first ? normalizeGeoJsonGeometry(first.geometry) : null;
  }
  if (input.type === 'Polygon' || input.type === 'MultiPolygon') return input;
  return null;
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i][0]);
    const yi = Number(ring[i][1]);
    const xj = Number(ring[j][0]);
    const yj = Number(ring[j][1]);
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonCoordinates(lon, lat, polygon) {
  if (!Array.isArray(polygon) || !polygon.length) return false;
  if (!pointInRing(lon, lat, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) {
    if (pointInRing(lon, lat, polygon[i])) return false;
  }
  return true;
}

function pointInGeoJson(lon, lat, geometry) {
  const geo = normalizeGeoJsonGeometry(geometry);
  if (!geo) return null;
  if (geo.type === 'Polygon') return pointInPolygonCoordinates(lon, lat, geo.coordinates);
  if (geo.type === 'MultiPolygon') return geo.coordinates.some(poly => pointInPolygonCoordinates(lon, lat, poly));
  return null;
}

function toMeters(lon, lat, refLat) {
  const R = 6371000;
  const x = (lon * Math.PI / 180) * R * Math.cos(refLat * Math.PI / 180);
  const y = (lat * Math.PI / 180) * R;
  return [x, y];
}

function distancePointToSegmentMeters(lon, lat, lon1, lat1, lon2, lat2) {
  const refLat = lat;
  const [px, py] = toMeters(lon, lat, refLat);
  const [ax, ay] = toMeters(lon1, lat1, refLat);
  const [bx, by] = toMeters(lon2, lat2, refLat);
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function minDistanceToRingMeters(lon, lat, ring) {
  let min = Infinity;
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1];
    const b = ring[i];
    const d = distancePointToSegmentMeters(lon, lat, Number(a[0]), Number(a[1]), Number(b[0]), Number(b[1]));
    if (d < min) min = d;
  }
  return min;
}

function minDistanceToGeoJsonMeters(lon, lat, geometry) {
  const geo = normalizeGeoJsonGeometry(geometry);
  if (!geo) return null;
  const polygons = geo.type === 'Polygon' ? [geo.coordinates] : geo.coordinates;
  let min = Infinity;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      const d = minDistanceToRingMeters(lon, lat, ring);
      if (d < min) min = d;
    }
  }
  return Number.isFinite(min) ? min : null;
}

function getGeoJsonBounds(geometry) {
  const geo = normalizeGeoJsonGeometry(geometry);
  if (!geo) return null;
  const coords = [];
  const polygons = geo.type === 'Polygon' ? [geo.coordinates] : geo.coordinates;
  polygons.forEach(poly => poly.forEach(ring => ring.forEach(c => coords.push(c))));
  if (!coords.length) return null;
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  coords.forEach(c => {
    const lon = Number(c[0]);
    const lat = Number(c[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
  });
  if (!Number.isFinite(minLat)) return null;
  return { minLon, minLat, maxLon, maxLat, centerLat: (minLat + maxLat) / 2, centerLon: (minLon + maxLon) / 2 };
}

function evaluateJurisdiction(controlCenter, latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { valid: false, status: 'INVALID_LOCATION', reason: 'Ubicación inválida' };
  }

  const boundary = normalizeGeoJsonGeometry(controlCenter?.boundary_geojson);
  if (!boundary) {
    // Mientras no se cargue polígono, no bloqueamos. Se marca como no verificado.
    return { valid: true, status: 'NO_GEOFENCE_CONFIGURED', reason: 'Centro de control sin polígono configurado' };
  }

  const inside = pointInGeoJson(lon, lat, boundary);
  if (inside === true) {
    return { valid: true, status: 'IN_JURISDICTION', reason: 'Dentro del límite comunal' };
  }

  const buffer = Math.max(0, Number(controlCenter?.geofence_buffer_meters || 0));
  const distance = minDistanceToGeoJsonMeters(lon, lat, boundary);
  if (distance != null && distance <= buffer) {
    return {
      valid: true,
      status: 'IN_JURISDICTION_BUFFER',
      reason: `Dentro de tolerancia GPS (${Math.round(distance)} m del límite comunal)`,
      distance_meters: Math.round(distance)
    };
  }

  return {
    valid: false,
    status: 'OUT_OF_JURISDICTION',
    reason: `Evento fuera del territorio autorizado del centro de control${distance != null ? ` (${Math.round(distance)} m del límite)` : ''}`,
    distance_meters: distance == null ? null : Math.round(distance)
  };
}

async function resolveControlCenterForNeighborRegistration(latitude, longitude) {
  await ensureGeofenceSchema();

  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    const error = new Error("Para registrarte necesitamos obtener tu ubicación GPS.");
    error.statusCode = 400;
    throw error;
  }

  const ccResult = await pool.query(`
    SELECT id, code, name, latitude, longitude, boundary_geojson, geofence_buffer_meters
    FROM control_centers
    ORDER BY code
  `);

  const centers = ccResult.rows || [];
  const geofencedCenters = centers.filter((center) => normalizeGeoJsonGeometry(center.boundary_geojson));
  const matches = [];

  for (const center of geofencedCenters) {
    const jurisdiction = evaluateJurisdiction(center, lat, lon);
    if (jurisdiction.valid && jurisdiction.status !== 'NO_GEOFENCE_CONFIGURED') {
      matches.push({ controlCenter: center, jurisdiction });
    }
  }

  if (matches.length) {
    matches.sort((a, b) => {
      const aDistance = a.jurisdiction.distance_meters ?? 0;
      const bDistance = b.jurisdiction.distance_meters ?? 0;
      const aExact = a.jurisdiction.status === 'IN_JURISDICTION' ? 0 : 1;
      const bExact = b.jurisdiction.status === 'IN_JURISDICTION' ? 0 : 1;
      return aExact - bExact || aDistance - bDistance || String(a.controlCenter.code).localeCompare(String(b.controlCenter.code));
    });
    return matches[0];
  }

  if (geofencedCenters.length) {
    const candidates = geofencedCenters
      .map((center) => {
        const distance = minDistanceToGeoJsonMeters(lon, lat, center.boundary_geojson);
        return {
          controlCenter: center,
          distance_meters: distance == null ? null : Math.round(distance)
        };
      })
      .filter((item) => item.distance_meters != null)
      .sort((a, b) => a.distance_meters - b.distance_meters);

    const nearest = candidates[0];
    const error = new Error(
      nearest
        ? `Tu ubicación GPS no corresponde a una zona cubierta por un Centro de Control. Centro más cercano: ${nearest.controlCenter.name || nearest.controlCenter.code}, a ${nearest.distance_meters} m del límite.`
        : "Tu ubicación GPS no corresponde a una zona cubierta por un Centro de Control."
    );
    error.statusCode = 422;
    error.details = nearest ? {
      nearest_control_center_code: nearest.controlCenter.code,
      nearest_control_center_name: nearest.controlCenter.name,
      distance_meters: nearest.distance_meters
    } : null;
    throw error;
  }

  const coordinateCandidates = centers
    .filter((center) => Number.isFinite(Number(center.latitude)) && Number.isFinite(Number(center.longitude)))
    .map((center) => ({
      controlCenter: center,
      distance_meters: Math.round(distanceMeters(lat, lon, Number(center.latitude), Number(center.longitude)))
    }))
    .sort((a, b) => a.distance_meters - b.distance_meters);

  if (coordinateCandidates.length) {
    const nearest = coordinateCandidates[0];
    return {
      controlCenter: nearest.controlCenter,
      jurisdiction: {
        valid: true,
        status: 'NEAREST_CONTROL_CENTER',
        reason: `Centro de control más cercano por GPS (${nearest.distance_meters} m)`,
        distance_meters: nearest.distance_meters
      }
    };
  }

  const error = new Error("No hay Centros de Control configurados para asignar el registro.");
  error.statusCode = 500;
  throw error;
}

app.get('/admin/control-centers/:code/geofence', async (req, res) => {
  if (!checkAdminToken(req, res)) return;
  try {
    await ensureGeofenceSchema();
    const result = await pool.query(`
      SELECT id, code, name, latitude, longitude, boundary_geojson,
             geofence_buffer_meters, map_center_lat, map_center_lon, map_zoom
      FROM control_centers
      WHERE code = $1
      LIMIT 1
    `, [requestedControlCenterForSession(req, req.params.code)]);
    if (!result.rows.length) return res.status(404).json({ status: 'error', message: 'Unknown control center' });
    res.json({ status: 'ok', control_center: result.rows[0] });
  } catch (error) {
    console.error('[GET GEOFENCE ERROR]', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/admin/control-centers/:code/geofence', async (req, res) => {
  if (!checkAdminToken(req, res)) return;
  try {
    await ensureGeofenceSchema();
    const boundary = normalizeGeoJsonGeometry(req.body.boundary_geojson || req.body.geojson || req.body);
    if (!boundary) {
      return res.status(400).json({ status: 'error', message: 'Debes enviar un GeoJSON Polygon, MultiPolygon, Feature o FeatureCollection' });
    }
    const bounds = getGeoJsonBounds(boundary);
    const buffer = Math.max(0, Number(req.body.geofence_buffer_meters ?? 100));
    const mapZoom = Math.max(8, Math.min(18, Number(req.body.map_zoom || 13)));
    const centerLat = Number(req.body.map_center_lat ?? bounds?.centerLat);
    const centerLon = Number(req.body.map_center_lon ?? bounds?.centerLon);

    const result = await pool.query(`
      UPDATE control_centers
      SET boundary_geojson = $2::jsonb,
          geofence_buffer_meters = $3,
          map_center_lat = $4,
          map_center_lon = $5,
          map_zoom = $6
      WHERE code = $1
      RETURNING id, code, name, latitude, longitude, boundary_geojson,
                geofence_buffer_meters, map_center_lat, map_center_lon, map_zoom
    `, [requestedControlCenterForSession(req, req.params.code), JSON.stringify(boundary), buffer, centerLat, centerLon, mapZoom]);

    if (!result.rows.length) return res.status(404).json({ status: 'error', message: 'Unknown control center' });
    res.json({ status: 'ok', message: 'Geofence updated', control_center: result.rows[0], bounds });
  } catch (error) {
    console.error('[SET GEOFENCE ERROR]', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/debug/geofence/check', async (req, res) => {
  if (!requireDebugAccess(req, res)) return;
  try {
    await ensureGeofenceSchema();
    const code = req.body.control_center_code || 'CC-VINA';
    const ccResult = await pool.query(`
      SELECT id, code, name, boundary_geojson, geofence_buffer_meters
      FROM control_centers
      WHERE code = $1
      LIMIT 1
    `, [code]);
    if (!ccResult.rows.length) return res.status(404).json({ status: 'error', message: 'Unknown control center' });
    const result = evaluateJurisdiction(ccResult.rows[0], req.body.latitude, req.body.longitude);
    res.json({ status: 'ok', control_center_code: code, jurisdiction: result });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/*
   =========================================================
   PHYSICAL SOS BUTTON REGISTRY
   =========================================================

   Los botones físicos no tienen una PWA asociada, por lo que la
   central no puede enviarles solicitudes internas de llamada/video.
   Para esos casos se registra un teléfono directo asociado al botón.

   Puedes configurar/editar el inventario por variable de entorno:

   PHYSICAL_SOS_BUTTONS_JSON='[{"id":"8322560","ident":"9705249564","name":"BotonSOS_1_Pudahuel","phone":"+569XXXXXXXX","control_center_code":"CC-VINA","address":"..."}]'

   También se deja el botón piloto declarado como base, sin teléfono
   real hardcodeado.
   =========================================================
 */

const DEFAULT_PHYSICAL_SOS_BUTTONS = [
  {
    id: "8322560",
    platform_id: "8322560",
    ident: "9705249564",
    name: "BotonSOS_1_Pudahuel",
    phone: process.env.PHYSICAL_BUTTON_8322560_PHONE || "",
    control_center_code: "CC-VINA",
    address: "Botón físico SOS piloto",
    notes: "Botón físico RF-V51 piloto"
  }
];

function loadPhysicalSosButtons() {
  const raw = process.env.PHYSICAL_SOS_BUTTONS_JSON;

  if (!raw) return DEFAULT_PHYSICAL_SOS_BUTTONS;

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") return Object.values(parsed);
  } catch (error) {
    console.warn("[PHYSICAL SOS REGISTRY] Invalid PHYSICAL_SOS_BUTTONS_JSON:", error.message);
  }

  return DEFAULT_PHYSICAL_SOS_BUTTONS;
}

function getPhysicalSosButtonProfile(normalized) {
  const platformId = normalized?.device?.platform_id ? String(normalized.device.platform_id) : null;
  const ident = normalized?.device?.id ? String(normalized.device.id) : null;
  const name = normalized?.device?.name || null;

  const registry = loadPhysicalSosButtons();

  const found = registry.find((item) => {
    const keys = [
      item.id,
      item.platform_id,
      item.ident,
      item.device_id,
      item.name
    ]
      .filter(Boolean)
      .map(String);

    return (platformId && keys.includes(platformId)) ||
      (ident && keys.includes(ident)) ||
      (name && keys.includes(name));
  });

  return {
    id: platformId || ident || "UNKNOWN",
    platform_id: platformId,
    ident,
    name: normalized?.device?.name || found?.name || `Botón SOS ${platformId || ident || "UNKNOWN"}`,
    phone: found?.phone || "",
    address: found?.address || found?.location || "",
    owner_name: found?.owner_name || found?.owner || "",
    control_center_code: found?.control_center_code || "CC-VINA",
    notes: found?.notes || ""
  };
}


async function getPhysicalSosButtonProfileFromDb(normalized) {
  const platformId = normalized?.device?.platform_id ? String(normalized.device.platform_id) : null;
  const ident = normalized?.device?.id ? String(normalized.device.id) : null;
  const deviceName = normalized?.device?.name ? String(normalized.device.name) : null;

  const keys = [platformId, ident, deviceName].filter(Boolean);
  if (!keys.length) return null;

  const result = await pool.query(
    `
    SELECT
      d.*,
      cc.code AS control_center_code,
      cc.name AS control_center_name
    FROM devices d
    LEFT JOIN control_centers cc ON cc.id = d.control_center_id
    WHERE d.type = 'PHYSICAL_SOS'
      AND (
        d.id = ANY($1::text[])
        OR d.platform_id = ANY($1::text[])
        OR d.name = ANY($1::text[])
        OR d.metadata->>'ident' = ANY($1::text[])
        OR d.metadata->>'device_id' = ANY($1::text[])
      )
    ORDER BY d.updated_at DESC NULLS LAST
    LIMIT 1
    `,
    [keys]
  );

  const row = result.rows[0];
  if (!row) return null;
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};

  return {
    id: row.platform_id || row.id || ident || platformId || 'UNKNOWN',
    platform_id: row.platform_id || platformId || null,
    ident: metadata.ident || ident || null,
    name: row.name || deviceName || `Botón SOS ${row.platform_id || row.id || ident || platformId || 'UNKNOWN'}`,
    phone: metadata.sim_phone || metadata.phone || '',
    address: metadata.registered_address || metadata.address || '',
    owner_name: metadata.owner_name || metadata.owner || '',
    control_center_code: row.control_center_code || metadata.control_center_code || 'CC-VINA',
    notes: metadata.notes || '',
    enabled: metadata.enabled !== false,
    db_device_id: row.id,
    metadata
  };
}

async function syncPhysicalSosDeviceTelemetry(normalized) {
  const platformId = normalized?.device?.platform_id ? String(normalized.device.platform_id) : null;
  const ident = normalized?.device?.id ? String(normalized.device.id) : null;
  const deviceName = normalized?.device?.name ? String(normalized.device.name) : null;
  const keys = [platformId, ident, deviceName].filter(Boolean);
  if (!keys.length) return null;

  const found = await pool.query(
    `
    SELECT *
    FROM devices
    WHERE type = 'PHYSICAL_SOS'
      AND (
        id = ANY($1::text[])
        OR platform_id = ANY($1::text[])
        OR name = ANY($1::text[])
        OR metadata->>'ident' = ANY($1::text[])
      )
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 1
    `,
    [keys]
  );

  if (!found.rows.length) return null;

  const current = found.rows[0];
  const currentMetadata = current.metadata && typeof current.metadata === 'object' ? current.metadata : {};
  const nextMetadata = {
    ...currentMetadata,
    ident: currentMetadata.ident || ident || null,
    last_event_type: normalized.event_type || null,
    battery: normalized.device?.battery ?? currentMetadata.battery ?? null,
    gsm_signal: normalized.device?.gsm_signal ?? currentMetadata.gsm_signal ?? null,
    satellites: normalized.position?.satellites ?? currentMetadata.satellites ?? null,
    position_valid: normalized.position?.valid ?? currentMetadata.position_valid ?? null,
    raw_type: normalized.raw_type || currentMetadata.raw_type || null
  };

  const latitude = normalized.position?.latitude ?? current.last_latitude;
  const longitude = normalized.position?.longitude ?? current.last_longitude;

  const update = await pool.query(
    `
    UPDATE devices
    SET
      platform_id = COALESCE($2, platform_id),
      name = COALESCE($3, name),
      last_latitude = $4,
      last_longitude = $5,
      last_seen = NOW(),
      status = 'ONLINE',
      metadata = $6::jsonb,
      updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [current.id, platformId, deviceName, latitude, longitude, JSON.stringify(nextMetadata)]
  );

  return update.rows[0] || null;
}

async function getControlCenterIdByCode(code = "CC-VINA") {
  const result = await pool.query(
    `
    SELECT id
    FROM control_centers
    WHERE code = $1
    LIMIT 1
    `,
    [code]
  );

  return result.rows[0]?.id || null;
}

async function findOpenPhysicalDeviceTicket(normalized, profile) {
  const platformId = profile.platform_id || null;
  const ident = profile.ident || null;

  const exactResult = await pool.query(
    `
    SELECT *
    FROM tickets
    WHERE source_type = 'GPS_DEVICE'
      AND source_event_id = $1
      AND state NOT IN ('CLOSED','CANCELLED','RESOLVED')
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [normalized.event_id]
  );

  if (exactResult.rows.length > 0) {
    return exactResult.rows[0];
  }

  try {
    const recentResult = await pool.query(
      `
      SELECT DISTINCT t.*
      FROM tickets t
      JOIN ticket_actions ta ON ta.ticket_id = t.id
      WHERE t.source_type = 'GPS_DEVICE'
        AND t.state NOT IN ('CLOSED','CANCELLED','RESOLVED')
        AND t.created_at > NOW() - INTERVAL '30 minutes'
        AND ta.action_type = 'TICKET_CREATED'
        AND (
          ta.metadata->>'platform_id' = $1
          OR ta.metadata->>'device_id' = $1
          OR ta.metadata->>'ident' = $2
          OR ta.metadata->>'device_id' = $2
        )
      ORDER BY t.created_at DESC
      LIMIT 1
      `,
      [platformId, ident]
    );

    return recentResult.rows[0] || null;
  } catch (error) {
    console.warn("[PHYSICAL SOS DUP CHECK WARNING]", error.message);
    return null;
  }
}

async function createTicketFromPhysicalSos(normalized) {
  if (normalized.event_type !== "SOS") return null;

  const latitude = normalized.position?.latitude;
  const longitude = normalized.position?.longitude;

  if (latitude == null || longitude == null) {
    console.warn("[PHYSICAL SOS] SOS received without position. Ticket not created.", normalized.event_id);
    return null;
  }

  const dbProfile = await getPhysicalSosButtonProfileFromDb(normalized).catch((error) => {
    console.warn("[PHYSICAL SOS DB PROFILE WARNING]", error.message);
    return null;
  });
  const profile = dbProfile || getPhysicalSosButtonProfile(normalized);

  if (profile.enabled === false) {
    console.log("[PHYSICAL SOS] Device disabled by admin inventory", { device_id: profile.id, platform_id: profile.platform_id });
    return null;
  }

  const controlCenterId = await getControlCenterIdByCode(profile.control_center_code);

  if (!controlCenterId) {
    console.warn("[PHYSICAL SOS] Control center not found", profile.control_center_code);
    return null;
  }

  const settingsRow = await getControlCenterSettingsById(controlCenterId).catch(() => null);
  const platformSettings = settingsRow?.settings || DEFAULT_CONTROL_CENTER_SETTINGS;

  if (platformSettings.features?.physical_sos_buttons_enabled === false) {
    console.log("[PHYSICAL SOS] Physical SOS buttons disabled by control center policy", { control_center_code: profile.control_center_code });
    return null;
  }

  const existingTicket = await findOpenPhysicalDeviceTicket(normalized, profile);

  if (existingTicket) {
    console.log("[PHYSICAL SOS] Open ticket already exists", {
      ticket_id: existingTicket.id,
      source_event_id: normalized.event_id,
      device_id: profile.id
    });

    return existingTicket;
  }

  const phoneText = profile.phone ? ` Teléfono asociado: ${profile.phone}.` : "";
  const addressText = profile.address ? ` Ubicación/sector registrado: ${profile.address}.` : "";

  const ticket = await createTicket({
    control_center_id: controlCenterId,
    citizen_user_id: null,
    source_type: "GPS_DEVICE",
    source_event_id: normalized.event_id,
    alert_type: "SOS_DEVICE",
    title: "SOS botón físico",
    description: `Alerta SOS generada por botón físico ${profile.name}.${phoneText}${addressText}`,
    latitude,
    longitude,
    accuracy: normalized.position?.accuracy ?? null,
    priority: 1,
    metadata: {
      channel: "physical_sos_button",
      device_id: profile.id,
      platform_id: profile.platform_id,
      ident: profile.ident,
      device_name: profile.name,
      device_phone: profile.phone || null,
      owner_name: profile.owner_name || null,
      registered_address: profile.address || null,
      registry_notes: profile.notes || null,
      source_event_id: normalized.event_id,
      raw_type: normalized.raw_type,
      battery: normalized.device?.battery ?? null,
      satellites: normalized.position?.satellites ?? null,
      valid: normalized.position?.valid ?? null
    }
  });

  console.log("[PHYSICAL SOS TICKET CREATED]", {
    ticket_id: ticket.id,
    source_event_id: normalized.event_id,
    device_id: profile.id,
    device_phone: profile.phone || null
  });

  return ticket;
}


function normalizeMessage(msg, receivedAt) {
	const lat = msg["position.latitude"] ?? msg["latitude"] ?? null;
	const lon = msg["position.longitude"] ?? msg["longitude"] ?? null;
	const battery = msg["battery.level"] ?? msg["battery"] ?? null;
	const type = msg["message.type"] || "UNKNOWN";

	const isSos =
		msg["sos.alarm"] === true ||
		type === "AL_LTE" ||
		type === "SOS" ||
		type === "ALARM";

	const hasPosition = lat !== null && lon !== null;

	let eventType = null;

	if (isSos) {
		eventType = "SOS";
	} else if (type === "LK") {
		eventType = "KEEP_ALIVE";
	} else if (hasPosition) {
		eventType = "LOCATION";
	} else if (battery !== null && Number(battery) <= 20) {
		eventType = "LOW_BATTERY";
	} else {
		eventType = type;
	}

	return {
source: "VSTI",
	version: "1.0",
	event_id: `VSTI-${msg["ident"] || msg["device.id"] || "UNKNOWN"}-${Math.floor(
			msg["timestamp"] || Date.now() / 1000
			)}`,
	event_type: eventType,
	device: {
id: msg["ident"] || msg["device.id"] || null,
    platform_id: msg["device.id"] || null,
    name: msg["device.name"] || null,
    battery: battery,
    gsm_signal: msg["gsm.signal.level"] ?? null,
    operator_mcc: msg["gsm.mcc"] ?? null,
    operator_mnc: msg["gsm.mnc"] ?? null
	},
position: {
latitude: lat,
	  longitude: lon,
	  valid: msg["position.valid"] ?? null,
	  satellites: msg["position.satellites"] ?? null,
	  speed: msg["position.speed"] ?? msg["speed"] ?? null,
	  direction: msg["position.direction"] ?? null,
	  altitude: msg["position.altitude"] ?? null,
	  accuracy: msg["position.accuracy"] ?? null
	  },
alarm: {
sos: msg["sos.alarm"] ?? false,
     battery_low: msg["battery.low.status"] ?? false,
     wristband_connected: msg["wristband.connected.status"] ?? null
       },
network: {
peer: msg["peer"] ?? null,
      vendor_code: msg["vendor.code"] ?? null,
      cellid: msg["gsm.cellid"] ?? null,
      lac: msg["gsm.lac"] ?? null
	 },
raw_type: type,
	  timestamp: msg["timestamp"] || null,
	  received_at: receivedAt
	};
}


function updateDeviceState(normalized) {
	const id = normalized.device.id;
	if (!id) return;

	devices[id] = {
		id,
		platform_id: normalized.device.platform_id,
		name: normalized.device.name,
		battery: normalized.device.battery,
		last_event_type: normalized.event_type,
		last_seen: normalized.received_at,
		last_position: normalized.position.latitude && normalized.position.longitude
			? normalized.position
			: devices[id]?.last_position || null,
		status: "ONLINE"
	};
}

function updateGpsDeviceFromNormalized(normalized) {
	const platformId = normalized.device.platform_id;
	if (!platformId) return;

	const id = String(platformId);
	const existing = gpsDevices[id] || {};

	const isSos =
		normalized.event_type === "SOS" ||
		normalized.alarm?.sos === true;

	gpsDevices[id] = {
		...existing,
		id,
		name: normalized.device.name || existing.name || `Botón SOS ${id}`,
		latitude: normalized.position.latitude ?? existing.latitude,
		longitude: normalized.position.longitude ?? existing.longitude,
		speed: normalized.position.speed ?? existing.speed,
		direction: normalized.position.direction ?? existing.direction,
		satellites: normalized.position.satellites ?? existing.satellites,
		valid: normalized.position.valid ?? existing.valid,
		last_seen: normalized.received_at,
		updated_at_ms: Date.now(),
		last_event_type: normalized.event_type,
		sos_active: isSos ? true : (existing.sos_active || false),

		sos_started_at: isSos ? normalized.received_at : existing.sos_started_at,
		sos_started_at_ms: isSos ? Date.now() : existing.sos_started_at_ms,
		sos_event_id: isSos ? normalized.event_id : existing.sos_event_id,


		sos_acknowledged: isSos ? false : existing.sos_acknowledged || false,
		sos_acknowledged_at: isSos ? null : existing.sos_acknowledged_at || null
	};
}






/*
   =========================================================
   SAYVU FORWARDING - PILOT MODE
   =========================================================

   Durante la fase piloto se envían TODOS los eventos a SayVU:
   - SOS
   - LOCATION
   - KEEP_ALIVE / LK
   - LOW_BATTERY
   - Cualquier otro evento futuro

   Más adelante VSTI podrá filtrar el tráfico desde este middleware
   sin requerir cambios en SayVU.

   =========================================================
 */


async function sendToSayVU(payload) {
	console.log("PREPARED FOR SAYVU");
	console.log(JSON.stringify(payload, null, 2));

	if (!SAYVU_API_URL) {
		console.log("SAYVU_API_URL not configured. Payload not sent.");
		return { sent: false, reason: "SAYVU_API_URL not configured" };
	}

	try {
		const response = await fetch(SAYVU_API_URL, {
method: "POST",
headers: {
"Content-Type": "application/json",
...(SAYVU_TOKEN ? { Authorization: `Bearer ${SAYVU_TOKEN}` } : {})
},
body: JSON.stringify(payload)
});

const text = await response.text();

console.log("SAYVU RESPONSE:", response.status, text);

return {
sent: response.ok,
      status: response.status,
      response: text
};
} catch (error) {
	console.error("ERROR SENDING TO SAYVU:", error.message);
	return {
sent: false,
      error: error.message
	};
}
}

async function processIncomingMessage(msg, receivedAt) {
	const normalized = normalizeMessage(msg, receivedAt);

	updateDeviceState(normalized);

	updateGpsDeviceFromNormalized(normalized);

  await syncPhysicalSosDeviceTelemetry(normalized).catch((error) => {
    console.warn("[PHYSICAL SOS TELEMETRY SYNC WARNING]", error.message);
  });

	let physicalSosTicket = null;

	if (normalized.event_type === "SOS") {
		try {
			physicalSosTicket = await createTicketFromPhysicalSos(normalized);
		} catch (error) {
			console.error("[PHYSICAL SOS TICKET ERROR]", error);
		}
	}


	const shouldSendToSayVU = true;

	/*
	   const shouldSendToSayVU =
	   normalized.event_type === "SOS" ||
	   normalized.event_type === "LOCATION" ||
	   normalized.event_type === "LOW_BATTERY";

	   if (normalized.event_type === "KEEP_ALIVE") {
	   console.log("KEEP_ALIVE received. Internal monitoring only.");
	   return { normalized, forwarded: false, physical_sos_ticket: physicalSosTicket };
	   }
	 */


	if (shouldSendToSayVU) {
		const result = await sendToSayVU(normalized);
		return { normalized, forwarded: true, result, physical_sos_ticket: physicalSosTicket };
	}

	console.log("Message received but not forwarded.");
	console.log(JSON.stringify(normalized, null, 2));

	return { normalized, forwarded: false };
}

function startFlespiMqtt() {
	if (!FLESPI_TOKEN) {
		console.log("FLESPI_TOKEN not configured. MQTT disabled.");
		return;
	}

	const client = mqtt.connect(FLESPI_MQTT_URL, {
username: FLESPI_TOKEN,
password: "",
reconnectPeriod: 5000,
connectTimeout: 10000
});

client.on("connect", () => {
		console.log("Connected to Flespi MQTT");

		client.subscribe(
				"flespi/state/gw/devices/+/telemetry/position",
				{ qos: 0 },
				(err) => {
				if (err) {
				console.error("Flespi subscribe error:", err.message);
				} else {
				console.log("Subscribed to Flespi position telemetry");
				}
				}
				);
		});

client.on("message", (topic, message) => {
		try {
		const payload = JSON.parse(message.toString());
		const parts = topic.split("/");
		const deviceId = parts[4];

		if (!payload.latitude || !payload.longitude) return;


		const existing = gpsDevices[deviceId] || {};

		gpsDevices[deviceId] = {
		...existing,

		id: deviceId,
		latitude: payload.latitude,
		longitude: payload.longitude,
		speed: payload.speed ?? null,
		direction: payload.direction ?? null,
		satellites: payload.satellites ?? null,
		valid: payload.valid ?? null,
		last_seen: nowChile(),
		updated_at_ms: Date.now()
		};

		console.log("GPS POSITION", gpsDevices[deviceId]);
		} catch (error) {
			console.error("Error processing Flespi MQTT message:", error.message);
		}
});

client.on("error", (err) => {
		console.error("Flespi MQTT error:", err.message);
		});

client.on("reconnect", () => {
		console.log("Reconnecting to Flespi MQTT...");
		});
}



function normalizeResolverId(id) {
  return String(id || "").trim().toLowerCase();
}

async function getRejectedResolverIdsForTicket(ticketId) {
  const rejected = new Set();

  const add = (value) => {
    const normalized = normalizeResolverId(value);
    if (normalized) rejected.add(normalized);
  };

  // Main source: assignment lifecycle table.
  try {
    const result = await pool.query(
      `
      SELECT DISTINCT resolver_user_id
      FROM ticket_assignments
      WHERE ticket_id = $1
        AND UPPER(COALESCE(state,'')) = 'REJECTED'
        AND resolver_user_id IS NOT NULL
      `,
      [ticketId]
    );
    for (const row of result.rows || []) add(row.resolver_user_id);
  } catch (error) {
    console.warn('[REJECTED RESOLVER IDS] ticket_assignments lookup failed:', error.message);
  }

  // Safety source: action log. This catches legacy/manual flows where the assignment row was not updated.
  try {
    const result = await pool.query(
      `
      SELECT DISTINCT actor_user_id
      FROM ticket_actions
      WHERE ticket_id = $1
        AND action_type = 'RESOLVER_REJECTED'
        AND actor_user_id IS NOT NULL
      `,
      [ticketId]
    );
    for (const row of result.rows || []) add(row.actor_user_id);
  } catch (error) {
    console.warn('[REJECTED RESOLVER IDS] ticket_actions lookup failed:', error.message);
  }

  return Array.from(rejected);
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (v) => v * Math.PI / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


/*
   =========================================================
   INCIDENT AGGREGATION / MULTI-REPORT CASES
   =========================================================

   Un incidente operativo puede recibir muchos reportes de vecinos.
   El primer reporte crea el ticket; los siguientes, si son cercanos,
   recientes y compatibles, se asocian al ticket existente como
   testimonios/antecedentes sin saturar a la central con tickets duplicados.
*/

let incidentAggregationSchemaReady = false;
const INCIDENT_DEDUP_RADIUS_METERS = Number(process.env.INCIDENT_DEDUP_RADIUS_METERS || 120);
const INCIDENT_DEDUP_WINDOW_MINUTES = Number(process.env.INCIDENT_DEDUP_WINDOW_MINUTES || 30);

function incidentPolicyFromSettings(settings) {
  const normalized = normalizeControlCenterSettings(settings || {});
  return normalized.incident_policy || DEFAULT_CONTROL_CENTER_SETTINGS.incident_policy;
}

async function ensureIncidentAggregationSchema() {
  if (incidentAggregationSchemaReady) return;

  await pool.query(`
    ALTER TABLE mobile_events
      ADD COLUMN IF NOT EXISTS linked_ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL
  `);

  await pool.query(`
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
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ticket_reports_ticket_created
    ON ticket_reports(ticket_id, created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ticket_reports_mobile_event
    ON ticket_reports(mobile_event_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_mobile_events_linked_ticket
    ON mobile_events(linked_ticket_id)
  `);

  incidentAggregationSchemaReady = true;
}

function incidentGroup(alertType) {
  const type = String(alertType || 'SOS_MANUAL').toUpperCase();
  if (['FIRE', 'INCENDIO'].includes(type)) return 'FIRE';
  if (type === 'VIF' || type === 'VIF_SILENT_SHAKE' || type.includes('VIOLENCIA')) return 'VIF';
  if (['SECURITY', 'SEGURIDAD', 'ROBBERY', 'THEFT'].includes(type)) return 'SECURITY';
  if (['MEDICAL', 'MEDICA', 'MÉDICA', 'FALL_DETECTED', 'TRAFFIC_ACCIDENT', 'ACCIDENT', 'URBAN_RISK', 'SOS_MANUAL', 'OTHER'].includes(type)) {
    return 'PUBLIC_INCIDENT';
  }
  return 'PUBLIC_INCIDENT';
}

function incidentTypesCompatible(a, b) {
  const groupA = incidentGroup(a);
  const groupB = incidentGroup(b);
  if (groupA === groupB) return true;
  const typeA = String(a || '').toUpperCase();
  const typeB = String(b || '').toUpperCase();
  return (typeA === 'SOS_MANUAL' && groupB === 'PUBLIC_INCIDENT') ||
         (typeB === 'SOS_MANUAL' && groupA === 'PUBLIC_INCIDENT');
}

function scoreIncidentMatch(distance, ageMinutes, categoryCompatible, policy = null) {
  const p = incidentPolicyFromSettings({ incident_policy: policy || {} });
  const radiusMeters = Number(policy?.dedup_radius_meters || INCIDENT_DEDUP_RADIUS_METERS);
  const windowMinutes = Number(policy?.dedup_window_minutes || INCIDENT_DEDUP_WINDOW_MINUTES);
  if (!categoryCompatible || distance == null) return 0;
  const distanceScore = Math.max(0, 1 - (distance / radiusMeters));
  const timeScore = Math.max(0, 1 - (ageMinutes / windowMinutes));
  return Math.round((0.65 * distanceScore + 0.35 * timeScore) * 100) / 100;
}

async function findNearbyActiveIncident({ controlCenterId, latitude, longitude, alertType, settings = null }) {
  await ensureIncidentAggregationSchema();
  const incidentPolicy = incidentPolicyFromSettings(settings || {});
  if (!incidentPolicy.dedup_enabled) return null;
  const dedupWindowMinutes = Math.max(1, Math.round(Number(incidentPolicy.dedup_window_minutes || INCIDENT_DEDUP_WINDOW_MINUTES)));
  const dedupRadiusMeters = Math.max(1, Math.round(Number(incidentPolicy.dedup_radius_meters || INCIDENT_DEDUP_RADIUS_METERS)));

  const result = await pool.query(
    `
    SELECT
      t.*,
      citizen.full_name AS citizen_name,
      resolver.full_name AS resolver_name,
      COALESCE(report_stats.report_count, 0)::int AS report_count
    FROM tickets t
    LEFT JOIN users citizen ON citizen.id = t.citizen_user_id
    LEFT JOIN users resolver ON resolver.id = t.assigned_resolver_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS report_count
      FROM ticket_reports tr
      WHERE tr.ticket_id = t.id
    ) report_stats ON true
    WHERE t.control_center_id = $1
      AND t.state NOT IN ('RESOLVED','CLOSED','CANCELLED')
      AND t.latitude IS NOT NULL
      AND t.longitude IS NOT NULL
      AND t.created_at >= NOW() - ($2::int * INTERVAL '1 minute')
    ORDER BY t.created_at DESC
    LIMIT 50
    `,
    [controlCenterId, dedupWindowMinutes]
  );

  const candidates = result.rows
    .map((ticket) => {
      const distance = distanceMeters(Number(latitude), Number(longitude), Number(ticket.latitude), Number(ticket.longitude));
      const ageMinutes = Math.max(0, (Date.now() - new Date(ticket.created_at).getTime()) / 60000);
      const compatible = incidentTypesCompatible(alertType, ticket.alert_type);
      const score = scoreIncidentMatch(distance, ageMinutes, compatible, incidentPolicy);
      return { ticket, distance_meters: distance, age_minutes: ageMinutes, compatible, score };
    })
    .filter((item) => item.compatible && item.distance_meters <= dedupRadiusMeters)
    .sort((a, b) => b.score - a.score || a.distance_meters - b.distance_meters);

  return candidates[0] || null;
}

async function insertTicketReport({ ticket, event, citizen, normalizedAlert, source, confidence, isPrimaryReport, match = null }) {
  await ensureIncidentAggregationSchema();
  const reportId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const confidenceValue = confidence == null || confidence === '' ? null : Number(confidence);

  const result = await pool.query(
    `
    INSERT INTO ticket_reports (
      id,
      ticket_id,
      mobile_event_id,
      reporter_user_id,
      reporter_name,
      reporter_phone,
      latitude,
      longitude,
      accuracy,
      alert_type,
      title,
      description,
      source,
      confidence_score,
      match_score,
      distance_meters,
      is_primary_report
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    RETURNING *
    `,
    [
      reportId,
      ticket.id,
      event.id,
      citizen?.id || event.user_id || null,
      citizen?.full_name || event.name || null,
      citizen?.phone || event.phone || null,
      event.latitude,
      event.longitude,
      event.accuracy,
      normalizedAlert.alert_type,
      normalizedAlert.title,
      normalizedAlert.description,
      source || null,
      Number.isFinite(confidenceValue) ? confidenceValue : null,
      match?.score ?? null,
      match?.distance_meters == null ? null : Math.round(match.distance_meters),
      isPrimaryReport === true
    ]
  );

  await pool.query(
    `
    UPDATE mobile_events
    SET linked_ticket_id = $2,
        acknowledged = true,
        acknowledged_at = COALESCE(acknowledged_at, NOW()),
        updated_at = NOW()
    WHERE id = $1
    `,
    [event.id, ticket.id]
  );

  return result.rows[0];
}

async function ticketReportCount(ticketId) {
  await ensureIncidentAggregationSchema();
  const result = await pool.query(
    `SELECT COUNT(*)::int AS report_count FROM ticket_reports WHERE ticket_id = $1`,
    [ticketId]
  );
  return Number(result.rows[0]?.report_count || 0);
}

async function autoAssignResolver(ticket, options = {}) {
  const force = options.force === true;
  const excludeResolverUserIds = new Set(
    (options.excludeResolverUserIds || options.exclude_resolver_user_ids || [])
      .filter(Boolean)
      .map(normalizeResolverId)
      .filter(Boolean)
  );

  if (!ticket || !ticket.id) {
    return null;
  }

  if (!force && ticket.assigned_resolver_id) {
    return {
      ticket,
      resolver: null,
      skipped: true,
      reason: "Ticket ya tenía resolutor asignado"
    };
  }

  if (ticket.latitude == null || ticket.longitude == null) {
    await pool.query(
      `
      INSERT INTO ticket_actions (
        ticket_id,
        actor_role,
        action_type,
        description,
        metadata
      )
      VALUES ($1,'SYSTEM','AUTO_ASSIGN_SKIPPED',$2,$3)
      `,
      [
        ticket.id,
        "No se pudo asignar automáticamente: ticket sin coordenadas",
        JSON.stringify({ reason: "MISSING_TICKET_LOCATION" })
      ]
    );
    return null;
  }

  const rejectedResolverIds = await getRejectedResolverIdsForTicket(ticket.id);
  for (const resolverId of rejectedResolverIds) {
    excludeResolverUserIds.add(normalizeResolverId(resolverId));
  }

  const candidateResult = await pool.query(
    `
    SELECT
      u.id,
      u.full_name,
      u.phone,
      u.role,
      u.is_active,
      u.validation_status,
      u.control_center_id,
      rl.latitude,
      rl.longitude,
      rl.status,
      rl.updated_at,
      CASE
        WHEN rl.updated_at IS NULL THEN NULL
        ELSE EXTRACT(EPOCH FROM (NOW() - rl.updated_at))
      END AS location_age_seconds,
      (
        SELECT COUNT(*)::int
        FROM tickets active_tickets
        WHERE active_tickets.assigned_resolver_id = u.id
          AND active_tickets.state = ANY($2::text[])
      ) AS active_tickets_count
    FROM users u
    LEFT JOIN resolver_locations rl ON rl.user_id = u.id
    WHERE u.control_center_id = $1
      AND u.role = 'RESOLVER'
    `,
    [ticket.control_center_id, ACTIVE_RESOLVER_TICKET_STATES]
  );

  const configuredMaxAgeSeconds = Number(process.env.AUTO_ASSIGN_MAX_LOCATION_AGE_SECONDS ?? 180);
  const maxAgeSeconds = Number.isFinite(configuredMaxAgeSeconds) && configuredMaxAgeSeconds > 0
    ? configuredMaxAgeSeconds
    : 180;

  const candidates = candidateResult.rows.map((resolver) => {
    const lat = Number(resolver.latitude);
    const lon = Number(resolver.longitude);
    const age = resolver.location_age_seconds == null ? null : Number(resolver.location_age_seconds);
    const activeTicketsCount = Number(resolver.active_tickets_count || 0);
    const hasLocation = Number.isFinite(lat) && Number.isFinite(lon);
    const isStale = hasLocation && (age == null || age > maxAgeSeconds);

    const rejection_reasons = [];
    if (excludeResolverUserIds.has(normalizeResolverId(resolver.id))) rejection_reasons.push("ALREADY_REJECTED_TICKET");
    if (resolver.is_active !== true) rejection_reasons.push("USER_INACTIVE");
    if (String(resolver.status || "").toUpperCase() !== "AVAILABLE") rejection_reasons.push(`STATUS_${resolver.status || "NO_STATUS"}`);
    if (activeTicketsCount > 0) rejection_reasons.push("HAS_ACTIVE_TICKET");
    if (!hasLocation) rejection_reasons.push("NO_LOCATION");
    if (isStale) rejection_reasons.push("STALE_LOCATION");

    return {
      ...resolver,
      active_tickets_count: activeTicketsCount,
      latitude: hasLocation ? lat : null,
      longitude: hasLocation ? lon : null,
      location_age_seconds: age,
      max_location_age_seconds: maxAgeSeconds,
      distance_meters: hasLocation
        ? distanceMeters(Number(ticket.latitude), Number(ticket.longitude), lat, lon)
        : null,
      eligible: rejection_reasons.length === 0,
      rejection_reasons
    };
  });

  const eligible = candidates
    .filter((resolver) => resolver.eligible)
    .sort((a, b) => Number(a.distance_meters || Infinity) - Number(b.distance_meters || Infinity));

  if (eligible.length === 0) {
    await pool.query(
      `
      INSERT INTO ticket_actions (
        ticket_id,
        actor_role,
        action_type,
        description,
        metadata
      )
      VALUES ($1,'SYSTEM','NO_RESOLVER_AVAILABLE',$2,$3)
      `,
      [
        ticket.id,
        "No hay resolutores disponibles para asignación automática",
        JSON.stringify({
          reason: "NO_ELIGIBLE_RESOLVER",
          total_resolvers_in_center: candidates.length,
          excluded_resolver_user_ids: Array.from(excludeResolverUserIds),
          max_location_age_seconds: maxAgeSeconds,
          candidates: candidates.map((r) => ({
            resolver_user_id: r.id,
            resolver_name: r.full_name,
            status: r.status,
            is_active: r.is_active,
            validation_status: r.validation_status,
            active_tickets_count: r.active_tickets_count || 0,
            has_location: r.latitude != null && r.longitude != null,
            location_age_seconds: r.location_age_seconds == null ? null : Math.round(r.location_age_seconds),
            max_location_age_seconds: r.max_location_age_seconds || maxAgeSeconds,
            distance_meters: r.distance_meters == null ? null : Math.round(r.distance_meters),
            rejection_reasons: r.rejection_reasons
          }))
        })
      ]
    );

    return null;
  }

  const selected = eligible[0];

  if (force) {
    await pool.query(
      `
      UPDATE ticket_assignments
      SET state = 'SUPERSEDED', updated_at = NOW()
      WHERE ticket_id = $1
        AND state IN ('PENDING','ACCEPTED')
      `,
      [ticket.id]
    ).catch(() => null);
  }

  await pool.query(
    `
    INSERT INTO ticket_assignments (
      ticket_id,
      resolver_user_id,
      assignment_type,
      state,
      distance_meters,
      notified_at
    )
    VALUES ($1,$2,'AUTO','PENDING',$3,NOW())
    `,
    [
      ticket.id,
      selected.id,
      selected.distance_meters
    ]
  );

  const update = await pool.query(
    `
    UPDATE tickets
    SET
      assigned_resolver_id = $1,
      state = 'ASSIGNED',
      assigned_at = NOW(),
      updated_at = NOW()
    WHERE id = $2
    RETURNING *
    `,
    [
      selected.id,
      ticket.id
    ]
  );

  await pool.query(
    `
    INSERT INTO ticket_actions (
      ticket_id,
      actor_role,
      action_type,
      description,
      metadata
    )
    VALUES ($1,'SYSTEM','AUTO_ASSIGNED',$2,$3)
    `,
    [
      ticket.id,
      `Resolutor asignado automáticamente: ${selected.full_name}`,
      JSON.stringify({
        resolver_user_id: selected.id,
        resolver_name: selected.full_name,
        distance_meters: Math.round(selected.distance_meters),
        location_age_seconds: selected.location_age_seconds == null ? null : Math.round(selected.location_age_seconds),
        force
      })
    ]
  );

  return {
    ticket: update.rows[0],
    resolver: selected
  };
}

async function countActiveTicketsForResolver(resolverUserId) {
  if (!resolverUserId) return 0;
  try {
    const result = await pool.query(
      `
      SELECT COUNT(*)::int AS total
      FROM tickets
      WHERE assigned_resolver_id = $1
        AND state = ANY($2::text[])
      `,
      [resolverUserId, ACTIVE_RESOLVER_TICKET_STATES]
    );
    return Number(result.rows?.[0]?.total || 0);
  } catch (error) {
    console.warn('[COUNT ACTIVE TICKETS FOR RESOLVER ERROR]', error.message);
    return 0;
  }
}

async function assignTicketToResolverManually(ticketId, resolverUserId, options = {}) {
  const force = options.force === true;
  const operatorUserId = options.operator_user_id || options.operatorUserId || null;
  const reason = String(options.reason || '').trim() || 'Asignación manual desde mapa operacional';

  const ticketResult = await pool.query(
    `
    SELECT *
    FROM tickets
    WHERE id = $1
      AND state NOT IN ('CLOSED','CANCELLED','RESOLVED')
    LIMIT 1
    `,
    [ticketId]
  );

  if (!ticketResult.rows.length) {
    const error = new Error('Ticket no encontrado o ya cerrado');
    error.statusCode = 404;
    error.code = 'TICKET_NOT_ASSIGNABLE';
    throw error;
  }

  const ticket = ticketResult.rows[0];

  const resolverResult = await pool.query(
    `
    SELECT
      u.id,
      u.full_name,
      u.phone,
      u.role,
      u.is_active,
      u.control_center_id,
      rl.status,
      rl.latitude,
      rl.longitude,
      rl.accuracy,
      rl.updated_at,
      CASE
        WHEN rl.updated_at IS NULL THEN NULL
        ELSE EXTRACT(EPOCH FROM (NOW() - rl.updated_at))
      END AS location_age_seconds
    FROM users u
    LEFT JOIN resolver_locations rl ON rl.user_id = u.id
    WHERE u.id = $1
    LIMIT 1
    `,
    [resolverUserId]
  );

  if (!resolverResult.rows.length) {
    const error = new Error('Resolutor no encontrado');
    error.statusCode = 404;
    error.code = 'RESOLVER_NOT_FOUND';
    throw error;
  }

  const resolver = resolverResult.rows[0];

  if (resolver.role !== 'RESOLVER' || resolver.is_active !== true) {
    const error = new Error('Usuario no es un resolutor activo');
    error.statusCode = 409;
    error.code = 'RESOLVER_NOT_ACTIVE';
    throw error;
  }

  if (String(resolver.control_center_id) !== String(ticket.control_center_id)) {
    const error = new Error('El resolutor pertenece a otro centro de control');
    error.statusCode = 409;
    error.code = 'RESOLVER_CONTROL_CENTER_MISMATCH';
    throw error;
  }

  const activeTicketsCount = await countActiveTicketsForResolver(resolver.id);
  const resolverStatus = String(resolver.status || 'OFFLINE').toUpperCase();
  const hasOperationalWarning = activeTicketsCount > 0 || resolverStatus !== 'AVAILABLE';

  if (hasOperationalWarning && !force) {
    const error = new Error('El resolutor no está libre. Para asignar igualmente, use force=true.');
    error.statusCode = 409;
    error.code = 'RESOLVER_NOT_FREE_REQUIRES_FORCE';
    error.details = {
      resolver_user_id: resolver.id,
      resolver_name: resolver.full_name,
      resolver_status: resolver.status,
      active_tickets_count: activeTicketsCount
    };
    throw error;
  }

  if (ticket.assigned_resolver_id) {
    await pool.query(
      `
      UPDATE ticket_assignments
      SET state = 'SUPERSEDED', updated_at = NOW()
      WHERE ticket_id = $1
        AND state IN ('PENDING','ACCEPTED')
      `,
      [ticket.id]
    ).catch((error) => console.warn('[MANUAL ASSIGN SUPERSEDE ERROR]', error.message));
  }

  const distance = (ticket.latitude != null && ticket.longitude != null && resolver.latitude != null && resolver.longitude != null)
    ? distanceMeters(Number(ticket.latitude), Number(ticket.longitude), Number(resolver.latitude), Number(resolver.longitude))
    : null;

  await pool.query(
    `
    INSERT INTO ticket_assignments (
      ticket_id,
      resolver_user_id,
      assignment_type,
      state,
      distance_meters,
      notified_at
    )
    VALUES ($1,$2,'MANUAL','PENDING',$3,NOW())
    `,
    [ticket.id, resolver.id, distance]
  );

  const update = await pool.query(
    `
    UPDATE tickets
    SET
      assigned_resolver_id = $1,
      state = 'ASSIGNED',
      assigned_at = NOW(),
      updated_at = NOW()
    WHERE id = $2
    RETURNING *
    `,
    [resolver.id, ticket.id]
  );

  await pool.query(
    `
    UPDATE resolver_locations
    SET status = CASE WHEN status = 'ON_SITE' THEN 'ON_SITE' WHEN status = 'EN_ROUTE' THEN 'EN_ROUTE' ELSE 'BUSY' END,
        updated_at = NOW()
    WHERE user_id = $1
    `,
    [resolver.id]
  ).catch(() => null);

  const actionType = ticket.assigned_resolver_id ? 'MANUAL_REASSIGNED' : 'MANUAL_ASSIGNED';
  await pool.query(
    `
    INSERT INTO ticket_actions (
      ticket_id,
      actor_user_id,
      actor_role,
      action_type,
      description,
      metadata
    )
    VALUES ($1,$2,'OPERATOR',$3,$4,$5)
    `,
    [
      ticket.id,
      operatorUserId,
      actionType,
      `${ticket.assigned_resolver_id ? 'Ticket reasignado' : 'Ticket asignado'} manualmente a ${resolver.full_name}`,
      JSON.stringify({
        reason,
        force,
        resolver_user_id: resolver.id,
        resolver_name: resolver.full_name,
        previous_resolver_user_id: ticket.assigned_resolver_id || null,
        resolver_status: resolver.status || null,
        resolver_active_tickets_count_before: activeTicketsCount,
        distance_meters: distance == null ? null : Math.round(distance)
      })
    ]
  );

  return {
    ticket: update.rows[0],
    resolver: { ...resolver, active_tickets_count: activeTicketsCount, distance_meters: distance },
    forced: force,
    previous_resolver_user_id: ticket.assigned_resolver_id || null
  };
}

async function assignNextQueuedTicketToResolver(resolverUserId, options = {}) {
  if (!resolverUserId) return null;

  const activeTicketsCount = await countActiveTicketsForResolver(resolverUserId);
  if (activeTicketsCount > 0) {
    return { assigned: false, reason: 'RESOLVER_STILL_HAS_ACTIVE_TICKETS', active_tickets_count: activeTicketsCount };
  }

  const resolverResult = await pool.query(
    `
    SELECT
      u.id,
      u.full_name,
      u.control_center_id,
      u.is_active,
      rl.status
    FROM users u
    LEFT JOIN resolver_locations rl ON rl.user_id = u.id
    WHERE u.id = $1
      AND u.role = 'RESOLVER'
      AND u.is_active = true
    LIMIT 1
    `,
    [resolverUserId]
  );

  if (!resolverResult.rows.length) {
    return { assigned: false, reason: 'RESOLVER_NOT_ACTIVE' };
  }

  const resolver = resolverResult.rows[0];
  const resolverStatus = String(resolver.status || 'OFFLINE').toUpperCase();
  if (resolverStatus !== 'AVAILABLE') {
    return { assigned: false, reason: `RESOLVER_NOT_AVAILABLE_${resolverStatus}` };
  }

  const excludedTicketIds = (options.excludeTicketIds || options.exclude_ticket_ids || [])
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter(Boolean);

  const params = [resolver.control_center_id, resolver.id];
  let excludedSql = '';
  if (excludedTicketIds.length) {
    params.push(excludedTicketIds);
    excludedSql = `AND NOT (id = ANY($${params.length}::uuid[]))`;
  }

  const queuedTicket = await pool.query(
    `
    SELECT *
    FROM tickets
    WHERE control_center_id = $1
      AND assigned_resolver_id IS NULL
      AND state = 'ACTIVE'
      ${excludedSql}
      AND NOT EXISTS (
        SELECT 1
        FROM ticket_assignments rejected_assignments
        WHERE rejected_assignments.ticket_id = tickets.id
          AND rejected_assignments.resolver_user_id = $2
          AND UPPER(COALESCE(rejected_assignments.state,'')) = 'REJECTED'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM ticket_actions rejected_actions
        WHERE rejected_actions.ticket_id = tickets.id
          AND rejected_actions.actor_user_id = $2
          AND rejected_actions.action_type = 'RESOLVER_REJECTED'
      )
    ORDER BY created_at ASC
    LIMIT 1
    `,
    params
  );

  if (!queuedTicket.rows.length) {
    return { assigned: false, reason: 'NO_QUEUED_TICKET' };
  }

  const assignment = await assignTicketToResolverManually(queuedTicket.rows[0].id, resolver.id, {
    force: true,
    operator_user_id: null,
    reason: options.reason || 'Autoasignación de cola al quedar libre el resolutor'
  });

  await pool.query(
    `
    INSERT INTO ticket_actions (
      ticket_id,
      actor_role,
      action_type,
      description,
      metadata
    )
    VALUES ($1,'SYSTEM','AUTO_QUEUE_ASSIGNED',$2,$3)
    `,
    [
      assignment.ticket.id,
      `Ticket de cola asignado automáticamente a ${resolver.full_name}`,
      JSON.stringify({
        trigger: options.trigger || 'RESOLVER_RELEASED',
        resolver_user_id: resolver.id,
        resolver_name: resolver.full_name,
        skipped_rejected_tickets: true
      })
    ]
  ).catch(() => null);

  return { assigned: true, ...assignment };
}


let phoneLocationRequestSchemaReady = false;
async function ensurePhoneLocationRequestSchema() {
  if (phoneLocationRequestSchemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_location_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      destination_phone TEXT,
      requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      expires_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      accuracy DOUBLE PRECISION,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ticket_location_requests_ticket
    ON ticket_location_requests(ticket_id, created_at DESC)
  `);
  phoneLocationRequestSchemaReady = true;
}

function locationRequestTokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

async function createTicket({
  control_center_id,
  citizen_user_id = null,
  created_by_user_id = null,
  created_by_role = null,
  creation_description = null,
  source_type,
  source_event_id = null,
  alert_type,
  title,
  description = null,
  latitude,
  longitude,
  accuracy = null,
  priority = 3,
  metadata = {}
}) {
  const ticketResult = await pool.query(
    `
    INSERT INTO tickets (
      control_center_id,
      citizen_user_id,
      source_type,
      source_event_id,
      alert_type,
      title,
      description,
      state,
      priority,
      latitude,
      longitude,
      accuracy
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,
      'ACTIVE',
      $8,$9,$10,$11
    )
    RETURNING *
    `,
    [
      control_center_id,
      citizen_user_id,
      source_type,
      source_event_id,
      alert_type,
      title,
      description,
      priority,
      latitude,
      longitude,
      accuracy
    ]
  );

  let ticket = ticketResult.rows[0];

  ticket = await classifyAndPersistTicketSector(ticket).catch((error) => {
    console.warn('[CREATE TICKET SECTOR WARNING]', error.message);
    return ticket;
  });

  await pool.query(
    `
    INSERT INTO ticket_actions (
      ticket_id,
      actor_user_id,
      actor_role,
      action_type,
      description,
      metadata
    )
    VALUES ($1,$2,$3,$4,$5,$6)
    `,
    [
      ticket.id,
      created_by_user_id || citizen_user_id,
      created_by_role || (citizen_user_id ? "NEIGHBOR" : "SYSTEM"),
      "TICKET_CREATED",
      creation_description || "Ticket creado por alerta entrante",
      metadata
    ]
  );
const ccSettings = await getControlCenterSettingsById(control_center_id).catch(() => null);
  const settings = ccSettings?.settings || DEFAULT_CONTROL_CENTER_SETTINGS;
  if (settings.features?.resolver_auto_assignment_enabled !== false && settings.resolver_policy?.auto_assignment_enabled !== false) {
    const assignment = await autoAssignResolver(ticket);
    return assignment?.ticket || ticket;
  }

  await pool.query(
    `
    INSERT INTO ticket_actions (
      ticket_id,
      actor_role,
      action_type,
      description,
      metadata
    )
    VALUES ($1,'SYSTEM','AUTO_ASSIGNMENT_SKIPPED',$2,$3)
    `,
    [
      ticket.id,
      'Autoasignación omitida por política del centro de control',
      JSON.stringify({ policy: 'resolver_auto_assignment_enabled=false' })
    ]
  );

  return ticket;
}

async function syncMobileEventStateFromTicket(ticketId, mobileState) {
  try {
    await pool.query(
      `
      UPDATE mobile_events m
      SET
        state = $2,
        updated_at = NOW()
      FROM tickets t
      WHERE t.id = $1
        AND t.source_type = 'MOBILE_APP'
        AND t.source_event_id = m.id
      `,
      [ticketId, mobileState]
    );
  } catch (error) {
    console.warn(
      `[MOBILE EVENT SYNC WARNING] Could not sync ticket ${ticketId} to ${mobileState}:`,
      error.message
    );
  }
}


const ACTIVE_RESOLVER_TICKET_STATES = [
  "ASSIGNED",
  "ACCEPTED_BY_RESOLVER",
  "EN_ROUTE",
  "ON_SITE"
];

async function getActiveTicketsForResolver(resolverUserId) {
  const result = await pool.query(
    `
    SELECT
      id,
      state,
      title,
      alert_type,
      priority,
      created_at,
      updated_at
    FROM tickets
    WHERE assigned_resolver_id = $1
      AND state = ANY($2::text[])
    ORDER BY created_at DESC
    `,
    [resolverUserId, ACTIVE_RESOLVER_TICKET_STATES]
  );
  return result.rows || [];
}

async function releaseResolverIfNoActiveTicket(resolverUserId, options = {}) {
  if (!resolverUserId) return { released: false, reason: "NO_RESOLVER_ID" };

  const activeTickets = await getActiveTicketsForResolver(resolverUserId);
  if (activeTickets.length > 0 && !options.force) {
    return {
      released: false,
      reason: "HAS_ACTIVE_TICKET",
      active_tickets: activeTickets
    };
  }

  const targetStatus = options.status || "AVAILABLE";
  const allowedTarget = ["AVAILABLE", "OFFLINE", "BUSY"].includes(targetStatus)
    ? targetStatus
    : "AVAILABLE";

  const update = await pool.query(
    `
    UPDATE resolver_locations
    SET
      status = $2,
      updated_at = CASE WHEN $4::boolean = true THEN NOW() ELSE updated_at END
    WHERE user_id = $1
      AND (
        status IN ('BUSY','EN_ROUTE','ON_SITE')
        OR $3::boolean = true
      )
    RETURNING *
    `,
    [resolverUserId, allowedTarget, options.force === true, options.touch === true]
  );

  return {
    released: update.rows.length > 0,
    reason: update.rows.length > 0 ? "RELEASED" : "NO_STATUS_CHANGE",
    status: allowedTarget,
    resolver_location: update.rows[0] || null,
    active_tickets: activeTickets
  };
}

function isResolverOnlineFromLocation(row) {
  if (!row) return false;
  const status = String(row.status || row.resolver_status || "").toUpperCase();
  const updatedAt = row.updated_at || row.resolver_updated_at;
  if (!updatedAt) return false;
  if (status === "OFFLINE") return false;
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  return Number.isFinite(ageMs) && ageMs <= 3 * 60 * 1000;
}

async function reconcileResolverStatesForControlCenter(controlCenterId) {
  if (!controlCenterId) return { checked: 0, reconciled: 0, results: [] };

  const candidates = await pool.query(
    `
    SELECT u.id
    FROM users u
    LEFT JOIN resolver_locations rl ON rl.user_id = u.id
    WHERE u.control_center_id = $1
      AND u.role = 'RESOLVER'
      AND u.is_active = true
      AND COALESCE(rl.status, '') IN ('BUSY','EN_ROUTE','ON_SITE')
    `,
    [controlCenterId]
  );

  const results = [];
  for (const row of candidates.rows || []) {
    results.push(await reconcileResolverOperationalStatus(row.id, { touch: false }));
  }

  return {
    checked: candidates.rows.length,
    reconciled: results.filter((r) => r.reconciled).length,
    results
  };
}

async function reconcileResolverOperationalStatus(resolverUserId, options = {}) {
  const userResult = await pool.query(
    `
    SELECT
      u.id,
      u.full_name,
      u.role,
      u.is_active,
      u.control_center_id,
      cc.code AS control_center_code,
      rl.status AS resolver_status,
      rl.updated_at AS resolver_updated_at,
      rl.latitude,
      rl.longitude
    FROM users u
    JOIN control_centers cc ON cc.id = u.control_center_id
    LEFT JOIN resolver_locations rl ON rl.user_id = u.id
    WHERE u.id = $1
    LIMIT 1
    `,
    [resolverUserId]
  );

  if (!userResult.rows.length) {
    return { status: "error", message: "Resolver not found" };
  }

  const resolver = userResult.rows[0];
  if (resolver.role !== "RESOLVER") {
    return { status: "error", message: "User is not a resolver", resolver };
  }

  const activeTickets = await getActiveTicketsForResolver(resolverUserId);
  const currentStatus = String(resolver.resolver_status || "OFFLINE").toUpperCase();

  if (activeTickets.length === 0 && ["BUSY", "EN_ROUTE", "ON_SITE"].includes(currentStatus)) {
    const targetStatus = options.offline === true ? "OFFLINE" : "AVAILABLE";
    const release = await releaseResolverIfNoActiveTicket(resolverUserId, {
      force: true,
      status: targetStatus,
      touch: options.touch === true
    });
    return {
      status: "ok",
      reconciled: true,
      action: "RELEASED_STALE_RESOLVER_STATUS",
      previous_status: currentStatus,
      new_status: targetStatus,
      resolver,
      active_tickets: [],
      release
    };
  }

  return {
    status: "ok",
    reconciled: false,
    action: "NO_CHANGE_REQUIRED",
    current_status: currentStatus,
    resolver,
    active_tickets: activeTickets
  };
}

async function releaseResolverFromTicket(ticketId, reason = "TICKET_TERMINATED") {
  const ticketResult = await pool.query(
    `
    SELECT id, assigned_resolver_id, state
    FROM tickets
    WHERE id = $1
    LIMIT 1
    `,
    [ticketId]
  );

  const ticket = ticketResult.rows[0];
  if (!ticket || !ticket.assigned_resolver_id) {
    return { released: false, reason: "NO_ASSIGNED_RESOLVER" };
  }

  const release = await releaseResolverIfNoActiveTicket(ticket.assigned_resolver_id, {
    status: "AVAILABLE"
  });

  if (release.released) {
    await pool.query(
      `
      INSERT INTO ticket_actions (
        ticket_id,
        actor_role,
        action_type,
        description,
        metadata
      )
      VALUES ($1,'SYSTEM','RESOLVER_RELEASED',$2,$3)
      `,
      [
        ticketId,
        "Resolutor liberado automáticamente al finalizar/liberar el caso",
        JSON.stringify({
          reason,
          resolver_user_id: ticket.assigned_resolver_id,
          new_status: release.status
        })
      ]
    ).catch(() => null);
  }

  return release;
}



const OTP_TTL_MINUTES = Number(process.env.OTP_TTL_MINUTES || 10);
const OTP_LENGTH = Number(process.env.OTP_LENGTH || 6);
// Modo seguro por defecto: no exponer códigos en la App Vecino.
// Para laboratorio/staging, habilitar explícitamente OTP_LOG_CODES=true y revisar logs de Render.
const OTP_DEMO_MODE = process.env.OTP_DEMO_MODE === "true";
const OTP_EXPOSE_DEMO_CODE = process.env.OTP_EXPOSE_DEMO_CODE === "true";
const OTP_LOG_CODES = process.env.OTP_LOG_CODES === "true";
const OTP_REQUIRE_DELIVERY = process.env.OTP_REQUIRE_DELIVERY === "true";
const OTP_DEFAULT_CHANNEL = process.env.OTP_DEFAULT_CHANNEL || "sms";
const OTP_PROVIDER = String(process.env.OTP_PROVIDER || "internal").toLowerCase();
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID || "";

let authOtpTableReady = false;

function normalizePhoneForAuth(phone) {
  return String(phone || "").trim().replace(/\s+/g, "");
}

function normalizePhoneForProvider(phone) {
  const value = normalizePhoneForAuth(phone).replace(/[^\d+]/g, "");
  if (!value) return "";
  if (value.startsWith("+")) return value;
  if (value.startsWith("56")) return `+${value}`;
  if (value.startsWith("9") && value.length === 9) return `+56${value}`;
  return value;
}

function isTwilioVerifyOtpEnabled(channel = "sms") {
  if (OTP_PROVIDER !== "twilio_verify") return false;
  if (!["sms", "whatsapp"].includes(String(channel || "").toLowerCase())) return false;
  return Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_VERIFY_SERVICE_SID);
}

function twilioVerifyAuthHeader() {
  return `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64")}`;
}

async function postTwilioVerifyForm(pathSuffix, form) {
  const url = `https://verify.twilio.com/v2/Services/${encodeURIComponent(TWILIO_VERIFY_SERVICE_SID)}/${pathSuffix}`;
  const body = new URLSearchParams(form);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: twilioVerifyAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = data?.message || data?.raw || `Twilio Verify HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.twilio = data;
    throw error;
  }

  return data || {};
}

async function sendTwilioVerifyCode({ phone, channel }) {
  const to = normalizePhoneForProvider(phone);
  if (!to) {
    return { sent: false, channel, reason: "missing_phone" };
  }

  if (!isTwilioVerifyOtpEnabled(channel)) {
    return { sent: false, channel, reason: "twilio_verify_not_configured" };
  }

  try {
    const verification = await postTwilioVerifyForm("Verifications", {
      To: to,
      Channel: String(channel || "sms").toLowerCase()
    });

    return {
      sent: ["pending", "approved"].includes(verification.status),
      channel,
      provider: "twilio_verify",
      sid: verification.sid || null,
      to: verification.to || to,
      verification_status: verification.status || null
    };
  } catch (error) {
    console.error("[TWILIO VERIFY SEND ERROR]", {
      status: error.status || null,
      message: error.message
    });

    return {
      sent: false,
      channel,
      provider: "twilio_verify",
      status: error.status || null,
      error: error.message
    };
  }
}

async function checkTwilioVerifyCode({ phone, code, channel = "sms" }) {
  const to = normalizePhoneForProvider(phone);
  if (!to || !code) return { ok: false, reason: "invalid_or_expired" };

  if (!isTwilioVerifyOtpEnabled(channel)) {
    return { ok: false, reason: "twilio_verify_not_configured" };
  }

  try {
    const verification = await postTwilioVerifyForm("VerificationCheck", {
      To: to,
      Code: String(code || "").trim()
    });

    if (verification.status === "approved") {
      return {
        ok: true,
        provider: "twilio_verify",
        sid: verification.sid || null,
        to: verification.to || to,
        status: verification.status
      };
    }

    return {
      ok: false,
      provider: "twilio_verify",
      reason: "invalid_or_expired",
      status: verification.status || null
    };
  } catch (error) {
    console.error("[TWILIO VERIFY CHECK ERROR]", {
      status: error.status || null,
      message: error.message
    });

    return {
      ok: false,
      provider: "twilio_verify",
      reason: "invalid_or_expired",
      status: error.status || null
    };
  }
}

function generateOtpCode() {
  const digits = Math.max(4, Math.min(8, OTP_LENGTH));
  const min = 10 ** (digits - 1);
  const max = 10 ** digits - 1;

  if (typeof crypto.randomInt === "function") {
    return String(crypto.randomInt(min, max + 1));
  }

  // Fallback defensivo para runtimes Node antiguos.
  const range = max - min + 1;
  const random = crypto.randomBytes(4).readUInt32BE(0);
  return String(min + (random % range));
}

function hashOtpCode(phone, code) {
  return crypto
    .createHash("sha256")
    .update(`${normalizePhoneForAuth(phone)}:${code}:${process.env.OTP_HASH_SECRET || TOKEN}`)
    .digest("hex");
}

function resolveOtpChannel(channel, email) {
  const requested = String(channel || OTP_DEFAULT_CHANNEL || "sms").toLowerCase();

  if (["sms", "whatsapp", "email", "demo"].includes(requested)) {
    if (requested === "email" && !email) return "sms";
    if (requested === "demo" && !OTP_DEMO_MODE) return "sms";
    return requested;
  }

  return "sms";
}

async function ensureAuthOtpTable() {
  if (authOtpTableReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_otps (
      id BIGSERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      email TEXT,
      channel TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'LOGIN',
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      metadata JSONB DEFAULT '{}'::jsonb
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_auth_otps_phone_created
    ON auth_otps(phone, created_at DESC)
  `);

  authOtpTableReady = true;
}

async function sendOtpByWebhook({ url, token, payload }) {
  if (!url) return { sent: false, reason: "webhook_not_configured" };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();

  return {
    sent: response.ok,
    status: response.status,
    response: text
  };
}

async function deliverOtpCode({ phone, email, channel, code, purpose }) {
  const message = `Tu código SOS Municipal es ${code}. Vigencia ${OTP_TTL_MINUTES} minutos.`;
  const token = process.env.OTP_WEBHOOK_TOKEN || "";
  let result = { sent: false, channel, reason: "provider_not_configured" };

  try {
    if (isTwilioVerifyOtpEnabled(channel)) {
      result = await sendTwilioVerifyCode({ phone, channel });
    } else if (channel === "sms") {
      result = await sendOtpByWebhook({
        url: process.env.OTP_SMS_WEBHOOK_URL,
        token,
        payload: { to: phone, text: message, code, purpose }
      });
    } else if (channel === "whatsapp") {
      result = await sendOtpByWebhook({
        url: process.env.OTP_WHATSAPP_WEBHOOK_URL,
        token,
        payload: { to: phone, text: message, code, purpose }
      });
    } else if (channel === "email") {
      result = await sendOtpByWebhook({
        url: process.env.OTP_EMAIL_WEBHOOK_URL,
        token,
        payload: {
          to: email,
          subject: "Código SOS Municipal",
          text: message,
          code,
          purpose
        }
      });
    } else if (channel === "demo" && OTP_DEMO_MODE) {
      result = { sent: true, channel, reason: "demo_mode" };
    }
  } catch (error) {
    console.error("[OTP DELIVERY ERROR]", error.message);
    result = { sent: false, channel, error: error.message };
  }

  if ((OTP_LOG_CODES || (OTP_DEMO_MODE && OTP_EXPOSE_DEMO_CODE)) && result.provider !== "twilio_verify") {
    console.log("[OTP CODE]", {
      phone,
      email: email || null,
      channel,
      purpose,
      delivery_sent: Boolean(result.sent),
      code,
      expires_minutes: OTP_TTL_MINUTES
    });
  }

  if (result.provider === "twilio_verify") {
    console.log("[OTP TWILIO VERIFY]", {
      phone,
      channel,
      purpose,
      delivery_sent: Boolean(result.sent),
      verification_status: result.verification_status || null,
      sid: result.sid || null
    });
  }

  return result;
}

async function createAndSendOtp({ phone, email = null, channel = null, purpose = "LOGIN", metadata = {} }) {
  await ensureAuthOtpTable();

  const cleanPhone = normalizePhoneForAuth(phone);
  const selectedChannel = resolveOtpChannel(channel, email);
  const code = generateOtpCode();
  const codeHash = hashOtpCode(cleanPhone, code);

  await pool.query(
    `
    INSERT INTO auth_otps (
      phone,
      email,
      channel,
      purpose,
      code_hash,
      expires_at,
      metadata
    )
    VALUES ($1,$2,$3,$4,$5,NOW() + ($6 || ' minutes')::interval,$7)
    `,
    [
      cleanPhone,
      email || null,
      selectedChannel,
      purpose,
      codeHash,
      String(OTP_TTL_MINUTES),
      JSON.stringify(metadata || {})
    ]
  );

  const delivery = await deliverOtpCode({
    phone: cleanPhone,
    email,
    channel: selectedChannel,
    code,
    purpose
  });

  if (OTP_REQUIRE_DELIVERY && selectedChannel !== "demo" && !delivery.sent) {
    const error = new Error("No se pudo enviar el código de validación. Intenta nuevamente o contacta a la central.");
    error.code = "OTP_DELIVERY_FAILED";
    error.delivery = delivery;
    throw error;
  }

  return {
    channel: selectedChannel,
    delivery,
    demo_code: selectedChannel === "demo" && OTP_DEMO_MODE && OTP_EXPOSE_DEMO_CODE ? code : undefined,
    expires_minutes: OTP_TTL_MINUTES
  };
}

async function verifyOtpForPhone({ phone, code, purpose = null }) {
  await ensureAuthOtpTable();

  const cleanPhone = normalizePhoneForAuth(phone);
  const pendingOtpResult = await pool.query(
    `
    SELECT *
    FROM auth_otps
    WHERE phone = $1
      AND consumed_at IS NULL
      AND expires_at > NOW()
      ${purpose ? "AND purpose = $2" : ""}
    ORDER BY created_at DESC
    LIMIT 1
    `,
    purpose ? [cleanPhone, purpose] : [cleanPhone]
  );
  const pendingOtp = pendingOtpResult.rows[0] || null;

  if (pendingOtp && pendingOtp.channel !== "demo" && isTwilioVerifyOtpEnabled(pendingOtp.channel)) {
    const twilioVerification = await checkTwilioVerifyCode({
      phone: cleanPhone,
      code,
      channel: pendingOtp.channel
    });

    if (!twilioVerification.ok) {
      return {
        ok: false,
        reason: twilioVerification.reason || "invalid_or_expired",
        provider: "twilio_verify"
      };
    }

    const latestOtp = await pool.query(
      `
      SELECT *
      FROM auth_otps
      WHERE phone = $1
        AND consumed_at IS NULL
        ${purpose ? "AND purpose = $2" : ""}
      ORDER BY created_at DESC
      LIMIT 1
      `,
      purpose ? [cleanPhone, purpose] : [cleanPhone]
    );

    if (latestOtp.rows.length > 0) {
      await pool.query(
        `UPDATE auth_otps SET consumed_at = NOW() WHERE id = $1`,
        [latestOtp.rows[0].id]
      );
    }

    return {
      ok: true,
      provider: "twilio_verify",
      otp: latestOtp.rows[0] || null
    };
  }

  const codeHash = hashOtpCode(cleanPhone, String(code || "").trim());

  const result = pendingOtpResult;

  if (result.rows.length === 0) {
    return { ok: false, reason: "invalid_or_expired" };
  }

  const otp = result.rows[0];

  if (otp.attempts >= 5) {
    return { ok: false, reason: "too_many_attempts" };
  }

  if (otp.code_hash !== codeHash) {
    await pool.query(
      `UPDATE auth_otps SET attempts = attempts + 1 WHERE id = $1`,
      [otp.id]
    );

    return { ok: false, reason: "invalid_or_expired" };
  }

  await pool.query(
    `UPDATE auth_otps SET consumed_at = NOW() WHERE id = $1`,
    [otp.id]
  );

  return { ok: true, otp };
}

function publicUserPayload(user, controlCenter = null) {
  return {
    id: user.id,
    control_center_id: user.control_center_id,
    control_center_code: user.control_center_code || controlCenter?.code || null,
    control_center_name: user.control_center_name || controlCenter?.name || null,
    role: user.role,
    validation_status: user.validation_status,
    provisional_expires_at: user.provisional_expires_at || null,
    is_active: user.is_active === true,
    full_name: user.full_name,
    phone: user.phone,
    rut: user.rut,
    email: user.email,
    declared_address: user.declared_address,
    latitude: user.latitude,
    longitude: user.longitude
  };
}


function canNeighborUseSos(user) {
  if (!user) return { ok: false, reason: "Usuario no encontrado" };

  if (user.role !== "NEIGHBOR") {
    return { ok: false, reason: "El usuario no tiene perfil de vecino" };
  }

  if (user.is_active !== true) {
    return { ok: false, reason: "La cuenta está suspendida o inactiva" };
  }

  const blockedStatuses = [
    "PENDING_VERIFICATION",
    "REJECTED",
    "SUSPENDED"
  ];

  if (blockedStatuses.includes(user.validation_status)) {
    return {
      ok: false,
      reason: `El usuario no está habilitado para generar SOS (${user.validation_status})`
    };
  }

  if (user.validation_status === "PROVISIONAL_ACTIVE" && user.provisional_expires_at) {
    const expiresAt = new Date(user.provisional_expires_at).getTime();
    if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
      return {
        ok: false,
        reason: "El registro provisional expiró. Debe ser validado por la municipalidad."
      };
    }
  }

  return { ok: true };
}

async function getNeighborById(userId) {
  const result = await pool.query(
    `
    SELECT
      u.*,
      cc.code AS control_center_code,
      cc.name AS control_center_name
    FROM users u
    LEFT JOIN control_centers cc ON cc.id = u.control_center_id
    WHERE u.id = $1
    LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] || null;
}


app.get("/debug/physical-buttons", (req, res) => {
  if (!requireDebugAccess(req, res)) return;
  res.json({
    status: "ok",
    total: loadPhysicalSosButtons().length,
    buttons: loadPhysicalSosButtons()
  });
});



app.get("/", (req, res) => {
		res.json({
status: "ok",
service: "VS&TI Device Middleware",
version: "2.0-v20-central-operator-call-flow",
endpoints: [
"POST /endpoint",
"GET /devices",
"POST /sirens/command",
"POST /sirens/status",
"GET /sirens",
"GET /map/devices"
]
});
		});

app.post("/endpoint", async (req, res) => {
		if (!checkToken(req, res)) return;

		const receivedAt = nowChile();
		const messages = Array.isArray(req.body) ? req.body : [req.body];

		console.log("INCOMING DEVICE DATA");
		console.log(JSON.stringify(req.body, null, 2));

		const results = [];

		for (const msg of messages) {
		const result = await processIncomingMessage(msg, receivedAt);
		results.push(result);
		}

		res.json({
status: "ok",
message: "Device data processed",
received_at: receivedAt,
remote_ip: getRemoteIp(req),
messages_received: messages.length,
messages_forwarded: results.filter(r => r.forwarded).length,
results
});
});

app.get("/devices", (req, res) => {
		if (!checkToken(req, res)) return;

		res.json({
status: "ok",
total: Object.keys(devices).length,
devices
});
		});

app.post("/sirens/command", (req, res) => {
		if (!checkToken(req, res)) return;

		const { sirens, action, duration_seconds, source, event_id } = req.body;

		if (!Array.isArray(sirens) || sirens.length === 0) {
		return res.status(400).json({
status: "error",
message: "sirens must be a non-empty array"
});
		}

		if (!["ON", "OFF"].includes(action)) {
		return res.status(400).json({
status: "error",
message: "action must be ON or OFF"
});
		}

		const duration = Number(duration_seconds || 60);
		const expiresAt = action === "ON" ? Date.now() + duration * 1000 : Date.now();

sirens.forEach((sirenId) => {
		sirenStates[sirenId] = {
state: action,
relay: action === "ON",
event_id: event_id || null,
source: source || null,
updated_at: nowChile(),
expires_at: expiresAt
};
});

console.log("SIREN COMMAND");
console.log(JSON.stringify(req.body, null, 2));

res.json({
status: "ok",
message: "Command registered",
sirens,
action,
duration_seconds: action === "ON" ? duration : 0
});
});

app.post("/sirens/status", (req, res) => {
		if (!checkToken(req, res)) return;

		const { siren_id, relay_state, firmware, rssi, uptime } = req.body;
		console.log("[SIREN STATUS]", {
				siren_id,
				relay_state,
				firmware,
				rssi,
				uptime,
				remote_ip: getRemoteIp(req),
				received_at: nowChile()
				});

		if (!siren_id) {
		return res.status(400).json({
status: "error",
message: "siren_id is required"
});
		}

let current = sirenStates[siren_id];

if (!current || Date.now() > current.expires_at) {
	current = {
state: "OFF",
       relay: false,
       event_id: null,
       source: null,
       updated_at: nowChile(),
       expires_at: Date.now()
	};
	sirenStates[siren_id] = current;
}

current.last_seen = nowChile();
current.last_seen_ms = Date.now();
current.remote_ip = getRemoteIp(req);
current.relay_reported = relay_state ?? null;
current.firmware = firmware || null;
current.rssi = rssi ?? null;
current.uptime = uptime ?? null;

const remaining = Math.max(0, Math.ceil((current.expires_at - Date.now()) / 1000));

res.json({
status: "ok",
siren_id,
state: current.state,
relay: current.relay,
remaining_seconds: remaining,
event_id: current.event_id
});
});

app.get("/sirens", (req, res) => {
		if (!checkToken(req, res)) return;

		res.json({
status: "ok",
total: Object.keys(sirenStates).length,
sirens: sirenStates
});
		});

app.get("/map/devices", (req, res) => {
		if (!checkToken(req, res)) return;

		const now = Date.now();

		const items = Object.values(gpsDevices).map((d) => ({
					...d,
					online: true
					}));

		res.json({
status: "ok",
total: items.length,
devices: items
});
		});

const publicSirens = [
{
  id: "LAB-001",
  name: "Sirena Libertad / 6 Norte",
  latitude: -33.01775,
  longitude: -71.55105,
  location: "Av.Libertad con 6 Norte, Viña del Mar",
}
];

app.get("/public/map-state", async (req, res) => {
  if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere sesión operacional para consultar el mapa")) return;
		const now = Date.now();
    const controlCenterCode = req.query.control_center_code || 'CC-VINA';
    const settingsRow = await getControlCenterSettingsByCode(controlCenterCode);
    const platformSettings = settingsRow?.settings || DEFAULT_CONTROL_CENTER_SETTINGS;


const mobileResult = await pool.query(`
  SELECT DISTINCT ON (user_id)
    id,
    'MOBILE_SOS' AS type,
    'mobile_pwa' AS source,
    user_id,
    name,
    phone,
    latitude,
    longitude,
    accuracy,
    battery,
    state,
    acknowledged,
    acknowledged_at,
    cancelled,
    linked_ticket_id,
    created_at,
    updated_at
  FROM mobile_events
  WHERE state IN ('ACTIVE', 'ACKNOWLEDGED')
  ORDER BY user_id, created_at DESC
`);

const mobileEventsForMap = mobileResult.rows;


		let devicesForMap = Object.values(gpsDevices).map((d) => {
				let sosState = "NORMAL";

				if (d.sos_started_at && !d.sos_acknowledged) {
				const sosTime = d.sos_started_at_ms || 0;
				const elapsed = Date.now() - sosTime;

				if (elapsed <= SOS_ACTIVE_MS) {
				sosState = "ACTIVE";
				} else if (elapsed <= SOS_RECENT_MS) {
				sosState = "RECENT";
				}
				}

				return {
id: d.id,
name: d.name || (d.id === "8322560" ? "Botón SOS Piloto" : `Botón SOS ${d.id}`),
latitude: d.latitude,
longitude: d.longitude,
speed: d.speed,
direction: d.direction,
satellites: d.satellites,
valid: d.valid,
last_seen: d.last_seen,
online: true,
sos_state: sosState,
sos_active: sosState === "ACTIVE",
sos_recent: sosState === "RECENT",
sos_started_at: d.sos_started_at || null,
sos_started_at_ms: d.sos_started_at_ms || null,
sos_event_id: d.sos_event_id || null,
sos_acknowledged: d.sos_acknowledged === true,
sos_acknowledged_at: d.sos_acknowledged_at || null,
last_event_type: d.last_event_type || null
				};
		}); 








    if (settingsRow && platformSettings.features?.physical_sos_buttons_enabled !== false) {
      try {
        const registeredDevicesResult = await pool.query(
          `
          SELECT
            id,
            name,
            type,
            platform_id,
            last_latitude,
            last_longitude,
            last_seen,
            status,
            metadata,
            updated_at
          FROM devices
          WHERE control_center_id = $1
            AND type = 'PHYSICAL_SOS'
            AND COALESCE((metadata->>'enabled')::boolean, true) = true
          ORDER BY name ASC
          `,
          [settingsRow.control_center_id]
        );

        const liveKeys = new Set(devicesForMap.map((device) => String(device.id)));
        const registeredDevices = registeredDevicesResult.rows
          .filter((device) => !liveKeys.has(String(device.platform_id || device.id)))
          .map((device) => {
            const metadata = device.metadata && typeof device.metadata === 'object' ? device.metadata : {};
            return {
              id: device.platform_id || device.id,
              registry_id: device.id,
              name: device.name || `Botón SOS ${device.platform_id || device.id}`,
              type: device.type || 'PHYSICAL_SOS',
              platform_id: device.platform_id,
              latitude: device.last_latitude,
              longitude: device.last_longitude,
              last_seen: device.last_seen,
              online: String(device.status || '').toUpperCase() === 'ONLINE',
              sos_state: 'NORMAL',
              sos_active: false,
              sos_recent: false,
              last_event_type: metadata.last_event_type || null,
              battery: metadata.battery ?? null,
              phone: metadata.sim_phone || metadata.phone || null,
              registered_address: metadata.registered_address || metadata.address || null,
              metadata
            };
          });

        devicesForMap = [...devicesForMap, ...registeredDevices];
      } catch (error) {
        console.warn('[MAP STATE REGISTERED PHYSICAL DEVICES WARNING]', error.message);
      }
    }

    const configuredSirens = settingsRow
      ? await loadSirensForControlCenter(settingsRow.control_center_id, platformSettings)
      : publicSirens;

    const sirensEnabledForMap = platformSettings.features?.sirens_enabled !== false;
    const sirensSourceForMap = sirensEnabledForMap ? configuredSirens : [];

		const sirensForMap = sirensSourceForMap.map((s) => {
				const state = sirenStates[s.id] || {
state: s.state || "OFF",
relay: s.relay === true,
event_id: null,
source: null,
updated_at: s.updated_at || null,
expires_at: Date.now()
};

const expired = state.expires_at && now > state.expires_at;

return {
id: s.id,
name: s.name,
latitude: s.latitude,
longitude: s.longitude,
location: s.location,
enabled: s.enabled !== false,
activation_mode: s.activation_mode || platformSettings.siren_policy.activation_mode,
default_duration_seconds: s.default_duration_seconds || platformSettings.siren_policy.default_duration_seconds,
max_duration_seconds: s.max_duration_seconds || platformSettings.siren_policy.max_duration_seconds,
state: expired ? "OFF" : state.state,
active: !expired && state.relay === true,
event_id: expired ? null : state.event_id,
source: expired ? null : state.source,
updated_at: state.updated_at || null
};
});


res.json({
  status: "ok",
  updated_at: nowChile(),
  devices: devicesForMap,
  sirens: sirensForMap,
  mobile_events: mobileEventsForMap,
  platform_settings: publicSettingsPayload(platformSettings)
});

});

app.get("/public/control-centers/:code/settings", async (req, res) => {
  try {
    const requestedCode = req.params.code || req.query.control_center_code || 'CC-VINA';
    const row = await getControlCenterSettingsByCode(requestedCode);
    if (!row) {
      return res.status(404).json({ status: "error", message: "Centro de control no encontrado" });
    }

    return res.json({
      status: "ok",
      control_center: {
        id: row.control_center_id,
        code: row.control_center_code,
        name: row.control_center_name
      },
      platform_settings: publicSettingsPayload(row.settings)
    });
  } catch (error) {
    console.error("[PUBLIC CONTROL CENTER SETTINGS ERROR]", error);
    return res.status(500).json({ status: "error", message: error.message });
  }
});


app.post("/public/sirens/activate", async (req, res) => {
		if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere sesión operacional para activar sirenas")) return;
		const { siren_id, duration_seconds, control_center_code } = req.body;

		if (!siren_id) {
		return res.status(400).json({
status: "error",
message: "siren_id is required"
});
		}

    try {
      const authorizedCode = requestedControlCenterForSession(req, control_center_code, 'CC-VINA');
      const { settingsRow, siren } = await findSirenByIdForPublicControlCenter(siren_id, authorizedCode);
      const settings = settingsRow?.settings || DEFAULT_CONTROL_CENTER_SETTINGS;

      if (!settings.features.sirens_enabled) {
        return res.status(403).json({ status: "error", message: "Las sirenas no están habilitadas para este centro de control" });
      }

      if (!settings.siren_policy.operator_manual_control_enabled) {
        return res.status(403).json({ status: "error", message: "La activación manual de sirenas está deshabilitada por política" });
      }

      if (!siren) {
        return res.status(404).json({ status: "error", message: "Unknown siren_id" });
      }

      const maxDuration = Number(siren.max_duration_seconds || settings.siren_policy.max_duration_seconds || 180);
      const defaultDuration = Number(siren.default_duration_seconds || settings.siren_policy.default_duration_seconds || 60);
      const duration = Math.min(maxDuration, Math.max(5, Number(duration_seconds || defaultDuration)));
      const expiresAt = Date.now() + duration * 1000;

      sirenStates[siren_id] = {
        state: "ON",
        relay: true,
        event_id: `PUBLIC-MAP-${Date.now()}`,
        source: "public-map",
        updated_at: nowChile(),
        expires_at: expiresAt
      };

      await pool.query(
        `UPDATE sirens SET state='ON', relay=true, updated_at=NOW() WHERE id=$1`,
        [siren_id]
      );

      res.json({
        status: "ok",
        message: "Siren activated",
        siren_id,
        duration_seconds: duration
      });
    } catch (error) {
      console.error("[PUBLIC SIREN ACTIVATE ERROR]", error);
      res.status(500).json({ status: "error", message: error.message });
    }
});

app.post("/public/sirens/deactivate", async (req, res) => {
		if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere sesión operacional para desactivar sirenas")) return;
		const { siren_id, control_center_code } = req.body;

		if (!siren_id) {
		return res.status(400).json({
status: "error",
message: "siren_id is required"
});
		}

    try {
      const authorizedCode = requestedControlCenterForSession(req, control_center_code, 'CC-VINA');
      const { settingsRow, siren } = await findSirenByIdForPublicControlCenter(siren_id, authorizedCode);
      const settings = settingsRow?.settings || DEFAULT_CONTROL_CENTER_SETTINGS;

      if (!settings.features.sirens_enabled) {
        return res.status(403).json({ status: "error", message: "Las sirenas no están habilitadas para este centro de control" });
      }

      if (!siren) {
        return res.status(404).json({ status: "error", message: "Unknown siren_id" });
      }

      sirenStates[siren_id] = {
        state: "OFF",
        relay: false,
        event_id: `PUBLIC-MAP-OFF-${Date.now()}`,
        source: "public-map",
        updated_at: nowChile(),
        expires_at: Date.now()
		};

      await pool.query(
        `UPDATE sirens SET state='OFF', relay=false, updated_at=NOW() WHERE id=$1`,
        [siren_id]
      );

      res.json({
        status: "ok",
        message: "Siren deactivated",
        siren_id
      });
    } catch (error) {
      console.error("[PUBLIC SIREN DEACTIVATE ERROR]", error);
      res.status(500).json({ status: "error", message: error.message });
    }
});

app.post("/public/devices/ack-sos", (req, res) => {
		if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere sesión operacional para reconocer dispositivos")) return;
		const { device_id } = req.body;

		if (!device_id) {
		return res.status(400).json({
status: "error",
message: "device_id is required"
});
		}

		const id = String(device_id);
		const device = gpsDevices[id];

		if (!device) {
		return res.status(404).json({
status: "error",
message: "Unknown device_id"
});
		}

		device.sos_active = false;
device.sos_acknowledged = true;
device.sos_acknowledged_at = nowChile();
device.sos_started_at = null;
device.sos_started_at_ms = null;
device.sos_event_id = null;
device.last_event_type = "SOS_ACKNOWLEDGED";

res.json({
status: "ok",
message: "SOS acknowledged",
device_id: id,
acknowledged_at: device.sos_acknowledged_at
});
});


function safeFileExtension(mimeType, fallbackType) {
  const map = {
    "audio/webm": "webm",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "video/webm": "webm",
    "video/mp4": "mp4",
    "video/quicktime": "mov"
  };

  return map[mimeType] || (fallbackType === "video" ? "mp4" : "webm");
}

function parseDataUrl(dataUrl) {
  // Acepta data URLs simples y también con parámetros, por ejemplo:
  // data:audio/mp4;codecs=mp4a.40.2;base64,....
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/s.exec(dataUrl || "");

  if (!match) {
    return null;
  }

  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], "base64")
  };
}

function publicBaseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
}

function meetingRoomForTicket(ticketId) {
  return `VSTI-SOS-${String(ticketId).replace(/[^a-zA-Z0-9]/g, "").slice(0, 32)}`;
}

function meetingUrlForTicket(ticketId, mode = "video") {
  const room = meetingRoomForTicket(ticketId);
  const startWithVideoMuted = mode === "voice" ? "true" : "false";

  return `https://meet.jit.si/${room}#config.prejoinPageEnabled=false&config.startWithVideoMuted=${startWithVideoMuted}&config.startWithAudioMuted=false`;
}

let voiceSchemaReady = false;

async function ensureVoiceSchema() {
  if (voiceSchemaReady) return;

  await pool.query(`
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
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ticket_voice_sessions_ticket_created
    ON ticket_voice_sessions(ticket_id, created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ticket_voice_sessions_wa_center
    ON ticket_voice_sessions(wa_center_session_id)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticket_voice_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      voice_session_id UUID REFERENCES ticket_voice_sessions(id) ON DELETE SET NULL,
      ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,
      wa_center_session_id TEXT,
      provider_event_id TEXT,
      external_reference TEXT,
      event TEXT NOT NULL,
      participant_role TEXT,
      duration_seconds INTEGER,
      failure_reason TEXT,
      payload JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE ticket_voice_events ADD COLUMN IF NOT EXISTS provider_event_id TEXT`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_voice_events_provider_event
    ON ticket_voice_events(provider_event_id)
    WHERE provider_event_id IS NOT NULL
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ticket_voice_events_session_created
    ON ticket_voice_events(wa_center_session_id, created_at DESC)
  `);

  voiceSchemaReady = true;
}

function sosPublicBaseUrl(req) {
  return SOS_PUBLIC_BASE_URL || publicBaseUrl(req);
}

function normalizeVoiceStatus(event) {
  const raw = String(event || '').toUpperCase();
  if (raw === 'SESSION_CREATED') return 'CREATED';
  if (raw === 'PARTICIPANT_REGISTERED') return 'WAITING';
  if (raw === 'RINGING') return 'RINGING';
  if (raw === 'CONNECTED') return 'CONNECTED';
  if (raw === 'PARTICIPANT_DISCONNECTED') return 'ENDED';
  if (raw === 'ENDED') return 'ENDED';
  if (raw === 'REJECTED') return 'REJECTED';
  if (raw === 'FAILED') return 'FAILED';
  if (raw === 'NO_ANSWER') return 'NO_ANSWER';
  if (raw === 'EXPIRED') return 'EXPIRED';
  if (raw === 'RECORDING_AVAILABLE') return 'ENDED';
  return raw || 'UPDATED';
}

function voiceEventDescription(event, payload = {}) {
  const normalized = String(event || '').toUpperCase();
  const role = payload.participant_role ? ` (${payload.participant_role})` : '';
  const descriptions = {
    SESSION_CREATED: 'Se preparó la llamada segura',
    PARTICIPANT_REGISTERED: `Participante disponible en la llamada segura${role}`,
    RINGING: `Llamada segura sonando${role}`,
    CONNECTED: 'Llamada segura conectada',
    PARTICIPANT_DISCONNECTED: `Participante desconectado de llamada segura${role}`,
    ENDED: 'Llamada segura finalizada',
    REJECTED: 'Llamada segura rechazada',
    FAILED: 'Llamada segura fallida',
    NO_ANSWER: 'Llamada segura sin respuesta',
    EXPIRED: 'Sesión de llamada segura expirada',
    RECORDING_AVAILABLE: 'Grabación de llamada segura disponible'
  };
  return descriptions[normalized] || `Actualización de llamada segura: ${normalized || 'UPDATED'}`;
}

function sanitizeVoiceSessionRow(row, options = {}) {
  if (!row) return null;
  const includeCredentials = options.includeCredentials === true;
  const sanitizeParticipant = (value) => {
    if (!value || typeof value !== 'object') return value || null;
    if (includeCredentials) return value;
    const copy = { ...value };
    delete copy.password;
    delete copy.ha1;
    delete copy.password_hash;
    return copy;
  };

  const rawRequest = row.raw_request && typeof row.raw_request === 'object'
    ? row.raw_request
    : {};
  const recordingRequested = typeof rawRequest.record === 'boolean'
    ? rawRequest.record
    : (typeof rawRequest.recording === 'boolean' ? rawRequest.recording : null);

  return {
    id: row.id,
    ticket_id: row.ticket_id,
    mobile_event_id: row.mobile_event_id,
    requested_by: row.requested_by,
    target_type: row.target_type,
    neighbor_id: row.neighbor_id,
    resolver_user_id: row.resolver_user_id,
    operator_user_id: row.operator_user_id,
    status: row.status,
    external_reference: row.external_reference,
    wa_center_session_id: row.wa_center_session_id,
    wa_center_call_id: row.wa_center_call_id,
    wa_center_bridge_id: row.wa_center_bridge_id,
    started_at: row.started_at,
    connected_at: row.connected_at,
    ended_at: row.ended_at,
    duration_seconds: row.duration_seconds,
    failure_reason: row.failure_reason,
    recording_url: row.recording_url,
    recording_id: row.recording_id,
    // Snapshot de la política aplicada al crear esta sesión. No se deriva de
    // la configuración actual del CC porque el administrador puede cambiarla
    // después de finalizada la llamada.
    recording_requested: recordingRequested,
    created_at: row.created_at,
    updated_at: row.updated_at,
    party_a_webrtc: sanitizeParticipant(row.party_a_webrtc),
    party_b_webrtc: sanitizeParticipant(row.party_b_webrtc)
  };
}

function voiceSessionForParticipant(session, role) {
  if (!session) return null;
  const selectedRole = role === 'party_b' ? 'party_b' : 'party_a';
  const webrtc = selectedRole === 'party_b' ? session.party_b_webrtc : session.party_a_webrtc;
  const safeSession = { ...session };
  delete safeSession.party_a_webrtc;
  delete safeSession.party_b_webrtc;
  return {
    ...safeSession,
    participant_role: selectedRole,
    webrtc: webrtc || null
  };
}

function voiceParticipantForRequester({ requestedBy, targetType }) {
  const requester = String(requestedBy || '').toUpperCase();
  if (requester === 'NEIGHBOR') return 'party_a';
  return 'party_b';
}

function operatorCanHandleVoiceSession(session, ticket = null) {
  if (!session) return false;
  const requestedBy = String(session.requested_by || '').toUpperCase();
  const targetType = String(session.target_type || '').toUpperCase();
  const hasResolver = Boolean(ticket?.assigned_resolver_id || ticket?.resolver_id);
  return requestedBy === 'NEIGHBOR' && (targetType === 'CENTRAL' || (!hasResolver && targetType !== 'RESOLVER'));
}

async function getVoiceSessionForTicket(ticketId, sessionId = 'latest', options = {}) {
  await ensureVoiceSchema();
  const latest = !sessionId || String(sessionId).toLowerCase() === 'latest';
  const params = latest ? [ticketId] : [ticketId, sessionId];
  const query = latest
    ? `
      SELECT *
      FROM ticket_voice_sessions
      WHERE ticket_id = $1
        AND status NOT IN ('FAILED','ENDED','EXPIRED','NO_ANSWER','REJECTED')
      ORDER BY created_at DESC
      LIMIT 1
      `
    : `
      SELECT *
      FROM ticket_voice_sessions
      WHERE ticket_id = $1
        AND (id::text = $2 OR wa_center_session_id = $2)
      ORDER BY created_at DESC
      LIMIT 1
      `;

  const result = await pool.query(query, params);
  return result.rows[0] ? sanitizeVoiceSessionRow(result.rows[0], options) : null;
}

async function getVoiceSessionsForTicket(ticketId, options = {}) {
  if (!ticketId) return [];
  await ensureVoiceSchema();

  const result = await pool.query(
    `
    SELECT *
    FROM ticket_voice_sessions
    WHERE ticket_id = $1
    ORDER BY created_at DESC
    LIMIT $2
    `,
    [ticketId, Math.min(Number(options.limit || 10), 50)]
  );

  return result.rows.map((row) => sanitizeVoiceSessionRow(row, options));
}

async function fetchTicketVoiceContext(ticketId) {
  const result = await pool.query(
    `
    SELECT
      t.*,
      cc.code AS control_center_code,
      cc.name AS control_center_name,
      citizen.id AS citizen_id,
      citizen.full_name AS citizen_name,
      citizen.phone AS citizen_phone,
      resolver.id AS resolver_id,
      resolver.full_name AS resolver_name,
      resolver.phone AS resolver_phone
    FROM tickets t
    JOIN control_centers cc ON cc.id = t.control_center_id
    LEFT JOIN users citizen ON citizen.id = t.citizen_user_id
    LEFT JOIN users resolver ON resolver.id = t.assigned_resolver_id
    WHERE t.id = $1
    LIMIT 1
    `,
    [ticketId]
  );

  return result.rows[0] || null;
}

async function callWaCenterCreateVoiceSession(payload) {
  if (!WA_CENTER_VOICE_ENABLED) {
    const err = new Error('El servicio de llamadas no está habilitado en este ambiente.');
    err.code = 'WA_CENTER_VOICE_DISABLED';
    throw err;
  }

  if (!WA_CENTER_BASE_URL || !WA_CENTER_API_TOKEN) {
    const err = new Error('El servicio de llamadas no está configurado.');
    err.code = 'WA_CENTER_VOICE_NOT_CONFIGURED';
    throw err;
  }

  const response = await fetch(`${WA_CENTER_BASE_URL}/voice/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${WA_CENTER_API_TOKEN}`
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!response.ok || data?.ok === false) {
    const err = new Error(data?.message || data?.error || `Servicio de llamadas HTTP ${response.status}`);
    err.code = 'WA_CENTER_CREATE_FAILED';
    err.status = response.status;
    err.response = data;
    throw err;
  }

  return data;
}

const VOICE_TERMINAL_STATUSES = new Set(['ENDED', 'FAILED', 'NO_ANSWER', 'EXPIRED', 'REJECTED']);
const VOICE_NO_ANSWER_TIMEOUT_MS = 45_000;

function isVoiceTerminalStatus(status) {
  return VOICE_TERMINAL_STATUSES.has(String(status || '').toUpperCase());
}

async function callWaCenterVoiceAction(session, action) {
  if (!WA_CENTER_VOICE_ENABLED) {
    const err = new Error('El servicio de llamadas no está habilitado en este ambiente.');
    err.code = 'WA_CENTER_VOICE_DISABLED';
    throw err;
  }

  if (!WA_CENTER_BASE_URL || !WA_CENTER_API_TOKEN) {
    const err = new Error('El servicio de llamadas no está configurado.');
    err.code = 'WA_CENTER_VOICE_NOT_CONFIGURED';
    throw err;
  }

  const waSessionId = session?.wa_center_session_id;
  if (!waSessionId) {
    const err = new Error('La llamada no está disponible para finalizar.');
    err.code = 'WA_CENTER_SESSION_ID_MISSING';
    throw err;
  }

  const normalizedAction = action === 'end' ? 'end' : 'revoke';
  const response = await fetch(
    `${WA_CENTER_BASE_URL}/voice/sessions/${encodeURIComponent(waSessionId)}/${normalizedAction}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WA_CENTER_API_TOKEN}`
      },
      body: JSON.stringify({})
    }
  );

  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  // Una sesión que el proveedor ya cerró cumple el objetivo de una limpieza idempotente.
  if (!response.ok && ![404, 409, 410].includes(response.status)) {
    const err = new Error(data?.message || data?.error || `Servicio de llamadas HTTP ${response.status}`);
    err.code = 'WA_CENTER_FINALIZE_FAILED';
    err.status = response.status;
    err.response = data;
    throw err;
  }

  return data;
}

async function finalizeTicketVoiceSession({
  session,
  outcome = 'ENDED',
  actorRole = 'SYSTEM',
  actorUserId = null,
  reason = null
}) {
  if (!session?.id) {
    const err = new Error('Voice session not found');
    err.statusCode = 404;
    throw err;
  }

  const currentStatus = String(session.status || '').toUpperCase();
  if (isVoiceTerminalStatus(currentStatus)) return session;

  const normalizedOutcome = VOICE_TERMINAL_STATUSES.has(String(outcome).toUpperCase())
    ? String(outcome).toUpperCase()
    : 'ENDED';
  const action = currentStatus === 'CONNECTED' || session.connected_at ? 'end' : 'revoke';

  await callWaCenterVoiceAction(session, action);

  const updated = await pool.query(
    `
    UPDATE ticket_voice_sessions
    SET
      status = $2,
      ended_at = COALESCE(ended_at, NOW()),
      failure_reason = CASE WHEN $3::text IS NULL THEN failure_reason ELSE $3 END,
      updated_at = NOW()
    WHERE id = $1
      AND status NOT IN ('ENDED','FAILED','NO_ANSWER','EXPIRED','REJECTED')
    RETURNING *
    `,
    [session.id, normalizedOutcome, reason]
  );

  if (updated.rows.length === 0) {
    return getVoiceSessionForTicket(session.ticket_id, session.id, { includeCredentials: false });
  }

  const eventName = normalizedOutcome;
  await pool.query(
    `
    INSERT INTO ticket_voice_events (
      voice_session_id,
      ticket_id,
      wa_center_session_id,
      external_reference,
      event,
      failure_reason,
      payload
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    `,
    [
      session.id,
      session.ticket_id,
      session.wa_center_session_id,
      session.external_reference,
      eventName,
      reason,
      JSON.stringify({ source: 'sos_lifecycle', action, outcome: normalizedOutcome, reason })
    ]
  );

  await pool.query(
    `
    INSERT INTO ticket_actions (
      ticket_id,
      actor_user_id,
      actor_role,
      action_type,
      description,
      metadata
    )
    VALUES ($1,$2,$3,$4,$5,$6)
    `,
    [
      session.ticket_id,
      actorUserId,
      actorRole,
      `VOICE_${normalizedOutcome}`,
      voiceEventDescription(eventName, { failure_reason: reason }),
      JSON.stringify({
        provider: 'wa_center',
        voice_session_id: session.id,
        wa_center_session_id: session.wa_center_session_id,
        action,
        outcome: normalizedOutcome,
        reason
      })
    ]
  );

  return sanitizeVoiceSessionRow(updated.rows[0], { includeCredentials: false });
}

function scheduleVoiceNoAnswerTimeout(session) {
  if (!session?.id || !session?.ticket_id) return;

  const timer = setTimeout(async () => {
    try {
      const latest = await getVoiceSessionForTicket(session.ticket_id, session.id, { includeCredentials: false });
      if (!latest || isVoiceTerminalStatus(latest.status)) return;

      if (String(latest.status).toUpperCase() === 'CONNECTED') {
        const confirmation = await pool.query(
          `
          SELECT
            EXISTS (
              SELECT 1
              FROM ticket_voice_events
              WHERE voice_session_id = $1
                AND event = 'CONNECTED'
                AND participant_role IS NULL
            ) AS session_connected,
            (
              SELECT COUNT(DISTINCT participant_role)
              FROM ticket_voice_events
              WHERE voice_session_id = $1
                AND event IN ('PARTICIPANT_REGISTERED','CONNECTED')
                AND participant_role IS NOT NULL
            )::int AS participant_count,
            EXISTS (
              SELECT 1
              FROM ticket_actions
              WHERE ticket_id = $2
                AND action_type = 'VOICE_ACCEPTED'
                AND metadata->>'voice_session_id' = $1::text
            ) AS accepted
          `,
          [latest.id, latest.ticket_id]
        );
        const accepted = String(latest.requested_by || '').toUpperCase() !== 'NEIGHBOR' ||
          confirmation.rows[0]?.accepted === true;
        const fullyConnected = accepted && (
          confirmation.rows[0]?.session_connected === true ||
          Number(confirmation.rows[0]?.participant_count || 0) >= 2
        );
        if (fullyConnected) return;
      }

      await finalizeTicketVoiceSession({
        session: latest,
        outcome: 'NO_ANSWER',
        actorRole: 'SYSTEM',
        reason: 'Tiempo de espera agotado (45 segundos)'
      });
    } catch (error) {
      console.error('[VOICE NO ANSWER TIMEOUT ERROR]', error);
    }
  }, VOICE_NO_ANSWER_TIMEOUT_MS);

  if (typeof timer.unref === 'function') timer.unref();
}

async function resolveWebhookVoiceStatus(session, normalizedStatus, payload = {}) {
  const currentStatus = String(session?.status || 'CREATED').toUpperCase();
  if (isVoiceTerminalStatus(currentStatus)) return currentStatus;

  if (normalizedStatus === 'CONNECTED' &&
      String(session?.requested_by || '').toUpperCase() === 'NEIGHBOR') {
    const acceptance = await pool.query(
      `
      SELECT 1
      FROM ticket_actions
      WHERE ticket_id = $1
        AND action_type = 'VOICE_ACCEPTED'
        AND metadata->>'voice_session_id' = $2
      LIMIT 1
      `,
      [session.ticket_id, String(session.id)]
    );

    // Entrar al bridge no equivale a que Central/Resolutor haya contestado.
    if (acceptance.rows.length === 0) return 'RINGING';
  }

  const participantRole = payload.participant_role || null;
  if (participantRole && ['WAITING', 'CONNECTED'].includes(normalizedStatus)) {
    const participants = await pool.query(
      `
      SELECT COUNT(DISTINCT participant_role)::int AS participant_count
      FROM ticket_voice_events
      WHERE voice_session_id = $1
        AND event IN ('PARTICIPANT_REGISTERED','CONNECTED')
        AND participant_role IS NOT NULL
      `,
      [session.id]
    );

    // Un solo anexo dentro del bridge sigue siendo una llamada sonando.
    if (Number(participants.rows[0]?.participant_count || 0) < 2) return 'RINGING';
    return 'CONNECTED';
  }

  // Los webhooks pueden llegar fuera de orden; nunca retroceder desde CONNECTED.
  if (currentStatus === 'CONNECTED' && ['CREATED', 'WAITING', 'RINGING'].includes(normalizedStatus)) {
    return 'CONNECTED';
  }

  return normalizedStatus;
}

async function registerVoiceParticipantConnected(session, participantRole) {
  const role = String(participantRole || '').toUpperCase();
  if (!session?.id || !['NEIGHBOR', 'RESOLVER', 'OPERATOR'].includes(role)) {
    const err = new Error('Invalid voice participant');
    err.statusCode = 400;
    throw err;
  }
  if (isVoiceTerminalStatus(session.status)) return session;

  await pool.query(
    `
    INSERT INTO ticket_voice_events (
      voice_session_id,
      ticket_id,
      wa_center_session_id,
      external_reference,
      event,
      participant_role,
      payload
    )
    SELECT $1,$2,$3,$4,'CONNECTED',$5,$6
    WHERE NOT EXISTS (
      SELECT 1
      FROM ticket_voice_events
      WHERE voice_session_id = $1
        AND event = 'CONNECTED'
        AND participant_role = $5
    )
    `,
    [
      session.id,
      session.ticket_id,
      session.wa_center_session_id,
      session.external_reference,
      role,
      JSON.stringify({ source: 'client_bridge_confirmation', participant_role: role })
    ]
  );

  const confirmation = await pool.query(
    `
    SELECT
      (
        SELECT COUNT(DISTINCT participant_role)
        FROM ticket_voice_events
        WHERE voice_session_id = $1
          AND event = 'CONNECTED'
          AND participant_role IS NOT NULL
      )::int AS participant_count,
      EXISTS (
        SELECT 1
        FROM ticket_actions
        WHERE ticket_id = $2
          AND action_type = 'VOICE_ACCEPTED'
          AND metadata->>'voice_session_id' = $1::text
      ) AS accepted
    `,
    [session.id, session.ticket_id]
  );

  const accepted = String(session.requested_by || '').toUpperCase() !== 'NEIGHBOR' ||
    confirmation.rows[0]?.accepted === true;
  const connected = accepted && Number(confirmation.rows[0]?.participant_count || 0) >= 2;
  const updated = await pool.query(
    `
    UPDATE ticket_voice_sessions
    SET status = CASE WHEN $2 THEN 'CONNECTED' ELSE 'RINGING' END,
        connected_at = CASE WHEN $2 THEN COALESCE(connected_at, NOW()) ELSE connected_at END,
        updated_at = NOW()
    WHERE id = $1
      AND status NOT IN ('ENDED','FAILED','NO_ANSWER','EXPIRED','REJECTED')
    RETURNING *
    `,
    [session.id, connected]
  );

  return sanitizeVoiceSessionRow(updated.rows[0] || session, { includeCredentials: false });
}

let voiceMaintenanceStarted = false;

function startVoiceSessionMaintenance() {
  if (voiceMaintenanceStarted) return;
  voiceMaintenanceStarted = true;

  const sweep = async () => {
    try {
      await ensureVoiceSchema();
      const stale = await pool.query(
        `
        SELECT tvs.*
        FROM ticket_voice_sessions tvs
        WHERE tvs.status NOT IN ('ENDED','FAILED','NO_ANSWER','EXPIRED','REJECTED')
          AND (
            (
              tvs.status <> 'CONNECTED'
              AND tvs.created_at < NOW() - INTERVAL '45 seconds'
            )
            OR (
              tvs.status = 'CONNECTED'
              AND tvs.created_at < NOW() - INTERVAL '45 seconds'
              AND (
                (
                  tvs.requested_by = 'NEIGHBOR'
                  AND NOT EXISTS (
                    SELECT 1
                    FROM ticket_actions ta
                    WHERE ta.ticket_id = tvs.ticket_id
                      AND ta.action_type = 'VOICE_ACCEPTED'
                      AND ta.metadata->>'voice_session_id' = tvs.id::text
                  )
                )
                OR (
                  NOT EXISTS (
                    SELECT 1
                    FROM ticket_voice_events tve
                    WHERE tve.voice_session_id = tvs.id
                      AND tve.event = 'CONNECTED'
                      AND tve.participant_role IS NULL
                  )
                  AND (
                    SELECT COUNT(DISTINCT tve.participant_role)
                    FROM ticket_voice_events tve
                    WHERE tve.voice_session_id = tvs.id
                      AND tve.event IN ('PARTICIPANT_REGISTERED','CONNECTED')
                      AND tve.participant_role IS NOT NULL
                  ) < 2
                )
              )
            )
            OR (
              tvs.status = 'CONNECTED'
              AND tvs.updated_at < NOW() - INTERVAL '20 minutes'
            )
          )
        ORDER BY tvs.created_at ASC
        LIMIT 50
        `
      );

      for (const row of stale.rows) {
        await finalizeTicketVoiceSession({
          session: sanitizeVoiceSessionRow(row, { includeCredentials: false }),
          outcome: String(row.status).toUpperCase() === 'CONNECTED' ? 'ENDED' : 'NO_ANSWER',
          actorRole: 'SYSTEM',
          reason: 'VOICE_SESSION_MAINTENANCE'
        }).catch((error) => {
          console.error('[VOICE SESSION MAINTENANCE FINALIZE ERROR]', error);
        });
      }
    } catch (error) {
      console.error('[VOICE SESSION MAINTENANCE ERROR]', error);
    }
  };

  const initial = setTimeout(sweep, 5_000);
  const interval = setInterval(sweep, 30_000);
  if (typeof initial.unref === 'function') initial.unref();
  if (typeof interval.unref === 'function') interval.unref();
}

startVoiceSessionMaintenance();

async function createTicketVoiceSession({ req, ticket, requestedBy, targetType, actorUserId = null, resolverUserId = null }) {
  await ensureVoiceSchema();

  if (!ticket?.id) {
    const err = new Error('Ticket not found');
    err.statusCode = 404;
    throw err;
  }

  const terminal = ['RESOLVED', 'CLOSED', 'CANCELLED'];
  if (terminal.includes(String(ticket.state || '').toUpperCase())) {
    const err = new Error('No se puede iniciar llamada segura para un ticket cerrado.');
    err.statusCode = 409;
    throw err;
  }

  const settingsRow = await getControlCenterSettingsById(ticket.control_center_id).catch(() => null);
  const platformSettings = settingsRow?.settings || DEFAULT_CONTROL_CENTER_SETTINGS;

  if (platformSettings.features?.secure_voice_enabled === false) {
    const err = new Error('Las llamadas seguras no están habilitadas para este centro de control.');
    err.code = 'SECURE_VOICE_DISABLED_BY_POLICY';
    err.statusCode = 403;
    throw err;
  }

  const externalReference = `sos-ticket-${ticket.id}`;
  const normalizedTargetType = String(targetType || '').toUpperCase();

  // Contrato del proveedor de voz:
  // - SOS conserva toda la lógica del caso/ticket.
  // - El proveedor solo ve una referencia externa y participantes genéricos.
  // - party_a queda reservado para Vecino.
  // - party_b queda reservado para Central/Operador o Resolutor.
  const partyALabel = 'vecino';
  const partyBLabel = normalizedTargetType === 'RESOLVER' || String(requestedBy).toUpperCase() === 'RESOLVER'
    ? 'resolutor'
    : 'central';

  const payload = {
    external_reference: externalReference,
    mode: 'BRIDGE',
    expires_in_seconds: Math.max(60, Number(platformSettings.voice_policy?.expires_minutes || 15) * 60),
    record: platformSettings.voice_policy?.recording_enabled !== false,
    supervision: platformSettings.voice_policy?.supervision_enabled !== false,
    participants: [
      { role: 'party_a', type: 'webrtc', label: partyALabel },
      { role: 'party_b', type: 'webrtc', label: partyBLabel }
    ],
    // Los tokens WA-Center restringidos usan el webhook global configurado en
    // el proveedor y rechazan overrides por sesión. La opción queda disponible
    // solo para instalaciones antiguas que lo permitan explícitamente.
    ...(WA_CENTER_CALLBACK_URL_OVERRIDE
      ? { callback_url: `${sosPublicBaseUrl(req)}/integrations/wa-center/voice-events` }
      : {})
  };

  const insertResult = await pool.query(
    `
    INSERT INTO ticket_voice_sessions (
      ticket_id,
      mobile_event_id,
      requested_by,
      target_type,
      neighbor_id,
      resolver_user_id,
      operator_user_id,
      external_reference,
      status,
      party_a_role,
      party_b_role,
      raw_request
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'REQUESTED','party_a','party_b',$9)
    RETURNING *
    `,
    [
      ticket.id,
      ticket.source_type === 'MOBILE_APP' ? ticket.source_event_id : null,
      requestedBy,
      normalizedTargetType,
      ticket.citizen_user_id || ticket.citizen_id || null,
      resolverUserId || ticket.assigned_resolver_id || ticket.resolver_id || null,
      requestedBy === 'OPERATOR' ? actorUserId : null,
      externalReference,
      JSON.stringify(payload)
    ]
  );

  const localSession = insertResult.rows[0];

  try {
    const waResponse = await callWaCenterCreateVoiceSession(payload);
    const participantA = Array.isArray(waResponse.participants) ? waResponse.participants.find(p => p.role === 'party_a') : null;
    const participantB = Array.isArray(waResponse.participants) ? waResponse.participants.find(p => p.role === 'party_b') : null;

    const updated = await pool.query(
      `
      UPDATE ticket_voice_sessions
      SET
        wa_center_session_id = $2,
        status = COALESCE($3, 'CREATED'),
        party_a_webrtc = $4,
        party_b_webrtc = $5,
        raw_response = $6,
        started_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [
        localSession.id,
        waResponse.session_id || null,
        waResponse.status || 'CREATED',
        JSON.stringify(participantA || {}),
        JSON.stringify(participantB || {}),
        JSON.stringify(waResponse || {})
      ]
    );

    await pool.query(
      `
      INSERT INTO ticket_actions (
        ticket_id,
        actor_user_id,
        actor_role,
        action_type,
        description,
        metadata
      )
      VALUES ($1,$2,$3,'CALL_VOICE',$4,$5)
      `,
      [
        ticket.id,
        actorUserId,
        requestedBy,
        requestedBy === 'NEIGHBOR'
          ? 'Vecino solicitó llamada segura'
          : requestedBy === 'RESOLVER'
            ? 'Resolutor solicitó llamada segura con el vecino'
            : 'Central solicitó llamada segura con el vecino',
        JSON.stringify({
          channel: 'voice',
          provider: 'wa_center',
          target_type: normalizedTargetType,
          requested_by: requestedBy,
          voice_session_id: localSession.id,
          wa_center_session_id: waResponse.session_id || null,
          external_reference: externalReference,
          status: waResponse.status || 'CREATED'
        })
      ]
    );

    await pool.query(`UPDATE tickets SET updated_at = NOW() WHERE id = $1`, [ticket.id]);

    const createdSession = sanitizeVoiceSessionRow(updated.rows[0], { includeCredentials: true });
    scheduleVoiceNoAnswerTimeout(createdSession);
    return createdSession;
  } catch (error) {
    await pool.query(
      `
      UPDATE ticket_voice_sessions
      SET status = 'FAILED', failure_reason = $2, raw_response = $3, updated_at = NOW()
      WHERE id = $1
      `,
      [localSession.id, error.message, JSON.stringify(error.response || { message: error.message, code: error.code || null })]
    );

    await pool.query(
      `
      INSERT INTO ticket_actions (
        ticket_id,
        actor_user_id,
        actor_role,
        action_type,
        description,
        metadata
      )
      VALUES ($1,$2,$3,'CALL_REJECTED',$4,$5)
      `,
      [
        ticket.id,
        actorUserId,
        requestedBy,
        'No fue posible crear la llamada segura',
        JSON.stringify({
          channel: 'voice',
          provider: 'wa_center',
          target_type: normalizedTargetType,
          requested_by: requestedBy,
          voice_session_id: localSession.id,
          error: error.message,
          code: error.code || null
        })
      ]
    );

    throw error;
  }
}


function normalizeMobileSosPayload(reqBody = {}) {
  const rawType = String(reqBody.alert_type || "SOS_MANUAL").toUpperCase();

  const definitions = {
    SOS_MANUAL: {
      alert_type: "SOS_MANUAL",
      title: "SOS móvil",
      description: "Alerta SOS generada desde aplicación móvil",
      priority: 1
    },
    VIF: {
      alert_type: "VIF",
      title: "Violencia Intrafamiliar",
      description: "Alerta de violencia intrafamiliar generada desde aplicación móvil",
      priority: 1
    },
    VIF_SILENT_SHAKE: {
      alert_type: "VIF_SILENT_SHAKE",
      title: "Alerta silenciosa VIF",
      description: "Alerta silenciosa generada por triple agitación del teléfono. No llamar automáticamente; evaluar contacto discreto.",
      priority: 1
    },
    FALL_DETECTED: {
      alert_type: "FALL_DETECTED",
      title: "Posible caída / emergencia médica",
      description: "Evento generado por detección de caída o impacto fuerte del teléfono, sin cancelación del usuario.",
      priority: 1
    },
    MEDICAL: {
      alert_type: "MEDICAL",
      title: "Emergencia médica",
      description: "Emergencia médica reportada desde aplicación móvil",
      priority: 1
    },
    FIRE: {
      alert_type: "FIRE",
      title: "Incendio",
      description: "Incendio reportado desde aplicación móvil",
      priority: 1
    },
    SECURITY: {
      alert_type: "SECURITY",
      title: "Seguridad ciudadana",
      description: "Evento de seguridad reportado desde aplicación móvil",
      priority: 2
    }
  };

  const base = definitions[rawType] || {
    alert_type: rawType,
    title: reqBody.title || "SOS móvil",
    description: reqBody.description || "Alerta generada desde aplicación móvil",
    priority: Number(reqBody.priority || 1)
  };

  return {
    ...base,
    title: reqBody.title || base.title,
    description: reqBody.description || base.description,
    priority: Number(reqBody.priority || base.priority || 1),
    sensor_event_type: reqBody.sensor_event_type || null,
    silent: reqBody.silent === true,
    confidence: reqBody.confidence || null
  };
}

app.post("/public/mobile/sos", async (req, res) => {
  try {
    const {
      user_id,
      name,
      phone,
      latitude,
      longitude,
      accuracy,
      battery,
      source,
      alert_type = "SOS_MANUAL",
      title,
      priority = 1,
      description,
      sensor_event_type,
      silent,
      confidence,
      qr_context,
      control_center_code = "CC-VINA"
    } = req.body;

    if (!checkIdentityAccess(req, res, ["NEIGHBOR", "ADMIN", "SUPER_ADMIN"], user_id, "Sesión de vecino requerida para generar SOS")) return;

    if (!user_id) {
      return res.status(400).json({
        status: "error",
        message: "user_id is required"
      });
    }

    if (latitude == null || longitude == null) {
      return res.status(400).json({
        status: "error",
        message: "latitude and longitude are required"
      });
    }

    const latNum = Number(latitude);
    const lonNum = Number(longitude);
    const accuracyNum = accuracy == null || accuracy === "" ? null : Number(accuracy);

    if (!Number.isFinite(latNum) || !Number.isFinite(lonNum) || Math.abs(latNum) > 90 || Math.abs(lonNum) > 180) {
      return res.status(400).json({
        status: "error",
        message: "Coordenadas GPS inválidas"
      });
    }

    const maxAccuracy = maxResolverGpsAccuracyMeters();
    if (accuracyNum != null && Number.isFinite(accuracyNum) && accuracyNum > maxAccuracy) {
      return res.status(422).json({
        status: "error",
        code: "LOW_ACCURACY_GPS",
        message: `Ubicación demasiado imprecisa (${Math.round(accuracyNum)} m). No se actualizó la posición del resolutor.`,
        accuracy: accuracyNum,
        max_accuracy_meters: maxAccuracy
      });
    }

    await ensureNeighborProvisioningSchema();

    const userResult = await pool.query(
      `
      SELECT
        u.id,
        u.control_center_id,
        u.role,
        u.validation_status,
        u.provisional_expires_at,
        u.is_active,
        u.full_name,
        u.phone,
        u.declared_address,
        cc.code AS control_center_code,
        cc.name AS control_center_name,
        cc.boundary_geojson,
        cc.geofence_buffer_meters,
        cc.map_center_lat,
        cc.map_center_lon,
        cc.map_zoom
      FROM users u
      LEFT JOIN control_centers cc ON cc.id = u.control_center_id
      WHERE u.id = $1
      LIMIT 1
      `,
      [user_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(403).json({
        status: "error",
        message: "El vecino debe estar registrado y autenticado para generar SOS"
      });
    }

    const citizen = userResult.rows[0];
    const sosPermission = canNeighborUseSos(citizen);

    if (!sosPermission.ok) {
      return res.status(403).json({
        status: "error",
        message: sosPermission.reason,
        validation_status: citizen.validation_status,
        is_active: citizen.is_active === true
      });
    }

    const controlCenterId = citizen.control_center_id;
    const citizenUserId = citizen.id;

    if (!controlCenterId) {
      return res.status(400).json({
        status: "error",
        message: "El vecino no tiene centro de control asignado"
      });
    }

    await ensureGeofenceSchema();
    await ensureIncidentAggregationSchema();
    const jurisdiction = evaluateJurisdiction(citizen, Number(latitude), Number(longitude));

    if (!jurisdiction.valid) {
      await pool.query(
        `
        UPDATE mobile_events
        SET
          state = 'CANCELLED',
          cancelled = true,
          cancelled_at = NOW(),
          updated_at = NOW()
        WHERE user_id = $1
          AND state = 'ACTIVE'
        `,
        [user_id]
      );

      const rejectedEventId = `MOBILE-SOS-${user_id}-${Date.now()}`;
      const rejectedEvent = await pool.query(
        `
        INSERT INTO mobile_events (
          id,
          user_id,
          name,
          phone,
          latitude,
          longitude,
          accuracy,
          battery,
          state,
          acknowledged,
          cancelled,
          jurisdiction_status,
          jurisdiction_reason
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OUT_OF_JURISDICTION',false,true,$9,$10)
        RETURNING *
        `,
        [
          rejectedEventId,
          user_id,
          citizen.full_name || name || "Usuario movil",
          citizen.phone || phone || null,
          Number(latitude),
          Number(longitude),
          accuracy ?? null,
          battery ?? null,
          jurisdiction.status,
          jurisdiction.reason
        ]
      );

      return res.status(422).json({
        status: "out_of_jurisdiction",
        message: "Tu alerta fue recibida, pero estás fuera del territorio cubierto por tu Municipalidad. En caso de emergencia real, contacta a los servicios de emergencia locales.",
        event_id: rejectedEvent.rows[0].id,
        ticket_id: null,
        jurisdiction,
        user: publicUserPayload(citizen)
      });
    }

    const normalizedAlert = normalizeMobileSosPayload({
      alert_type,
      title,
      priority,
      description,
      sensor_event_type,
      silent,
      confidence,
      source
    });

    const settingsRow = await getControlCenterSettingsById(controlCenterId);
    const platformSettings = settingsRow?.settings || DEFAULT_CONTROL_CENTER_SETTINGS;

    if (platformSettings.features?.mobile_app_enabled === false) {
      return res.status(403).json({
        status: "error",
        message: "La App Vecino no está habilitada para este centro de control."
      });
    }

    if (!isNeighborEmergencyCategoryEnabled(platformSettings, normalizedAlert.alert_type)) {
      return res.status(403).json({
        status: "error",
        message: "Esta categoría no está habilitada para tu Centro de Control."
      });
    }

    await ensureMunicipalQrSchema();
    let qrAttribution = null;
    if (qr_context && typeof qr_context === 'object' && qr_context.code) {
      const qrResult = await pool.query(
        `SELECT q.id, q.code, q.name, q.latitude, q.longitude, q.control_center_id,
                v.id AS visit_id
         FROM municipal_qr_points q
         LEFT JOIN municipal_qr_visits v ON v.id = $2 AND v.qr_point_id = q.id
         WHERE q.code = $1 AND q.enabled = true AND q.control_center_id = $3
         LIMIT 1`,
        [String(qr_context.code).trim(), qr_context.visit_id || null, controlCenterId]
      );
      if (qrResult.rows.length) qrAttribution = qrResult.rows[0];
    }

    await pool.query(
      `
      UPDATE mobile_events
      SET
        state = 'CANCELLED',
        cancelled = true,
        cancelled_at = NOW(),
        updated_at = NOW()
      WHERE user_id = $1
        AND state = 'ACTIVE'
      `,
      [user_id]
    );

    const eventId = `MOBILE-SOS-${user_id}-${Date.now()}`;

    const result = await pool.query(
      `
      INSERT INTO mobile_events (
        id,
        user_id,
        name,
        phone,
        latitude,
        longitude,
        accuracy,
        battery,
        state,
        acknowledged,
        cancelled,
        jurisdiction_status,
        jurisdiction_reason,
        qr_point_id,
        qr_visit_id,
        qr_context
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',false,false,$9,$10,$11,$12,$13)
      RETURNING *
      `,
      [
        eventId,
        user_id,
        citizen.full_name || name || "Usuario movil",
        citizen.phone || phone || null,
        Number(latitude),
        Number(longitude),
        accuracy ?? null,
        battery ?? null,
        jurisdiction.status,
        jurisdiction.reason,
        qrAttribution?.id || null,
        qrAttribution?.visit_id || null,
        qrAttribution ? JSON.stringify({
          code: qrAttribution.code,
          name: qrAttribution.name,
          installed_latitude: Number(qrAttribution.latitude),
          installed_longitude: Number(qrAttribution.longitude),
          visit_id: qrAttribution.visit_id || null
        }) : null
      ]
    );

    const event = result.rows[0];

    const existingIncident = platformSettings.features?.multi_report_incidents_enabled === false
      ? null
      : await findNearbyActiveIncident({
          controlCenterId,
          latitude: event.latitude,
          longitude: event.longitude,
          alertType: normalizedAlert.alert_type,
          settings: platformSettings
        });

    if (existingIncident?.ticket) {
      const linkedTicket = existingIncident.ticket;
      const report = await insertTicketReport({
        ticket: linkedTicket,
        event,
        citizen,
        normalizedAlert,
        source,
        confidence: normalizedAlert.confidence,
        isPrimaryReport: false,
        match: existingIncident
      });

      await pool.query(
        `
        INSERT INTO ticket_actions (
          ticket_id,
          actor_user_id,
          actor_role,
          action_type,
          description,
          metadata
        )
        VALUES ($1,$2,'NEIGHBOR','REPORT_ATTACHED',$3,$4)
        `,
        [
          linkedTicket.id,
          citizenUserId,
          `${citizen.full_name || name || 'Vecino'} sumó información a un incidente ya reportado`,
          JSON.stringify({
            mobile_event_id: event.id,
            ticket_report_id: report.id,
            report_count: Number(linkedTicket.report_count || 0) + 1,
            dedup_distance_meters: Math.round(existingIncident.distance_meters),
            dedup_score: existingIncident.score,
            alert_type: normalizedAlert.alert_type,
            title: normalizedAlert.title,
            description: normalizedAlert.description,
            source,
            aggregation: 'NEARBY_ACTIVE_INCIDENT'
          })
        ]
      );

      await pool.query(`UPDATE tickets SET updated_at = NOW() WHERE id = $1`, [linkedTicket.id]);
      const reportCount = await ticketReportCount(linkedTicket.id);

      console.log("[MOBILE SOS DB DUPLICATE-LINKED]", { event_id: event.id, ticket_id: linkedTicket.id, report_count: reportCount });

      return res.json({
        status: "ok",
        message: "Este incidente ya estaba reportado. Sumamos tu información al caso activo.",
        event_id: event.id,
        state: event.state,
        received_at: event.created_at,
        ticket_id: linkedTicket.id,
        incident_linked: true,
        duplicate_of_ticket_id: linkedTicket.id,
        report_count: reportCount,
        match: {
          distance_meters: Math.round(existingIncident.distance_meters),
          score: existingIncident.score,
          window_minutes: platformSettings.incident_policy?.dedup_window_minutes || INCIDENT_DEDUP_WINDOW_MINUTES,
          radius_meters: platformSettings.incident_policy?.dedup_radius_meters || INCIDENT_DEDUP_RADIUS_METERS
        },
        user: publicUserPayload(citizen)
      });
    }

    const ticket = await createTicket({
      control_center_id: controlCenterId,
      citizen_user_id: citizenUserId,
      source_type: "MOBILE_APP",
      source_event_id: event.id,
      alert_type: normalizedAlert.alert_type,
      title: normalizedAlert.title,
      description: normalizedAlert.description,
      latitude: event.latitude,
      longitude: event.longitude,
      accuracy: event.accuracy,
      priority: normalizedAlert.priority,
      metadata: {
        mobile_event_id: event.id,
        phone: citizen.phone || phone,
        battery,
        source,
        alert_type: normalizedAlert.alert_type,
        title: normalizedAlert.title,
        priority: normalizedAlert.priority,
        sensor_event_type: normalizedAlert.sensor_event_type,
        silent: normalizedAlert.silent,
        confidence: normalizedAlert.confidence,
        control_center_code: citizen.control_center_code || control_center_code,
        citizen_validation_status: citizen.validation_status,
        anonymous_user_id: user_id,
        jurisdiction_status: jurisdiction.status,
        jurisdiction_reason: jurisdiction.reason,
        jurisdiction_distance_meters: jurisdiction.distance_meters ?? null,
        aggregation: 'PRIMARY_INCIDENT'
      }
    });

    await pool.query(
      `
      UPDATE tickets
      SET jurisdiction_status = $2,
          jurisdiction_reason = $3
      WHERE id = $1
      `,
      [ticket.id, jurisdiction.status, jurisdiction.reason]
    );

    await insertTicketReport({
      ticket,
      event,
      citizen,
      normalizedAlert,
      source,
      confidence: normalizedAlert.confidence,
      isPrimaryReport: true,
      match: null
    });

    console.log("[MOBILE SOS DB]", event);

    res.json({
      status: "ok",
      message: "Mobile SOS received",
      event_id: event.id,
      state: event.state,
      received_at: event.created_at,
      ticket_id: ticket ? ticket.id : null,
      incident_linked: false,
      report_count: 1,
      user: publicUserPayload(citizen)
    });

  } catch (error) {
    console.error("[MOBILE SOS DB ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message || "Database error creating mobile SOS"
    });
  }
});


app.post("/public/mobile/cancel", async (req, res) => {
  try {
    const { event_id, user_id } = req.body;

    if (!checkIdentityAccess(req, res, ["NEIGHBOR", "ADMIN", "SUPER_ADMIN"], user_id, "Sesión de vecino requerida para cancelar SOS")) return;

    if (!event_id) {
      return res.status(400).json({
        status: "error",
        message: "event_id is required"
      });
    }

    const result = await pool.query(
      `
      SELECT
        m.*,
        t.id AS ticket_id,
        t.control_center_id AS ticket_control_center_id,
        t.state AS ticket_state,
        t.title AS ticket_title,
        t.alert_type AS ticket_alert_type,
        t.priority AS ticket_priority,
        t.created_at AS ticket_created_at,
        t.acknowledged_at AS ticket_acknowledged_at,
        t.assigned_at AS ticket_assigned_at,
        t.resolved_at AS ticket_resolved_at,
        t.closed_at AS ticket_closed_at,
        t.assigned_resolver_id,
        r.full_name AS resolver_name,
        r.phone AS resolver_phone
      FROM mobile_events m
      LEFT JOIN tickets t
        ON t.source_type = 'MOBILE_APP'
       AND t.source_event_id = m.id
      LEFT JOIN users r
        ON r.id = t.assigned_resolver_id
      WHERE m.id = $1
      ORDER BY t.created_at DESC NULLS LAST
      LIMIT 1
      `,
      [event_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Unknown event_id"
      });
    }

    const event = result.rows[0];

    if (user_id && event.user_id !== user_id) {
      return res.status(403).json({
        status: "error",
        message: "user_id does not match event"
      });
    }

    const update = await pool.query(
      `
      UPDATE mobile_events
      SET
        state = 'CANCELLED',
        cancelled = true,
        cancelled_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [event_id]
    );

    const cancelledTickets = await pool.query(
      `
      UPDATE tickets
      SET
        state = 'CANCELLED',
        closed_at = COALESCE(closed_at, NOW()),
        updated_at = NOW()
      WHERE source_type = 'MOBILE_APP'
        AND source_event_id = $1
        AND state NOT IN ('CLOSED','RESOLVED','CANCELLED')
      RETURNING id, assigned_resolver_id
      `,
      [event_id]
    );

    for (const cancelledTicket of cancelledTickets.rows || []) {
      await releaseResolverFromTicket(cancelledTicket.id, "TICKET_CANCELLED_BY_NEIGHBOR").catch((error) => {
        console.warn("[RESOLVER RELEASE WARNING] mobile cancel:", error.message);
      });
    }

    console.log("[MOBILE SOS CANCELLED DB]", update.rows[0]);

    res.json({
      status: "ok",
      message: "Mobile SOS cancelled",
      event_id,
      state: update.rows[0].state,
      cancelled_at: update.rows[0].cancelled_at
    });

  } catch (error) {
    console.error("[MOBILE CANCEL DB ERROR]", error);

    res.status(500).json({
      status: "error",
      message: "Database error cancelling mobile SOS"
    });
  }
});



app.post("/public/mobile/ack", async (req, res) => {
  if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere sesión operacional para reconocer alertas")) return;
  try {
    const { event_id, operator } = req.body;

    if (!event_id) {
      return res.status(400).json({
        status: "error",
        message: "event_id is required"
      });
    }

    const result = await pool.query(
      `
      UPDATE mobile_events
      SET
        state = 'ACKNOWLEDGED',
        acknowledged = true,
        acknowledged_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [event_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Unknown event_id"
      });
    }

    await pool.query(
      `
      UPDATE tickets
      SET
        state = 'ACKNOWLEDGED',
        acknowledged_at = COALESCE(acknowledged_at, NOW()),
        updated_at = NOW()
      WHERE source_type = 'MOBILE_APP'
        AND source_event_id = $1
        AND state = 'ACTIVE'
      `,
      [event_id]
    );

    console.log("[MOBILE SOS ACK DB]", {
      ...result.rows[0],
      operator: operator || "operator"
    });

    res.json({
      status: "ok",
      message: "Mobile SOS acknowledged",
      event_id,
      state: result.rows[0].state,
      acknowledged_at: result.rows[0].acknowledged_at
    });

  } catch (error) {
    console.error("[MOBILE ACK DB ERROR]", error);

    res.status(500).json({
      status: "error",
      message: "Database error acknowledging mobile SOS"
    });
  }
});



async function getNeighborTicketActivity(ticketId, limit = 30) {
  if (!ticketId) return [];

  const result = await pool.query(
    `
    SELECT
      id,
      action_type,
      actor_role,
      description,
      metadata,
      created_at
    FROM ticket_actions
    WHERE ticket_id = $1
      AND actor_role = 'NEIGHBOR'
      AND action_type IN (
        'MESSAGE_TEXT',
        'MEDIA_AUDIO',
        'MEDIA_VIDEO',
        'CALL_VOICE',
        'CALL_VIDEO',
        'CALL_ACCEPTED',
        'CALL_REJECTED',
        'CALL_RESPONSE'
      )
    ORDER BY created_at DESC
    LIMIT $2
    `,
    [ticketId, limit]
  );

  const actionItems = result.rows
    // Las llamadas gestionadas por WA-Center se resumen desde
    // ticket_voice_sessions más abajo. Así evitamos mostrar por separado la
    // solicitud y el rechazo técnico de una misma sesión.
    .filter((row) => {
      const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
      return !metadata.voice_session_id;
    })
    .map((row) => {
    const metadata = row.metadata && typeof row.metadata === 'object'
      ? row.metadata
      : {};

    let kind = 'event';
    let title = row.description || 'Actualización enviada';
    let body = null;
    let media_url = null;
    let file_name = null;

    if (row.action_type === 'MESSAGE_TEXT') {
      kind = 'text';
      title = 'Mensaje de texto enviado';
      body = metadata.message || null;
    } else if (row.action_type === 'MEDIA_AUDIO') {
      kind = 'audio';
      title = 'Audio enviado';
      media_url = metadata.media_url || null;
      file_name = metadata.file_name || null;
    } else if (row.action_type === 'MEDIA_VIDEO') {
      kind = 'video';
      title = 'Video enviado';
      media_url = metadata.media_url || null;
      file_name = metadata.file_name || null;
    } else if (row.action_type === 'CALL_VOICE' || row.action_type === 'CALL_VIDEO') {
      kind = row.action_type === 'CALL_VOICE' ? 'voice_call' : 'video_call';
      title = row.description || 'Solicitud de llamada enviada';
    } else if (row.action_type === 'CALL_ACCEPTED' || row.action_type === 'CALL_REJECTED' || row.action_type === 'CALL_RESPONSE') {
      kind = 'call_response';
      title = row.description || 'Respuesta de llamada enviada';
    }

    return {
      id: row.id,
      kind,
      title,
      body,
      media_url,
      file_name,
      created_at: row.created_at
    };
    });

  await ensureVoiceSchema();
  const voiceResult = await pool.query(
    `
    SELECT
      id,
      status,
      target_type,
      started_at,
      connected_at,
      ended_at,
      duration_seconds,
      failure_reason,
      recording_url,
      created_at
    FROM ticket_voice_sessions
    WHERE ticket_id = $1
      AND requested_by = 'NEIGHBOR'
    ORDER BY created_at DESC
    LIMIT $2
    `,
    [ticketId, limit]
  );

  const voiceItems = voiceResult.rows.map((session) => {
    const status = String(session.status || 'REQUESTED').toUpperCase();
    const target = String(session.target_type || '').toUpperCase() === 'RESOLVER'
      ? 'con el resolutor'
      : 'con la central';
    const connected = Boolean(session.connected_at) || status === 'CONNECTED';
    const terminalFailure = ['FAILED', 'NO_ANSWER', 'EXPIRED', 'REJECTED'].includes(status)
      || (status === 'ENDED' && !connected);
    let title = `Llamada solicitada ${target}`;
    let body = 'Esperando conexión de la llamada segura.';

    if (status === 'ENDED' && connected) {
      title = 'Llamada segura finalizada';
      body = session.duration_seconds != null
        ? `La comunicación ${target} duró ${Math.max(0, Math.round(Number(session.duration_seconds)))} segundos.`
        : `La comunicación ${target} terminó correctamente.`;
    } else if (status === 'CONNECTED' || connected) {
      title = 'Llamada segura conectada';
      body = `Comunicación establecida ${target}.`;
    } else if (terminalFailure) {
      title = 'Intento de llamada no completado';
      body = status === 'NO_ANSWER'
        ? `No hubo respuesta ${target}.`
        : status === 'REJECTED'
          ? `La llamada ${target} fue rechazada.`
          : 'La sesión no alcanzó a conectarse. Puedes volver a intentarlo.';
    }

    return {
      id: `voice-session-${session.id}`,
      kind: terminalFailure ? 'call_response' : 'voice_call',
      title,
      body,
      media_url: null,
      file_name: null,
      created_at: session.ended_at || session.connected_at || session.started_at || session.created_at
    };
  });

  return [...actionItems, ...voiceItems]
    .sort((left, right) => new Date(right.created_at || 0).getTime() - new Date(left.created_at || 0).getTime())
    .slice(0, limit);
}

function buildNeighborProgress(event) {
  const state = event.ticket_state || event.state || "ACTIVE";
  const shortTicket = event.ticket_id
    ? `#${String(event.ticket_id).slice(0, 8).toUpperCase()}`
    : null;

  const steps = [
    {
      key: "central_informed",
      label: "Central informada",
      detail: shortTicket
        ? `La central recibió tu emergencia ${shortTicket}.`
        : "La central recibió tu emergencia.",
      done: true,
      active: state === "ACTIVE" && !event.assigned_resolver_id,
      at: event.ticket_created_at || event.created_at || null
    }
  ];

  if (event.assigned_resolver_id) {
    steps.push({
      key: "resolver_assigned",
      label: "Resolutor asignado",
      detail: event.resolver_name
        ? `Tu caso fue asignado a ${event.resolver_name}.`
        : "Tu caso fue asignado a un resolutor municipal.",
      done: true,
      active: ["ASSIGNED", "ACCEPTED_BY_RESOLVER"].includes(state),
      at: event.ticket_assigned_at || null,
      resolver_name: event.resolver_name || null,
      resolver_phone: event.resolver_phone || null
    });
  } else if (!["RESOLVED", "CLOSED", "CANCELLED"].includes(state)) {
    steps.push({
      key: "resolver_pending",
      label: "Esperando resolutor disponible",
      detail: "La central mantiene el caso activo hasta asignar apoyo en terreno.",
      done: false,
      active: true,
      at: null
    });
  }

  if (["EN_ROUTE", "ON_SITE", "RESOLVED", "CLOSED"].includes(state)) {
    steps.push({
      key: "resolver_en_route",
      label: "Resolutor en camino",
      detail: event.resolver_name
        ? `${event.resolver_name} se dirige al lugar.`
        : "El resolutor se dirige al lugar.",
      done: true,
      active: state === "EN_ROUTE",
      at: null
    });
  }

  if (["ON_SITE", "RESOLVED", "CLOSED"].includes(state)) {
    steps.push({
      key: "resolver_on_site",
      label: "Resolutor en sitio",
      detail: "El resolutor informó llegada al lugar.",
      done: true,
      active: state === "ON_SITE",
      at: null
    });
  }

  if (["RESOLVED", "CLOSED"].includes(state)) {
    steps.push({
      key: "case_closed",
      label: state === "RESOLVED" ? "Caso resuelto" : "Caso cerrado",
      detail: "La emergencia fue finalizada por el equipo municipal.",
      done: true,
      active: false,
      at: event.ticket_resolved_at || event.ticket_closed_at || null
    });
  }

  const reportCount = Number(event.report_count || 0);
  const isPrimaryReport = event.is_primary_report === true || String(event.is_primary_report).toLowerCase() === 'true';

  let headline = reportCount > 1 && !isPrimaryReport
    ? "Tu reporte fue sumado a un caso activo."
    : "La central ya recibió tu emergencia.";
  let detail = reportCount > 1
    ? `Este incidente acumula ${reportCount} reportes ciudadanos. Puedes agregar información mientras se gestiona el caso.`
    : "Puedes agregar información mientras se gestiona el caso.";

  if (state === "ASSIGNED") {
    headline = "Resolutor asignado.";
    detail = event.resolver_name
      ? `Tu caso fue asignado a ${event.resolver_name}.`
      : "Tu caso fue asignado a un resolutor municipal.";
  } else if (state === "ACCEPTED_BY_RESOLVER") {
    headline = "El resolutor aceptó el caso.";
    detail = event.resolver_name
      ? `${event.resolver_name} está coordinando la atención.`
      : "El resolutor está coordinando la atención.";
  } else if (state === "EN_ROUTE") {
    headline = "Resolutor en camino.";
    detail = event.resolver_name
      ? `${event.resolver_name} se dirige al lugar.`
      : "El resolutor se dirige al lugar.";
  } else if (state === "ON_SITE") {
    headline = "Resolutor en sitio.";
    detail = "El resolutor informó que llegó al lugar.";
  } else if (state === "RESOLVED") {
    headline = "Caso resuelto.";
    detail = "La central finalizó la atención del caso.";
  } else if (state === "CLOSED") {
    headline = "Caso cerrado.";
    detail = "La central cerró administrativamente el caso.";
  } else if (!event.assigned_resolver_id) {
    headline = "Central informada.";
    detail = "Tu emergencia está activa. Aún no hay resolutor asignado.";
  }

  return {
    ticket_id: event.ticket_id || null,
    ticket_state: state,
    alert_type: event.ticket_alert_type || event.alert_type || null,
    ticket_alert_type: event.ticket_alert_type || null,
    report_count: reportCount,
    is_primary_report: isPrimaryReport,
    headline,
    detail,
    resolver: event.assigned_resolver_id
      ? {
          id: event.assigned_resolver_id,
          name: event.resolver_name || "Resolutor municipal",
          phone: event.resolver_phone || null
        }
      : null,
    steps
  };
}

app.get("/public/mobile/status/:event_id", async (req, res) => {
  try {
    if (!checkAuthenticatedAccess(req, res, ["NEIGHBOR", "OPERATOR", "ADMIN", "SUPER_ADMIN"], "Sesión requerida para consultar el evento")) return;
    await ensureIncidentAggregationSchema();
    const { event_id } = req.params;

    const result = await pool.query(
      `
      SELECT
        m.*,
        t.id AS ticket_id,
        t.state AS ticket_state,
        t.title AS ticket_title,
        t.alert_type AS ticket_alert_type,
        t.priority AS ticket_priority,
        t.created_at AS ticket_created_at,
        t.acknowledged_at AS ticket_acknowledged_at,
        t.assigned_at AS ticket_assigned_at,
        t.resolved_at AS ticket_resolved_at,
        t.closed_at AS ticket_closed_at,
        t.assigned_resolver_id,
        r.full_name AS resolver_name,
        r.phone AS resolver_phone,
        COALESCE(report_stats.report_count, 0)::int AS report_count,
        report_self.id AS self_report_id,
        COALESCE(report_self.is_primary_report, false) AS is_primary_report
      FROM mobile_events m
      LEFT JOIN tickets t
        ON (t.source_type = 'MOBILE_APP' AND t.source_event_id = m.id)
        OR t.id = m.linked_ticket_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS report_count
        FROM ticket_reports tr
        WHERE tr.ticket_id = t.id
      ) report_stats ON true
      LEFT JOIN LATERAL (
        SELECT tr.id, tr.is_primary_report
        FROM ticket_reports tr
        WHERE tr.ticket_id = t.id
          AND tr.mobile_event_id = m.id
        ORDER BY tr.created_at DESC
        LIMIT 1
      ) report_self ON true
      LEFT JOIN users r
        ON r.id = t.assigned_resolver_id
      WHERE m.id = $1
      ORDER BY t.created_at DESC NULLS LAST
      LIMIT 1
      `,
      [event_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Unknown event_id"
      });
    }

    const event = result.rows[0];
    event.alert_type = event.ticket_alert_type || event.alert_type || null;
    if (String(req.panel_session.role || "").toUpperCase() === "NEIGHBOR" && String(event.user_id) !== String(req.panel_session.sub)) {
      return res.status(403).json({ status: "error", message: "No autorizado para este evento" });
    }
    const terminalTicketStates = ["RESOLVED", "CLOSED", "CANCELLED"];
    const effectiveState = terminalTicketStates.includes(event.ticket_state)
      ? event.ticket_state
      : event.state;

    event.effective_state = effectiveState;

    const neighborProgress = buildNeighborProgress(event);

    let pendingCallRequest = null;

    if (event.ticket_id && !terminalTicketStates.includes(effectiveState)) {
      const callResult = await pool.query(
        `
        SELECT
          id,
          action_type,
          actor_role,
          description,
          metadata,
          created_at
        FROM ticket_actions
        WHERE ticket_id = $1
          AND actor_role = 'OPERATOR'
          AND action_type IN ('CALL_VOICE','CALL_VIDEO')
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [event.ticket_id]
      );

      if (callResult.rows.length > 0) {
        const action = callResult.rows[0];
        pendingCallRequest = {
          id: action.id,
          mode: action.action_type === "CALL_VIDEO" ? "video" : "voice",
          description: action.description,
          metadata: action.metadata,
          created_at: action.created_at
        };
      }
    }

    const neighborActivity = event.ticket_id
      ? await getNeighborTicketActivity(event.ticket_id)
      : [];
    const voiceSessions = event.ticket_id
      ? await getVoiceSessionsForTicket(event.ticket_id, { includeCredentials: false, limit: 5 })
      : [];
    const statusSettingsRow = event.ticket_control_center_id
      ? await getControlCenterSettingsById(event.ticket_control_center_id).catch(() => null)
      : null;
    const statusPlatformSettings = statusSettingsRow?.settings || DEFAULT_CONTROL_CENTER_SETTINGS;

    res.json({
      status: "ok",
      event,
      ticket_state: event.ticket_state || null,
      effective_state: effectiveState,
      neighbor_progress: neighborProgress,
      neighbor_activity: neighborActivity,
      voice_sessions: voiceSessions,
      pending_call_request: pendingCallRequest,
      platform_settings: publicSettingsPayload(statusPlatformSettings)
    });

  } catch (error) {
    console.error("[MOBILE STATUS DB ERROR]", error);

    res.status(500).json({
      status: "error",
      message: "Database error getting mobile SOS status"
    });
  }
});


app.get("/public/mobile/active", async (req, res) => {
  try {
    await ensureIncidentAggregationSchema();
    const { user_id } = req.query;

    if (!checkIdentityAccess(req, res, ["NEIGHBOR", "ADMIN", "SUPER_ADMIN"], user_id, "Sesión de vecino requerida")) return;

    if (!user_id) {
      return res.status(400).json({
        status: "error",
        message: "user_id is required"
      });
    }

    const result = await pool.query(
      `
      SELECT
        m.*,
        t.id AS ticket_id,
        t.state AS ticket_state,
        t.title AS ticket_title,
        t.alert_type AS ticket_alert_type,
        t.priority AS ticket_priority,
        t.created_at AS ticket_created_at,
        t.acknowledged_at AS ticket_acknowledged_at,
        t.assigned_at AS ticket_assigned_at,
        t.resolved_at AS ticket_resolved_at,
        t.closed_at AS ticket_closed_at,
        t.assigned_resolver_id,
        r.full_name AS resolver_name,
        r.phone AS resolver_phone,
        COALESCE(report_stats.report_count, 0)::int AS report_count,
        report_self.id AS self_report_id,
        COALESCE(report_self.is_primary_report, false) AS is_primary_report
      FROM mobile_events m
      LEFT JOIN tickets t
        ON (t.source_type = 'MOBILE_APP' AND t.source_event_id = m.id)
        OR t.id = m.linked_ticket_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS report_count
        FROM ticket_reports tr
        WHERE tr.ticket_id = t.id
      ) report_stats ON true
      LEFT JOIN LATERAL (
        SELECT tr.id, tr.is_primary_report
        FROM ticket_reports tr
        WHERE tr.ticket_id = t.id
          AND tr.mobile_event_id = m.id
        ORDER BY tr.created_at DESC
        LIMIT 1
      ) report_self ON true
      LEFT JOIN users r
        ON r.id = t.assigned_resolver_id
      WHERE m.user_id = $1
        AND (
          (
            t.id IS NOT NULL
            AND t.state NOT IN ('RESOLVED','CLOSED','CANCELLED')
          )
          OR (
            t.id IS NULL
            AND m.state IN ('ACTIVE','ACKNOWLEDGED')
          )
        )
      ORDER BY COALESCE(t.created_at, m.created_at) DESC
      LIMIT 1
      `,
      [user_id]
    );

    if (result.rows.length === 0) {
      return res.json({
        status: "ok",
        active: false,
        event: null,
        ticket_id: null,
        neighbor_progress: null,
        neighbor_activity: []
      });
    }

    const event = result.rows[0];
    event.alert_type = event.ticket_alert_type || event.alert_type || null;
    const terminalTicketStates = ["RESOLVED", "CLOSED", "CANCELLED"];
    const effectiveState = terminalTicketStates.includes(event.ticket_state)
      ? event.ticket_state
      : (event.ticket_state || event.state);

    event.effective_state = effectiveState;

    const neighborActivity = event.ticket_id
      ? await getNeighborTicketActivity(event.ticket_id)
      : [];
    const voiceSessions = event.ticket_id
      ? await getVoiceSessionsForTicket(event.ticket_id, { includeCredentials: false, limit: 5 })
      : [];

    res.json({
      status: "ok",
      active: true,
      event,
      ticket_id: event.ticket_id || null,
      ticket_state: event.ticket_state || null,
      effective_state: effectiveState,
      neighbor_progress: buildNeighborProgress(event),
      neighbor_activity: neighborActivity,
      voice_sessions: voiceSessions
    });

  } catch (error) {
    console.error("[MOBILE ACTIVE CASE ERROR]", error);

    res.status(500).json({
      status: "error",
      message: "Database error getting active mobile case"
    });
  }
});



app.post("/auth/panel-login", authRateLimit, async (req, res) => {
  try {
    const {
      phone,
      panel_type = "CONTROL_CENTER",
      code = null,
      channel = null
    } = req.body || {};

    const cleanPhone = normalizePhoneForAuth(phone);
    const allowedRoles = allowedRolesForPanel(panel_type);

    if (!cleanPhone) {
      return res.status(400).json({
        status: "error",
        message: "phone is required"
      });
    }

    const result = await pool.query(
      `
      SELECT
        u.id,
        u.control_center_id,
        cc.code AS control_center_code,
        cc.name AS control_center_name,
        u.role,
        u.validation_status,
        u.is_active,
        u.full_name,
        u.phone,
        u.email,
        u.rut,
        u.declared_address,
        u.latitude,
        u.longitude
      FROM users u
      JOIN control_centers cc ON cc.id = u.control_center_id
      WHERE u.phone = $1
      ORDER BY u.created_at DESC
      LIMIT 1
      `,
      [cleanPhone]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Usuario no encontrado"
      });
    }

    const user = result.rows[0];

    if (user.is_active !== true) {
      return res.status(403).json({
        status: "error",
        message: "La cuenta está suspendida o inactiva"
      });
    }

    if (!allowedRoles.includes(user.role)) {
      return res.status(403).json({
        status: "error",
        message: `Acceso no permitido para rol ${user.role}`
      });
    }

    const normalizedPanelType = String(panel_type || "CONTROL_CENTER").trim().toUpperCase();
    const purpose = `PANEL_LOGIN_${normalizedPanelType}`;

    if (!code) {
      const otp = await createAndSendOtp({
        phone: cleanPhone,
        email: user.email || null,
        channel: channel || null,
        purpose,
        metadata: {
          user_id: user.id,
          role: user.role,
          panel_type: normalizedPanelType,
          control_center_code: user.control_center_code
        }
      });
      return res.json({
        status: "ok",
        requires_verification: true,
        message: "Código de acceso enviado",
        otp_channel: otp.channel,
        otp_expires_minutes: otp.expires_minutes,
        ...(otp.demo_code ? { demo_code: otp.demo_code } : {})
      });
    }

    const verification = await verifyOtpForPhone({ phone: cleanPhone, code, purpose });
    if (!verification.ok) {
      return res.status(401).json({
        status: "error",
        message: verification.reason === "too_many_attempts"
          ? "Demasiados intentos. Solicita un nuevo código."
          : "Código inválido o expirado."
      });
    }

    const token = createPanelSessionToken(user, normalizedPanelType);

    res.json({
      status: "ok",
      message: "Login panel OK",
      token,
      expires_hours: PANEL_SESSION_TTL_HOURS,
      user
    });
  } catch (error) {
    console.error("[PANEL LOGIN ERROR]", error);
    res.status(500).json({
      status: "error",
      message: error.message || "Error logging into panel"
    });
  }
});

app.get("/auth/session", async (req, res) => {
  try {
    const session = panelSessionFromRequest(req);

    if (!session) {
      return res.status(401).json({
        status: "error",
        message: "Sesión inválida o expirada"
      });
    }

    const result = await pool.query(
      `
      SELECT
        u.id,
        u.control_center_id,
        cc.code AS control_center_code,
        cc.name AS control_center_name,
        u.role,
        u.validation_status,
        u.is_active,
        u.full_name,
        u.phone,
        u.email,
        u.rut,
        u.declared_address,
        u.latitude,
        u.longitude
      FROM users u
      JOIN control_centers cc ON cc.id = u.control_center_id
      WHERE u.id = $1
      LIMIT 1
      `,
      [session.sub]
    );

    if (result.rows.length === 0 || result.rows[0].is_active !== true) {
      return res.status(401).json({
        status: "error",
        message: "Usuario inactivo o no encontrado"
      });
    }

    const sessionSettingsRow = await getControlCenterSettingsById(result.rows[0].control_center_id).catch(() => null);
    const sessionPlatformSettings = sessionSettingsRow?.settings || DEFAULT_CONTROL_CENTER_SETTINGS;

    res.json({
      status: "ok",
      session,
      user: result.rows[0],
      platform_settings: publicSettingsPayload(sessionPlatformSettings)
    });
  } catch (error) {
    console.error("[SESSION CHECK ERROR]", error);
    res.status(500).json({
      status: "error",
      message: error.message || "Error checking session"
    });
  }
});

app.get("/auth/me", async (req, res) => {
  try {
    const userId = req.query.user_id || req.headers["x-user-id"];

    if (!checkIdentityAccess(req, res, ["NEIGHBOR", "ADMIN", "SUPER_ADMIN"], userId, "Sesión de vecino requerida")) return;

    if (!userId) {
      return res.status(400).json({
        status: "error",
        message: "user_id is required"
      });
    }

    const user = await getNeighborById(userId);

    if (!user) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    res.json({
      status: "ok",
      user: publicUserPayload(user),
      can_use_sos: canNeighborUseSos(user).ok,
      block_reason: canNeighborUseSos(user).reason || null
    });

  } catch (error) {
    console.error("[AUTH ME ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message || "Error getting current user"
    });
  }
});

app.post("/auth/register", authRateLimit, async (req, res) => {
  try {
    const {
      control_center_code,
      full_name,
      rut,
      phone,
      email,
      declared_address,
      latitude,
      longitude,
      emergency_contacts,
      otp_channel
    } = req.body;

    if (!full_name || !phone || !declared_address) {
      return res.status(400).json({
        status: "error",
        message: "full_name, phone and declared_address are required"
      });
    }

    await ensureNeighborProvisioningSchema();
    const resolvedControlCenter = await resolveControlCenterForNeighborRegistration(latitude, longitude);
    const controlCenter = resolvedControlCenter.controlCenter;
    const registrationJurisdiction = resolvedControlCenter.jurisdiction;
    const cleanPhone = normalizePhoneForAuth(phone);
    const provisionalExpiresAtSql = "NOW() + INTERVAL '7 days'";

    const existingResult = await pool.query(
      `
      SELECT *
      FROM users
      WHERE phone = $1
        AND is_active = true
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [cleanPhone]
    );

    let user;
    let operation = "created";

    if (existingResult.rows.length > 0) {
      const existing = existingResult.rows[0];

      if (existing.role !== "NEIGHBOR") {
        return res.status(409).json({
          status: "error",
          message: `Phone already registered with role ${existing.role}`
        });
      }

      const updateResult = await pool.query(
        `
        UPDATE users
        SET
          control_center_id = $1,
          full_name = $2,
          rut = $3,
          email = $4,
          declared_address = $5,
          latitude = $6,
          longitude = $7,
          validation_status = COALESCE(validation_status, 'PROVISIONAL_ACTIVE'),
          provisional_expires_at = CASE
            WHEN validation_status = 'VALIDATED' THEN provisional_expires_at
            ELSE ${provisionalExpiresAtSql}
          END,
          is_active = true,
          updated_at = NOW()
        WHERE id = $8
        RETURNING *
        `,
        [
          controlCenter.id,
          full_name,
          rut || null,
          email || null,
          declared_address || null,
          latitude ?? null,
          longitude ?? null,
          existing.id
        ]
      );

      user = updateResult.rows[0];
      operation = "updated";
    } else {
      const userResult = await pool.query(
        `
        INSERT INTO users (
          control_center_id,
          role,
          validation_status,
          full_name,
          rut,
          phone,
          email,
          declared_address,
          latitude,
          longitude,
          provisional_expires_at
        )
        VALUES (
          $1,
          'NEIGHBOR',
          'PROVISIONAL_ACTIVE',
          $2,$3,$4,$5,$6,$7,$8,
          ${provisionalExpiresAtSql}
        )
        RETURNING *
        `,
        [
          controlCenter.id,
          full_name,
          rut || null,
          cleanPhone,
          email || null,
          declared_address || null,
          latitude ?? null,
          longitude ?? null
        ]
      );

      user = userResult.rows[0];
    }

    const contacts = Array.isArray(emergency_contacts)
      ? emergency_contacts
      : [];

    await pool.query(
      `
      DELETE FROM emergency_contacts
      WHERE user_id = $1
      `,
      [user.id]
    );

    for (const contact of contacts) {
      if (!contact.name || !contact.phone) continue;

      await pool.query(
        `
        INSERT INTO emergency_contacts (
          user_id,
          name,
          relationship,
          phone,
          priority
        )
        VALUES ($1,$2,$3,$4,$5)
        `,
        [
          user.id,
          contact.name,
          contact.relationship || null,
          contact.phone,
          contact.priority || 1
        ]
      );
    }

    const otp = await createAndSendOtp({
      phone: cleanPhone,
      email: email || null,
      channel: otp_channel || null,
      purpose: "REGISTER",
      metadata: {
        user_id: user.id,
        operation,
        control_center_code: controlCenter.code,
        requested_control_center_code: control_center_code || null,
        assignment_source: "GPS_GEOFENCE",
        assignment_status: registrationJurisdiction.status,
        assignment_reason: registrationJurisdiction.reason,
        assignment_distance_meters: registrationJurisdiction.distance_meters ?? null
      }
    });

    res.json({
      status: "ok",
      message: operation === "created"
        ? "User registered. Verification code sent."
        : "User updated. Verification code sent.",
      operation,
      requires_verification: true,
      otp_channel: otp.channel,
      otp_expires_minutes: otp.expires_minutes,
      ...(otp.demo_code ? { demo_code: otp.demo_code } : {}),
      assignment: {
        source: "GPS_GEOFENCE",
        control_center_code: controlCenter.code,
        control_center_name: controlCenter.name,
        status: registrationJurisdiction.status,
        reason: registrationJurisdiction.reason,
        distance_meters: registrationJurisdiction.distance_meters ?? null
      },
      user: publicUserPayload(user, controlCenter)
    });

  } catch (error) {
    console.error("[AUTH REGISTER ERROR]", error);

    res.status(error.statusCode || 500).json({
      status: "error",
      message: error.message || "Database error registering user"
    });
  }
});

app.post("/auth/request-code", authRateLimit, async (req, res) => {
  try {
    const {
      phone,
      channel,
      purpose = "LOGIN"
    } = req.body;

    const cleanPhone = normalizePhoneForAuth(phone);

    if (!cleanPhone) {
      return res.status(400).json({
        status: "error",
        message: "phone is required"
      });
    }

    const userResult = await pool.query(
      `
      SELECT
        u.*,
        cc.code AS control_center_code,
        cc.name AS control_center_name
      FROM users u
      JOIN control_centers cc ON cc.id = u.control_center_id
      WHERE u.phone = $1
      ORDER BY u.created_at DESC
      LIMIT 1
      `,
      [cleanPhone]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Usuario no encontrado. Debe registrarse primero."
      });
    }

    const user = userResult.rows[0];

    if (user.is_active !== true) {
      return res.status(403).json({
        status: "error",
        message: "La cuenta está suspendida o inactiva. Contacta a la central."
      });
    }

    if (user.role !== "NEIGHBOR") {
      return res.status(403).json({
        status: "error",
        message: "Este acceso es solo para vecinos."
      });
    }

    const otp = await createAndSendOtp({
      phone: cleanPhone,
      email: user.email || null,
      channel: channel || null,
      purpose,
      metadata: {
        user_id: user.id,
        control_center_code: user.control_center_code
      }
    });

    res.json({
      status: "ok",
      message: "Código enviado",
      otp_channel: otp.channel,
      otp_expires_minutes: otp.expires_minutes,
      ...(otp.demo_code ? { demo_code: otp.demo_code } : {})
    });

  } catch (error) {
    console.error("[AUTH REQUEST CODE ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message || "Error requesting verification code"
    });
  }
});

app.post("/auth/verify-code", authRateLimit, async (req, res) => {
  try {
    const {
      phone,
      code,
      purpose = null
    } = req.body;

    const cleanPhone = normalizePhoneForAuth(phone);

    if (!cleanPhone || !code) {
      return res.status(400).json({
        status: "error",
        message: "phone and code are required"
      });
    }

    const verification = await verifyOtpForPhone({
      phone: cleanPhone,
      code,
      purpose
    });

    if (!verification.ok) {
      return res.status(401).json({
        status: "error",
        message: verification.reason === "too_many_attempts"
          ? "Demasiados intentos. Solicita un nuevo código."
          : "Código inválido o expirado."
      });
    }

    const userResult = await pool.query(
      `
      SELECT
        u.*,
        cc.code AS control_center_code,
        cc.name AS control_center_name
      FROM users u
      JOIN control_centers cc ON cc.id = u.control_center_id
      WHERE u.phone = $1
      ORDER BY u.created_at DESC
      LIMIT 1
      `,
      [cleanPhone]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    const user = userResult.rows[0];

    if (user.is_active !== true) {
      return res.status(403).json({
        status: "error",
        message: "La cuenta está suspendida o inactiva. Contacta a la central."
      });
    }

    if (user.role !== "NEIGHBOR") {
      return res.status(403).json({
        status: "error",
        message: "Este acceso es solo para vecinos."
      });
    }

    res.json({
      status: "ok",
      message: "Código verificado",
      token: createPanelSessionToken(user, "NEIGHBOR"),
      expires_hours: PANEL_SESSION_TTL_HOURS,
      user: publicUserPayload(user)
    });

  } catch (error) {
    console.error("[AUTH VERIFY CODE ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message || "Error verifying code"
    });
  }
});

app.post("/auth/logout", async (req, res) => {
  res.json({
    status: "ok",
    message: "Logged out"
  });
});


app.post("/resolver/auth/login", authRateLimit, async (req, res) => {
  try {
    const { phone, code = null, channel = null } = req.body || {};

    if (!phone) {
      return res.status(400).json({
        status: "error",
        message: "phone is required"
      });
    }

    const normalizedPhone = String(phone).trim();

    const result = await pool.query(
      `
      SELECT
        u.id,
        u.control_center_id,
        cc.code AS control_center_code,
        cc.name AS control_center_name,
        u.role,
        u.validation_status,
        u.full_name,
        u.phone,
        u.email,
        u.rut,
        u.declared_address,
        u.latitude,
        u.longitude
      FROM users u
      JOIN control_centers cc ON cc.id = u.control_center_id
      WHERE u.phone = $1
        AND u.role = 'RESOLVER'
        AND u.is_active = true
      ORDER BY u.created_at DESC
      LIMIT 1
      `,
      [normalizedPhone]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Resolutor no encontrado o no activo para este teléfono"
      });
    }

    const user = result.rows[0];

    const purpose = "RESOLVER_LOGIN";
    if (!code) {
      const otp = await createAndSendOtp({
        phone: normalizedPhone,
        email: user.email || null,
        channel: channel || null,
        purpose,
        metadata: {
          user_id: user.id,
          role: user.role,
          control_center_code: user.control_center_code
        }
      });
      return res.json({
        status: "ok",
        requires_verification: true,
        message: "Código de acceso enviado",
        otp_channel: otp.channel,
        otp_expires_minutes: otp.expires_minutes,
        ...(otp.demo_code ? { demo_code: otp.demo_code } : {})
      });
    }

    const verification = await verifyOtpForPhone({ phone: normalizedPhone, code, purpose });
    if (!verification.ok) {
      return res.status(401).json({
        status: "error",
        message: verification.reason === "too_many_attempts"
          ? "Demasiados intentos. Solicita un nuevo código."
          : "Código inválido o expirado."
      });
    }

    const token = createPanelSessionToken(user, "RESOLVER");

    res.json({
      status: "ok",
      message: "Resolver login OK",
      token,
      expires_hours: PANEL_SESSION_TTL_HOURS,
      user
    });

  } catch (error) {
    console.error("[RESOLVER AUTH LOGIN ERROR]", error);

    res.status(500).json({
      status: "error",
      message: "Database error logging resolver in"
    });
  }
});

app.post("/auth/login-demo", authRateLimit, async (req, res) => {
  if (process.env.AUTH_DEMO_LOGIN_ENABLED !== "true") {
    return res.status(404).json({
      status: "error",
      message: "Demo login disabled"
    });
  }

  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({
        status: "error",
        message: "phone is required"
      });
    }

    const result = await pool.query(
      `
      SELECT
        u.id,
        u.control_center_id,
        cc.code AS control_center_code,
        cc.name AS control_center_name,
        u.role,
        u.validation_status,
        u.full_name,
        u.phone,
        u.email,
        u.rut,
        u.declared_address,
        u.latitude,
        u.longitude
      FROM users u
      JOIN control_centers cc ON cc.id = u.control_center_id
      WHERE u.phone = $1
        AND u.is_active = true
      ORDER BY u.created_at DESC
      LIMIT 1
      `,
      [phone]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    const user = result.rows[0];

    res.json({
      status: "ok",
      message: "Login demo OK",
      token: `demo-token-${user.id}`,
      user
    });

  } catch (error) {
    console.error("[AUTH LOGIN DEMO ERROR]", error);

    res.status(500).json({
      status: "error",
      message: "Database error logging in"
    });
  }
});


app.get("/tickets", async (req, res) => {
  if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere usuario OPERATOR o ADMIN para listar tickets")) return;
  try {
    const {
      state,
      limit
    } = req.query;

    const control_center_code = dashboardAuthorizedControlCenterCode(req);
    const params = [control_center_code];
    let where = `cc.code = $1`;

    if (state) {
      params.push(state);
      where += ` AND t.state = $${params.length}`;
    }

    const maxLimit = Math.min(Number(limit || 50), 200);
    params.push(maxLimit);

    const result = await pool.query(
      `
      SELECT
        t.id,
        cc.code AS control_center_code,
        t.source_type,
        t.source_event_id,
        t.alert_type,
        t.title,
        t.description,
        t.state,
        t.priority,
        t.latitude,
        t.longitude,

        COALESCE(t.event_sector_name,
          CASE
            WHEN t.latitude IS NULL OR t.longitude IS NULL THEN 'Sector no informado'
            WHEN t.latitude > -32.981 AND t.longitude < -71.532 THEN 'Reñaca Bajo / Jardín del Mar'
            WHEN t.latitude > -32.982 AND t.longitude >= -71.532 THEN 'Reñaca Alto'
            WHEN t.latitude > -32.999 AND t.longitude > -71.510 THEN 'Gómez Carreño / Glorias Navales'
            WHEN t.latitude > -33.007 AND t.longitude > -71.522 THEN 'Achupallas / Santa Julia'
            WHEN t.latitude > -33.009 AND t.longitude <= -71.522 THEN 'Santa Inés / Población Vergara'
            WHEN t.latitude > -33.024 AND t.longitude < -71.545 THEN 'Plan Viña / Libertad'
            WHEN t.latitude > -33.026 AND t.longitude >= -71.545 THEN 'Miraflores / Chorrillos'
            WHEN t.latitude <= -33.035 AND t.longitude < -71.545 THEN 'Recreo / Agua Santa'
            WHEN t.latitude <= -33.035 AND t.longitude >= -71.545 THEN 'Forestal / Nueva Aurora'
            ELSE 'Viña del Mar'
          END
        ) AS incident_sector,
        COALESCE(t.event_sector_method, 'Estimación por coordenada; pendiente cartografía oficial de sectores') AS sector_method,
        t.accuracy,
        t.created_at,
        t.acknowledged_at,
        t.assigned_at,
        t.resolved_at,
        t.closed_at,
        u.full_name AS citizen_name,
        u.phone AS citizen_phone,
        resolver.full_name AS resolver_name
      FROM tickets t
      JOIN control_centers cc
        ON cc.id = t.control_center_id

      LEFT JOIN mobile_events source_event
        ON source_event.id = t.source_event_id

      LEFT JOIN municipal_qr_points qr_point
        ON qr_point.id = source_event.qr_point_id
      LEFT JOIN users u
        ON u.id = t.citizen_user_id
      LEFT JOIN users resolver
        ON resolver.id = t.assigned_resolver_id
      WHERE ${where}
      ORDER BY t.created_at DESC
      LIMIT $${params.length}
      `,
      params
    );

    res.json({
      status: "ok",
      total: result.rows.length,
      tickets: result.rows
    });

  } catch (error) {
    console.error("[GET TICKETS ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});



app.get("/settings/emergency-categories", async (req, res) => {
  if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere sesión operacional")) return;
  try {
    const categories = await loadEmergencyCategoryCatalog({ includeDisabled: false });
    res.json({ status: "ok", categories });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.post("/tickets/manual", async (req, res) => {
  if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere sesión operacional para crear tickets")) return;

  try {
    const actor = req.panel_session || {};
    const controlCenterCode = dashboardAuthorizedControlCenterCode(req);
    const controlCenterResult = await pool.query(
      `SELECT id, code, name FROM control_centers WHERE code = $1 LIMIT 1`,
      [controlCenterCode]
    );
    if (!controlCenterResult.rows.length) {
      return res.status(404).json({ status: "error", message: "Centro de control no encontrado" });
    }

    const latitude = Number(req.body?.latitude);
    const longitude = Number(req.body?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      return res.status(400).json({ status: "error", message: "Debes indicar coordenadas GPS válidas para ubicar el evento" });
    }

    const alertType = String(req.body?.alert_type || "").trim().toUpperCase();
    const catalog = await loadEmergencyCategoryCatalog({ includeDisabled: false });
    const category = catalog.find(item => item.type === alertType && item.enabled !== false);
    if (!category) {
      return res.status(400).json({ status: "error", message: "La categoría seleccionada no está habilitada" });
    }

    const callerName = String(req.body?.caller_name || "").trim().slice(0, 160) || null;
    const callerPhone = String(req.body?.caller_phone || "").trim().slice(0, 40) || null;
    const reportedAddress = String(req.body?.reported_address || "").trim().slice(0, 300) || null;
    const description = String(req.body?.description || "").trim().slice(0, 3000);
    if (!description) {
      return res.status(400).json({ status: "error", message: "Describe brevemente la emergencia informada por teléfono" });
    }

    const waCenterSessionId = String(req.body?.wa_center_session_id || "").trim().slice(0, 180) || null;
    const waCenterCallId = String(req.body?.wa_center_call_id || "").trim().slice(0, 180) || null;
    const waCenterBridgeId = String(req.body?.wa_center_bridge_id || "").trim().slice(0, 180) || null;
    const externalReference = String(req.body?.external_reference || "").trim().slice(0, 220) || null;
    const recordingId = String(req.body?.recording_id || "").trim().slice(0, 220) || null;
    const durationSeconds = req.body?.duration_seconds == null ? null : Math.max(0, Math.round(Number(req.body.duration_seconds)));
    let recordingUrl = String(req.body?.recording_url || "").trim().slice(0, 2000) || null;
    if (recordingUrl) {
      try {
        const parsed = new URL(recordingUrl);
        if (parsed.protocol !== "https:") throw new Error("HTTPS required");
      } catch {
        return res.status(400).json({ status: "error", message: "La URL de grabación debe ser HTTPS" });
      }
    }

    await ensureVoiceSchema();
    if (waCenterSessionId || waCenterCallId) {
      const duplicate = await pool.query(
        `SELECT id, ticket_id FROM ticket_voice_sessions
         WHERE ($1::text IS NOT NULL AND wa_center_session_id = $1)
            OR ($2::text IS NOT NULL AND wa_center_call_id = $2)
         ORDER BY created_at DESC LIMIT 1`,
        [waCenterSessionId, waCenterCallId]
      );
      if (duplicate.rows[0]?.ticket_id) {
        return res.status(409).json({ status: "error", message: "Esta llamada de WA-Center ya está asociada a otro ticket", ticket_id: duplicate.rows[0].ticket_id });
      }
    }

    const metadata = {
      intake_channel: "MUNICIPAL_PHONE",
      caller_name: callerName,
      caller_phone: callerPhone,
      reported_address: reportedAddress,
      operator_user_id: actor.sub || null,
      operator_name: actor.full_name || actor.name || null,
      wa_center_session_id: waCenterSessionId,
      wa_center_call_id: waCenterCallId,
      external_reference: externalReference,
      recording_url: recordingUrl,
      recording_id: recordingId,
      duration_seconds: Number.isFinite(durationSeconds) ? durationSeconds : null
    };

    const ticket = await createTicket({
      control_center_id: controlCenterResult.rows[0].id,
      created_by_user_id: actor.sub || null,
      created_by_role: String(actor.role || "OPERATOR").toUpperCase(),
      creation_description: "Ticket ingresado manualmente por llamada al teléfono municipal",
      source_type: "PHONE_CALL",
      source_event_id: waCenterSessionId || waCenterCallId || externalReference,
      alert_type: category.type,
      title: String(req.body?.title || category.title || "Emergencia telefónica").trim().slice(0, 180),
      description,
      latitude,
      longitude,
      accuracy: null,
      priority: Math.max(1, Math.min(5, Number(req.body?.priority || category.priority || 2))),
      metadata
    });

    let voiceSession = null;
    if (waCenterSessionId || waCenterCallId || recordingUrl || recordingId) {
      const providerReference = externalReference || `sos-ticket-${ticket.id}`;
      const voiceResult = await pool.query(
        `INSERT INTO ticket_voice_sessions (
           ticket_id, requested_by, target_type, operator_user_id, external_reference,
           wa_center_session_id, wa_center_call_id, wa_center_bridge_id, status,
           party_a_role, party_b_role, recording_id, recording_url,
           duration_seconds, ended_at, raw_response
         ) VALUES ($1,'EXTERNAL_CALLER','CENTRAL',$2,$3,$4,$5,$6,$7,'caller','central',$8,$9,$10,
           CASE WHEN $7 = 'ENDED' THEN NOW() ELSE NULL END,$11)
         RETURNING *`,
        [
          ticket.id,
          actor.sub || null,
          providerReference,
          waCenterSessionId,
          waCenterCallId,
          waCenterBridgeId,
          recordingUrl || recordingId ? "ENDED" : "CONNECTED",
          recordingId,
          recordingUrl,
          Number.isFinite(durationSeconds) ? durationSeconds : null,
          JSON.stringify(req.body?.wa_center_payload || {})
        ]
      );
      voiceSession = voiceResult.rows[0];

      await pool.query(
        `UPDATE ticket_voice_events
         SET voice_session_id = $1, ticket_id = $2
         WHERE voice_session_id IS NULL
           AND (($3::text IS NOT NULL AND wa_center_session_id = $3)
             OR ($4::text IS NOT NULL AND external_reference = $4)
             OR ($5::text IS NOT NULL AND payload->>'call_id' = $5)
             OR ($5::text IS NOT NULL AND payload->>'wa_center_call_id' = $5))`,
        [voiceSession.id, ticket.id, waCenterSessionId, providerReference, waCenterCallId]
      );

      const historicalEvent = await pool.query(
        `SELECT payload, duration_seconds
         FROM ticket_voice_events
         WHERE voice_session_id = $1
         ORDER BY (event = 'RECORDING_AVAILABLE') DESC, created_at DESC
         LIMIT 1`,
        [voiceSession.id]
      );
      const historicalPayload = historicalEvent.rows[0]?.payload || {};
      const historicalRecordingUrl = historicalPayload.recording_url || historicalPayload.recording?.url || null;
      const historicalRecordingId = historicalPayload.recording_id || historicalPayload.recording?.id || null;
      if ((!recordingUrl && historicalRecordingUrl) || (!recordingId && historicalRecordingId)) {
        const mergedVoice = await pool.query(
          `UPDATE ticket_voice_sessions
           SET recording_url = COALESCE($2, recording_url),
               recording_id = COALESCE($3, recording_id),
               duration_seconds = COALESCE($4, duration_seconds),
               status = CASE WHEN $2::text IS NOT NULL OR $3::text IS NOT NULL THEN 'ENDED' ELSE status END,
               ended_at = CASE WHEN $2::text IS NOT NULL OR $3::text IS NOT NULL THEN COALESCE(ended_at, NOW()) ELSE ended_at END,
               updated_at = NOW()
           WHERE id = $1 RETURNING *`,
          [
            voiceSession.id,
            recordingUrl || historicalRecordingUrl,
            recordingId || historicalRecordingId,
            Number.isFinite(durationSeconds) ? durationSeconds : historicalEvent.rows[0]?.duration_seconds || null
          ]
        );
        voiceSession = mergedVoice.rows[0] || voiceSession;
      }
    }

    res.status(201).json({
      status: "ok",
      message: "Ticket telefónico creado",
      ticket,
      manual_intake: metadata,
      voice_session: sanitizeVoiceSessionRow(voiceSession, { includeCredentials: false })
    });
  } catch (error) {
    console.error("[MANUAL PHONE TICKET ERROR]", error);
    res.status(500).json({ status: "error", message: error.message || "No fue posible crear el ticket telefónico" });
  }
});

app.post("/tickets/:id/location-request", async (req, res) => {
  if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere sesión operacional")) return;
  if (!(await checkTicketParticipantAccess(req, res, req.params.id))) return;
  try {
    await ensurePhoneLocationRequestSchema();
    const ticketResult = await pool.query(
      `SELECT t.id, t.state, t.source_type, cc.name AS control_center_name
       FROM tickets t JOIN control_centers cc ON cc.id = t.control_center_id
       WHERE t.id = $1 LIMIT 1`,
      [req.params.id]
    );
    const ticket = ticketResult.rows[0];
    if (!ticket) return res.status(404).json({ status: "error", message: "Ticket no encontrado" });
    if (["CLOSED", "CANCELLED", "RESOLVED"].includes(String(ticket.state || "").toUpperCase())) {
      return res.status(409).json({ status: "error", message: "No se puede solicitar ubicación para un ticket cerrado" });
    }

    const destinationPhone = String(req.body?.phone || "").trim().slice(0, 40) || null;
    const ttlMinutes = Math.max(5, Math.min(60, Number(process.env.PHONE_LOCATION_REQUEST_TTL_MINUTES || 20)));
    const rawToken = crypto.randomBytes(32).toString("base64url");
    const tokenHash = locationRequestTokenHash(rawToken);

    await pool.query(
      `UPDATE ticket_location_requests
       SET status = 'REPLACED', updated_at = NOW()
       WHERE ticket_id = $1 AND status = 'PENDING'`,
      [ticket.id]
    );
    const requestResult = await pool.query(
      `INSERT INTO ticket_location_requests (
         ticket_id, token_hash, destination_phone, requested_by, expires_at
       ) VALUES ($1,$2,$3,$4,NOW() + ($5::int * INTERVAL '1 minute'))
       RETURNING id, expires_at`,
      [ticket.id, tokenHash, destinationPhone, req.panel_session?.sub || null, ttlMinutes]
    );

    await pool.query(
      `INSERT INTO ticket_actions (
         ticket_id, actor_user_id, actor_role, action_type, description, metadata
       ) VALUES ($1,$2,$3,'LOCATION_REQUEST_SENT',$4,$5)`,
      [
        ticket.id,
        req.panel_session?.sub || null,
        req.panel_session?.role || "OPERATOR",
        "Operador generó enlace seguro para solicitar ubicación al llamante",
        JSON.stringify({
          location_request_id: requestResult.rows[0].id,
          destination_phone: destinationPhone,
          expires_at: requestResult.rows[0].expires_at
        })
      ]
    );

    const url = `${sosPublicBaseUrl(req)}/public/location-request/${rawToken}`;
    res.status(201).json({
      status: "ok",
      location_request: {
        id: requestResult.rows[0].id,
        url,
        expires_at: requestResult.rows[0].expires_at,
        destination_phone: destinationPhone,
        control_center_name: ticket.control_center_name
      }
    });
  } catch (error) {
    console.error("[CREATE TICKET LOCATION REQUEST ERROR]", error);
    res.status(500).json({ status: "error", message: error.message || "No fue posible generar el enlace de ubicación" });
  }
});

app.get("/public/location-request/:token", locationRequestRateLimit, async (req, res) => {
  try {
    res.setHeader("Permissions-Policy", "geolocation=(self), camera=(), microphone=()");
    await ensurePhoneLocationRequestSchema();
    const tokenHash = locationRequestTokenHash(req.params.token);
    const result = await pool.query(
      `SELECT lr.status, lr.expires_at, cc.name AS control_center_name
       FROM ticket_location_requests lr
       JOIN tickets t ON t.id = lr.ticket_id
       JOIN control_centers cc ON cc.id = t.control_center_id
       WHERE lr.token_hash = $1 LIMIT 1`,
      [tokenHash]
    );
    const request = result.rows[0];
    const available = request && request.status === "PENDING" && new Date(request.expires_at).getTime() > Date.now();
    res.setHeader("Permissions-Policy", "geolocation=(self)");
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Compartir ubicación · SOS Municipal</title>
<style>body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#eef2f7;color:#0f172a;display:grid;min-height:100vh;place-items:center;padding:18px;box-sizing:border-box}.card{width:min(560px,100%);background:#fff;border-radius:26px;padding:28px;box-shadow:0 20px 60px #0f172a22;text-align:center}.icon{font-size:52px}h1{margin:10px 0}p{color:#475569;line-height:1.5}.notice{background:#eff6ff;border:1px solid #bfdbfe;padding:13px;border-radius:14px;text-align:left}button{width:100%;border:0;border-radius:15px;padding:15px;font-size:17px;font-weight:900;background:#dc2626;color:#fff;margin-top:16px}button:disabled{background:#94a3b8}.status{min-height:26px;margin-top:14px;font-weight:800}.ok{color:#15803d}.error{color:#b91c1c}</style></head>
<body><main class="card"><div class="icon">📍</div><h1>Compartir ubicación</h1>
<p>${available ? `El <strong>${String(request.control_center_name || "Centro de Control Municipal").replace(/[<>&"]/g, "")}</strong> necesita ubicar correctamente la emergencia que informaste.` : "Este enlace ya fue utilizado, reemplazado o venció."}</p>
<div class="notice">Tu ubicación se enviará solamente cuando presiones el botón y autorices el GPS del teléfono.</div>
<form id="locationForm" method="post" action="${sosPublicBaseUrl(req)}/public/location-request/${encodeURIComponent(req.params.token)}/position"><input type="hidden" name="latitude"><input type="hidden" name="longitude"><input type="hidden" name="accuracy"></form>
<button id="send" ${available ? "" : "disabled"}>Compartir mi ubicación actual</button><div id="status" class="status"></div></main>
<script>const button=document.getElementById('send'),statusEl=document.getElementById('status'),form=document.getElementById('locationForm');button?.addEventListener('click',()=>{if(!navigator.geolocation){statusEl.className='status error';statusEl.textContent='Este teléfono no permite obtener ubicación.';return;}button.disabled=true;statusEl.className='status';statusEl.textContent='Obteniendo GPS de alta precisión…';navigator.geolocation.getCurrentPosition(p=>{form.elements.latitude.value=String(p.coords.latitude);form.elements.longitude.value=String(p.coords.longitude);form.elements.accuracy.value=String(p.coords.accuracy);statusEl.textContent='Enviando ubicación…';form.submit();},e=>{button.disabled=false;statusEl.className='status error';statusEl.textContent=e.code===1?'Debes permitir el acceso a ubicación para continuar.':'No pudimos obtener un GPS preciso. Intenta nuevamente al aire libre.';},{enableHighAccuracy:true,timeout:20000,maximumAge:0});});</script></body></html>`);
  } catch (error) {
    res.status(500).type("text").send("No fue posible abrir la solicitud de ubicación.");
  }
});

function sendPublicLocationResponse(req, res, status, payload) {
  if (!req.is("application/x-www-form-urlencoded")) return res.status(status).json(payload);
  const ok = status >= 200 && status < 300;
  const message = String(payload.message || (ok ? "Ubicación enviada correctamente" : "No fue posible enviar la ubicación"))
    .replace(/[<>&"]/g, "");
  return res.status(status).type("html").send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ubicación · SOS Municipal</title><style>body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#eef2f7;color:#0f172a;display:grid;min-height:100vh;place-items:center;padding:18px;box-sizing:border-box}.card{width:min(560px,100%);background:#fff;border-radius:26px;padding:32px;box-shadow:0 20px 60px #0f172a22;text-align:center}.icon{font-size:58px}h1{margin:12px 0}p{color:#475569;line-height:1.5;font-size:18px}</style></head><body><main class="card"><div class="icon">${ok ? "✅" : "⚠️"}</div><h1>${ok ? "Ubicación compartida" : "No fue posible completar el envío"}</h1><p>${message}</p><p>${ok ? "Ya puedes cerrar esta página y volver a WhatsApp." : "Vuelve a WhatsApp y solicita un nuevo enlace si el problema continúa."}</p></main></body></html>`);
}

app.post("/public/location-request/:token/position", locationRequestRateLimit, express.urlencoded({ extended: false }), async (req, res) => {
  const client = await pool.connect();
  try {
    await ensurePhoneLocationRequestSchema();
    const latitude = Number(req.body?.latitude);
    const longitude = Number(req.body?.longitude);
    const accuracy = Number(req.body?.accuracy);
    const maxAccuracy = Math.max(30, Number(process.env.PHONE_LOCATION_MAX_ACCURACY_METERS || 200));
    const absoluteAccuracyLimit = Math.max(maxAccuracy, Number(process.env.PHONE_LOCATION_ABSOLUTE_MAX_ACCURACY_METERS || 5000));
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      return sendPublicLocationResponse(req, res, 400, { status: "error", message: "El teléfono entregó coordenadas inválidas" });
    }
    if (!Number.isFinite(accuracy) || accuracy > absoluteAccuracyLimit) {
      return sendPublicLocationResponse(req, res, 422, { status: "error", message: `La ubicación es demasiado imprecisa (${Math.round(accuracy || 0)} m). Intenta nuevamente al aire libre.` });
    }
    const lowPrecision = accuracy > maxAccuracy;

    await client.query("BEGIN");
    const requestResult = await client.query(
      `SELECT lr.*, t.state
       FROM ticket_location_requests lr JOIN tickets t ON t.id = lr.ticket_id
       WHERE lr.token_hash = $1 FOR UPDATE`,
      [locationRequestTokenHash(req.params.token)]
    );
    const request = requestResult.rows[0];
    if (!request || request.status !== "PENDING" || new Date(request.expires_at).getTime() <= Date.now()) {
      await client.query("ROLLBACK");
      return sendPublicLocationResponse(req, res, 410, { status: "error", message: "El enlace ya fue utilizado o venció" });
    }
    if (["CLOSED", "CANCELLED", "RESOLVED"].includes(String(request.state || "").toUpperCase())) {
      await client.query("ROLLBACK");
      return sendPublicLocationResponse(req, res, 409, { status: "error", message: "Este caso ya fue cerrado" });
    }

    const ticketResult = await client.query(
      `UPDATE tickets SET latitude=$2, longitude=$3, accuracy=$4, updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [request.ticket_id, latitude, longitude, accuracy]
    );
    await client.query(
      `UPDATE ticket_location_requests SET status='COMPLETED', completed_at=NOW(),
       latitude=$2, longitude=$3, accuracy=$4, updated_at=NOW() WHERE id=$1`,
      [request.id, latitude, longitude, accuracy]
    );
    await client.query(
      `INSERT INTO ticket_actions (ticket_id, actor_role, action_type, description, metadata)
       VALUES ($1,'EXTERNAL_CALLER','LOCATION_SHARED',$2,$3)`,
      [request.ticket_id, lowPrecision
        ? `Llamante compartió ubicación GPS aproximada (${Math.round(accuracy)} m de precisión)`
        : "Llamante compartió su ubicación GPS mediante enlace seguro", JSON.stringify({
        location_request_id: request.id,
        latitude,
        longitude,
        accuracy,
        low_precision: lowPrecision,
        preferred_max_accuracy_meters: maxAccuracy
      })]
    );
    await client.query("COMMIT");
    await classifyAndPersistTicketSector(ticketResult.rows[0]).catch(error => console.warn("[PHONE LOCATION SECTOR WARNING]", error.message));
    sendPublicLocationResponse(req, res, 200, {
      status: "ok",
      message: lowPrecision
        ? `Ubicación aproximada recibida (${Math.round(accuracy)} m de precisión)`
        : "Ubicación recibida correctamente",
      accuracy,
      low_precision: lowPrecision
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    console.error("[PHONE LOCATION SUBMIT ERROR]", error);
    sendPublicLocationResponse(req, res, 500, { status: "error", message: "No fue posible actualizar la ubicación" });
  } finally {
    client.release();
  }
});

app.post("/tickets/:id/acknowledge", async (req, res) => {
  if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere sesión operacional")) return;
  if (!(await checkTicketParticipantAccess(req, res, req.params.id))) return;
  try {
    const { id } = req.params;
    const { operator_user_id } = req.body;

    const result = await pool.query(
      `
      UPDATE tickets
      SET
        state = 'ACKNOWLEDGED',
        acknowledged_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Ticket not found"
      });
    }

    const ticket = result.rows[0];

    await pool.query(
      `
      INSERT INTO ticket_actions (
        ticket_id,
        actor_user_id,
        actor_role,
        action_type,
        description
      )
      VALUES ($1,$2,'OPERATOR','ACKNOWLEDGED',$3)
      `,
      [
        ticket.id,
        operator_user_id || null,
        "Operador tomó conocimiento del caso"
      ]
    );

    res.json({
      status: "ok",
      message: "Ticket acknowledged",
      ticket
    });

  } catch (error) {
    console.error("[ACK TICKET ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/debug/set-role", async (req, res) => {
  if (!requireDebugAccess(req, res)) return;
  try {
    const { phone, role } = req.body;

    const validRoles = [
      "NEIGHBOR",
      "RESOLVER",
      "OPERATOR",
      "ADMIN"
    ];

    if (!validRoles.includes(role)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid role"
      });
    }

    const result = await pool.query(
      `
      UPDATE users
      SET role = $1,
          updated_at = NOW()
      WHERE phone = $2
      RETURNING id, full_name, phone, role
      `,
      [role, phone]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    res.json({
      status: "ok",
      user: result.rows[0]
    });

  } catch (error) {
    console.error("[SET ROLE ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.get("/debug/users", async (req, res) => {
  if (!requireDebugAccess(req, res)) return;
  try {
    const result = await pool.query(`
      SELECT
        id,
        full_name,
        role,
        phone,
        control_center_id,
        validation_status,
        created_at
      FROM users
      ORDER BY created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("[DEBUG USERS ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});


function requireAdminTokenIfConfigured(req, res) {
  const configured = process.env.ADMIN_TOKEN;
  const provided = req.headers["x-admin-token"] || req.headers["authorization"]?.replace(/^Bearer\s+/i, "");
  if (configured && provided === configured) return true;
  return checkRoleAccess(req, res, ["ADMIN", "SUPER_ADMIN"], "Se requiere sesión ADMIN o ADMIN_TOKEN");
}

function maxResolverGpsAccuracyMeters() {
  return Number(process.env.RESOLVER_GPS_MAX_ACCURACY_METERS || 150);
}

app.post("/debug/resolver-location", async (req, res) => {
  if (!requireDebugAccess(req, res)) return;
  try {
    const {
      user_id,
      latitude,
      longitude,
      accuracy = 10,
      status = "AVAILABLE"
    } = req.body;

    const userResult = await pool.query(
      `
      SELECT control_center_id
      FROM users
      WHERE id = $1
      `,
      [user_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    const control_center_id = userResult.rows[0].control_center_id;

    await pool.query(
      `
      INSERT INTO resolver_locations (
        user_id,
        control_center_id,
        latitude,
        longitude,
        accuracy,
        status,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        accuracy = EXCLUDED.accuracy,
        status = EXCLUDED.status,
        updated_at = NOW()
      `,
      [
        user_id,
        control_center_id,
        latitude,
        longitude,
        accuracy,
        status
      ]
    );

    res.json({ status: "ok" });

  } catch (error) {
    console.error("[RESOLVER LOCATION ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});



app.post("/tickets/:id/accept", async (req, res) => {
  if (!checkIdentityAccess(req, res, ["RESOLVER", "ADMIN", "SUPER_ADMIN"], req.body?.resolver_user_id, "Sesión de resolutor requerida")) return;
  try {
    const { id } = req.params;
    const { resolver_user_id } = req.body;

    if (!resolver_user_id) {
      return res.status(400).json({
        status: "error",
        message: "resolver_user_id is required"
      });
    }

    const assignmentResult = await pool.query(
      `
      SELECT *
      FROM ticket_assignments
      WHERE ticket_id = $1
        AND resolver_user_id = $2
        AND state = 'PENDING'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [id, resolver_user_id]
    );

    if (assignmentResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "No pending assignment found for this resolver"
      });
    }

    await pool.query(
      `
      UPDATE ticket_assignments
      SET
        state = 'ACCEPTED',
        accepted_at = NOW()
      WHERE id = $1
      `,
      [assignmentResult.rows[0].id]
    );

    const ticketResult = await pool.query(
      `
      UPDATE tickets
      SET
        state = 'ACCEPTED_BY_RESOLVER',
        assigned_resolver_id = $1,
        updated_at = NOW()
      WHERE id = $2
      RETURNING *
      `,
      [resolver_user_id, id]
    );

    await pool.query(
      `
      UPDATE resolver_locations
      SET
        status = 'BUSY',
        updated_at = NOW()
      WHERE user_id = $1
      `,
      [resolver_user_id]
    );

    await pool.query(
      `
      INSERT INTO ticket_actions (
        ticket_id,
        actor_user_id,
        actor_role,
        action_type,
        description
      )
      VALUES ($1,$2,'RESOLVER','RESOLVER_ACCEPTED',$3)
      `,
      [
        id,
        resolver_user_id,
        "Resolutor aceptó el caso"
      ]
    );

    res.json({
      status: "ok",
      message: "Ticket accepted by resolver",
      ticket: ticketResult.rows[0]
    });

  } catch (error) {
    console.error("[ACCEPT TICKET ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/tickets/:id/en-route", async (req, res) => {
  if (!checkIdentityAccess(req, res, ["RESOLVER", "ADMIN", "SUPER_ADMIN"], req.body?.resolver_user_id, "Sesión de resolutor requerida")) return;
  try {
    const { id } = req.params;
    const { resolver_user_id } = req.body;

    if (!resolver_user_id) {
      return res.status(400).json({
        status: "error",
        message: "resolver_user_id is required"
      });
    }

    const ticketResult = await pool.query(
      `
      UPDATE tickets
      SET
        state = 'EN_ROUTE',
        updated_at = NOW()
      WHERE id = $1
        AND assigned_resolver_id = $2
      RETURNING *
      `,
      [id, resolver_user_id]
    );

    if (ticketResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Ticket not found or resolver not assigned"
      });
    }

    await pool.query(
      `
      UPDATE resolver_locations
      SET
        status = 'EN_ROUTE',
        updated_at = NOW()
      WHERE user_id = $1
      `,
      [resolver_user_id]
    );

    await pool.query(
      `
      INSERT INTO ticket_actions (
        ticket_id,
        actor_user_id,
        actor_role,
        action_type,
        description
      )
      VALUES ($1,$2,'RESOLVER','RESOLVER_EN_ROUTE',$3)
      `,
      [
        id,
        resolver_user_id,
        "Resolutor se dirige al lugar"
      ]
    );

    res.json({
      status: "ok",
      message: "Resolver en route",
      ticket: ticketResult.rows[0]
    });

  } catch (error) {
    console.error("[EN ROUTE TICKET ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/tickets/:id/on-site", async (req, res) => {
  if (!checkIdentityAccess(req, res, ["RESOLVER", "ADMIN", "SUPER_ADMIN"], req.body?.resolver_user_id, "Sesión de resolutor requerida")) return;
  try {
    const { id } = req.params;
    const { resolver_user_id } = req.body;

    if (!resolver_user_id) {
      return res.status(400).json({
        status: "error",
        message: "resolver_user_id is required"
      });
    }

    const ticketResult = await pool.query(
      `
      UPDATE tickets
      SET
        state = 'ON_SITE',
        updated_at = NOW()
      WHERE id = $1
        AND assigned_resolver_id = $2
      RETURNING *
      `,
      [id, resolver_user_id]
    );

    if (ticketResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Ticket not found or resolver not assigned"
      });
    }

    await pool.query(
      `
      UPDATE resolver_locations
      SET
        status = 'ON_SITE',
        updated_at = NOW()
      WHERE user_id = $1
      `,
      [resolver_user_id]
    );

    await pool.query(
      `
      INSERT INTO ticket_actions (
        ticket_id,
        actor_user_id,
        actor_role,
        action_type,
        description
      )
      VALUES ($1,$2,'RESOLVER','RESOLVER_ON_SITE',$3)
      `,
      [
        id,
        resolver_user_id,
        "Resolutor llegó al lugar"
      ]
    );

    res.json({
      status: "ok",
      message: "Resolver on site",
      ticket: ticketResult.rows[0]
    });

  } catch (error) {
    console.error("[ON SITE TICKET ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/tickets/:id/resolve", async (req, res) => {
  if (!checkIdentityAccess(req, res, ["RESOLVER", "ADMIN", "SUPER_ADMIN"], req.body?.resolver_user_id, "Sesión de resolutor requerida")) return;
  try {
    const { id } = req.params;
    const {
      resolver_user_id,
      resolution_notes
    } = req.body;

    if (!resolver_user_id) {
      return res.status(400).json({
        status: "error",
        message: "resolver_user_id is required"
      });
    }

    const ticketResult = await pool.query(
      `
      UPDATE tickets
      SET
        state = 'RESOLVED',
        resolved_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
        AND assigned_resolver_id = $2
      RETURNING *
      `,
      [id, resolver_user_id]
    );

    if (ticketResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Ticket not found or resolver not assigned"
      });
    }

    await pool.query(
      `
      UPDATE resolver_locations
      SET
        status = 'AVAILABLE',
        updated_at = NOW()
      WHERE user_id = $1
      `,
      [resolver_user_id]
    );

    await pool.query(
      `
      INSERT INTO ticket_actions (
        ticket_id,
        actor_user_id,
        actor_role,
        action_type,
        description,
        metadata
      )
      VALUES ($1,$2,'RESOLVER','TICKET_RESOLVED',$3,$4)
      `,
      [
        id,
        resolver_user_id,
        "Resolutor marcó el caso como resuelto",
        JSON.stringify({
          resolution_notes: resolution_notes || null
        })
      ]
    );

    if (resolution_notes) {
      await pool.query(
        `
        INSERT INTO ticket_notes (
          ticket_id,
          author_user_id,
          note
        )
        VALUES ($1,$2,$3)
        `,
        [
          id,
          resolver_user_id,
          resolution_notes
        ]
      );
    }

    const nextAssignment = await assignNextQueuedTicketToResolver(resolver_user_id, {
      trigger: "TICKET_RESOLVED",
      resolved_ticket_id: id
    }).catch((error) => {
      console.warn("[AUTO QUEUE AFTER RESOLVE ERROR]", error.message);
      return { assigned: false, reason: error.message };
    });

    res.json({
      status: "ok",
      message: nextAssignment?.assigned
        ? "Ticket resolved; next queued ticket assigned"
        : "Ticket resolved",
      ticket: ticketResult.rows[0],
      next_assignment: nextAssignment || null
    });

  } catch (error) {
    console.error("[RESOLVE TICKET ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/tickets/:id/close", async (req, res) => {
  if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere sesión operacional")) return;
  if (!(await checkTicketParticipantAccess(req, res, req.params.id))) return;
  try {
    const { id } = req.params;
    const {
      operator_user_id,
      closing_notes
    } = req.body;

    const ticketResult = await pool.query(
      `
      UPDATE tickets
      SET
        state = 'CLOSED',
        closed_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [id]
    );

    if (ticketResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Ticket not found"
      });
    }

    await syncMobileEventStateFromTicket(id, "CLOSED");
    await releaseResolverFromTicket(id, "TICKET_CLOSED_BY_OPERATOR").catch((error) => {
      console.warn("[RESOLVER RELEASE WARNING] close:", error.message);
    });

    await pool.query(
      `
      INSERT INTO ticket_actions (
        ticket_id,
        actor_user_id,
        actor_role,
        action_type,
        description,
        metadata
      )
      VALUES ($1,$2,'OPERATOR','TICKET_CLOSED',$3,$4)
      `,
      [
        id,
        operator_user_id || null,
        "Operador cerró administrativamente el caso",
        JSON.stringify({
          closing_notes: closing_notes || null
        })
      ]
    );

    if (closing_notes) {
      await pool.query(
        `
        INSERT INTO ticket_notes (
          ticket_id,
          author_user_id,
          note
        )
        VALUES ($1,$2,$3)
        `,
        [
          id,
          operator_user_id || null,
          closing_notes
        ]
      );
    }

    res.json({
      status: "ok",
      message: "Ticket closed",
      ticket: ticketResult.rows[0]
    });

  } catch (error) {
    console.error("[CLOSE TICKET ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/tickets/:id/reject", async (req, res) => {
  if (!checkIdentityAccess(req, res, ["RESOLVER", "ADMIN", "SUPER_ADMIN"], req.body?.resolver_user_id, "Sesión de resolutor requerida")) return;
  try {
    const { id } = req.params;
    const {
      resolver_user_id,
      reject_reason
    } = req.body;

    if (!resolver_user_id) {
      return res.status(400).json({
        status: "error",
        message: "resolver_user_id is required"
      });
    }

    const ticketBeforeResult = await pool.query(
      `
      SELECT *
      FROM tickets
      WHERE id = $1
        AND state NOT IN ('CLOSED','CANCELLED','RESOLVED')
      LIMIT 1
      `,
      [id]
    );

    if (!ticketBeforeResult.rows.length) {
      return res.status(404).json({
        status: "error",
        message: "Ticket no encontrado o ya cerrado"
      });
    }

    const ticketBefore = ticketBeforeResult.rows[0];

    if (
      ticketBefore.assigned_resolver_id &&
      String(ticketBefore.assigned_resolver_id) !== String(resolver_user_id)
    ) {
      return res.status(409).json({
        status: "error",
        code: "TICKET_ASSIGNED_TO_ANOTHER_RESOLVER",
        message: "Este caso está asignado a otro resolutor. No se puede rechazar desde esta sesión.",
        ticket_id: id,
        assigned_resolver_id: ticketBefore.assigned_resolver_id,
        requested_resolver_user_id: resolver_user_id
      });
    }

    if (!ticketBefore.assigned_resolver_id) {
      return res.status(409).json({
        status: "error",
        code: "TICKET_NOT_ASSIGNED",
        message: "Este caso no tiene resolutor asignado. No se puede rechazar desde la App Resolutor.",
        ticket_id: id,
        requested_resolver_user_id: resolver_user_id
      });
    }

    const assignmentUpdate = await pool.query(
      `
      UPDATE ticket_assignments
      SET
        state = 'REJECTED',
        rejected_at = NOW(),
        updated_at = NOW()
      WHERE ticket_id = $1
        AND resolver_user_id = $2
        AND state IN ('PENDING','ACCEPTED')
      RETURNING *
      `,
      [id, resolver_user_id]
    );

    // Even if the assignment row was already marked as REJECTED, the ticket must not remain locked
    // to that resolver. This fixes manual assignment + resolver rejection flows.
    const ticketResult = await pool.query(
      `
      UPDATE tickets
      SET
        assigned_resolver_id = NULL,
        state = CASE
          WHEN state IN ('CLOSED','CANCELLED','RESOLVED') THEN state
          ELSE 'ACTIVE'
        END,
        assigned_at = NULL,
        updated_at = NOW()
      WHERE id = $1
        AND assigned_resolver_id = $2
        AND state NOT IN ('CLOSED','CANCELLED','RESOLVED')
      RETURNING *
      `,
      [id, resolver_user_id]
    );

    const releasedTicket = ticketResult.rows[0] || ticketBefore;

    await pool.query(
      `
      UPDATE resolver_locations rl
      SET
        status = 'AVAILABLE',
        updated_at = NOW()
      WHERE rl.user_id = $1
        AND NOT EXISTS (
          SELECT 1
          FROM tickets t
          WHERE t.assigned_resolver_id = $1
            AND t.id <> $2
            AND t.state IN ('ASSIGNED','ACCEPTED_BY_RESOLVER','EN_ROUTE','ON_SITE')
        )
      `,
      [resolver_user_id, id]
    ).catch(() => null);

    await pool.query(
      `
      INSERT INTO ticket_actions (
        ticket_id,
        actor_user_id,
        actor_role,
        action_type,
        description,
        metadata
      )
      VALUES ($1,$2,'RESOLVER','RESOLVER_REJECTED',$3,$4)
      `,
      [
        id,
        resolver_user_id,
        "Resolutor rechazó el caso. El ticket queda liberado para reasignación.",
        JSON.stringify({
          reject_reason: reject_reason || null,
          previous_assigned_resolver_id: ticketBefore.assigned_resolver_id || null,
          assignment_rows_rejected: assignmentUpdate.rows.length
        })
      ]
    );

    const excludedAfterReject = Array.from(new Set([
      normalizeResolverId(resolver_user_id),
      ...(await getRejectedResolverIdsForTicket(id))
    ].filter(Boolean)));

    const reassignment = await autoAssignResolver(releasedTicket, {
      force: true,
      excludeResolverUserIds: excludedAfterReject
    });

    const nextAssignment = await assignNextQueuedTicketToResolver(resolver_user_id, {
      trigger: "TICKET_REJECTED_RESOLVER_FREE",
      rejected_ticket_id: id,
      excludeTicketIds: [id],
      reason: "Autoasignación de cola tras rechazo y liberación del resolutor"
    }).catch((error) => {
      console.warn("[AUTO QUEUE AFTER REJECT ERROR]", error.message);
      return { assigned: false, reason: error.message };
    });

    res.json({
      status: "ok",
      message: nextAssignment?.assigned
        ? "Ticket rejected; next queued ticket assigned to resolver"
        : "Ticket rejected by resolver",
      ticket: reassignment?.ticket || releasedTicket,
      released: true,
      reassigned: !!reassignment,
      rejected_resolver_user_id: resolver_user_id,
      excluded_resolver_user_ids: excludedAfterReject,
      new_resolver: reassignment?.resolver || null,
      next_assignment: nextAssignment || null
    });

  } catch (error) {
    console.error("[REJECT TICKET ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});


app.post("/tickets/:id/manual-assign", async (req, res) => {
  if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere sesión operacional")) return;
  if (!(await checkTicketParticipantAccess(req, res, req.params.id))) return;
  try {
    const { id } = req.params;
    const {
      resolver_user_id,
      operator_user_id = null,
      force = false,
      reason = "Asignación manual desde mapa operacional"
    } = req.body || {};

    if (!resolver_user_id) {
      return res.status(400).json({
        status: "error",
        message: "resolver_user_id is required"
      });
    }

    const assignment = await assignTicketToResolverManually(id, resolver_user_id, {
      force: force === true || String(force).toLowerCase() === "true",
      operator_user_id,
      reason
    });

    res.json({
      status: "ok",
      message: assignment.forced
        ? "Ticket asignado manualmente con forzado operacional"
        : "Ticket asignado manualmente",
      ticket: assignment.ticket,
      resolver: {
        id: assignment.resolver.id,
        full_name: assignment.resolver.full_name,
        phone: assignment.resolver.phone,
        status: assignment.resolver.status,
        active_tickets_count_before: assignment.resolver.active_tickets_count || 0,
        distance_meters: assignment.resolver.distance_meters == null ? null : Math.round(assignment.resolver.distance_meters)
      },
      forced: assignment.forced,
      previous_resolver_user_id: assignment.previous_resolver_user_id
    });
  } catch (error) {
    console.error("[MANUAL ASSIGN TICKET ERROR]", error);
    res.status(error.statusCode || 500).json({
      status: "error",
      code: error.code || "MANUAL_ASSIGN_ERROR",
      message: error.message,
      details: error.details || null
    });
  }
});


app.post("/tickets/:id/auto-assign", async (req, res) => {
  if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere sesión operacional")) return;
  if (!(await checkTicketParticipantAccess(req, res, req.params.id))) return;
  try {
    const { id } = req.params;

    const ticketResult = await pool.query(
      `
      SELECT *
      FROM tickets
      WHERE id = $1
        AND state NOT IN ('CLOSED','CANCELLED','RESOLVED')
      LIMIT 1
      `,
      [id]
    );

    if (!ticketResult.rows.length) {
      return res.status(404).json({
        status: "error",
        message: "Ticket no encontrado o ya cerrado"
      });
    }

    let ticket = ticketResult.rows[0];

    const rejectedResolverIds = await getRejectedResolverIdsForTicket(id);

    const latestAssignmentResult = await pool.query(
      `
      SELECT *
      FROM ticket_assignments
      WHERE ticket_id = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [id]
    ).catch(() => ({ rows: [] }));

    const latestAssignment = latestAssignmentResult.rows?.[0] || null;

    // Safety repair: if a resolver rejected but the ticket still points to that resolver,
    // release it before retrying assignment.
    if (
      latestAssignment &&
      latestAssignment.state === 'REJECTED' &&
      ticket.assigned_resolver_id &&
      String(ticket.assigned_resolver_id) === String(latestAssignment.resolver_user_id)
    ) {
      const released = await pool.query(
        `
        UPDATE tickets
        SET
          assigned_resolver_id = NULL,
          state = 'ACTIVE',
          assigned_at = NULL,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [id]
      );
      ticket = released.rows[0] || ticket;
    }

    const assignment = await autoAssignResolver(ticket, {
      force: true,
      excludeResolverUserIds: rejectedResolverIds
    });

    if (!assignment || !assignment.ticket) {
      return res.status(409).json({
        status: "no_resolver_available",
        message: "No hay resolutores AVAILABLE elegibles para este ticket. Revisa estado, centro de control y ubicación GPS del resolutor. Los resolutores que ya rechazaron este ticket quedan excluidos de la reasignación automática.",
        excluded_resolver_user_ids: rejectedResolverIds
      });
    }

    res.json({
      status: "ok",
      message: "Ticket asignado automáticamente",
      ticket: assignment.ticket,
      excluded_resolver_user_ids: rejectedResolverIds,
      resolver: {
        id: assignment.resolver.id,
        full_name: assignment.resolver.full_name,
        phone: assignment.resolver.phone,
        status: assignment.resolver.status,
        distance_meters: Math.round(assignment.resolver.distance_meters || 0)
      }
    });
  } catch (error) {
    console.error("[AUTO ASSIGN TICKET ERROR]", error);
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});


app.post("/tickets/:id/messages", async (req, res) => {
  try {
    const { id } = req.params;
    if (!(await checkTicketParticipantAccess(req, res, id))) return;
    const {
      message,
      sender_role = "NEIGHBOR",
      sender_name = "Vecino"
    } = req.body;

    const cleanMessage = String(message || "").trim();

    if (!cleanMessage) {
      return res.status(400).json({
        status: "error",
        message: "message is required"
      });
    }

    const ticketCheck = await pool.query(
      `SELECT id FROM tickets WHERE id = $1`,
      [id]
    );

    if (ticketCheck.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Ticket not found"
      });
    }

    // Los mensajes operativos se guardan solo como ticket_actions.
    // SOS-MAP los muestra en la sección Comunicaciones.
    // No se duplican en ticket_notes; Notas queda reservado para cierre, resolución o notas internas.
    const actionResult = await pool.query(
      `
      INSERT INTO ticket_actions (
        ticket_id,
        actor_user_id,
        actor_role,
        action_type,
        description,
        metadata
      )
      VALUES ($1,NULL,$2,'MESSAGE_TEXT',$3,$4)
      RETURNING *
      `,
      [
        id,
        sender_role,
        `${sender_name} envió un mensaje de texto`,
        JSON.stringify({
          channel: "text",
          message: cleanMessage,
          sender_name
        })
      ]
    );

    await pool.query(
      `UPDATE tickets SET updated_at = NOW() WHERE id = $1`,
      [id]
    );

    res.json({
      status: "ok",
      message: "Message stored",
      action: actionResult.rows[0]
    });

  } catch (error) {
    console.error("[TICKET MESSAGE ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/tickets/:id/media", async (req, res) => {
  try {
    const { id } = req.params;
    if (!(await checkTicketParticipantAccess(req, res, id))) return;
    const {
      media_type,
      data_url,
      file_name,
      sender_role = "NEIGHBOR",
      sender_name = "Vecino"
    } = req.body;

    if (!["audio", "video"].includes(media_type)) {
      return res.status(400).json({
        status: "error",
        message: "media_type must be audio or video"
      });
    }

    const parsed = parseDataUrl(data_url);

    if (!parsed) {
      return res.status(400).json({
        status: "error",
        message: "data_url must be a valid base64 data URL"
      });
    }

    const maxBytes = media_type === "video"
      ? 25 * 1024 * 1024
      : 8 * 1024 * 1024;

    if (parsed.buffer.length > maxBytes) {
      return res.status(413).json({
        status: "error",
        message: "media file too large"
      });
    }

    const ticketCheck = await pool.query(
      `SELECT id FROM tickets WHERE id = $1`,
      [id]
    );

    if (ticketCheck.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Ticket not found"
      });
    }

    const ext = safeFileExtension(parsed.mimeType, media_type);
    const safeTicket = String(id).replace(/[^a-zA-Z0-9_-]/g, "");
    const uploadName = `${safeTicket}-${Date.now()}-${media_type}.${ext}`;
    const uploadPath = path.join(UPLOAD_DIR, uploadName);

    fs.writeFileSync(uploadPath, parsed.buffer);

    const mediaUrl = `${publicBaseUrl(req)}/uploads/${uploadName}`;
    const actionType = media_type === "audio" ? "MEDIA_AUDIO" : "MEDIA_VIDEO";

    const actionResult = await pool.query(
      `
      INSERT INTO ticket_actions (
        ticket_id,
        actor_user_id,
        actor_role,
        action_type,
        description,
        metadata
      )
      VALUES ($1,NULL,$2,$3,$4,$5)
      RETURNING *
      `,
      [
        id,
        sender_role,
        actionType,
        `${sender_name} envió ${media_type === "audio" ? "un audio" : "un video"}`,
        JSON.stringify({
          channel: media_type,
          media_type,
          media_url: mediaUrl,
          file_name: file_name || uploadName,
          mime_type: parsed.mimeType,
          size_bytes: parsed.buffer.length,
          sender_name
        })
      ]
    );

    await pool.query(
      `UPDATE tickets SET updated_at = NOW() WHERE id = $1`,
      [id]
    );

    res.json({
      status: "ok",
      message: "Media stored",
      media_url: mediaUrl,
      action: actionResult.rows[0]
    });

  } catch (error) {
    console.error("[TICKET MEDIA ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/tickets/:id/call-start", async (req, res) => {
  try {
    const { id } = req.params;
    if (!(await checkTicketParticipantAccess(req, res, id))) return;
    const {
      mode = "video",
      sender_role = "NEIGHBOR",
      sender_name = "Vecino"
    } = req.body;

    if (!["voice", "video"].includes(mode)) {
      return res.status(400).json({
        status: "error",
        message: "mode must be voice or video"
      });
    }

    const ticketCheck = await pool.query(
      `SELECT id FROM tickets WHERE id = $1`,
      [id]
    );

    if (ticketCheck.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Ticket not found"
      });
    }

    const actionType = mode === "voice" ? "CALL_VOICE" : "CALL_VIDEO";
    const isOperator = sender_role === "OPERATOR";
    const description = isOperator
      ? `Central SOS solicitó ${mode === "voice" ? "llamada de voz" : "videollamada"} al vecino`
      : `${sender_name} solicitó ${mode === "voice" ? "llamada de voz" : "videollamada"}`;

    const actionResult = await pool.query(
      `
      INSERT INTO ticket_actions (
        ticket_id,
        actor_user_id,
        actor_role,
        action_type,
        description,
        metadata
      )
      VALUES ($1,NULL,$2,$3,$4,$5)
      RETURNING *
      `,
      [
        id,
        sender_role,
        actionType,
        description,
        JSON.stringify({
          channel: mode,
          mode,
          direction: isOperator ? "central_to_neighbor" : "neighbor_to_central",
          sender_name
        })
      ]
    );

    await pool.query(
      `UPDATE tickets SET updated_at = NOW() WHERE id = $1`,
      [id]
    );

    res.json({
      status: "ok",
      message: "Internal call request stored",
      mode,
      action: actionResult.rows[0]
    });

  } catch (error) {
    console.error("[TICKET CALL ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/tickets/:id/call-response", async (req, res) => {
  try {
    const { id } = req.params;
    if (!(await checkTicketParticipantAccess(req, res, id))) return;
    const {
      request_action_id = null,
      response,
      mode = "voice",
      sender_role = "NEIGHBOR",
      sender_name = "Vecino"
    } = req.body;

    if (!["ACCEPTED", "REJECTED"].includes(response)) {
      return res.status(400).json({
        status: "error",
        message: "response must be ACCEPTED or REJECTED"
      });
    }

    if (!["voice", "video"].includes(mode)) {
      return res.status(400).json({
        status: "error",
        message: "mode must be voice or video"
      });
    }

    const ticketCheck = await pool.query(
      `SELECT id FROM tickets WHERE id = $1`,
      [id]
    );

    if (ticketCheck.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Ticket not found"
      });
    }

    const actionType = response === "ACCEPTED" ? "CALL_ACCEPTED" : "CALL_REJECTED";
    const description = response === "ACCEPTED"
      ? `${sender_name} aceptó la ${mode === "voice" ? "llamada de voz" : "videollamada"}`
      : `${sender_name} rechazó la ${mode === "voice" ? "llamada de voz" : "videollamada"}`;

    const actionResult = await pool.query(
      `
      INSERT INTO ticket_actions (
        ticket_id,
        actor_user_id,
        actor_role,
        action_type,
        description,
        metadata
      )
      VALUES ($1,NULL,$2,$3,$4,$5)
      RETURNING *
      `,
      [
        id,
        sender_role,
        actionType,
        description,
        JSON.stringify({
          channel: mode,
          mode,
          response,
          request_action_id,
          sender_name
        })
      ]
    );

    await pool.query(
      `UPDATE tickets SET updated_at = NOW() WHERE id = $1`,
      [id]
    );

    res.json({
      status: "ok",
      message: "Internal call response stored",
      response,
      action: actionResult.rows[0]
    });

  } catch (error) {
    console.error("[TICKET CALL RESPONSE ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

async function getMobileVoiceAccess(eventId, userId = null) {
  if (!userId) {
    const err = new Error('user_id is required');
    err.statusCode = 400;
    throw err;
  }

  const result = await pool.query(
    `
    SELECT
      m.id AS event_id,
      m.user_id,
      t.id AS ticket_id,
      t.state AS ticket_state
    FROM mobile_events m
    LEFT JOIN tickets t
      ON t.source_type = 'MOBILE_APP'
     AND t.source_event_id = m.id
    WHERE m.id = $1
    ORDER BY t.created_at DESC NULLS LAST
    LIMIT 1
    `,
    [eventId]
  );

  const access = result.rows[0] || null;
  if (!access) {
    const err = new Error('Mobile event not found');
    err.statusCode = 404;
    throw err;
  }
  if (userId && access.user_id && String(userId) !== String(access.user_id)) {
    const err = new Error('Mobile event does not belong to user');
    err.statusCode = 403;
    throw err;
  }
  if (!access.ticket_id) {
    const err = new Error('El caso aún no tiene ticket operacional asociado.');
    err.statusCode = 409;
    throw err;
  }
  return access;
}

async function getResolverVoiceAccess(ticketId, resolverUserId) {
  if (!resolverUserId) {
    const err = new Error('resolver_user_id is required');
    err.statusCode = 400;
    throw err;
  }

  const ticket = await fetchTicketVoiceContext(ticketId);
  if (!ticket) {
    const err = new Error('Ticket not found');
    err.statusCode = 404;
    throw err;
  }
  if (String(ticket.assigned_resolver_id || '') !== String(resolverUserId)) {
    const err = new Error('El ticket no está asignado a este resolutor');
    err.statusCode = 403;
    throw err;
  }
  return ticket;
}

app.post("/public/mobile/events/:eventId/voice/request", async (req, res) => {
  try {
    const { eventId } = req.params;
    const { user_id = null } = req.body || {};
    if (!checkIdentityAccess(req, res, ["NEIGHBOR", "ADMIN", "SUPER_ADMIN"], user_id, "Sesión de vecino requerida")) return;

    const eventResult = await pool.query(
      `
      SELECT
        m.*,
        t.id AS ticket_id,
        t.source_type,
        t.source_event_id,
        t.state AS ticket_state
      FROM mobile_events m
      LEFT JOIN tickets t
        ON t.source_type = 'MOBILE_APP'
       AND t.source_event_id = m.id
      WHERE m.id = $1
      ORDER BY t.created_at DESC NULLS LAST
      LIMIT 1
      `,
      [eventId]
    );

    if (eventResult.rows.length === 0) {
      return res.status(404).json({ status: "error", message: "Mobile event not found" });
    }

    const event = eventResult.rows[0];
    if (user_id && event.user_id && String(user_id) !== String(event.user_id)) {
      return res.status(403).json({ status: "error", message: "Mobile event does not belong to user" });
    }

    if (!event.ticket_id) {
      return res.status(409).json({ status: "error", message: "El caso aún no tiene ticket operacional asociado." });
    }

    const ticket = await fetchTicketVoiceContext(event.ticket_id);
    const voiceSession = await createTicketVoiceSession({
      req,
      ticket,
      requestedBy: "NEIGHBOR",
      // La decisión de enrutamiento pertenece al backend, nunca al cliente móvil.
      targetType: ticket?.assigned_resolver_id ? "RESOLVER" : "CENTRAL",
      actorUserId: ticket?.citizen_user_id || null,
      resolverUserId: ticket?.assigned_resolver_id || null
    });

    res.json({
      status: "ok",
      message: "Llamada segura solicitada",
      voice_session: voiceSessionForParticipant(voiceSession, 'party_a')
    });
  } catch (error) {
    console.error("[MOBILE VOICE REQUEST ERROR]", error);
    res.status(error.statusCode || 500).json({
      status: "error",
      message: error.message || "No fue posible solicitar llamada segura"
    });
  }
});


app.post("/public/mobile/events/:eventId/voice/sessions/:sessionId/join", async (req, res) => {
  try {
    const { eventId, sessionId } = req.params;
    const { user_id = null } = req.body || {};
    if (!checkIdentityAccess(req, res, ["NEIGHBOR", "ADMIN", "SUPER_ADMIN"], user_id, "Sesión de vecino requerida")) return;

    const eventResult = await pool.query(
      `
      SELECT
        m.*,
        t.id AS ticket_id,
        t.source_type,
        t.source_event_id,
        t.state AS ticket_state
      FROM mobile_events m
      LEFT JOIN tickets t
        ON t.source_type = 'MOBILE_APP'
       AND t.source_event_id = m.id
      WHERE m.id = $1
      ORDER BY t.created_at DESC NULLS LAST
      LIMIT 1
      `,
      [eventId]
    );

    if (eventResult.rows.length === 0) {
      return res.status(404).json({ status: "error", message: "Mobile event not found" });
    }

    const event = eventResult.rows[0];
    if (user_id && event.user_id && String(user_id) !== String(event.user_id)) {
      return res.status(403).json({ status: "error", message: "Mobile event does not belong to user" });
    }

    if (!event.ticket_id) {
      return res.status(409).json({ status: "error", message: "El caso aún no tiene ticket operacional asociado." });
    }

    const session = await getVoiceSessionForTicket(event.ticket_id, sessionId, { includeCredentials: true });
    if (!session) {
      return res.status(404).json({ status: "error", message: "Voice session not found" });
    }

    res.json({
      status: "ok",
      message: "Credenciales de llamada segura entregadas",
      voice_session: voiceSessionForParticipant(session, 'party_a')
    });
  } catch (error) {
    console.error("[MOBILE VOICE JOIN ERROR]", error);
    res.status(error.statusCode || 500).json({
      status: "error",
      message: error.message || "No fue posible entrar a la llamada segura"
    });
  }
});

app.get("/public/mobile/events/:eventId/voice/sessions/:sessionId/status", async (req, res) => {
  try {
    const { eventId, sessionId } = req.params;
    const { user_id = null } = req.query || {};
    const access = await getMobileVoiceAccess(eventId, user_id);
    const session = await getVoiceSessionForTicket(access.ticket_id, sessionId, { includeCredentials: false });

    if (!session) {
      return res.status(404).json({ status: "error", message: "Voice session not found" });
    }

    res.json({
      status: "ok",
      voice_session: voiceSessionForParticipant(session, 'party_a')
    });
  } catch (error) {
    console.error("[MOBILE VOICE STATUS ERROR]", error);
    res.status(error.statusCode || 500).json({
      status: "error",
      message: error.message || "No fue posible consultar la llamada segura"
    });
  }
});

app.post("/public/mobile/events/:eventId/voice/sessions/:sessionId/connected", async (req, res) => {
  try {
    const { eventId, sessionId } = req.params;
    const { user_id = null } = req.body || {};
    const access = await getMobileVoiceAccess(eventId, user_id);
    const session = await getVoiceSessionForTicket(access.ticket_id, sessionId, { includeCredentials: false });

    if (!session) {
      return res.status(404).json({ status: "error", message: "Voice session not found" });
    }

    const updated = await registerVoiceParticipantConnected(session, 'NEIGHBOR');
    res.json({
      status: "ok",
      message: "Entrada del vecino al canal confirmada",
      voice_session: voiceSessionForParticipant(updated, 'party_a')
    });
  } catch (error) {
    console.error("[MOBILE VOICE CONNECTED ERROR]", error);
    res.status(error.statusCode || 500).json({
      status: "error",
      message: error.message || "No fue posible confirmar la conexión del vecino"
    });
  }
});

app.post("/public/mobile/events/:eventId/voice/sessions/:sessionId/end", async (req, res) => {
  try {
    const { eventId, sessionId } = req.params;
    const { user_id = null, reason = "HANGUP" } = req.body || {};
    const access = await getMobileVoiceAccess(eventId, user_id);
    const session = await getVoiceSessionForTicket(access.ticket_id, sessionId, { includeCredentials: false });

    if (!session) {
      return res.status(404).json({ status: "error", message: "Voice session not found" });
    }

    const normalizedReason = String(reason || "HANGUP").toUpperCase();
    const outcome = normalizedReason === "NO_ANSWER"
      ? "NO_ANSWER"
      : normalizedReason === "ERROR"
        ? "FAILED"
        : "ENDED";
    const endedSession = await finalizeTicketVoiceSession({
      session,
      outcome,
      actorRole: "NEIGHBOR",
      actorUserId: access.user_id || null,
      reason: normalizedReason
    });

    res.json({
      status: "ok",
      message: "Llamada segura finalizada",
      voice_session: voiceSessionForParticipant(endedSession, 'party_a')
    });
  } catch (error) {
    console.error("[MOBILE VOICE END ERROR]", error);
    res.status(error.statusCode || 500).json({
      status: "error",
      message: error.message || "No fue posible finalizar la llamada segura"
    });
  }
});

app.post("/resolver/tickets/:ticketId/voice/request", async (req, res) => {
  if (!checkIdentityAccess(req, res, ["RESOLVER", "ADMIN", "SUPER_ADMIN"], req.body?.resolver_user_id, "Sesión de resolutor requerida")) return;
  try {
    const { ticketId } = req.params;
    const { resolver_user_id } = req.body || {};

    if (!resolver_user_id) {
      return res.status(400).json({ status: "error", message: "resolver_user_id is required" });
    }

    const ticket = await fetchTicketVoiceContext(ticketId);
    if (!ticket) {
      return res.status(404).json({ status: "error", message: "Ticket not found" });
    }

    if (String(ticket.assigned_resolver_id || "") !== String(resolver_user_id)) {
      return res.status(403).json({ status: "error", message: "El ticket no está asignado a este resolutor" });
    }

    const voiceSession = await createTicketVoiceSession({
      req,
      ticket,
      requestedBy: "RESOLVER",
      targetType: "NEIGHBOR",
      actorUserId: resolver_user_id,
      resolverUserId: resolver_user_id
    });

    res.json({
      status: "ok",
      message: "Llamada segura solicitada",
      voice_session: voiceSessionForParticipant(voiceSession, 'party_b')
    });
  } catch (error) {
    console.error("[RESOLVER VOICE REQUEST ERROR]", error);
    res.status(error.statusCode || 500).json({
      status: "error",
      message: error.message || "No fue posible solicitar llamada segura"
    });
  }
});

app.post("/tickets/:id/voice/request", async (req, res) => {
  try {
    if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere usuario OPERATOR o ADMIN para iniciar llamada segura")) return;

    const { id } = req.params;
    if (!(await checkTicketParticipantAccess(req, res, id))) return;
    const { target_type = "NEIGHBOR" } = req.body || {};
    const ticket = await fetchTicketVoiceContext(id);

    if (!ticket) {
      return res.status(404).json({ status: "error", message: "Ticket not found" });
    }

    const voiceSession = await createTicketVoiceSession({
      req,
      ticket,
      requestedBy: "OPERATOR",
      targetType: String(target_type || "NEIGHBOR").toUpperCase(),
      actorUserId: req.panel_session?.sub || null,
      resolverUserId: ticket.assigned_resolver_id || null
    });

    res.json({
      status: "ok",
      message: "Llamada segura solicitada",
      voice_session: voiceSessionForParticipant(voiceSession, 'party_b')
    });
  } catch (error) {
    console.error("[OPERATOR VOICE REQUEST ERROR]", error);
    res.status(error.statusCode || 500).json({
      status: "error",
      message: error.message || "No fue posible solicitar llamada segura"
    });
  }
});

app.get("/tickets/:id/voice/sessions", async (req, res) => {
  if (!(await checkTicketParticipantAccess(req, res, req.params.id))) return;
  try {
    const { id } = req.params;
    const sessions = await getVoiceSessionsForTicket(id, { includeCredentials: false, limit: 20 });
    res.json({ status: "ok", total: sessions.length, voice_sessions: sessions });
  } catch (error) {
    console.error("[GET VOICE SESSIONS ERROR]", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.get("/tickets/:id/voice/sessions/:sessionId/status", async (req, res) => {
  try {
    if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere usuario OPERATOR o ADMIN para consultar llamada segura")) return;
    const { id, sessionId } = req.params;
    const session = await getVoiceSessionForTicket(id, sessionId, { includeCredentials: false });

    if (!session) {
      return res.status(404).json({ status: "error", message: "Voice session not found" });
    }

    res.json({
      status: "ok",
      voice_session: voiceSessionForParticipant(session, 'party_b')
    });
  } catch (error) {
    console.error("[OPERATOR VOICE STATUS ERROR]", error);
    res.status(error.statusCode || 500).json({
      status: "error",
      message: error.message || "No fue posible consultar la llamada segura"
    });
  }
});

app.post("/tickets/:id/voice/sessions/:sessionId/join", async (req, res) => {
  try {
    if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere usuario OPERATOR o ADMIN para atender llamada segura")) return;

    const { id, sessionId } = req.params;
    if (!(await checkTicketParticipantAccess(req, res, id))) return;
    const session = await getVoiceSessionForTicket(id, sessionId, { includeCredentials: true });

    if (!session) {
      return res.status(404).json({ status: "error", message: "Voice session not found" });
    }

    const ticket = await fetchTicketVoiceContext(id);
    if (String(session.target_type || "").toUpperCase() === "RESOLVER") {
      return res.status(409).json({
        status: "error",
        message: "Esta llamada segura está destinada al resolutor asignado. Debe atenderla desde la App Resolutor."
      });
    }

    if (operatorCanHandleVoiceSession(session, ticket)) {
      await pool.query(
        `
        UPDATE ticket_voice_sessions
        SET status = CASE WHEN status = 'CONNECTED' THEN status ELSE 'RINGING' END,
            updated_at = NOW()
        WHERE id = $1
        `,
        [session.id]
      );

      await pool.query(
        `
        INSERT INTO ticket_actions (
          ticket_id, actor_user_id, actor_role, action_type, description, metadata
        )
        SELECT $1,$2,'OPERATOR','VOICE_ACCEPTED','Central aceptó la llamada del vecino',$3
        WHERE NOT EXISTS (
          SELECT 1
          FROM ticket_actions
          WHERE ticket_id = $1
            AND action_type = 'VOICE_ACCEPTED'
            AND metadata->>'voice_session_id' = $4
        )
        `,
        [
          id,
          req.panel_session?.sub || null,
          JSON.stringify({
            voice_session_id: session.id,
            wa_center_session_id: session.wa_center_session_id
          }),
          String(session.id)
        ]
      );
    }

    res.json({
      status: "ok",
      message: "Credenciales de llamada segura entregadas",
      voice_session: voiceSessionForParticipant(session, 'party_b')
    });
  } catch (error) {
    console.error("[OPERATOR VOICE JOIN ERROR]", error);
    res.status(error.statusCode || 500).json({
      status: "error",
      message: error.message || "No fue posible atender la llamada segura"
    });
  }
});

app.post("/tickets/:id/voice/sessions/:sessionId/connected", async (req, res) => {
  try {
    if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere usuario OPERATOR o ADMIN para confirmar llamada segura")) return;
    const { id, sessionId } = req.params;
    const session = await getVoiceSessionForTicket(id, sessionId, { includeCredentials: false });

    if (!session) {
      return res.status(404).json({ status: "error", message: "Voice session not found" });
    }

    const updated = await registerVoiceParticipantConnected(session, 'OPERATOR');
    res.json({
      status: "ok",
      message: "Entrada de Central al canal confirmada",
      voice_session: voiceSessionForParticipant(updated, 'party_b')
    });
  } catch (error) {
    console.error("[OPERATOR VOICE CONNECTED ERROR]", error);
    res.status(error.statusCode || 500).json({
      status: "error",
      message: error.message || "No fue posible confirmar la conexión de Central"
    });
  }
});

app.post("/tickets/:id/voice/sessions/:sessionId/reject", async (req, res) => {
  try {
    if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere usuario OPERATOR o ADMIN para rechazar llamada segura")) return;
    const { id, sessionId } = req.params;
    const { reason = "REJECTED_BY_OPERATOR" } = req.body || {};
    const session = await getVoiceSessionForTicket(id, sessionId, { includeCredentials: false });

    if (!session) {
      return res.status(404).json({ status: "error", message: "Voice session not found" });
    }
    const ticket = await fetchTicketVoiceContext(id);
    if (!operatorCanHandleVoiceSession(session, ticket)) {
      return res.status(409).json({ status: "error", message: "Esta sesión no es una llamada entrante para Central" });
    }

    const rejected = await finalizeTicketVoiceSession({
      session,
      outcome: "REJECTED",
      actorRole: "OPERATOR",
      actorUserId: req.panel_session?.sub || null,
      reason
    });

    res.json({
      status: "ok",
      message: "Llamada rechazada",
      voice_session: voiceSessionForParticipant(rejected, 'party_b')
    });
  } catch (error) {
    console.error("[OPERATOR VOICE REJECT ERROR]", error);
    res.status(error.statusCode || 500).json({
      status: "error",
      message: error.message || "No fue posible rechazar la llamada"
    });
  }
});

app.post("/tickets/:id/voice/sessions/:sessionId/end", async (req, res) => {
  try {
    if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere usuario OPERATOR o ADMIN para finalizar llamada segura")) return;

    const { id, sessionId } = req.params;
    const { reason = "HANGUP" } = req.body || {};
    const session = await getVoiceSessionForTicket(id, sessionId, { includeCredentials: false });

    if (!session) {
      return res.status(404).json({ status: "error", message: "Voice session not found" });
    }

    const normalizedReason = String(reason || "HANGUP").toUpperCase();
    const outcome = normalizedReason === "NO_ANSWER"
      ? "NO_ANSWER"
      : ["REGISTRATION_FAILED", "WEBRTC_DISCONNECTED", "WEBRTC_FAILED", "REQUEST_FAILED", "ANSWER_FAILED", "ERROR"]
          .some((value) => normalizedReason.includes(value))
        ? "FAILED"
        : "ENDED";
    const ended = await finalizeTicketVoiceSession({
      session,
      outcome,
      actorRole: "OPERATOR",
      actorUserId: req.panel_session?.sub || null,
      reason
    });

    res.json({
      status: "ok",
      message: "Llamada finalizada",
      voice_session: voiceSessionForParticipant(ended, 'party_b')
    });
  } catch (error) {
    console.error("[OPERATOR VOICE END ERROR]", error);
    res.status(error.statusCode || 500).json({
      status: "error",
      message: error.message || "No fue posible finalizar la llamada"
    });
  }
});

app.post("/resolver/tickets/:ticketId/voice/sessions/:sessionId/join", async (req, res) => {
  if (!checkIdentityAccess(req, res, ["RESOLVER", "ADMIN", "SUPER_ADMIN"], req.body?.resolver_user_id, "Sesión de resolutor requerida")) return;
  try {
    const { ticketId, sessionId } = req.params;
    const { resolver_user_id } = req.body || {};

    if (!resolver_user_id) {
      return res.status(400).json({ status: "error", message: "resolver_user_id is required" });
    }

    const ticket = await fetchTicketVoiceContext(ticketId);
    if (!ticket) {
      return res.status(404).json({ status: "error", message: "Ticket not found" });
    }

    if (String(ticket.assigned_resolver_id || "") !== String(resolver_user_id)) {
      return res.status(403).json({ status: "error", message: "El ticket no está asignado a este resolutor" });
    }

    const session = await getVoiceSessionForTicket(ticketId, sessionId, { includeCredentials: true });
    if (!session) {
      return res.status(404).json({ status: "error", message: "Voice session not found" });
    }

    res.json({
      status: "ok",
      message: "Credenciales de llamada segura entregadas",
      voice_session: voiceSessionForParticipant(session, 'party_b')
    });
  } catch (error) {
    console.error("[RESOLVER VOICE JOIN ERROR]", error);
    res.status(error.statusCode || 500).json({
      status: "error",
      message: error.message || "No fue posible atender la llamada segura"
    });
  }
});

app.get("/resolver/tickets/:ticketId/voice/sessions/:sessionId/status", async (req, res) => {
  try {
    const { ticketId, sessionId } = req.params;
    const { resolver_user_id } = req.query || {};
    await getResolverVoiceAccess(ticketId, resolver_user_id);
    const session = await getVoiceSessionForTicket(ticketId, sessionId, { includeCredentials: false });

    if (!session) {
      return res.status(404).json({ status: "error", message: "Voice session not found" });
    }

    res.json({
      status: "ok",
      voice_session: voiceSessionForParticipant(session, 'party_b')
    });
  } catch (error) {
    console.error("[RESOLVER VOICE STATUS ERROR]", error);
    res.status(error.statusCode || 500).json({
      status: "error",
      message: error.message || "No fue posible consultar la llamada segura"
    });
  }
});

app.post("/resolver/tickets/:ticketId/voice/sessions/:sessionId/connected", async (req, res) => {
  try {
    const { ticketId, sessionId } = req.params;
    const { resolver_user_id } = req.body || {};
    await getResolverVoiceAccess(ticketId, resolver_user_id);
    const session = await getVoiceSessionForTicket(ticketId, sessionId, { includeCredentials: false });

    if (!session) {
      return res.status(404).json({ status: "error", message: "Voice session not found" });
    }

    const updated = await registerVoiceParticipantConnected(session, 'RESOLVER');
    res.json({
      status: "ok",
      message: "Entrada del resolutor al canal confirmada",
      voice_session: voiceSessionForParticipant(updated, 'party_b')
    });
  } catch (error) {
    console.error("[RESOLVER VOICE CONNECTED ERROR]", error);
    res.status(error.statusCode || 500).json({
      status: "error",
      message: error.message || "No fue posible confirmar la conexión del resolutor"
    });
  }
});

app.post("/resolver/tickets/:ticketId/voice/sessions/:sessionId/accept", async (req, res) => {
  try {
    const { ticketId, sessionId } = req.params;
    const { resolver_user_id } = req.body || {};
    await getResolverVoiceAccess(ticketId, resolver_user_id);
    const session = await getVoiceSessionForTicket(ticketId, sessionId, { includeCredentials: false });

    if (!session) {
      return res.status(404).json({ status: "error", message: "Voice session not found" });
    }
    if (String(session.requested_by || "").toUpperCase() !== "NEIGHBOR" ||
        String(session.target_type || "").toUpperCase() !== "RESOLVER") {
      return res.status(409).json({ status: "error", message: "Esta sesión no es una llamada entrante del vecino" });
    }
    if (isVoiceTerminalStatus(session.status)) {
      return res.status(409).json({ status: "error", message: "La llamada ya finalizó" });
    }

    const updated = await pool.query(
      `
      UPDATE ticket_voice_sessions
      SET status = CASE WHEN status = 'CONNECTED' THEN status ELSE 'RINGING' END, updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [session.id]
    );

    await pool.query(
      `
      INSERT INTO ticket_actions (
        ticket_id, actor_user_id, actor_role, action_type, description, metadata
      )
      SELECT $1,$2,'RESOLVER','VOICE_ACCEPTED','Resolutor aceptó la llamada del vecino',$3
      WHERE NOT EXISTS (
        SELECT 1
        FROM ticket_actions
        WHERE ticket_id = $1
          AND action_type = 'VOICE_ACCEPTED'
          AND metadata->>'voice_session_id' = $4
      )
      `,
      [
        ticketId,
        resolver_user_id,
        JSON.stringify({
          voice_session_id: session.id,
          wa_center_session_id: session.wa_center_session_id
        }),
        String(session.id)
      ]
    );

    res.json({
      status: "ok",
      message: "Llamada aceptada",
      voice_session: voiceSessionForParticipant(
        sanitizeVoiceSessionRow(updated.rows[0], { includeCredentials: false }),
        'party_b'
      )
    });
  } catch (error) {
    console.error("[RESOLVER VOICE ACCEPT ERROR]", error);
    res.status(error.statusCode || 500).json({
      status: "error",
      message: error.message || "No fue posible aceptar la llamada"
    });
  }
});

app.post("/resolver/tickets/:ticketId/voice/sessions/:sessionId/reject", async (req, res) => {
  try {
    const { ticketId, sessionId } = req.params;
    const { resolver_user_id, reason = "REJECTED_BY_RESOLVER" } = req.body || {};
    await getResolverVoiceAccess(ticketId, resolver_user_id);
    const session = await getVoiceSessionForTicket(ticketId, sessionId, { includeCredentials: false });

    if (!session) {
      return res.status(404).json({ status: "error", message: "Voice session not found" });
    }
    if (String(session.requested_by || "").toUpperCase() !== "NEIGHBOR" ||
        String(session.target_type || "").toUpperCase() !== "RESOLVER") {
      return res.status(409).json({ status: "error", message: "Esta sesión no es una llamada entrante del vecino" });
    }

    const rejected = await finalizeTicketVoiceSession({
      session,
      outcome: "REJECTED",
      actorRole: "RESOLVER",
      actorUserId: resolver_user_id,
      reason
    });

    res.json({
      status: "ok",
      message: "Llamada rechazada",
      voice_session: voiceSessionForParticipant(rejected, 'party_b')
    });
  } catch (error) {
    console.error("[RESOLVER VOICE REJECT ERROR]", error);
    res.status(error.statusCode || 500).json({
      status: "error",
      message: error.message || "No fue posible rechazar la llamada"
    });
  }
});

app.post("/resolver/tickets/:ticketId/voice/sessions/:sessionId/end", async (req, res) => {
  try {
    const { ticketId, sessionId } = req.params;
    const { resolver_user_id, reason = "HANGUP" } = req.body || {};
    await getResolverVoiceAccess(ticketId, resolver_user_id);
    const session = await getVoiceSessionForTicket(ticketId, sessionId, { includeCredentials: false });

    if (!session) {
      return res.status(404).json({ status: "error", message: "Voice session not found" });
    }

    const ended = await finalizeTicketVoiceSession({
      session,
      outcome: "ENDED",
      actorRole: "RESOLVER",
      actorUserId: resolver_user_id,
      reason
    });

    res.json({
      status: "ok",
      message: "Llamada finalizada",
      voice_session: voiceSessionForParticipant(ended, 'party_b')
    });
  } catch (error) {
    console.error("[RESOLVER VOICE END ERROR]", error);
    res.status(error.statusCode || 500).json({
      status: "error",
      message: error.message || "No fue posible finalizar la llamada"
    });
  }
});

app.post("/integrations/wa-center/voice-events", async (req, res) => {
  try {
    if (WA_CENTER_WEBHOOK_SECRET) {
      const provided = req.headers["x-wa-center-webhook-secret"] ||
        String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
      if (provided !== WA_CENTER_WEBHOOK_SECRET) {
        return res.status(401).json({ status: "error", message: "Invalid voice webhook secret" });
      }
    }

    await ensureVoiceSchema();

    const payload = req.body || {};
    const sessionId = payload.session_id || payload.wa_center_session_id || null;
    const callId = payload.call_id || payload.wa_center_call_id || null;
    const externalReference = payload.external_reference || null;
    const providerEventId = String(payload.event_id || payload.webhook_event_id || "").trim().slice(0, 220) || null;
    const event = String(payload.event || "UPDATED").toUpperCase();
    const normalizedStatus = normalizeVoiceStatus(event);
    const rawRecordingUrl = payload.recording_url || payload.recording?.url || null;
    let recordingUrl = null;
    if (rawRecordingUrl) {
      try {
        const parsedRecordingUrl = new URL(String(rawRecordingUrl));
        if (parsedRecordingUrl.protocol !== "https:") throw new Error("HTTPS required");
        recordingUrl = parsedRecordingUrl.toString();
      } catch {
        return res.status(400).json({ status: "error", message: "recording_url must be a valid HTTPS URL" });
      }
    }

    const sessionResult = await pool.query(
      `
      SELECT *
      FROM ticket_voice_sessions
      WHERE ($1::text IS NOT NULL AND wa_center_session_id = $1)
         OR ($2::text IS NOT NULL AND external_reference = $2)
         OR ($3::text IS NOT NULL AND wa_center_call_id = $3)
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [sessionId, externalReference, callId]
    );

    const session = sessionResult.rows[0] || null;

    const voiceEventInsert = await pool.query(
      `
      INSERT INTO ticket_voice_events (
        voice_session_id,
        ticket_id,
        wa_center_session_id,
        provider_event_id,
        external_reference,
        event,
        participant_role,
        duration_seconds,
        failure_reason,
        payload
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (provider_event_id) WHERE provider_event_id IS NOT NULL DO NOTHING
      RETURNING id
      `,
      [
        session?.id || null,
        session?.ticket_id || null,
        sessionId,
        providerEventId,
        externalReference,
        event,
        payload.participant_role || null,
        payload.duration_seconds != null ? Number(payload.duration_seconds) : null,
        payload.failure_reason || null,
        JSON.stringify(payload)
      ]
    );

    if (providerEventId && voiceEventInsert.rows.length === 0) {
      return res.json({ status: "ok", matched: Boolean(session), event, duplicate: true });
    }

    if (session) {
      const effectiveStatus = await resolveWebhookVoiceStatus(session, normalizedStatus, payload);
      const recordingId = payload.recording_id || payload.recording?.id || null;

      await pool.query(
        `
        UPDATE ticket_voice_sessions
        SET
          status = $2,
          connected_at = CASE WHEN $3 = 'CONNECTED' THEN COALESCE(connected_at, NOW()) ELSE connected_at END,
          ended_at = CASE WHEN $3 IN ('ENDED','FAILED','NO_ANSWER','EXPIRED','REJECTED') THEN COALESCE(ended_at, NOW()) ELSE ended_at END,
          duration_seconds = COALESCE($4, duration_seconds),
          failure_reason = COALESCE($5, failure_reason),
          recording_url = COALESCE($6, recording_url),
          recording_id = COALESCE($7, recording_id),
          updated_at = NOW()
        WHERE id = $1
        `,
        [
          session.id,
          effectiveStatus,
          effectiveStatus,
          payload.duration_seconds != null ? Number(payload.duration_seconds) : null,
          payload.failure_reason || null,
          recordingUrl,
          recordingId
        ]
      );

      await pool.query(
        `
        INSERT INTO ticket_actions (
          ticket_id,
          actor_user_id,
          actor_role,
          action_type,
          description,
          metadata
        )
        VALUES ($1,NULL,'SYSTEM',$2,$3,$4)
        `,
        [
          session.ticket_id,
          `VOICE_${event}`,
          voiceEventDescription(event, payload),
          JSON.stringify({
            provider: 'wa_center',
            wa_center_session_id: sessionId,
            wa_center_call_id: callId,
            external_reference: externalReference,
            event,
            participant_role: payload.participant_role || null,
            duration_seconds: payload.duration_seconds || null,
            failure_reason: payload.failure_reason || null,
            recording_url: recordingUrl,
            recording_id: recordingId
          })
        ]
      );
    }

    res.json({ status: "ok", matched: Boolean(session), event });
  } catch (error) {
    console.error("[WA CENTER VOICE EVENT ERROR]", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.get("/tickets/:id/actions", async (req, res) => {
  try {
    const { id } = req.params;
    if (!(await checkTicketParticipantAccess(req, res, id))) return;

    const result = await pool.query(
      `
      SELECT
        ta.id,
        ta.action_type,
        ta.actor_role,
        ta.description,
        ta.metadata,
        ta.created_at,
        u.full_name AS actor_name
      FROM ticket_actions ta
      LEFT JOIN users u
        ON u.id = ta.actor_user_id
      WHERE ta.ticket_id = $1
      ORDER BY ta.created_at ASC
      `,
      [id]
    );

    res.json({
      status: "ok",
      total: result.rows.length,
      actions: result.rows
    });

  } catch (error) {
    console.error("[GET TICKET ACTIONS ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.get("/tickets/:id/notes", async (req, res) => {
  try {
    const { id } = req.params;
    if (!(await checkTicketParticipantAccess(req, res, id))) return;

    const result = await pool.query(
      `
      SELECT
        tn.id,
        tn.note,
        tn.created_at,
        u.full_name AS author_name
      FROM ticket_notes tn
      LEFT JOIN users u
        ON u.id = tn.author_user_id
      WHERE tn.ticket_id = $1
      ORDER BY tn.created_at ASC
      `,
      [id]
    );

    res.json({
      status: "ok",
      total: result.rows.length,
      notes: result.rows
    });

  } catch (error) {
    console.error("[GET TICKET NOTES ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.get("/public/qr/:code", async (req, res) => {
  try {
    await ensureMunicipalQrSchema();
    const result = await pool.query(
      `SELECT q.*, cc.code AS control_center_code, cc.name AS control_center_name
       FROM municipal_qr_points q
       JOIN control_centers cc ON cc.id = q.control_center_id
       WHERE q.code = $1 AND q.enabled = true LIMIT 1`,
      [String(req.params.code || '').trim()]
    );
    if (!result.rows.length) return res.status(404).json({ status: 'error', message: 'Punto QR no encontrado o inactivo' });
    res.json({ status: 'ok', qr_point: municipalQrPublicPayload(result.rows[0]) });
  } catch (error) {
    console.error('[PUBLIC QR LOOKUP ERROR]', error);
    res.status(500).json({ status: 'error', message: 'No fue posible consultar el punto QR' });
  }
});

app.post("/public/qr/:code/visit", qrVisitRateLimit, async (req, res) => {
  try {
    await ensureMunicipalQrSchema();
    const pointResult = await pool.query(
      `SELECT q.*, cc.code AS control_center_code, cc.name AS control_center_name
       FROM municipal_qr_points q
       JOIN control_centers cc ON cc.id = q.control_center_id
       WHERE q.code = $1 AND q.enabled = true LIMIT 1`,
      [String(req.params.code || '').trim()]
    );
    if (!pointResult.rows.length) return res.status(404).json({ status: 'error', message: 'Punto QR no encontrado o inactivo' });
    const ipHash = crypto.createHash('sha256').update(`${getRemoteIp(req)}:${SESSION_SECRET}`).digest('hex');
    const visit = await pool.query(
      `INSERT INTO municipal_qr_visits (qr_point_id, visit_token, ip_hash, user_agent, referrer)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, visited_at`,
      [
        pointResult.rows[0].id,
        String(req.body?.visit_token || '').trim().slice(0, 120) || null,
        ipHash,
        String(req.headers['user-agent'] || '').slice(0, 500) || null,
        String(req.body?.referrer || req.headers.referer || '').slice(0, 500) || null
      ]
    );
    res.json({
      status: 'ok',
      visit_id: visit.rows[0].id,
      visited_at: visit.rows[0].visited_at,
      qr_point: municipalQrPublicPayload(pointResult.rows[0])
    });
  } catch (error) {
    console.error('[PUBLIC QR VISIT ERROR]', error);
    res.status(500).json({ status: 'error', message: 'No fue posible registrar el acceso QR' });
  }
});

app.get("/admin/control-centers/:code/qr-points", async (req, res) => {
  if (!checkRoleAccess(req, res, ['ADMIN', 'SUPER_ADMIN'], 'Se requiere usuario ADMIN para gestionar QR')) return;
  try {
    await ensureMunicipalQrSchema();
    const code = requestedControlCenterForSession(req, req.params.code, 'CC-VINA');
    const result = await pool.query(
      `SELECT q.*, cc.code AS control_center_code, cc.name AS control_center_name,
              COUNT(v.id)::int AS visit_count,
              COUNT(DISTINCT NULLIF(v.visit_token,''))::int AS unique_visitors,
              MAX(v.visited_at) AS last_visit_at
       FROM municipal_qr_points q
       JOIN control_centers cc ON cc.id = q.control_center_id
       LEFT JOIN municipal_qr_visits v ON v.qr_point_id = q.id
       WHERE cc.code = $1
       GROUP BY q.id, cc.code, cc.name
       ORDER BY q.created_at DESC`,
      [code]
    );
    res.json({ status: 'ok', qr_points: result.rows.map(municipalQrPublicPayload) });
  } catch (error) {
    console.error('[ADMIN QR LIST ERROR]', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post("/admin/control-centers/:code/qr-points", async (req, res) => {
  if (!checkRoleAccess(req, res, ['ADMIN', 'SUPER_ADMIN'], 'Se requiere usuario ADMIN para gestionar QR')) return;
  try {
    await ensureMunicipalQrSchema();
    const code = requestedControlCenterForSession(req, req.params.code, 'CC-VINA');
    const cc = await pool.query('SELECT id, code, name FROM control_centers WHERE code = $1 LIMIT 1', [code]);
    if (!cc.rows.length) return res.status(404).json({ status: 'error', message: 'Centro de control no encontrado' });
    const latitude = Number(req.body?.latitude);
    const longitude = Number(req.body?.longitude);
    const name = String(req.body?.name || '').trim();
    if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      return res.status(400).json({ status: 'error', message: 'Nombre y coordenadas GPS válidas son obligatorios' });
    }
    const qrCode = `QR-${code.replace(/[^A-Z0-9]/g, '')}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const result = await pool.query(
      `INSERT INTO municipal_qr_points (control_center_id, code, name, description, latitude, longitude, enabled, metadata, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        cc.rows[0].id,
        qrCode,
        name.slice(0, 120),
        String(req.body?.description || '').trim().slice(0, 500) || null,
        latitude,
        longitude,
        req.body?.enabled !== false,
        JSON.stringify(req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {}),
        req.panel_session.sub
      ]
    );
    res.status(201).json({ status: 'ok', qr_point: municipalQrPublicPayload({ ...result.rows[0], control_center_code: cc.rows[0].code, control_center_name: cc.rows[0].name }) });
  } catch (error) {
    console.error('[ADMIN QR CREATE ERROR]', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.patch("/admin/qr-points/:id", async (req, res) => {
  if (!checkRoleAccess(req, res, ['ADMIN', 'SUPER_ADMIN'], 'Se requiere usuario ADMIN para gestionar QR')) return;
  try {
    await ensureMunicipalQrSchema();
    const allowedCode = requestedControlCenterForSession(req, req.body?.control_center_code, 'CC-VINA');
    const latitude = req.body?.latitude == null ? null : Number(req.body.latitude);
    const longitude = req.body?.longitude == null ? null : Number(req.body.longitude);
    if ((latitude != null && !Number.isFinite(latitude)) || (longitude != null && !Number.isFinite(longitude))) {
      return res.status(400).json({ status: 'error', message: 'Coordenadas GPS inválidas' });
    }
    const result = await pool.query(
      `UPDATE municipal_qr_points q SET
         name = COALESCE(NULLIF($3,''), q.name),
         description = CASE WHEN $4::text IS NULL THEN q.description ELSE NULLIF($4,'') END,
         latitude = COALESCE($5, q.latitude), longitude = COALESCE($6, q.longitude),
         enabled = COALESCE($7, q.enabled), updated_at = NOW()
       FROM control_centers cc
       WHERE q.id = $1 AND cc.id = q.control_center_id AND cc.code = $2
       RETURNING q.*, cc.code AS control_center_code, cc.name AS control_center_name`,
      [req.params.id, allowedCode, String(req.body?.name || '').trim(), req.body?.description == null ? null : String(req.body.description).trim(), latitude, longitude, typeof req.body?.enabled === 'boolean' ? req.body.enabled : null]
    );
    if (!result.rows.length) return res.status(404).json({ status: 'error', message: 'Punto QR no encontrado' });
    res.json({ status: 'ok', qr_point: municipalQrPublicPayload(result.rows[0]) });
  } catch (error) {
    console.error('[ADMIN QR UPDATE ERROR]', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.use("/dashboard", async (req, res, next) => {
  try {
    const session = panelSessionFromRequest(req);
    if (!session || !roleHasAccess(session.role, ['OPERATOR', 'ADMIN', 'SUPER_ADMIN'])) {
      return res.status(401).json({ status: 'error', message: 'Se requiere acceso autorizado al Dashboard' });
    }
    const settingsRow = session.control_center_id ? await getControlCenterSettingsById(session.control_center_id).catch(() => null) : null;
    const settings = normalizeControlCenterSettings(settingsRow?.settings || {});
    const allowedRoles = settings.operator_tools?.dashboard_roles || ['ADMIN', 'SUPER_ADMIN'];
    if (!allowedRoles.includes(String(session.role || '').toUpperCase())) {
      return res.status(403).json({ status: 'error', code: 'DASHBOARD_ACCESS_DISABLED', message: 'Tu cuenta no está autorizada para consultar el Dashboard' });
    }
    req.panel_session = session;
    next();
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'No fue posible validar acceso al Dashboard' });
  }
});

app.get("/dashboard/qr-analytics", async (req, res) => {
  if (!checkRoleAccess(req, res, ['OPERATOR', 'ADMIN', 'SUPER_ADMIN'], 'Se requiere acceso al Dashboard')) return;
  try {
    await ensureMunicipalQrSchema();
    const code = dashboardAuthorizedControlCenterCode(req);
    const days = Math.max(1, Math.min(365, Number(req.query.days || 30)));
    const result = await pool.query(
      `SELECT q.id, q.code, q.name, q.latitude, q.longitude,
              COUNT(DISTINCT v.id) FILTER (WHERE v.visited_at >= NOW() - ($2::int * INTERVAL '1 day'))::int AS visits,
              COUNT(DISTINCT NULLIF(v.visit_token,'')) FILTER (WHERE v.visited_at >= NOW() - ($2::int * INTERVAL '1 day'))::int AS unique_visitors,
              COUNT(DISTINCT m.id) FILTER (WHERE m.created_at >= NOW() - ($2::int * INTERVAL '1 day'))::int AS sos_events,
              MAX(v.visited_at) AS last_visit_at
       FROM municipal_qr_points q
       JOIN control_centers cc ON cc.id = q.control_center_id
       LEFT JOIN municipal_qr_visits v ON v.qr_point_id = q.id
       LEFT JOIN mobile_events m ON m.qr_point_id = q.id
       WHERE cc.code = $1
       GROUP BY q.id
       ORDER BY visits DESC, q.name ASC`,
      [code, days]
    );
    res.json({ status: 'ok', days, points: result.rows });
  } catch (error) {
    console.error('[DASHBOARD QR ANALYTICS ERROR]', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get("/dashboard/summary", async (req, res) => {
  if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere usuario OPERATOR o ADMIN para acceder al dashboard")) return;
  try {
    await ensureGeofenceSchema();
    const control_center_code = dashboardAuthorizedControlCenterCode(req);

    const result = await pool.query(`
      WITH cc AS (
        SELECT id
        FROM control_centers
        WHERE code = $1
      )
      SELECT
        COUNT(*) FILTER (WHERE t.state = 'ACTIVE') AS active_tickets,
        COUNT(*) FILTER (WHERE t.state = 'ASSIGNED') AS assigned_tickets,
        COUNT(*) FILTER (WHERE t.state = 'EN_ROUTE') AS en_route_tickets,
        COUNT(*) FILTER (WHERE t.state = 'ON_SITE') AS on_site_tickets,
        COUNT(*) FILTER (WHERE t.state = 'RESOLVED') AS resolved_tickets,
        COUNT(*) FILTER (WHERE t.state = 'CLOSED') AS closed_tickets
      FROM tickets t
      WHERE t.control_center_id = (SELECT id FROM cc)
    `, [control_center_code]);

    const resolvers = await pool.query(`
      SELECT
        status,
        COUNT(*) AS total
      FROM resolver_locations rl
      JOIN control_centers cc
        ON cc.id = rl.control_center_id
      WHERE cc.code = $1
      GROUP BY status
    `, [control_center_code]);

    res.json({
      status: "ok",
      tickets: result.rows[0],
      resolvers: resolvers.rows
    });

  } catch (error) {
    console.error("[DASHBOARD ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});



/*
   =========================================================
   EXECUTIVE DASHBOARD / ANALYTICS
   =========================================================

   Dashboard estadístico para venta/operación municipal.
   Acceso: OPERATOR o ADMIN mediante sesión de panel.
   =========================================================
*/

function dashboardNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function minutesToHuman(minutes) {
  const value = dashboardNumber(minutes, 0);
  if (value <= 0) return "0 min";
  if (value < 60) return `${Math.round(value)} min`;
  const h = Math.floor(value / 60);
  const m = Math.round(value % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

app.get("/debug/resolver-status-summary", async (req, res) => {
  if (!requireDebugAccess(req, res)) return;
  try {
    const adminToken = req.headers["x-admin-token"] || req.query.admin_token;
    if (process.env.ADMIN_TOKEN && adminToken !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ status: "error", message: "Invalid admin token" });
    }

    const controlCenterCode = req.query.control_center_code || "CC-VINA";
    const cc = await pool.query("SELECT id, code, name FROM control_centers WHERE code = $1 LIMIT 1", [controlCenterCode]);
    if (!cc.rows.length) return res.status(404).json({ status: "error", message: "Unknown control_center_code" });

    const ccId = cc.rows[0].id;
    const resolverGpsMaxAccuracy = maxResolverGpsAccuracyMeters();
    await reconcileResolverStatesForControlCenter(ccId);

    const rows = await pool.query(
      `
      WITH resolver_base AS (
        SELECT
          u.id,
          u.full_name,
          u.phone,
          u.is_active,
          COALESCE(UPPER(rl.status), 'SIN_UBICACION') AS raw_status,
          rl.latitude,
          rl.longitude,
          rl.accuracy,
          rl.updated_at,
          COUNT(t.id)::int AS active_tickets_count
        FROM users u
        LEFT JOIN resolver_locations rl ON rl.user_id = u.id
        LEFT JOIN tickets t ON t.assigned_resolver_id = u.id
          AND t.control_center_id = u.control_center_id
          AND t.state = ANY($2::text[])
        WHERE u.control_center_id = $1
          AND u.role = 'RESOLVER'
        GROUP BY u.id, u.full_name, u.phone, u.is_active, rl.status, rl.latitude, rl.longitude, rl.accuracy, rl.updated_at
      )
      SELECT
        *,
        CASE
          WHEN is_active IS NOT TRUE THEN 'INACTIVE'
          WHEN updated_at IS NULL THEN 'NO_GPS'
          WHEN accuracy IS NOT NULL AND (accuracy::numeric) > $3::numeric THEN 'GPS_INVALID'
          WHEN raw_status = 'OFFLINE' THEN 'OFFLINE'
          WHEN updated_at < NOW() - INTERVAL '10 minutes' THEN 'OFFLINE'
          WHEN updated_at < NOW() - INTERVAL '3 minutes' THEN 'STALE_GPS'
          WHEN raw_status IN ('BUSY','EN_ROUTE','ON_SITE') AND active_tickets_count = 0 THEN 'BLOCKED_NO_TICKET'
          WHEN active_tickets_count > 0 AND raw_status = 'EN_ROUTE' THEN 'EN_ROUTE'
          WHEN active_tickets_count > 0 AND raw_status = 'ON_SITE' THEN 'ON_SITE'
          WHEN active_tickets_count > 0 THEN 'BUSY'
          WHEN raw_status = 'AVAILABLE' THEN 'AVAILABLE'
          ELSE raw_status
        END AS operational_state
      FROM resolver_base
      ORDER BY full_name
      `,
      [ccId, ACTIVE_RESOLVER_TICKET_STATES, resolverGpsMaxAccuracy]
    );

    res.json({ status: "ok", control_center: cc.rows[0], resolvers: rows.rows });
  } catch (error) {
    console.error("[DEBUG RESOLVER STATUS SUMMARY ERROR]", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.get("/dashboard/analytics", async (req, res) => {
  if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere usuario OPERATOR o ADMIN para acceder al dashboard")) return;

  try {
    await ensureGeofenceSchema();
    const days = Math.max(1, Math.min(365, Number(req.query.days || 30)));
    const requestedCode = dashboardAuthorizedControlCenterCode(req);

    const ccResult = await pool.query(
      `
      SELECT id, code, name, municipality, region, country,
             municipality_logo_url, product_logo_url,
             brand_primary_color, brand_secondary_color,
             COALESCE(map_center_lat, latitude) AS latitude,
             COALESCE(map_center_lon, longitude) AS longitude,
             boundary_geojson,
             geofence_buffer_meters,
             map_center_lat,
             map_center_lon,
             map_zoom
      FROM control_centers
      WHERE code = $1
      LIMIT 1
      `,
      [requestedCode]
    );

    if (ccResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Unknown control_center_code"
      });
    }

    const controlCenter = ccResult.rows[0];
    const ccId = controlCenter.id;

    // Before calculating dashboard KPIs, reconcile impossible resolver states:
    // BUSY / EN_ROUTE / ON_SITE without an active assigned ticket.
    // This does not touch GPS freshness timestamps.
    const resolverReconciliation = await reconcileResolverStatesForControlCenter(ccId);
    const resolverGpsMaxAccuracy = maxResolverGpsAccuracyMeters();

    const summaryResult = await pool.query(
      `
      WITH all_tickets AS (
        SELECT *
        FROM tickets
        WHERE control_center_id = $1
      ), period_tickets AS (
        SELECT *
        FROM all_tickets
        WHERE created_at >= NOW() - ($2::int || ' days')::interval
      )
      SELECT
        (SELECT COUNT(*)::int FROM all_tickets) AS tickets_total_all_time,
        COUNT(*)::int AS tickets_total_period,
        COUNT(*) FILTER (WHERE state NOT IN ('CLOSED','CANCELLED','RESOLVED'))::int AS tickets_open,
        COUNT(*) FILTER (WHERE state = 'ACTIVE')::int AS tickets_active,
        COUNT(*) FILTER (WHERE state = 'ASSIGNED')::int AS tickets_assigned,
        COUNT(*) FILTER (WHERE state = 'EN_ROUTE')::int AS tickets_en_route,
        COUNT(*) FILTER (WHERE state = 'ON_SITE')::int AS tickets_on_site,
        COUNT(*) FILTER (WHERE state = 'RESOLVED')::int AS tickets_resolved,
        COUNT(*) FILTER (WHERE state = 'CLOSED')::int AS tickets_closed,
        COUNT(*) FILTER (WHERE state = 'CANCELLED')::int AS tickets_cancelled,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS tickets_last_24h,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS tickets_last_7d,
        COUNT(*) FILTER (WHERE priority <= 2)::int AS tickets_high_priority,
        COUNT(*) FILTER (WHERE COALESCE(jurisdiction_status, 'IN_JURISDICTION') = 'OUT_OF_JURISDICTION')::int AS tickets_out_of_jurisdiction,
        COUNT(*) FILTER (WHERE COALESCE(jurisdiction_status, 'IN_JURISDICTION') = 'IN_JURISDICTION_BUFFER')::int AS tickets_near_boundary,
        ROUND(AVG(EXTRACT(EPOCH FROM (acknowledged_at - created_at)) / 60.0) FILTER (WHERE acknowledged_at IS NOT NULL)::numeric, 1) AS avg_ack_minutes,
        ROUND(AVG(EXTRACT(EPOCH FROM (assigned_at - created_at)) / 60.0) FILTER (WHERE assigned_at IS NOT NULL)::numeric, 1) AS avg_assign_minutes,
        ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60.0) FILTER (WHERE resolved_at IS NOT NULL)::numeric, 1) AS avg_resolve_minutes,
        ROUND(AVG(EXTRACT(EPOCH FROM (closed_at - created_at)) / 60.0) FILTER (WHERE closed_at IS NOT NULL)::numeric, 1) AS avg_close_minutes,
        ROUND(MAX(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60.0) FILTER (WHERE state NOT IN ('CLOSED','CANCELLED','RESOLVED'))::numeric, 1) AS oldest_open_minutes,
        ROUND(
          100.0 * COUNT(*) FILTER (WHERE acknowledged_at IS NOT NULL AND acknowledged_at <= created_at + INTERVAL '5 minutes')
          / NULLIF(COUNT(*) FILTER (WHERE acknowledged_at IS NOT NULL), 0),
          1
        ) AS sla_ack_5m_pct,
        ROUND(
          100.0 * COUNT(*) FILTER (WHERE assigned_at IS NOT NULL AND assigned_at <= created_at + INTERVAL '15 minutes')
          / NULLIF(COUNT(*) FILTER (WHERE assigned_at IS NOT NULL), 0),
          1
        ) AS sla_assign_15m_pct,
        ROUND(
          100.0 * COUNT(*) FILTER (WHERE resolved_at IS NOT NULL AND resolved_at <= created_at + INTERVAL '60 minutes')
          / NULLIF(COUNT(*) FILTER (WHERE resolved_at IS NOT NULL), 0),
          1
        ) AS sla_resolve_60m_pct
      FROM period_tickets
      `,
      [ccId, days]
    );

    const usersSummaryResult = await pool.query(
      `
      SELECT
        COUNT(*)::int AS users_total,
        COUNT(*) FILTER (WHERE is_active = true)::int AS users_active,
        COUNT(*) FILTER (WHERE is_active = false)::int AS users_inactive,
        COUNT(*) FILTER (WHERE role = 'NEIGHBOR')::int AS neighbors_total,
        COUNT(*) FILTER (WHERE role = 'NEIGHBOR' AND validation_status = 'VALIDATED')::int AS neighbors_validated,
        COUNT(*) FILTER (WHERE role = 'NEIGHBOR' AND validation_status = 'PROVISIONAL_ACTIVE')::int AS neighbors_provisional,
        COUNT(*) FILTER (WHERE role = 'NEIGHBOR' AND validation_status = 'REJECTED')::int AS neighbors_rejected,
        COUNT(*) FILTER (WHERE role = 'RESOLVER')::int AS resolvers_total,
        COUNT(*) FILTER (WHERE role = 'OPERATOR')::int AS operators_total,
        COUNT(*) FILTER (WHERE role = 'ADMIN')::int AS admins_total
      FROM users
      WHERE control_center_id = $1
      `,
      [ccId]
    );

    const resolversSummaryResult = await pool.query(
      `
      WITH resolver_base AS (
        SELECT
          u.id,
          u.full_name,
          u.phone,
          u.is_active,
          COALESCE(UPPER(rl.status), 'SIN_UBICACION') AS raw_status,
          rl.latitude,
          rl.longitude,
          rl.accuracy,
          rl.updated_at,
          COUNT(t.id)::int AS active_tickets_count
        FROM users u
        LEFT JOIN resolver_locations rl ON rl.user_id = u.id
        LEFT JOIN tickets t ON t.assigned_resolver_id = u.id
          AND t.control_center_id = u.control_center_id
          AND t.state = ANY($2::text[])
        WHERE u.control_center_id = $1
          AND u.role = 'RESOLVER'
        GROUP BY u.id, u.full_name, u.phone, u.is_active, rl.status, rl.latitude, rl.longitude, rl.accuracy, rl.updated_at
      ), classified AS (
        SELECT
          *,
          CASE
            WHEN is_active IS NOT TRUE THEN 'INACTIVE'
            WHEN updated_at IS NULL THEN 'NO_GPS'
            WHEN accuracy IS NOT NULL AND (accuracy::numeric) > $3::numeric THEN 'GPS_INVALID'
            WHEN raw_status = 'OFFLINE' THEN 'OFFLINE'
            WHEN updated_at < NOW() - INTERVAL '10 minutes' THEN 'OFFLINE'
            WHEN updated_at < NOW() - INTERVAL '3 minutes' THEN 'STALE_GPS'
            WHEN raw_status IN ('BUSY','EN_ROUTE','ON_SITE') AND active_tickets_count = 0 THEN 'BLOCKED_NO_TICKET'
            WHEN active_tickets_count > 0 AND raw_status = 'EN_ROUTE' THEN 'EN_ROUTE'
            WHEN active_tickets_count > 0 AND raw_status = 'ON_SITE' THEN 'ON_SITE'
            WHEN active_tickets_count > 0 THEN 'BUSY'
            WHEN raw_status = 'AVAILABLE' THEN 'AVAILABLE'
            ELSE raw_status
          END AS operational_state,
          CASE
            WHEN updated_at IS NULL THEN 'NO_GPS'
            WHEN accuracy IS NOT NULL AND (accuracy::numeric) > $3::numeric THEN 'INVALID_ACCURACY'
            WHEN updated_at >= NOW() - INTERVAL '3 minutes' THEN 'FRESH'
            WHEN updated_at >= NOW() - INTERVAL '10 minutes' THEN 'STALE'
            ELSE 'EXPIRED'
          END AS gps_state
        FROM resolver_base
      )
      SELECT
        COUNT(*)::int AS resolvers_total,
        COUNT(*)::int AS resolvers_registered_total,
        COUNT(*) FILTER (WHERE is_active = true)::int AS resolvers_active,
        COUNT(*) FILTER (WHERE is_active IS NOT true)::int AS resolvers_inactive,
        COUNT(*) FILTER (WHERE updated_at IS NULL)::int AS resolvers_without_location,
        COUNT(*) FILTER (WHERE is_active = true AND operational_state IN ('AVAILABLE','BUSY','EN_ROUTE','ON_SITE'))::int AS resolvers_operational,
        COUNT(*) FILTER (WHERE is_active = true AND operational_state IN ('AVAILABLE','BUSY','EN_ROUTE','ON_SITE','BLOCKED_NO_TICKET'))::int AS resolvers_online,
        COUNT(*) FILTER (WHERE is_active = true AND operational_state = 'STALE_GPS')::int AS resolvers_stale,
        COUNT(*) FILTER (WHERE is_active = true AND operational_state IN ('STALE_GPS','GPS_INVALID','OFFLINE','NO_GPS'))::int AS resolvers_unavailable_gps,
        COUNT(*) FILTER (WHERE is_active IS NOT true OR operational_state IN ('OFFLINE','NO_GPS','GPS_INVALID','STALE_GPS'))::int AS resolvers_offline,
        COUNT(*) FILTER (WHERE is_active = true AND operational_state = 'AVAILABLE')::int AS resolvers_available_now,
        COUNT(*) FILTER (WHERE is_active = true AND operational_state IN ('BUSY','EN_ROUTE','ON_SITE'))::int AS resolvers_busy,
        COUNT(*) FILTER (WHERE is_active = true AND operational_state = 'EN_ROUTE')::int AS resolvers_en_route,
        COUNT(*) FILTER (WHERE is_active = true AND operational_state = 'ON_SITE')::int AS resolvers_on_site,
        COUNT(*) FILTER (WHERE is_active = true AND operational_state = 'BLOCKED_NO_TICKET')::int AS resolvers_blocked_without_ticket,
        COUNT(*) FILTER (WHERE is_active = true AND active_tickets_count > 0)::int AS resolvers_with_active_ticket,
        COUNT(*) FILTER (WHERE is_active = true AND gps_state = 'FRESH')::int AS resolvers_gps_fresh,
        COUNT(*) FILTER (WHERE is_active = true AND gps_state = 'STALE')::int AS resolvers_gps_stale,
        COUNT(*) FILTER (WHERE is_active = true AND gps_state IN ('EXPIRED','NO_GPS','INVALID_ACCURACY'))::int AS resolvers_gps_expired
      FROM classified
      `,
      [ccId, ACTIVE_RESOLVER_TICKET_STATES, resolverGpsMaxAccuracy]
    );

    const sirensSummaryResult = await pool.query(
      `
      SELECT
        COUNT(*)::int AS sirens_total,
        COUNT(*) FILTER (WHERE state = 'ON' OR relay = true)::int AS sirens_active,
        COUNT(*) FILTER (WHERE last_seen IS NOT NULL AND last_seen >= NOW() - INTERVAL '2 minutes')::int AS sirens_online,
        COUNT(*) FILTER (WHERE last_seen IS NULL OR last_seen < NOW() - INTERVAL '10 minutes')::int AS sirens_offline
      FROM sirens
      WHERE control_center_id = $1
      `,
      [ccId]
    );

    const devicesSummaryResult = await pool.query(
      `
      SELECT
        COUNT(*)::int AS devices_total,
        COUNT(*) FILTER (WHERE last_seen IS NOT NULL AND last_seen >= NOW() - INTERVAL '10 minutes')::int AS devices_online,
        COUNT(*) FILTER (WHERE last_seen IS NULL OR last_seen < NOW() - INTERVAL '10 minutes')::int AS devices_offline,
        COUNT(*) FILTER (WHERE status = 'SOS_ACTIVE')::int AS devices_sos_active
      FROM devices
      WHERE control_center_id = $1
      `,
      [ccId]
    );

    const stateResult = await pool.query(
      `
      SELECT state AS label, COUNT(*)::int AS value
      FROM tickets
      WHERE control_center_id = $1
        AND created_at >= NOW() - ($2::int || ' days')::interval
      GROUP BY state
      ORDER BY value DESC
      `,
      [ccId, days]
    );

    const alertTypeResult = await pool.query(
      `
      SELECT COALESCE(alert_type, 'SIN_TIPO') AS label, COUNT(*)::int AS value
      FROM tickets
      WHERE control_center_id = $1
        AND created_at >= NOW() - ($2::int || ' days')::interval
      GROUP BY COALESCE(alert_type, 'SIN_TIPO')
      ORDER BY value DESC
      LIMIT 12
      `,
      [ccId, days]
    );

    const sourceResult = await pool.query(
      `
      SELECT COALESCE(source_type, 'SIN_ORIGEN') AS label, COUNT(*)::int AS value
      FROM tickets
      WHERE control_center_id = $1
        AND created_at >= NOW() - ($2::int || ' days')::interval
      GROUP BY COALESCE(source_type, 'SIN_ORIGEN')
      ORDER BY value DESC
      `,
      [ccId, days]
    );

    const dailyResult = await pool.query(
      `
      SELECT
        TO_CHAR(date_trunc('day', created_at AT TIME ZONE 'America/Santiago'), 'YYYY-MM-DD') AS label,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE state NOT IN ('CLOSED','CANCELLED','RESOLVED'))::int AS open,
        COUNT(*) FILTER (WHERE state IN ('CLOSED','RESOLVED'))::int AS resolved
      FROM tickets
      WHERE control_center_id = $1
        AND created_at >= NOW() - ($2::int || ' days')::interval
      GROUP BY date_trunc('day', created_at AT TIME ZONE 'America/Santiago')
      ORDER BY label
      `,
      [ccId, days]
    );

    const hourlyResult = await pool.query(
      `
      SELECT
        EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Santiago')::int AS hour,
        COUNT(*)::int AS value
      FROM tickets
      WHERE control_center_id = $1
        AND created_at >= NOW() - ($2::int || ' days')::interval
      GROUP BY hour
      ORDER BY hour
      `,
      [ccId, days]
    );

    const topNeighborsResult = await pool.query(
      `
      SELECT
        COALESCE(u.full_name, 'Sin vecino asociado') AS name,
        u.phone,
        COUNT(t.id)::int AS tickets_count,
        MAX(t.created_at) AS last_ticket_at
      FROM tickets t
      LEFT JOIN users u ON u.id = t.citizen_user_id
      WHERE t.control_center_id = $1
        AND t.created_at >= NOW() - ($2::int || ' days')::interval
      GROUP BY u.id, u.full_name, u.phone
      ORDER BY tickets_count DESC, last_ticket_at DESC NULLS LAST
      LIMIT 10
      `,
      [ccId, days]
    );

    const topResolversResult = await pool.query(
      `
      SELECT
        COALESCE(u.full_name, 'Sin resolutor') AS name,
        u.phone,
        COUNT(t.id)::int AS assigned_count,
        COUNT(t.id) FILTER (WHERE t.state IN ('RESOLVED','CLOSED'))::int AS closed_count,
        ROUND(AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 60.0) FILTER (WHERE t.resolved_at IS NOT NULL)::numeric, 1) AS avg_resolve_minutes
      FROM tickets t
      LEFT JOIN users u ON u.id = t.assigned_resolver_id
      WHERE t.control_center_id = $1
        AND t.created_at >= NOW() - ($2::int || ' days')::interval
      GROUP BY u.id, u.full_name, u.phone
      ORDER BY assigned_count DESC
      LIMIT 10
      `,
      [ccId, days]
    );

    const pendingValidationResult = await pool.query(
      `
      SELECT
        id,
        full_name,
        phone,
        rut,
        declared_address,
        validation_status,
        created_at
      FROM users
      WHERE control_center_id = $1
        AND role = 'NEIGHBOR'
        AND validation_status IN ('PENDING_VERIFICATION','PROVISIONAL_ACTIVE')
        AND is_active = true
      ORDER BY created_at DESC
      LIMIT 10
      `,
      [ccId]
    );

    const recentTicketsResult = await pool.query(
      `
      SELECT
        t.id,
        t.title,
        t.alert_type,
        t.source_type,
        t.state,
        t.priority,
        t.created_at,
        t.acknowledged_at,
        t.assigned_at,
        t.resolved_at,
        t.closed_at,
        ROUND(EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 60.0)::int AS age_minutes,
        citizen.full_name AS citizen_name,
        citizen.phone AS citizen_phone,
        resolver.full_name AS resolver_name
      FROM tickets t
      LEFT JOIN users citizen ON citizen.id = t.citizen_user_id
      LEFT JOIN users resolver ON resolver.id = t.assigned_resolver_id
      WHERE t.control_center_id = $1
      ORDER BY t.created_at DESC
      LIMIT 12
      `,
      [ccId]
    );

    const resolverStatusResult = await pool.query(
      `
      WITH resolver_base AS (
        SELECT
          u.id,
          u.full_name,
          u.phone,
          u.is_active,
          COALESCE(UPPER(rl.status), 'SIN_UBICACION') AS raw_status,
          rl.latitude,
          rl.longitude,
          rl.accuracy,
          rl.updated_at,
          COUNT(t.id)::int AS active_tickets_count
        FROM users u
        LEFT JOIN resolver_locations rl ON rl.user_id = u.id
        LEFT JOIN tickets t ON t.assigned_resolver_id = u.id
          AND t.control_center_id = u.control_center_id
          AND t.state = ANY($2::text[])
        WHERE u.control_center_id = $1
          AND u.role = 'RESOLVER'
        GROUP BY u.id, u.full_name, u.phone, u.is_active, rl.status, rl.latitude, rl.longitude, rl.accuracy, rl.updated_at
      )
      SELECT
        id,
        full_name,
        phone,
        is_active,
        raw_status AS status,
        latitude,
        longitude,
        accuracy,
        updated_at,
        active_tickets_count,
        CASE
          WHEN is_active IS NOT TRUE THEN 'INACTIVE'
          WHEN updated_at IS NULL THEN 'NO_GPS'
          WHEN accuracy IS NOT NULL AND (accuracy::numeric) > $3::numeric THEN 'GPS_INVALID'
          WHEN raw_status = 'OFFLINE' THEN 'OFFLINE'
          WHEN updated_at < NOW() - INTERVAL '10 minutes' THEN 'OFFLINE'
          WHEN updated_at < NOW() - INTERVAL '3 minutes' THEN 'STALE_GPS'
          WHEN raw_status IN ('BUSY','EN_ROUTE','ON_SITE') AND active_tickets_count = 0 THEN 'BLOCKED_NO_TICKET'
          WHEN active_tickets_count > 0 AND raw_status = 'EN_ROUTE' THEN 'EN_ROUTE'
          WHEN active_tickets_count > 0 AND raw_status = 'ON_SITE' THEN 'ON_SITE'
          WHEN active_tickets_count > 0 THEN 'BUSY'
          WHEN raw_status = 'AVAILABLE' THEN 'AVAILABLE'
          ELSE raw_status
        END AS operational_state,
        CASE
          WHEN updated_at IS NULL THEN 'SIN_UBICACION'
          WHEN accuracy IS NOT NULL AND (accuracy::numeric) > $3::numeric THEN 'GPS_INVALIDO'
          WHEN updated_at >= NOW() - INTERVAL '3 minutes' THEN 'ONLINE'
          WHEN updated_at >= NOW() - INTERVAL '10 minutes' THEN 'DESACTUALIZADO'
          ELSE 'OFFLINE'
        END AS heartbeat
      FROM resolver_base
      ORDER BY full_name ASC
      `,
      [ccId, ACTIVE_RESOLVER_TICKET_STATES, resolverGpsMaxAccuracy]
    );

    const actionsResult = await pool.query(
      `
      SELECT
        action_type AS label,
        COUNT(*)::int AS value
      FROM ticket_actions ta
      JOIN tickets t ON t.id = ta.ticket_id
      WHERE t.control_center_id = $1
        AND ta.created_at >= NOW() - ($2::int || ' days')::interval
      GROUP BY action_type
      ORDER BY value DESC
      LIMIT 12
      `,
      [ccId, days]
    );

    const geoTicketsResult = await pool.query(
      `
      SELECT
        t.id,
        t.title,
        t.alert_type,
        t.source_type,
        t.state,
        t.priority,
        t.latitude,
        t.longitude,
        t.created_at,
        t.event_sector_name,
        t.event_sector_method,
        t.jurisdiction_status,
        citizen.full_name AS citizen_name,
        CASE
          WHEN t.priority <= 1 THEN 1.00
          WHEN t.priority = 2 THEN 0.90
          WHEN t.state NOT IN ('CLOSED','CANCELLED','RESOLVED') THEN 0.85
          ELSE 0.62
        END::float AS weight
      FROM tickets t
      LEFT JOIN users citizen ON citizen.id = t.citizen_user_id
      WHERE t.control_center_id = $1
        AND t.created_at >= NOW() - ($2::int || ' days')::interval
        AND t.latitude IS NOT NULL
        AND t.longitude IS NOT NULL
      ORDER BY t.created_at DESC
      LIMIT 500
      `,
      [ccId, days]
    );

    const geoZonesResult = await pool.query(
      `
      WITH geo AS (
        SELECT
          id,
          alert_type,
          state,
          latitude,
          longitude,
          created_at,
          COALESCE(NULLIF(TRIM(event_sector_name), ''), 'Sector no clasificado') AS sector_name,
          COALESCE(NULLIF(TRIM(event_sector_method), ''), 'Sector oficial/precargado del ticket') AS sector_method
        FROM tickets
        WHERE control_center_id = $1
          AND created_at >= NOW() - ($2::int || ' days')::interval
          AND latitude IS NOT NULL
          AND longitude IS NOT NULL
          AND COALESCE(jurisdiction_status, 'IN_JURISDICTION') <> 'OUT_OF_JURISDICTION'
      ), typed AS (
        SELECT
          sector_name,
          alert_type,
          COUNT(*)::int AS type_count,
          ROW_NUMBER() OVER (PARTITION BY sector_name ORDER BY COUNT(*) DESC, MAX(created_at) DESC, alert_type ASC) AS rn
        FROM geo
        GROUP BY sector_name, alert_type
      ), zones AS (
        SELECT
          sector_name,
          MIN(sector_method) AS sector_method,
          AVG(latitude)::float AS latitude,
          AVG(longitude)::float AS longitude,
          COUNT(*)::int AS tickets_count,
          COUNT(*) FILTER (WHERE state NOT IN ('CLOSED','CANCELLED','RESOLVED'))::int AS open_count,
          MAX(created_at) AS last_ticket_at
        FROM geo
        GROUP BY sector_name
      )
      SELECT
        z.sector_name AS sector_aproximado,
        z.sector_method,
        z.latitude,
        z.longitude,
        z.tickets_count,
        z.open_count,
        z.last_ticket_at,
        COALESCE(t.alert_type, 'SIN_TIPO') AS top_alert_type
      FROM zones z
      LEFT JOIN typed t ON t.sector_name = z.sector_name AND t.rn = 1
      ORDER BY z.tickets_count DESC, z.open_count DESC, z.last_ticket_at DESC NULLS LAST
      LIMIT 12
      `,
      [ccId, days]
    );

    const hourly = Array.from({ length: 24 }, (_, hour) => {
      const found = hourlyResult.rows.find((item) => Number(item.hour) === hour);
      return { hour, label: `${String(hour).padStart(2, "0")}:00`, value: found ? Number(found.value) : 0 };
    });

    const ticketSummary = summaryResult.rows[0] || {};
    const usersSummary = usersSummaryResult.rows[0] || {};
    const resolversSummary = resolversSummaryResult.rows[0] || {};
    const sirensSummary = sirensSummaryResult.rows[0] || {};
    const devicesSummary = devicesSummaryResult.rows[0] || {};

    res.json({
      status: "ok",
      updated_at: nowChile(),
      period_days: days,
      control_center: controlCenter,
      generated_by: req.panel_session ? {
        id: req.panel_session.sub,
        name: req.panel_session.name,
        role: req.panel_session.role
      } : null,
      summary: {
        tickets: {
          ...ticketSummary,
          avg_ack_human: minutesToHuman(ticketSummary.avg_ack_minutes),
          avg_assign_human: minutesToHuman(ticketSummary.avg_assign_minutes),
          avg_resolve_human: minutesToHuman(ticketSummary.avg_resolve_minutes),
          avg_close_human: minutesToHuman(ticketSummary.avg_close_minutes),
          oldest_open_human: minutesToHuman(ticketSummary.oldest_open_minutes)
        },
        users: usersSummary,
        resolvers: resolversSummary,
        sirens: sirensSummary,
        devices: devicesSummary
      },
      charts: {
        tickets_by_day: dailyResult.rows,
        tickets_by_hour: hourly,
        tickets_by_state: stateResult.rows,
        tickets_by_alert_type: alertTypeResult.rows,
        tickets_by_source: sourceResult.rows,
        actions_by_type: actionsResult.rows
      },
      rankings: {
        top_neighbors: topNeighborsResult.rows,
        top_resolvers: topResolversResult.rows
      },
      operations: {
        recent_tickets: recentTicketsResult.rows,
        pending_validation_neighbors: pendingValidationResult.rows,
        resolver_status: resolverStatusResult.rows,
        resolver_reconciliation: resolverReconciliation
      },
      geo: {
        center: {
          latitude: controlCenter.map_center_lat || controlCenter.latitude,
          longitude: controlCenter.map_center_lon || controlCenter.longitude
        },
        boundary_geojson: controlCenter.boundary_geojson || null,
        geofence_buffer_meters: controlCenter.geofence_buffer_meters || 0,
        map_zoom: controlCenter.map_zoom || 13,
        event_points: geoTicketsResult.rows.map((row) => ({
          ...row,
          latitude: row.latitude == null ? null : Number(row.latitude),
          longitude: row.longitude == null ? null : Number(row.longitude),
          weight: row.weight == null ? 0.65 : Number(row.weight)
        })),
        heatmap_points: geoTicketsResult.rows.map((row) => [
          Number(row.latitude),
          Number(row.longitude),
          row.weight == null ? 0.65 : Number(row.weight)
        ]),
        top_zones: geoZonesResult.rows.map((row) => ({
          ...row,
          latitude: row.latitude == null ? null : Number(row.latitude),
          longitude: row.longitude == null ? null : Number(row.longitude)
        }))
      }
    });
  } catch (error) {
    console.error("[DASHBOARD ANALYTICS ERROR]", error);
    res.status(500).json({
      status: "error",
      message: error.message || "Error generating dashboard analytics"
    });
  }
});



/*
   =========================================================
   Luc-IA + DASHBOARD TICKETS PAGINADOS v28
   =========================================================

   Objetivo:
   - Luc-IA consulta datos reales solo en lectura.
   - La consulta queda forzada al centro de control del usuario logueado.
   - No se permite SQL libre desde frontend.
   - Solo se ejecutan SELECT/WITH generados por catálogo seguro.
   - Se audita pregunta, intención, SQL y cantidad de filas.
   - El listado de tickets trabaja paginado de 10 en 10.
   =========================================================
*/

function dashboardAuthorizedControlCenterCode(req) {
  // Regla estricta multi-comuna:
  // - OPERATOR/ADMIN municipal: la sesión manda siempre.
  // - SUPER_ADMIN: puede elegir centro con control_center_code para soporte/demo.
  if (req.panel_session && isSuperAdminSession(req.panel_session)) {
    return String(req.query.control_center_code || req.body?.control_center_code || req.panel_session.control_center_code || "CC-VINA").trim().toUpperCase();
  }
  if (req.panel_session && req.panel_session.control_center_code) {
    return String(req.panel_session.control_center_code).trim().toUpperCase();
  }
  return String(req.query.control_center_code || req.body?.control_center_code || "CC-VINA").trim().toUpperCase();
}

let luciaSchemaReady = false;
async function ensureLuciaSchema() {
  if (luciaSchemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lucia_query_audit (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      user_role TEXT,
      control_center_id TEXT,
      control_center_code TEXT,
      question TEXT,
      intent TEXT,
      sql_text TEXT,
      row_count INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_lucia_audit_cc_created
    ON lucia_query_audit(control_center_id, created_at DESC)
  `);
  luciaSchemaReady = true;
}

function normalizeLuciaText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function luciaPeriodDays(question) {
  const q = normalizeLuciaText(question);
  const m = q.match(/(ultimos|ultimas|hace|de los|de las)\s+(\d{1,3})\s+(dias|dia)/);
  if (m) return Math.max(1, Math.min(365, Number(m[2])));
  if (/hoy|dia de hoy/.test(q)) return 1;
  if (/ayer/.test(q)) return 2;
  if (/semana|7 dias/.test(q)) return 7;
  if (/mes|mensual|30 dias/.test(q)) return 30;
  if (/trimestre|90 dias/.test(q)) return 90;
  if (/ano|año|12 meses|365 dias/.test(q)) return 365;
  return 30;
}

function luciaLimit(question, fallback = 10) {
  const q = normalizeLuciaText(question);
  const m = q.match(/(?:top|primeros|primeras|ultimos|ultimas|mostrar|muestrame|muéstrame)\s+(\d{1,3})/);
  if (m) return Math.max(1, Math.min(50, Number(m[1])));
  return fallback;
}


const LUCIA_PDF_DIR = path.join(UPLOAD_DIR, "lucia_reports");
fs.mkdirSync(LUCIA_PDF_DIR, { recursive: true });

function luciaWantsPdf(question) {
  const q = normalizeLuciaText(question);
  return /\bpdf\b|descargable|descargar|exportar|imprimir/.test(q);
}

function luciaRequestedAlertType(question) {
  const q = normalizeLuciaText(question);
  const candidates = [
    { key: "FIRE", label: "Incendio", aliases: ["incendio", "incendios", "fuego", "fire", "inc"] },
    { key: "MEDICAL", label: "Médica", aliases: ["medica", "medico", "salud", "ambulancia", "medical", "emergencia medica"] },
    { key: "VIF", label: "VIF", aliases: ["vif", "violencia", "silenciosa", "silencioso"] },
    { key: "SECURITY", label: "Seguridad", aliases: ["seguridad", "delito", "robo", "asalto", "seg", "security"] },
    { key: "FALL_DETECTED", label: "Caída", aliases: ["caida", "caidas", "fall", "fall_detected", "accidente"] },
    { key: "SOS_MANUAL", label: "SOS general", aliases: ["sos", "sos manual", "general", "manual"] },
    { key: "RISK", label: "Riesgo", aliases: ["riesgo", "risk", "peligro"] },
    { key: "OTHER", label: "Otro", aliases: ["otro", "otros", "other"] }
  ];

  for (const item of candidates) {
    if (item.aliases.some(alias => q.includes(alias))) {
      const sqlTypes = [item.key, item.label.toUpperCase(), item.label.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase()];
      if (item.key === "FIRE") sqlTypes.push("INCENDIO", "INCENDIOS", "INC");
      if (item.key === "MEDICAL") sqlTypes.push("MEDICA", "MÉDICA", "MEDICO", "SALUD");
      if (item.key === "SECURITY") sqlTypes.push("SEGURIDAD", "SEG");
      if (item.key === "FALL_DETECTED") sqlTypes.push("CAIDA", "CAÍDA", "FALL", "ACCIDENTE");
      if (item.key === "SOS_MANUAL") sqlTypes.push("SOS", "SOS GENERAL");
      return { key: item.key, label: item.label, sqlTypes: [...new Set(sqlTypes.map(x => String(x).toUpperCase()))] };
    }
  }
  return null;
}

function luciaGuidedSuggestions(kind = "general") {
  const catalog = {
    general: [
      { label: "Tickets sin asignar", question: "Qué tickets siguen sin asignar" },
      { label: "Tickets incendio", question: "Muéstrame tickets de incendio de los últimos 30 días" },
      { label: "Zonas críticas", question: "Identifica zonas críticas de los últimos 30 días" },
      { label: "Resolutores con más rechazos", question: "Qué resolutores han rechazado más tickets este mes" },
      { label: "Estado de plataforma", question: "Cuántos usuarios, resolutores, sirenas y dispositivos hay en la comuna" },
      { label: "PDF operativo", question: "Entrégame un reporte en PDF de los tickets abiertos" }
    ],
    severity: [
      { label: "Fuera de SLA", question: "Muéstrame tickets fuera de SLA" },
      { label: "Alta prioridad", question: "Muéstrame tickets abiertos de alta prioridad" },
      { label: "Sin asignar", question: "Qué tickets siguen sin asignar" },
      { label: "VIF", question: "Cuántos casos VIF hay esta semana" }
    ],
    inventory: [
      { label: "Sirenas", question: "Cuántas sirenas hay en la comuna" },
      { label: "Resolutores", question: "Cuántos resolutores hay en la comuna" },
      { label: "Vecinos", question: "Cuántos vecinos hay registrados" },
      { label: "Dispositivos", question: "Cuántos dispositivos hay en la comuna" }
    ],
    tickets: [
      { label: "Incendio", question: "Muéstrame tickets de incendio" },
      { label: "Médica", question: "Muéstrame tickets médicos" },
      { label: "Seguridad", question: "Muéstrame tickets de seguridad" },
      { label: "VIF", question: "Muéstrame tickets VIF" },
      { label: "Sin asignar", question: "Qué tickets siguen sin asignar" }
    ]
  };
  return catalog[kind] || catalog.general;
}

function luciaSuggestionKind(question, intent) {
  const q = normalizeLuciaText(question);
  if (intent === "ambiguous_severity") return "severity";
  if (/usuario|vecino|resolutor|sirena|dispositivo|inventario|plataforma/.test(q)) return "inventory";
  if (/ticket|caso|emergencia|evento/.test(q)) return "tickets";
  return "general";
}

function luciaPdfAscii(value) {
  return String(value ?? "")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "")
    .trim();
}

function luciaWrapLine(text, max = 98) {
  const words = luciaPdfAscii(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > max) {
      if (line) lines.push(line);
      line = word;
    } else {
      line = (line + " " + word).trim();
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function pdfEscape(text) {
  return luciaPdfAscii(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildSimpleLuciaPdf({ title, subtitle, lines, columns, rows }) {
  const pageLineLimit = 58;
  const allLines = [];
  allLines.push(title || "Reporte Luc-IA");
  if (subtitle) allLines.push(subtitle);
  allLines.push(`Generado: ${new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" })}`);
  allLines.push("");
  for (const line of (lines || [])) {
    allLines.push(...luciaWrapLine(line, 105));
  }
  allLines.push("");
  const safeColumns = (columns || []).slice(0, 7).map(c => luciaPdfAscii(c).slice(0, 18));
  if (safeColumns.length && rows && rows.length) {
    allLines.push(safeColumns.join(" | "));
    allLines.push("-".repeat(Math.min(110, safeColumns.join(" | ").length)));
    for (const row of rows.slice(0, Number(process.env.LUCIA_MAX_PDF_ROWS || 40))) {
      allLines.push(safeColumns.map(c => luciaPdfAscii(row[c]).slice(0, 18).padEnd(18)).join(" | "));
    }
    if (rows.length > Number(process.env.LUCIA_MAX_PDF_ROWS || 40)) {
      allLines.push(`... ${rows.length - Number(process.env.LUCIA_MAX_PDF_ROWS || 40)} filas adicionales no incluidas en este PDF.`);
    }
  } else {
    allLines.push("Sin tabla de resultados para este reporte.");
  }

  const pages = [];
  for (let i = 0; i < allLines.length; i += pageLineLimit) {
    pages.push(allLines.slice(i, i + pageLineLimit));
  }

  const objects = [];
  function addObject(content) {
    objects.push(content);
    return objects.length;
  }

  const catalogId = addObject("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesId = addObject("PAGES_PLACEHOLDER");
  const fontId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");
  const pageIds = [];

  for (const pageLines of pages) {
    let stream = "BT\n/F1 10 Tf\n12 TL\n50 792 Td\n";
    pageLines.forEach((line, idx) => {
      const text = pdfEscape(line).slice(0, 130);
      if (idx === 0) stream += `(${text}) Tj\n`;
      else stream += `T* (${text}) Tj\n`;
    });
    stream += "ET\n";
    const streamBytes = Buffer.from(stream, "latin1");
    const contentId = addObject(`<< /Length ${streamBytes.length} >>\nstream\n${stream}\nendstream`);
    const pageId = addObject(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }

  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

async function createLuciaPdfReport({ question, queryDef, rows, answer, controlCenter }) {
  const reportId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
  const columns = luciaColumns(rows);
  const title = `Reporte Luc-IA - ${queryDef.title || queryDef.intent}`;
  const subtitle = `${controlCenter.code} - ${controlCenter.name || "Centro de control"}`;
  const pdf = buildSimpleLuciaPdf({
    title,
    subtitle,
    lines: [
      `Pregunta: ${question}`,
      `Respuesta: ${answer}`,
      `Modo: solo lectura, restringido al centro de control autorizado.`,
      `Intent: ${queryDef.intent}. Periodo: ${queryDef.days || 0} dias. Filas: ${rows.length}.`
    ],
    columns,
    rows
  });
  const filename = `lucia_${controlCenter.code}_${reportId}.pdf`.replace(/[^A-Za-z0-9_.-]/g, "_");
  const filepath = path.join(LUCIA_PDF_DIR, filename);
  fs.writeFileSync(filepath, pdf);
  return {
    id: reportId,
    filename,
    url: `/uploads/lucia_reports/${filename}`,
    generated_at: new Date().toISOString()
  };
}

function luciaIntent(question) {
  const q = normalizeLuciaText(question);
  const requestedAlertType = luciaRequestedAlertType(question);

  if (/^(hola|buenas|ayuda|que puedes hacer|como me ayudas|opciones|menu)\b/.test(q)) return "guided_help";
  if (/grave|graves|complicad|critico|criticos|importante|urgente/.test(q) && !/zona|sector|barrio/.test(q)) return "ambiguous_severity";
  if (/alta prioridad|prioridad alta|prioritarios|prioritarias/.test(q) && /(ticket|tickets|caso|casos|emergencia|emergencias)/.test(q)) return "high_priority_tickets";

  // Inventario operacional. Se acepta “siren” como typo de sirena/sirenas.
  if (/siren|sirena|sirenas/.test(q)) return "sirens_summary";
  if (/(cuant|cantidad|total|inventario|estado de plataforma).*(usuario|usuarios|vecino|vecinos|resolutor|resolutores|dispositivo|dispositivos)/.test(q)) return "platform_inventory";

  if (/rechaz/.test(q) && /resolutor|funcionario|movil|equipo/.test(q)) return "resolver_rejections";
  if (/(top|ranking|mas|mayor|mejor).*(resolutor|funcionario|movil|equipo)|(resolutor|funcionario|movil|equipo).*(top|ranking|mas|mayor|mejor|atend|gestion|cerr|resuelt|resolv|finaliz|termin)/.test(q)) return "resolver_performance";
  if (/sin asignar|no asignad|pendiente de asign|disponible.*ticket|ticket.*disponible/.test(q)) return "unassigned_tickets";
  if (requestedAlertType && (
    /(ticket|tickets|caso|casos|evento|eventos|emergencia|emergencias|muestra|mostrar|muestrame|muéstrame|lista|listado|cuanto|cantidad|reporte|pdf)/.test(q) ||
    !/(resolutor|resolutores|sirena|sirenas|usuario|usuarios|vecino|vecinos|dispositivo|dispositivos)/.test(q)
  )) return "tickets_by_alert_type";
  if (/abiert|activo|en curso|pendiente|sin cerrar/.test(q) && /ticket|caso|emergencia/.test(q)) return "open_tickets";
  if (/vif|violencia|silencios/.test(q)) return "vif_summary";
  if (/sla|atras|atrasad|vencid|demora|fuera de plazo|tiempo/.test(q)) return "sla_risks";
  if (/zona|sector|barrio|calor|recurren|concentr/.test(q)) return "critical_zones";
  if (/tipo|categoria|emergencia/.test(q) && /(cuanto|cantidad|distrib|resumen|ranking)/.test(q)) return "ticket_types";
  if (/informe|resumen|ejecutivo|reporte|situacion|estado/.test(q)) return "executive_summary";

  // Antes caía al resumen ejecutivo. Eso confundía: ahora Luc-IA reconoce que no entendió.
  return "unknown";
}

function luciaBuildSafeQuery(question, ccId) {
  const intent = luciaIntent(question);
  const days = luciaPeriodDays(question);
  const limit = luciaLimit(question, 10);
  const baseParams = [ccId, days, limit];

  if (intent === "sirens_summary") {
    return {
      intent, days: 0, limit: 1,
      title: "Sirenas de la comuna",
      params: [ccId],
      sql: `
        SELECT
          COUNT(*)::int AS sirenas_total,
          COUNT(*) FILTER (WHERE COALESCE(UPPER(state), 'OFF') IN ('ON','ACTIVE','ACTIVA'))::int AS sirenas_activas,
          COUNT(*) FILTER (WHERE last_seen IS NOT NULL AND last_seen >= NOW() - INTERVAL '2 minutes')::int AS sirenas_online,
          COUNT(*) FILTER (WHERE last_seen IS NULL OR last_seen < NOW() - INTERVAL '2 minutes')::int AS sirenas_offline,
          STRING_AGG(name, ', ' ORDER BY name) AS nombres
        FROM sirens
        WHERE control_center_id = $1
        LIMIT 1
      `
    };
  }

  if (intent === "platform_inventory") {
    return {
      intent, days: 0, limit: 1,
      title: "Inventario operacional",
      params: [ccId],
      sql: `
        SELECT
          (SELECT COUNT(*)::int FROM users WHERE control_center_id = $1) AS usuarios_total,
          (SELECT COUNT(*)::int FROM users WHERE control_center_id = $1 AND role = 'NEIGHBOR') AS vecinos,
          (SELECT COUNT(*)::int FROM users WHERE control_center_id = $1 AND role = 'RESOLVER') AS resolutores,
          (SELECT COUNT(*)::int FROM users WHERE control_center_id = $1 AND role = 'OPERATOR') AS operadores,
          (SELECT COUNT(*)::int FROM users WHERE control_center_id = $1 AND role = 'ADMIN') AS admins,
          (SELECT COUNT(*)::int FROM sirens WHERE control_center_id = $1) AS sirenas,
          (SELECT COUNT(*)::int FROM devices WHERE control_center_id = $1) AS dispositivos,
          (SELECT COUNT(*)::int FROM tickets WHERE control_center_id = $1 AND state NOT IN ('CLOSED','CANCELLED','RESOLVED')) AS tickets_abiertos
        FROM control_centers cc
        WHERE cc.id = $1
        LIMIT 1
      `
    };
  }

  if (intent === "unknown" || intent === "guided_help" || intent === "ambiguous_severity") {
    return {
      intent, days: 0, limit: 1,
      title: intent === "ambiguous_severity" ? "Aclaración necesaria" : "Guía Luc-IA",
      params: [ccId],
      sql: `
        SELECT
          code AS centro_control,
          name AS comuna
        FROM control_centers cc
        WHERE cc.id = $1
        LIMIT 1
      `
    };
  }

  if (intent === "high_priority_tickets") {
    return {
      intent, days, limit,
      title: "Tickets de alta prioridad",
      params: baseParams,
      sql: `
        SELECT
          t.id,
          t.title AS titulo,
          t.alert_type AS tipo,
          t.state AS estado,
          t.priority AS prioridad,
          COALESCE(t.event_sector_name,
            CASE
              WHEN t.latitude > -32.9800 AND t.longitude < -71.5300 THEN 'Reñaca Bajo / Jardín del Mar'
              WHEN t.latitude > -33.0000 AND t.longitude > -71.5220 THEN 'Gómez Carreño / Reñaca Alto / Glorias Navales'
              WHEN t.latitude > -33.0020 AND t.longitude BETWEEN -71.5320 AND -71.5050 THEN 'Santa Julia / Achupallas / Canal Beagle'
              WHEN t.latitude BETWEEN -33.0300 AND -33.0100 AND t.longitude < -71.5400 THEN 'Plan Viña / Libertad / Población Vergara'
              WHEN t.latitude BETWEEN -33.0300 AND -33.0050 AND t.longitude BETWEEN -71.5400 AND -71.5150 THEN 'Miraflores / Chorrillos / Viña Oriente'
              WHEN t.latitude < -33.0350 AND t.longitude BETWEEN -71.5400 AND -71.5150 THEN 'Forestal'
              WHEN t.latitude < -33.0300 AND t.longitude < -71.5400 THEN 'Recreo / Nueva Aurora / Agua Santa'
              ELSE 'Sector estimado por coordenada'
            END
          ) AS sector_estimado,
          COALESCE(t.event_sector_method, 'Estimación por coordenada; no cartografía oficial de barrios') AS metodo_sector,
          citizen.full_name AS vecino,
          resolver.full_name AS resolutor,
          ROUND(EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 60.0)::int AS edad_min,
          t.created_at
        FROM tickets t
        LEFT JOIN users citizen ON citizen.id = t.citizen_user_id
        LEFT JOIN users resolver ON resolver.id = t.assigned_resolver_id
        WHERE t.control_center_id = $1
          AND t.created_at >= NOW() - ($2::int || ' days')::interval
          AND t.state NOT IN ('CLOSED','CANCELLED','RESOLVED')
          AND t.priority <= 2
        ORDER BY t.priority ASC, t.created_at ASC
        LIMIT $3
      `
    };
  }

  if (intent === "resolver_performance") {
    const performanceByResolved = /resuelt|cerrad|finaliz|terminad|completad/.test(normalizeLuciaText(question));
    return {
      intent, days, limit,
      title: performanceByResolved ? "Resolutores con más tickets resueltos" : "Desempeño de resolutores",
      params: baseParams,
      sort_mode: performanceByResolved ? "resolved" : "assigned",
      sql: `
        SELECT
          u.full_name AS resolutor,
          u.phone AS telefono,
          COUNT(t.id)::int AS tickets_asignados,
          COUNT(t.id) FILTER (WHERE t.state IN ('RESOLVED','CLOSED'))::int AS tickets_cerrados,
          COUNT(t.id) FILTER (WHERE t.state IN ('ASSIGNED','ACCEPTED_BY_RESOLVER','EN_ROUTE','ON_SITE'))::int AS tickets_en_gestion,
          ROUND(AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.assigned_at)) / 60.0) FILTER (WHERE t.resolved_at IS NOT NULL AND t.assigned_at IS NOT NULL)::numeric, 1) AS min_promedio_resolucion
        FROM users u
        LEFT JOIN tickets t ON t.assigned_resolver_id = u.id
          AND t.control_center_id = $1
          AND t.created_at >= NOW() - ($2::int || ' days')::interval
        WHERE u.control_center_id = $1
          AND u.role = 'RESOLVER'
        GROUP BY u.id, u.full_name, u.phone
        ORDER BY ${performanceByResolved ? "tickets_cerrados DESC, tickets_asignados DESC" : "tickets_asignados DESC, tickets_cerrados DESC"}, resolutor ASC
        LIMIT $3
      `
    };
  }

  if (intent === "resolver_rejections") {
    return {
      intent, days, limit,
      title: "Rechazos por resolutor",
      params: baseParams,
      sql: `
        SELECT
          COALESCE(u.full_name, 'Sin actor identificado') AS resolutor,
          COALESCE(u.phone, '—') AS telefono,
          COUNT(*)::int AS rechazos,
          MAX(ta.created_at) AS ultimo_rechazo
        FROM ticket_actions ta
        JOIN tickets t ON t.id = ta.ticket_id
        LEFT JOIN users u ON u.id = ta.actor_user_id
        WHERE t.control_center_id = $1
          AND ta.created_at >= NOW() - ($2::int || ' days')::interval
          AND ta.action_type IN ('RESOLVER_REJECTED','TICKET_REJECTED')
        GROUP BY u.id, u.full_name, u.phone
        ORDER BY rechazos DESC, ultimo_rechazo DESC
        LIMIT $3
      `
    };
  }

  if (intent === "unassigned_tickets") {
    return {
      intent, days, limit,
      title: "Tickets sin asignar",
      params: baseParams,
      sql: `
        SELECT
          t.id,
          t.title AS titulo,
          t.alert_type AS tipo,
          t.state AS estado,
          t.priority AS prioridad,
          ROUND(EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 60.0)::int AS edad_min,
          citizen.full_name AS vecino,
          t.created_at
        FROM tickets t
        LEFT JOIN users citizen ON citizen.id = t.citizen_user_id
        WHERE t.control_center_id = $1
          AND t.created_at >= NOW() - ($2::int || ' days')::interval
          AND t.state NOT IN ('CLOSED','CANCELLED','RESOLVED')
          AND t.assigned_resolver_id IS NULL
        ORDER BY t.priority ASC, t.created_at ASC
        LIMIT $3
      `
    };
  }

  if (intent === "open_tickets") {
    return {
      intent, days, limit,
      title: "Tickets abiertos",
      params: baseParams,
      sql: `
        SELECT
          t.id,
          t.title AS titulo,
          t.alert_type AS tipo,
          t.state AS estado,
          t.priority AS prioridad,
          resolver.full_name AS resolutor,
          ROUND(EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 60.0)::int AS edad_min,
          t.created_at
        FROM tickets t
        LEFT JOIN users resolver ON resolver.id = t.assigned_resolver_id
        WHERE t.control_center_id = $1
          AND t.created_at >= NOW() - ($2::int || ' days')::interval
          AND t.state NOT IN ('CLOSED','CANCELLED','RESOLVED')
        ORDER BY t.priority ASC, t.created_at ASC
        LIMIT $3
      `
    };
  }

  if (intent === "vif_summary") {
    return {
      intent, days, limit,
      title: "Resumen VIF",
      params: [ccId, days],
      sql: `
        SELECT
          COUNT(*)::int AS eventos_vif,
          COUNT(*) FILTER (WHERE state NOT IN ('CLOSED','CANCELLED','RESOLVED'))::int AS abiertos,
          COUNT(*) FILTER (WHERE source_type = 'MOBILE_APP')::int AS desde_app,
          COUNT(*) FILTER (WHERE priority <= 2)::int AS alta_prioridad,
          ROUND(AVG(EXTRACT(EPOCH FROM (assigned_at - created_at)) / 60.0) FILTER (WHERE assigned_at IS NOT NULL)::numeric, 1) AS min_promedio_asignacion,
          MAX(created_at) AS ultimo_evento
        FROM tickets
        WHERE control_center_id = $1
          AND created_at >= NOW() - ($2::int || ' days')::interval
          AND alert_type = 'VIF'
        LIMIT 1
      `
    };
  }

  if (intent === "sla_risks") {
    return {
      intent, days, limit,
      title: "Tickets con riesgo SLA",
      params: baseParams,
      sql: `
        SELECT
          t.id,
          t.title AS titulo,
          t.alert_type AS tipo,
          t.state AS estado,
          t.priority AS prioridad,
          resolver.full_name AS resolutor,
          ROUND(EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 60.0)::int AS edad_min,
          CASE
            WHEN t.acknowledged_at IS NULL AND t.created_at < NOW() - INTERVAL '5 minutes' THEN 'ACK vencido'
            WHEN t.assigned_at IS NULL AND t.created_at < NOW() - INTERVAL '15 minutes' THEN 'Asignación vencida'
            WHEN t.resolved_at IS NULL AND t.created_at < NOW() - INTERVAL '60 minutes' THEN 'Resolución vencida'
            ELSE 'En observación'
          END AS riesgo
        FROM tickets t
        LEFT JOIN users resolver ON resolver.id = t.assigned_resolver_id
        WHERE t.control_center_id = $1
          AND t.created_at >= NOW() - ($2::int || ' days')::interval
          AND t.state NOT IN ('CLOSED','CANCELLED','RESOLVED')
          AND (
            (t.acknowledged_at IS NULL AND t.created_at < NOW() - INTERVAL '5 minutes') OR
            (t.assigned_at IS NULL AND t.created_at < NOW() - INTERVAL '15 minutes') OR
            (t.resolved_at IS NULL AND t.created_at < NOW() - INTERVAL '60 minutes')
          )
        ORDER BY t.created_at ASC
        LIMIT $3
      `
    };
  }

  if (intent === "critical_zones") {
    return {
      intent, days, limit,
      title: "Zonas críticas por sector",
      params: baseParams,
      sql: `
        WITH geo AS (
          SELECT
            latitude::numeric AS lat,
            longitude::numeric AS lon,
            COALESCE(event_sector_name,
              CASE
                WHEN latitude > -32.9800 AND longitude < -71.5300 THEN 'Reñaca Bajo / Jardín del Mar'
                WHEN latitude > -33.0000 AND longitude > -71.5220 THEN 'Gómez Carreño / Reñaca Alto / Glorias Navales'
                WHEN latitude > -33.0020 AND longitude BETWEEN -71.5320 AND -71.5050 THEN 'Santa Julia / Achupallas / Canal Beagle'
                WHEN latitude BETWEEN -33.0300 AND -33.0100 AND longitude < -71.5400 THEN 'Plan Viña / Libertad / Población Vergara'
                WHEN latitude BETWEEN -33.0300 AND -33.0050 AND longitude BETWEEN -71.5400 AND -71.5150 THEN 'Miraflores / Chorrillos / Viña Oriente'
                WHEN latitude < -33.0350 AND longitude BETWEEN -71.5400 AND -71.5150 THEN 'Forestal'
                WHEN latitude < -33.0300 AND longitude < -71.5400 THEN 'Recreo / Nueva Aurora / Agua Santa'
                ELSE 'Sector por determinar dentro de la comuna'
              END
            ) AS sector_aproximado,
            alert_type,
            state,
            created_at
          FROM tickets
          WHERE control_center_id = $1
            AND created_at >= NOW() - ($2::int || ' days')::interval
            AND latitude IS NOT NULL
            AND longitude IS NOT NULL
            AND COALESCE(jurisdiction_status, 'IN_JURISDICTION') <> 'OUT_OF_JURISDICTION'
        ), typed AS (
          SELECT
            sector_aproximado,
            alert_type,
            COUNT(*)::int AS tipo_count,
            ROW_NUMBER() OVER (PARTITION BY sector_aproximado ORDER BY COUNT(*) DESC, alert_type ASC) AS rn
          FROM geo
          GROUP BY sector_aproximado, alert_type
        )
        SELECT
          g.sector_aproximado AS sector_estimado,
          COUNT(*)::int AS eventos,
          COUNT(*) FILTER (WHERE g.state NOT IN ('CLOSED','CANCELLED','RESOLVED'))::int AS abiertos,
          COALESCE(t.alert_type, 'SIN_TIPO') AS tipo_principal,
          'Zonificación oficial UV si está disponible; fallback por coordenada' AS metodo_sector,
          MAX(g.created_at) AS ultimo_evento
        FROM geo g
        LEFT JOIN typed t ON t.sector_aproximado = g.sector_aproximado AND t.rn = 1
        GROUP BY g.sector_aproximado, t.alert_type
        ORDER BY eventos DESC, ultimo_evento DESC
        LIMIT $3
      `
    };
  }

  if (intent === "tickets_by_alert_type") {
    const requested = luciaRequestedAlertType(question) || { key: "UNKNOWN", label: "tipo solicitado", sqlTypes: ["UNKNOWN"] };
    return {
      intent, days, limit,
      title: `Tickets de ${requested.label}`,
      requested_alert_type: requested,
      params: [ccId, days, limit, requested.sqlTypes],
      sql: `
        SELECT
          t.id,
          t.title AS titulo,
          t.alert_type AS tipo,
          t.state AS estado,
          t.priority AS prioridad,
          COALESCE(t.event_sector_name,
            CASE
              WHEN t.latitude > -32.9800 AND t.longitude < -71.5300 THEN 'Reñaca Bajo / Jardín del Mar'
              WHEN t.latitude > -33.0000 AND t.longitude > -71.5220 THEN 'Gómez Carreño / Reñaca Alto / Glorias Navales'
              WHEN t.latitude > -33.0020 AND t.longitude BETWEEN -71.5320 AND -71.5050 THEN 'Santa Julia / Achupallas / Canal Beagle'
              WHEN t.latitude BETWEEN -33.0300 AND -33.0100 AND t.longitude < -71.5400 THEN 'Plan Viña / Libertad / Población Vergara'
              WHEN t.latitude BETWEEN -33.0300 AND -33.0050 AND t.longitude BETWEEN -71.5400 AND -71.5150 THEN 'Miraflores / Chorrillos / Viña Oriente'
              WHEN t.latitude < -33.0350 AND t.longitude BETWEEN -71.5400 AND -71.5150 THEN 'Forestal'
              WHEN t.latitude < -33.0300 AND t.longitude < -71.5400 THEN 'Recreo / Nueva Aurora / Agua Santa'
              ELSE 'Sector por determinar'
            END
          ) AS sector_estimado,
          COALESCE(t.event_sector_method, 'Zonificación oficial UV si está disponible; fallback por coordenada') AS metodo_sector,
          citizen.full_name AS vecino,
          resolver.full_name AS resolutor,
          ROUND(EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 60.0)::int AS edad_min,
          COUNT(*) OVER()::int AS total_en_periodo,
          t.created_at
        FROM tickets t
        LEFT JOIN users citizen ON citizen.id = t.citizen_user_id
        LEFT JOIN users resolver ON resolver.id = t.assigned_resolver_id
        WHERE t.control_center_id = $1
          AND t.created_at >= NOW() - ($2::int || ' days')::interval
          AND UPPER(COALESCE(t.alert_type, '')) = ANY($4::text[])
        ORDER BY
          CASE WHEN t.state NOT IN ('CLOSED','CANCELLED','RESOLVED') THEN 0 ELSE 1 END,
          t.priority ASC,
          t.created_at DESC
        LIMIT $3
      `
    };
  }

  if (intent === "ticket_types") {
    return {
      intent, days, limit,
      title: "Tickets por tipo de emergencia",
      params: baseParams,
      sql: `
        SELECT
          COALESCE(alert_type, 'SIN_TIPO') AS tipo,
          COUNT(*)::int AS tickets,
          COUNT(*) FILTER (WHERE state NOT IN ('CLOSED','CANCELLED','RESOLVED'))::int AS abiertos,
          COUNT(*) FILTER (WHERE priority <= 2)::int AS alta_prioridad
        FROM tickets
        WHERE control_center_id = $1
          AND created_at >= NOW() - ($2::int || ' days')::interval
        GROUP BY alert_type
        ORDER BY tickets DESC
        LIMIT $3
      `
    };
  }

  return {
    intent: "executive_summary", days, limit: 1,
    title: "Resumen ejecutivo operacional",
    params: [ccId, days],
    sql: `
      SELECT
        COUNT(*)::int AS tickets_periodo,
        COUNT(*) FILTER (WHERE state NOT IN ('CLOSED','CANCELLED','RESOLVED'))::int AS tickets_abiertos,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS tickets_24h,
        COUNT(*) FILTER (WHERE priority <= 2)::int AS alta_prioridad,
        ROUND(AVG(EXTRACT(EPOCH FROM (assigned_at - created_at)) / 60.0) FILTER (WHERE assigned_at IS NOT NULL)::numeric, 1) AS min_promedio_asignacion,
        ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60.0) FILTER (WHERE resolved_at IS NOT NULL)::numeric, 1) AS min_promedio_resolucion,
        COUNT(*) FILTER (WHERE COALESCE(jurisdiction_status, 'IN_JURISDICTION') = 'OUT_OF_JURISDICTION')::int AS fuera_de_jurisdiccion
      FROM tickets
      WHERE control_center_id = $1
        AND created_at >= NOW() - ($2::int || ' days')::interval
      LIMIT 1
    `
  };
}

function validateLuciaSql(sql) {
  const compact = String(sql || "").replace(/\s+/g, " ").trim();
  if (!/^(SELECT|WITH)\s/i.test(compact)) throw new Error("Luc-IA solo puede ejecutar SELECT/WITH.");
  if (compact.includes(";")) throw new Error("Luc-IA no puede ejecutar múltiples sentencias.");
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|VACUUM|ANALYZE)\b/i.test(compact)) {
    throw new Error("Consulta bloqueada por política de solo lectura.");
  }
  const hasTenantFilter =
    /control_center_id\s*=\s*\$1/i.test(compact) ||
    /control_center_id\s*=\s*u\.control_center_id/i.test(compact) ||
    /FROM\s+control_centers\s+(?:cc\s+)?WHERE\s+(?:cc\.)?id\s*=\s*\$1/i.test(compact);

  if (!hasTenantFilter) {
    throw new Error("Consulta bloqueada: debe estar filtrada por centro de control.");
  }
  if (!/\bLIMIT\b/i.test(compact)) throw new Error("Consulta bloqueada: debe incluir LIMIT.");
  return compact;
}

async function runLuciaReadOnly(sql, params) {
  validateLuciaSql(sql);
  const client = await pool.connect();
  const started = Date.now();
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '3000ms'");
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return { rows: result.rows, row_count: result.rows.length, duration_ms: Date.now() - started };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

function luciaColumns(rows) {
  if (!rows || !rows.length) return [];
  return Object.keys(rows[0]);
}

function luciaAnswer(queryDef, rows, controlCenterCode) {
  const n = rows.length;
  const days = queryDef.days;
  if (queryDef.intent === "guided_help") {
    return `Puedo ayudarte a consultar la operación de ${controlCenterCode} con datos reales y solo de lectura. Elige una opción sugerida o pregúntame por tickets, resolutores, sirenas, zonas críticas, SLA o reportes PDF.`;
  }
  if (queryDef.intent === "ambiguous_severity") {
    return `Puedo revisar “casos graves”, pero necesito que lo definamos operacionalmente. Puedes verlo como tickets fuera de SLA, alta prioridad, sin asignar, VIF o con más rechazos.`;
  }
  if (queryDef.intent === "unknown") {
    return `No entendí con suficiente precisión la pregunta para convertirla en una consulta segura. Puedo guiarte con opciones operacionales: tickets, resolutores, sirenas, zonas críticas, SLA o reportes PDF.`;
  }
  if (queryDef.intent === "executive_summary") {
    const r = rows[0] || {};
    return `Resumen de ${controlCenterCode} para los últimos ${days} días: ${r.tickets_periodo || 0} tickets, ${r.tickets_abiertos || 0} abiertos, ${r.tickets_24h || 0} en las últimas 24 horas y ${r.alta_prioridad || 0} de alta prioridad. Tiempo promedio de asignación: ${r.min_promedio_asignacion ?? '—'} min. Tiempo promedio de resolución: ${r.min_promedio_resolucion ?? '—'} min.`;
  }
  if (queryDef.intent === "resolver_performance") {
    if (!n) return "No encontré actividad de resolutores para ese período.";
    const top = rows[0] || {};
    if (queryDef.sort_mode === "resolved") {
      return `El resolutor con mayor cantidad de tickets resueltos en el período es ${top.resolutor || "el primer lugar del ranking"}, con ${top.tickets_cerrados || 0} tickets cerrados/resueltos. Abajo dejé el ranking completo.`;
    }
    return `Encontré ${n} resolutores para el período. El ranking está ordenado por tickets asignados y cierres/resoluciones.`;
  }
  if (queryDef.intent === "resolver_rejections") return n ? `Estos son los resolutores con rechazos registrados en los últimos ${days} días.` : "No hay rechazos de resolutores registrados en ese período.";
  if (queryDef.intent === "unassigned_tickets") return n ? `Hay ${n} tickets sin asignar dentro del límite solicitado. Prioricé por criticidad y antigüedad.` : "No encontré tickets sin asignar en el período consultado.";
  if (queryDef.intent === "open_tickets") return n ? `Estos son los tickets abiertos más relevantes, ordenados por prioridad y antigüedad.` : "No encontré tickets abiertos para ese período.";
  if (queryDef.intent === "vif_summary") {
    const r = rows[0] || {};
    return `En VIF, para los últimos ${days} días, hay ${r.eventos_vif || 0} eventos, ${r.abiertos || 0} abiertos y ${r.alta_prioridad || 0} de alta prioridad. Promedio de asignación: ${r.min_promedio_asignacion ?? '—'} min.`;
  }
  if (queryDef.intent === "sla_risks") return n ? `Detecté ${n} tickets con riesgo o vencimiento SLA. Conviene revisar asignación y resolución.` : "No encontré tickets fuera de SLA en el período.";
  if (queryDef.intent === "critical_zones") return n ? `Estas son las principales zonas de recurrencia. El sector se calcula contra la capa oficial cargada de unidades vecinales/sectores; si un ticket no intersecta la capa, se marca sin sector oficial.` : "No hay puntos suficientes para identificar zonas críticas en ese período.";
  if (queryDef.intent === "high_priority_tickets") return n ? `Estos son los tickets abiertos de alta prioridad en los últimos ${days} días, con sector del evento según la zonificación cargada.` : "No encontré tickets abiertos de alta prioridad en ese período.";
  if (queryDef.intent === "tickets_by_alert_type") {
    const requested = queryDef.requested_alert_type?.label || "tipo solicitado";
    const total = rows[0]?.total_en_periodo ?? n;
    return total ? `Encontré ${total} ticket(s) de ${requested} en los últimos ${days} días dentro de ${controlCenterCode}. Muestro hasta ${queryDef.limit} registros, priorizando abiertos y más críticos.` : `No encontré tickets de ${requested} en los últimos ${days} días para ${controlCenterCode}.`;
  }
  if (queryDef.intent === "ticket_types") return n ? `Distribución de tickets por tipo de emergencia para los últimos ${days} días.` : "No hay tickets clasificados por tipo en ese período.";
  if (queryDef.intent === "sirens_summary") {
    const r = rows[0] || {};
    return `En ${controlCenterCode} hay ${r.sirenas_total || 0} sirena(s) registradas: ${r.sirenas_online || 0} online, ${r.sirenas_offline || 0} offline y ${r.sirenas_activas || 0} activas en este momento.`;
  }
  if (queryDef.intent === "platform_inventory") {
    const r = rows[0] || {};
    return `Inventario de ${controlCenterCode}: ${r.usuarios_total || 0} usuarios, ${r.vecinos || 0} vecinos, ${r.resolutores || 0} resolutores, ${r.operadores || 0} operadores, ${r.admins || 0} administradores, ${r.sirenas || 0} sirenas, ${r.dispositivos || 0} dispositivos y ${r.tickets_abiertos || 0} tickets abiertos.`;
  }

  return `Luc-IA procesó la consulta sobre ${controlCenterCode} y encontró ${n} filas.`;
}

function luciaSuggestionsForIntent(question, queryDef) {
  const q = normalizeLuciaText(question);
  const kind = luciaSuggestionKind(question, queryDef.intent);
  if (queryDef.intent === "unknown" || queryDef.intent === "guided_help" || queryDef.intent === "ambiguous_severity") {
    return luciaGuidedSuggestions(kind);
  }
  if (queryDef.intent === "critical_zones") {
    return [
      { label: "PDF zonas críticas", question: `Entrégame un reporte en PDF de zonas críticas de los últimos ${queryDef.days || 30} días` },
      { label: "Tickets sin asignar", question: "Qué tickets siguen sin asignar" },
      { label: "Tickets por tipo", question: "Distribución de tickets por tipo de emergencia" }
    ];
  }
  if (queryDef.intent === "resolver_rejections") {
    return [
      { label: "Top resolutores", question: "Muéstrame los resolutores que más tickets atendieron este mes" },
      { label: "Tickets sin asignar", question: "Qué tickets siguen sin asignar" },
      { label: "Fuera de SLA", question: "Muéstrame tickets fuera de SLA" }
    ];
  }
  if (/pdf/.test(q) || queryDef.intent === "tickets_by_alert_type" || queryDef.intent === "open_tickets") {
    return [
      { label: "Descargar PDF", question: q.includes("pdf") ? question : `${question} en PDF` },
      { label: "Sin asignar", question: "Qué tickets siguen sin asignar" },
      { label: "Fuera de SLA", question: "Muéstrame tickets fuera de SLA" }
    ];
  }
  return [];
}

app.post("/dashboard/lucia/ask", async (req, res) => {
  if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere usuario OPERATOR o ADMIN para usar Luc-IA")) return;

  try {
    await ensureLuciaSchema();
    const question = String(req.body?.question || "").trim();
    if (!question || question.length < 3) {
      return res.status(400).json({ status: "error", message: "Escribe una pregunta para Luc-IA." });
    }
    if (question.length > 800) {
      return res.status(400).json({ status: "error", message: "La pregunta es demasiado larga." });
    }

    const controlCenterCode = dashboardAuthorizedControlCenterCode(req);
    const cc = await pool.query("SELECT id, code, name FROM control_centers WHERE code = $1 LIMIT 1", [controlCenterCode]);
    if (!cc.rows.length) return res.status(404).json({ status: "error", message: "Centro de control no encontrado" });

    const queryDef = luciaBuildSafeQuery(question, cc.rows[0].id);
    const sqlPreview = validateLuciaSql(queryDef.sql);
    const result = await runLuciaReadOnly(queryDef.sql, queryDef.params);
    const answerText = luciaAnswer(queryDef, result.rows, cc.rows[0].code);
    const suggestions = luciaSuggestionsForIntent(question, queryDef);
    let report = null;
    if (luciaWantsPdf(question)) {
      report = await createLuciaPdfReport({
        question,
        queryDef,
        rows: result.rows,
        answer: answerText,
        controlCenter: cc.rows[0]
      });
    }
    const auditId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");

    await pool.query(
      `
      INSERT INTO lucia_query_audit (
        id, user_id, user_role, control_center_id, control_center_code,
        question, intent, sql_text, row_count, duration_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `,
      [
        auditId,
        req.panel_session.sub,
        req.panel_session.role,
        cc.rows[0].id,
        cc.rows[0].code,
        question,
        queryDef.intent,
        sqlPreview,
        result.row_count,
        result.duration_ms
      ]
    ).catch((error) => console.warn("[LUCIA AUDIT WARN]", error.message));

    res.json({
      status: "ok",
      lucia: {
        name: "Luc-IA",
        mode: "SELECT restringido por centro de control",
        question,
        answer: answerText,
        intent: queryDef.intent,
        title: queryDef.title,
        period_days: queryDef.days,
        row_count: result.row_count,
        duration_ms: result.duration_ms,
        control_center: { code: cc.rows[0].code, name: cc.rows[0].name },
        safety: {
          readonly: true,
          forced_control_center_code: cc.rows[0].code,
          max_rows: queryDef.limit || result.row_count,
          arbitrary_sql: false,
          pii_minimized: true
        },
        columns: luciaColumns(result.rows),
        rows: result.rows,
        suggestions,
        clarification: ["unknown", "guided_help", "ambiguous_severity"].includes(queryDef.intent),
        sector_method: ["critical_zones", "tickets_by_alert_type", "high_priority_tickets"].includes(queryDef.intent) ? "Zonificación oficial UV si está disponible; fallback por coordenada" : null,
        report,
        sql_preview: process.env.LUCIA_SHOW_SQL === "true" ? sqlPreview : null,
        audit_id: auditId
      }
    });
  } catch (error) {
    console.error("[LUCIA ASK ERROR]", error);
    res.status(500).json({
      status: "error",
      message: "Tuve un problema técnico al procesar la consulta. Prueba con una sugerencia o intenta nuevamente.",
      technical_message: process.env.NODE_ENV === "development" ? (error.message || String(error)) : undefined
    });
  }
});

app.get("/dashboard/tickets", async (req, res) => {
  if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere usuario OPERATOR o ADMIN para listar tickets")) return;

  try {
    const controlCenterCode = dashboardAuthorizedControlCenterCode(req);
    const cc = await pool.query("SELECT id, code, name FROM control_centers WHERE code = $1 LIMIT 1", [controlCenterCode]);
    if (!cc.rows.length) return res.status(404).json({ status: "error", message: "Centro de control no encontrado" });

    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(1000, Math.max(1, Number(req.query.page_size || 10)));
    const offset = (page - 1) * pageSize;
    const state = String(req.query.state || "").trim().toUpperCase();
    const alertType = String(req.query.alert_type || "").trim().toUpperCase();
    const q = String(req.query.q || "").trim();

    const params = [cc.rows[0].id];
    const where = ["t.control_center_id = $1"];
    if (state) {
      params.push(state);
      where.push(`t.state = $${params.length}`);
    }
    if (alertType) {
      params.push(alertType);
      where.push(`t.alert_type = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(
        t.id::text ILIKE $${params.length}
        OR COALESCE(t.title,'') ILIKE $${params.length}
        OR COALESCE(citizen.full_name,'') ILIKE $${params.length}
        OR COALESCE(resolver.full_name,'') ILIKE $${params.length}
      )`);
    }

    const whereSql = where.join(" AND ");
    const countResult = await pool.query(
      `
      SELECT COUNT(*)::int AS total
      FROM tickets t
      LEFT JOIN users citizen ON citizen.id = t.citizen_user_id
      LEFT JOIN users resolver ON resolver.id = t.assigned_resolver_id
      WHERE ${whereSql}
      `,
      params
    );

    const listParams = [...params, pageSize, offset];
    const limitIndex = listParams.length - 1;
    const offsetIndex = listParams.length;
    const rowsResult = await pool.query(
      `
      SELECT
        t.id,
        t.title,
        t.alert_type,
        t.source_type,
        t.state,
        t.priority,
        t.created_at,
        t.acknowledged_at,
        t.assigned_at,
        t.resolved_at,
        ROUND(EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 60.0)::int AS age_minutes,
        citizen.full_name AS citizen_name,
        resolver.full_name AS resolver_name
      FROM tickets t
      LEFT JOIN users citizen ON citizen.id = t.citizen_user_id
      LEFT JOIN users resolver ON resolver.id = t.assigned_resolver_id
      WHERE ${whereSql}
      ORDER BY t.created_at DESC
      LIMIT $${limitIndex} OFFSET $${offsetIndex}
      `,
      listParams
    );

    const total = Number(countResult.rows[0]?.total || 0);
    res.json({
      status: "ok",
      control_center: { code: cc.rows[0].code, name: cc.rows[0].name },
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: Math.max(1, Math.ceil(total / pageSize)),
        has_prev: page > 1,
        has_next: page * pageSize < total
      },
      tickets: rowsResult.rows
    });
  } catch (error) {
    console.error("[DASHBOARD TICKETS ERROR]", error);
    res.status(500).json({ status: "error", message: error.message || "No se pudo listar tickets" });
  }
});

app.get("/dashboard/map-state", async (req, res) => {
  if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere usuario OPERATOR o ADMIN para acceder al panel de control")) return;

  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    await ensureGeofenceSchema();
    const control_center_code = dashboardAuthorizedControlCenterCode(req);

    const ccResult = await pool.query(
      `
      SELECT id, code, name, municipality, region, country,
             municipality_logo_url, product_logo_url,
             brand_primary_color, brand_secondary_color,
             COALESCE(map_center_lat, latitude) AS latitude,
             COALESCE(map_center_lon, longitude) AS longitude,
             boundary_geojson,
             geofence_buffer_meters,
             map_center_lat,
             map_center_lon,
             map_zoom
      FROM control_centers
      WHERE code = $1
      `,
      [control_center_code]
    );

    if (ccResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Unknown control_center_code"
      });
    }

    const controlCenter = ccResult.rows[0];

    await ensureVoiceSchema();
    await ensureIncidentAggregationSchema();

    const ticketsResult = await pool.query(
      `
      SELECT
        t.id,
        t.source_type,
        t.source_event_id,
        t.alert_type,
        t.title,
        t.description,
        t.state,
        t.priority,
        t.latitude,
        t.longitude,
        t.accuracy,
        t.event_sector_code,
        t.event_sector_name AS incident_sector,
        t.event_sector_method AS sector_method,
        t.event_sector_source AS sector_source,
        t.created_at,
        t.acknowledged_at,
        t.assigned_at,
        t.resolved_at,
        t.closed_at,
        u.full_name AS citizen_name,
        u.phone AS citizen_phone,
        r.full_name AS resolver_name,
        latest_voice.id AS voice_session_id,
        latest_voice.wa_center_session_id AS wa_center_session_id,
        latest_voice.status AS voice_status,
        latest_voice.requested_by AS voice_requested_by,
        latest_voice.target_type AS voice_target_type,
        latest_voice.created_at AS voice_created_at,
        COALESCE(report_stats.report_count, 0)::int AS report_count,
        latest_report.latest_report_at AS latest_report_at,
        latest_assignment.state AS latest_assignment_state,
        latest_assignment.resolver_user_id AS latest_assignment_resolver_user_id,
        latest_assignment.rejected_at AS latest_assignment_rejected_at,
        latest_assignment.assignment_type AS latest_assignment_type
      FROM tickets t
      LEFT JOIN users u ON u.id = t.citizen_user_id
      LEFT JOIN users r ON r.id = t.assigned_resolver_id
      LEFT JOIN LATERAL (
        SELECT
          ta.state,
          ta.resolver_user_id,
          ta.rejected_at,
          ta.assignment_type
        FROM ticket_assignments ta
        WHERE ta.ticket_id = t.id
        ORDER BY ta.created_at DESC
        LIMIT 1
      ) latest_assignment ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS report_count
        FROM ticket_reports tr
        WHERE tr.ticket_id = t.id
      ) report_stats ON true
      LEFT JOIN LATERAL (
        SELECT MAX(tr.created_at) AS latest_report_at
        FROM ticket_reports tr
        WHERE tr.ticket_id = t.id
      ) latest_report ON true
      LEFT JOIN LATERAL (
        SELECT
          tvs.id,
          tvs.wa_center_session_id,
          tvs.status,
          tvs.requested_by,
          tvs.target_type,
          tvs.created_at
        FROM ticket_voice_sessions tvs
        WHERE tvs.ticket_id = t.id
          AND tvs.status NOT IN ('FAILED','ENDED','EXPIRED','NO_ANSWER')
        ORDER BY tvs.created_at DESC
        LIMIT 1
      ) latest_voice ON true
      WHERE t.control_center_id = $1
        AND t.state NOT IN ('CLOSED', 'CANCELLED')
      ORDER BY t.created_at DESC
      `,
      [controlCenter.id]
    );

    const resolverGpsMaxAccuracy = maxResolverGpsAccuracyMeters();
    await reconcileResolverStatesForControlCenter(controlCenter.id);

    const resolversResult = await pool.query(
      `
      WITH resolver_base AS (
        SELECT
          u.id,
          u.full_name,
          u.phone,
          u.is_active,
          COALESCE(UPPER(rl.status), 'SIN_UBICACION') AS raw_status,
          rl.latitude,
          rl.longitude,
          rl.accuracy,
          rl.updated_at,
          COUNT(t.id)::int AS active_tickets_count
        FROM users u
        LEFT JOIN resolver_locations rl ON rl.user_id = u.id
        LEFT JOIN tickets t ON t.assigned_resolver_id = u.id
          AND t.control_center_id = u.control_center_id
          AND t.state = ANY($2::text[])
        WHERE u.control_center_id = $1
          AND u.role = 'RESOLVER'
          AND u.is_active = true
        GROUP BY u.id, u.full_name, u.phone, u.is_active, rl.status, rl.latitude, rl.longitude, rl.accuracy, rl.updated_at
      )
      SELECT
        id,
        full_name,
        phone,
        latitude,
        longitude,
        accuracy,
        raw_status AS status,
        raw_status,
        updated_at,
        active_tickets_count,
        CASE
          WHEN is_active IS NOT TRUE THEN 'INACTIVE'
          WHEN updated_at IS NULL THEN 'NO_GPS'
          WHEN accuracy IS NOT NULL AND (accuracy::numeric) > $3::numeric THEN 'GPS_INVALID'
          WHEN raw_status = 'OFFLINE' THEN 'OFFLINE'
          WHEN updated_at < NOW() - INTERVAL '10 minutes' THEN 'OFFLINE'
          WHEN updated_at < NOW() - INTERVAL '3 minutes' THEN 'STALE_GPS'
          WHEN raw_status IN ('BUSY','EN_ROUTE','ON_SITE') AND active_tickets_count = 0 THEN 'BLOCKED_NO_TICKET'
          WHEN active_tickets_count > 0 AND raw_status = 'EN_ROUTE' THEN 'EN_ROUTE'
          WHEN active_tickets_count > 0 AND raw_status = 'ON_SITE' THEN 'ON_SITE'
          WHEN active_tickets_count > 0 THEN 'BUSY'
          WHEN raw_status = 'AVAILABLE' THEN 'AVAILABLE'
          ELSE raw_status
        END AS operational_state,
        CASE
          WHEN updated_at IS NULL THEN 'NO_GPS'
          WHEN accuracy IS NOT NULL AND (accuracy::numeric) > $3::numeric THEN 'INVALID_ACCURACY'
          WHEN updated_at >= NOW() - INTERVAL '3 minutes' THEN 'FRESH'
          WHEN updated_at >= NOW() - INTERVAL '10 minutes' THEN 'STALE'
          ELSE 'EXPIRED'
        END AS gps_state,
        CASE
          WHEN updated_at IS NULL THEN NULL
          ELSE ROUND(EXTRACT(EPOCH FROM (NOW() - updated_at)) / 60.0)::int
        END AS gps_age_minutes,
        $3::numeric AS max_allowed_accuracy_meters
      FROM resolver_base
      ORDER BY full_name ASC
      `,
      [controlCenter.id, ACTIVE_RESOLVER_TICKET_STATES, resolverGpsMaxAccuracy]
    );

    const sirensResult = await pool.query(
      `
      SELECT
        id,
        name,
        latitude,
        longitude,
        location,
        state,
        relay,
        last_seen,
        rssi,
        firmware,
        uptime,
        updated_at
      FROM sirens
      WHERE control_center_id = $1
      `,
      [controlCenter.id]
    );

    const devicesResult = await pool.query(
      `
      SELECT
        id,
        name,
        type,
        platform_id,
        last_latitude,
        last_longitude,
        last_seen,
        status,
        metadata,
        updated_at
      FROM devices
      WHERE control_center_id = $1
      `,
      [controlCenter.id]
    );

const sirensForDashboard = sirensResult.rows.map((siren) => {
  const runtime = sirenStates[siren.id];

  if (!runtime) {
    return {
      ...siren,
      active: siren.relay === true || siren.state === "ON"
    };
  }

  const expired = runtime.expires_at && Date.now() > runtime.expires_at;

  return {
    ...siren,
    state: expired ? "OFF" : runtime.state,
    relay: expired ? false : runtime.relay,
    active: !expired && runtime.relay === true,
    updated_at: runtime.updated_at || siren.updated_at
  };
});



    res.json({
      status: "ok",
      updated_at: nowChile(),
      control_center: controlCenter,
      counts: {
        tickets: ticketsResult.rows.length,
        resolvers: resolversResult.rows.length,
        sirens: sirensResult.rows.length,
        devices: devicesResult.rows.length
      },
      tickets: ticketsResult.rows,
      resolvers: resolversResult.rows,
      sirens: sirensForDashboard,
      devices: devicesResult.rows
    });

  } catch (error) {
    console.error("[DASHBOARD MAP STATE ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.get("/tickets/:id", async (req, res) => {
  try {
    await ensureIncidentAggregationSchema();
    await ensureMunicipalQrSchema();
    const { id } = req.params;
    if (!(await checkTicketParticipantAccess(req, res, id))) return;

    const ticketResult = await pool.query(
      `
      SELECT
        t.*,
        t.event_sector_code AS incident_sector_code,
        t.event_sector_name AS incident_sector,
        t.event_sector_name AS incident_sector_name,
        t.event_sector_method AS incident_sector_method,
        t.event_sector_source AS incident_sector_source,
        cc.code AS control_center_code,
        cc.name AS control_center_name,
        source_event.qr_context,
        qr_point.code AS qr_code,
        qr_point.name AS qr_point_name,
        qr_point.latitude AS qr_installed_latitude,
        qr_point.longitude AS qr_installed_longitude,

        citizen.full_name AS citizen_name,
        citizen.phone AS citizen_phone,
        citizen.email AS citizen_email,
        citizen.declared_address,

        resolver.full_name AS resolver_name,
        resolver.phone AS resolver_phone,
        latest_assignment.state AS latest_assignment_state,
        latest_assignment.resolver_user_id AS latest_assignment_resolver_user_id,
        latest_assignment.rejected_at AS latest_assignment_rejected_at,
        latest_assignment.assignment_type AS latest_assignment_type,
        COALESCE(report_stats.report_count, 0)::int AS report_count

      FROM tickets t

      JOIN control_centers cc
        ON cc.id = t.control_center_id

      LEFT JOIN mobile_events source_event
        ON t.source_type = 'MOBILE_APP'
       AND source_event.id = t.source_event_id

      LEFT JOIN municipal_qr_points qr_point
        ON qr_point.id = source_event.qr_point_id

      LEFT JOIN users citizen
        ON citizen.id = t.citizen_user_id

      LEFT JOIN users resolver
        ON resolver.id = t.assigned_resolver_id

      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS report_count
        FROM ticket_reports tr
        WHERE tr.ticket_id = t.id
      ) report_stats ON true

      LEFT JOIN LATERAL (
        SELECT
          ta.state,
          ta.resolver_user_id,
          ta.rejected_at,
          ta.assignment_type
        FROM ticket_assignments ta
        WHERE ta.ticket_id = t.id
        ORDER BY ta.created_at DESC
        LIMIT 1
      ) latest_assignment ON true

      WHERE t.id = $1
      `,
      [id]
    );

    if (ticketResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Ticket not found"
      });
    }

    const ticket = ticketResult.rows[0];

    const contactsResult = ticket.citizen_user_id
      ? await pool.query(
          `
          SELECT
            id,
            name,
            relationship,
            phone,
            priority
          FROM emergency_contacts
          WHERE user_id = $1
          ORDER BY priority ASC
          `,
          [ticket.citizen_user_id]
        )
      : { rows: [] };

    const actionsResult = await pool.query(
      `
      SELECT
        ta.id,
        ta.action_type,
        ta.actor_role,
        ta.description,
        ta.metadata,
        ta.created_at,
        u.full_name AS actor_name
      FROM ticket_actions ta
      LEFT JOIN users u
        ON u.id = ta.actor_user_id
      WHERE ta.ticket_id = $1
      ORDER BY ta.created_at ASC
      `,
      [id]
    );

    const notesResult = await pool.query(
      `
      SELECT
        tn.id,
        tn.note,
        tn.created_at,
        u.full_name AS author_name
      FROM ticket_notes tn
      LEFT JOIN users u
        ON u.id = tn.author_user_id
      WHERE tn.ticket_id = $1
      ORDER BY tn.created_at ASC
      `,
      [id]
    );

    const reportsResult = await pool.query(
      `
      SELECT
        tr.id,
        tr.mobile_event_id,
        tr.reporter_name,
        tr.reporter_phone,
        tr.latitude,
        tr.longitude,
        tr.accuracy,
        tr.alert_type,
        tr.title,
        tr.description,
        tr.distance_meters,
        tr.match_score,
        tr.is_primary_report,
        tr.created_at,
        qr.code AS qr_code,
        qr.name AS qr_point_name
      FROM ticket_reports tr
      LEFT JOIN mobile_events report_event ON report_event.id = tr.mobile_event_id
      LEFT JOIN municipal_qr_points qr ON qr.id = report_event.qr_point_id
      WHERE tr.ticket_id = $1
      ORDER BY tr.created_at ASC
      `,
      [id]
    );

    const voiceSessions = await getVoiceSessionsForTicket(id, { includeCredentials: false, limit: 20 });
    await ensurePhoneLocationRequestSchema();
    const locationRequestsResult = await pool.query(
      `SELECT id, status, NULL::text AS channel, destination_phone AS recipient, expires_at, completed_at,
              latitude, longitude, accuracy, created_at, updated_at
       FROM ticket_location_requests
       WHERE ticket_id = $1
       ORDER BY created_at ASC`,
      [id]
    );
    const creationAction = actionsResult.rows.find(action => action.action_type === "TICKET_CREATED");
    const manualIntake = ticket.source_type === "PHONE_CALL" ? (creationAction?.metadata || null) : null;
    const locationAuditActions = locationRequestsResult.rows.map((request) => ({
      id: `location-request-${request.id}`,
      action_type: `LOCATION_REQUEST_${String(request.status || "UNKNOWN").toUpperCase()}`,
      actor_role: "SYSTEM",
      description: request.completed_at
        ? `Solicitud GPS completada con precisión ${request.accuracy ?? "no informada"} m`
        : `Solicitud GPS ${String(request.status || "sin estado").toLowerCase()}; vence ${new Date(request.expires_at).toISOString()}`,
      metadata: {
        location_request_id: request.id,
        channel: request.channel,
        expires_at: request.expires_at,
        completed_at: request.completed_at,
        latitude: request.latitude,
        longitude: request.longitude,
        accuracy: request.accuracy
      },
      created_at: request.completed_at || request.updated_at || request.created_at,
      actor_name: null
    }));

    res.json({
      status: "ok",
      ticket,
      emergency_contacts: contactsResult.rows,
      actions: [...actionsResult.rows, ...locationAuditActions]
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
      notes: notesResult.rows,
      reports: reportsResult.rows,
      voice_sessions: voiceSessions,
      location_requests: locationRequestsResult.rows,
      manual_intake: manualIntake
    });

  } catch (error) {
    console.error("[GET TICKET DETAIL ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});






app.post("/resolvers/:id/reconcile-status", async (req, res) => {
  if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere sesión operacional")) return;
  try {
    const { id } = req.params;
    const { offline = false } = req.body || {};

    const result = await reconcileResolverOperationalStatus(id, { offline: offline === true });
    if (result.status === "error") {
      return res.status(404).json(result);
    }

    res.json(result);
  } catch (error) {
    console.error("[RECONCILE RESOLVER STATUS ERROR]", error);
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/resolvers/reconcile-states", async (req, res) => {
  if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere sesión operacional")) return;
  try {
    const { control_center_code = null } = req.body || {};
    const params = [];
    let where = "u.role = 'RESOLVER' AND u.is_active = true";
    if (control_center_code) {
      params.push(control_center_code);
      where += ` AND cc.code = $${params.length}`;
    }

    const resolvers = await pool.query(
      `
      SELECT u.id
      FROM users u
      JOIN control_centers cc ON cc.id = u.control_center_id
      WHERE ${where}
      `,
      params
    );

    const results = [];
    for (const row of resolvers.rows || []) {
      results.push(await reconcileResolverOperationalStatus(row.id));
    }

    res.json({
      status: "ok",
      count: results.length,
      reconciled: results.filter((r) => r.reconciled).length,
      results
    });
  } catch (error) {
    console.error("[RECONCILE RESOLVERS ERROR]", error);
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

/*
   =========================================================
   RESOLVER MOBILE APP - DEMO / MVP ENDPOINTS
   =========================================================
 */

app.post("/resolver/location", async (req, res) => {
  if (!checkIdentityAccess(req, res, ["RESOLVER", "ADMIN", "SUPER_ADMIN"], req.body?.user_id, "Sesión de resolutor requerida")) return;
  try {
    const {
      user_id,
      latitude,
      longitude,
      accuracy = null,
      status = "AVAILABLE",
      source = "unknown"
    } = req.body;

    const validStatuses = [
      "AVAILABLE",
      "BUSY",
      "EN_ROUTE",
      "ON_SITE",
      "OFFLINE"
    ];

    if (!user_id) {
      return res.status(400).json({
        status: "error",
        message: "user_id is required"
      });
    }

    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid resolver status"
      });
    }

    if (latitude == null || longitude == null) {
      return res.status(400).json({
        status: "error",
        message: "latitude and longitude are required"
      });
    }

    const latNum = Number(latitude);
    const rawLonNum = Number(longitude);
    let lonNum = rawLonNum;
    const accuracyNum = accuracy == null || accuracy === "" ? null : Number(accuracy);

    if (!Number.isFinite(latNum) || !Number.isFinite(rawLonNum) || Math.abs(latNum) > 90 || Math.abs(rawLonNum) > 180) {
      return res.status(400).json({
        status: "error",
        message: "Coordenadas GPS inválidas"
      });
    }

    const maxAccuracy = maxResolverGpsAccuracyMeters();
    if (accuracyNum != null && Number.isFinite(accuracyNum) && accuracyNum > maxAccuracy) {
      return res.status(422).json({
        status: "error",
        code: "LOW_ACCURACY_GPS",
        message: `Ubicación demasiado imprecisa (${Math.round(accuracyNum)} m). No se actualizó la posición del resolutor.`,
        accuracy: accuracyNum,
        max_accuracy_meters: maxAccuracy
      });
    }

    const userResult = await pool.query(
      `
      SELECT
        u.id,
        u.control_center_id,
        u.role,
        u.full_name,
        COALESCE(cc.map_center_lat, cc.latitude) AS control_center_latitude,
        COALESCE(cc.map_center_lon, cc.longitude) AS control_center_longitude
      FROM users u
      JOIN control_centers cc ON cc.id = u.control_center_id
      WHERE u.id = $1
        AND u.is_active = true
      `,
      [user_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    const user = userResult.rows[0];

    if (user.role !== "RESOLVER") {
      return res.status(403).json({
        status: "error",
        message: "User is not a resolver"
      });
    }

    // Algunos escenarios manuales del simulador iOS omiten el signo oeste y
    // reportan +70.x en vez de -70.x. Sólo corregimos cuando invertir el signo
    // acerca inequívocamente el punto al centro municipal configurado.
    let coordinateCorrection = null;
    const centerLat = Number(user.control_center_latitude);
    const centerLon = Number(user.control_center_longitude);
    if (Number.isFinite(centerLat) && Number.isFinite(centerLon) && rawLonNum !== 0) {
      const originalDistance = distanceMeters(latNum, rawLonNum, centerLat, centerLon);
      const flippedDistance = distanceMeters(latNum, -rawLonNum, centerLat, centerLon);
      if (originalDistance > 1000000 && flippedDistance < 250000 && flippedDistance * 5 < originalDistance) {
        lonNum = -rawLonNum;
        coordinateCorrection = "LONGITUDE_HEMISPHERE_SIGN";
        console.warn("[RESOLVER GPS COORDINATE CORRECTED]", {
          user_id: user.id,
          received_longitude: rawLonNum,
          corrected_longitude: lonNum,
          source: source || null
        });
      }
    }

    const requestedStatus = String(status || "AVAILABLE").toUpperCase();
    const activeTickets = await getActiveTicketsForResolver(user.id);
    let effectiveStatus = requestedStatus;

    if (requestedStatus !== "OFFLINE" && activeTickets.length > 0) {
      const activeStates = new Set(activeTickets.map((ticket) => String(ticket.state || "").toUpperCase()));
      if (activeStates.has("ON_SITE")) {
        effectiveStatus = "ON_SITE";
      } else if (activeStates.has("EN_ROUTE")) {
        effectiveStatus = "EN_ROUTE";
      } else {
        effectiveStatus = "BUSY";
      }
    } else if (["BUSY", "EN_ROUTE", "ON_SITE"].includes(requestedStatus) && activeTickets.length === 0) {
      effectiveStatus = "AVAILABLE";
    }

    const result = await pool.query(
      `
      INSERT INTO resolver_locations (
        user_id,
        control_center_id,
        latitude,
        longitude,
        accuracy,
        status,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        accuracy = EXCLUDED.accuracy,
        status = EXCLUDED.status,
        updated_at = NOW()
      RETURNING *
      `,
      [
        user.id,
        user.control_center_id,
        latNum,
        lonNum,
        accuracyNum,
        effectiveStatus
      ]
    );

    const nextAssignment = effectiveStatus === "AVAILABLE" && activeTickets.length === 0
      ? await assignNextQueuedTicketToResolver(user.id, {
          trigger: "RESOLVER_AVAILABLE_LOCATION_HEARTBEAT",
          reason: "Autoasignación de cola al reportar resolutor disponible"
        }).catch((error) => {
          console.warn("[AUTO QUEUE AFTER RESOLVER AVAILABLE ERROR]", error.message);
          return { assigned: false, reason: error.message };
        })
      : null;

    res.json({
      status: "ok",
      message: nextAssignment?.assigned
        ? "Resolver location updated; next queued ticket assigned"
        : (effectiveStatus !== requestedStatus ? "Resolver location updated; operational status auto-corrected" : "Resolver location updated"),
      requested_status: requestedStatus,
      effective_status: effectiveStatus,
      active_tickets_count: activeTickets.length,
      active_tickets: activeTickets,
      resolver_location: result.rows[0],
      coordinate_correction: coordinateCorrection,
      next_assignment: nextAssignment,
      source
    });

  } catch (error) {
    console.error("[RESOLVER LOCATION MVP ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});



app.get("/debug/resolver-locations", async (req, res) => {
  try {
    if (!requireAdminTokenIfConfigured(req, res)) return;

    const { control_center_code = "CC-VINA" } = req.query;
    const result = await pool.query(
      `
      SELECT
        u.id,
        u.full_name,
        u.phone,
        cc.code AS control_center_code,
        rl.latitude,
        rl.longitude,
        rl.accuracy,
        rl.status,
        rl.updated_at,
        COALESCE(active_tickets.total, 0)::int AS active_tickets
      FROM users u
      JOIN control_centers cc ON cc.id = u.control_center_id
      LEFT JOIN resolver_locations rl ON rl.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS total
        FROM tickets t
        WHERE t.assigned_resolver_id = u.id
          AND t.state NOT IN ('CLOSED','CANCELLED','RESOLVED')
      ) active_tickets ON true
      WHERE u.role = 'RESOLVER'
        AND cc.code = $1
      ORDER BY u.full_name ASC
      `,
      [control_center_code]
    );

    res.json({ status: "ok", control_center_code, resolvers: result.rows });
  } catch (error) {
    console.error("[DEBUG RESOLVER LOCATIONS ERROR]", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.post("/resolvers/:id/location/clear", async (req, res) => {
  try {
    if (!requireAdminTokenIfConfigured(req, res)) return;

    const { id } = req.params;
    const before = await pool.query(
      `
      SELECT u.id, u.full_name, rl.latitude, rl.longitude, rl.status, rl.updated_at
      FROM users u
      LEFT JOIN resolver_locations rl ON rl.user_id = u.id
      WHERE u.id = $1 AND u.role = 'RESOLVER'
      `,
      [id]
    );

    if (before.rows.length === 0) {
      return res.status(404).json({ status: "error", message: "Resolutor no encontrado" });
    }

    await pool.query(`DELETE FROM resolver_locations WHERE user_id = $1`, [id]);
    res.json({ status: "ok", message: "Ubicación del resolutor eliminada", resolver: before.rows[0] });
  } catch (error) {
    console.error("[CLEAR RESOLVER LOCATION ERROR]", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.post("/resolvers/:id/status/offline", async (req, res) => {
  if (!checkIdentityAccess(req, res, ["RESOLVER", "ADMIN", "SUPER_ADMIN"], req.params.id, "Sesión de resolutor requerida")) return;
  try {
    const { id } = req.params;
    if (!(await requireSameControlCenterForUser(req, res, id))) return;

    const userResult = await pool.query(
      `SELECT id, full_name, control_center_id, role FROM users WHERE id = $1 AND is_active = true`,
      [id]
    );
    if (userResult.rows.length === 0 || userResult.rows[0].role !== 'RESOLVER') {
      return res.status(404).json({ status: "error", message: "Resolutor no encontrado o inactivo" });
    }

    const result = await pool.query(
      `
      UPDATE resolver_locations
      SET status = 'OFFLINE', updated_at = NOW()
      WHERE user_id = $1
      RETURNING *
      `,
      [id]
    );

    res.json({
      status: "ok",
      message: result.rows.length ? "Resolutor fuera de turno" : "Resolutor fuera de turno; no había ubicación registrada",
      resolver_location: result.rows[0] || null
    });
  } catch (error) {
    console.error("[RESOLVER OFFLINE ERROR]", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.get("/resolver/:user_id/state", async (req, res) => {
  if (!checkIdentityAccess(req, res, ["RESOLVER", "ADMIN", "SUPER_ADMIN"], req.params.user_id, "Sesión de resolutor requerida")) return;
  try {
    const { user_id } = req.params;

    const userResult = await pool.query(
      `
      SELECT
        u.id,
        u.control_center_id,
        cc.code AS control_center_code,
        cc.name AS control_center_name,
        u.role,
        u.validation_status,
        u.full_name,
        u.phone,
        u.email,
        u.is_active
      FROM users u
      JOIN control_centers cc
        ON cc.id = u.control_center_id
      WHERE u.id = $1
      `,
      [user_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Resolver not found"
      });
    }

    const resolver = userResult.rows[0];
    const resolverSettingsRow = await getControlCenterSettingsById(resolver.control_center_id).catch(() => null);
    const resolverPlatformSettings = resolverSettingsRow?.settings || DEFAULT_CONTROL_CENTER_SETTINGS;

    await ensureVoiceSchema();

    if (resolver.role !== "RESOLVER") {
      return res.status(403).json({
        status: "error",
        message: "User is not a resolver"
      });
    }

    const reconciliation = await reconcileResolverOperationalStatus(user_id).catch((error) => ({
      status: "warning",
      message: error.message
    }));

    await ensureIncidentAggregationSchema();

    const locationResult = await pool.query(
      `
      SELECT *
      FROM resolver_locations
      WHERE user_id = $1
      `,
      [user_id]
    );

    const ticketsResult = await pool.query(
      `
      SELECT
        t.id,
        t.control_center_id,
        t.source_type,
        t.source_event_id,
        t.alert_type,
        t.title,
        t.description,
        t.state,
        t.priority,
        t.latitude,
        t.longitude,

        COALESCE(t.event_sector_name,
          CASE
            WHEN t.latitude IS NULL OR t.longitude IS NULL THEN 'Sector no informado'
            WHEN t.latitude > -32.981 AND t.longitude < -71.532 THEN 'Reñaca Bajo / Jardín del Mar'
            WHEN t.latitude > -32.982 AND t.longitude >= -71.532 THEN 'Reñaca Alto'
            WHEN t.latitude > -32.999 AND t.longitude > -71.510 THEN 'Gómez Carreño / Glorias Navales'
            WHEN t.latitude > -33.007 AND t.longitude > -71.522 THEN 'Achupallas / Santa Julia'
            WHEN t.latitude > -33.009 AND t.longitude <= -71.522 THEN 'Santa Inés / Población Vergara'
            WHEN t.latitude > -33.024 AND t.longitude < -71.545 THEN 'Plan Viña / Libertad'
            WHEN t.latitude > -33.026 AND t.longitude >= -71.545 THEN 'Miraflores / Chorrillos'
            WHEN t.latitude <= -33.035 AND t.longitude < -71.545 THEN 'Recreo / Agua Santa'
            WHEN t.latitude <= -33.035 AND t.longitude >= -71.545 THEN 'Forestal / Nueva Aurora'
            ELSE 'Viña del Mar'
          END
        ) AS incident_sector,
        COALESCE(t.event_sector_method, 'Estimación por coordenada; pendiente cartografía oficial de sectores') AS sector_method,
        t.accuracy,
        t.assigned_resolver_id,
        t.created_at,
        t.acknowledged_at,
        t.assigned_at,
        t.resolved_at,
        t.closed_at,
        citizen.full_name AS citizen_name,
        citizen.phone AS citizen_phone,
        resolver_user.full_name AS resolver_name,
        latest_assignment.state AS assignment_state,
        latest_assignment.assignment_type,
        latest_assignment.distance_meters,
        latest_voice.id AS voice_session_id,
        latest_voice.wa_center_session_id AS wa_center_session_id,
        latest_voice.status AS voice_status,
        latest_voice.requested_by AS voice_requested_by,
        latest_voice.target_type AS voice_target_type,
        latest_voice.created_at AS voice_created_at,
        COALESCE(report_stats.report_count, 0)::int AS report_count
      FROM tickets t
      LEFT JOIN users citizen
        ON citizen.id = t.citizen_user_id
      LEFT JOIN users resolver_user
        ON resolver_user.id = t.assigned_resolver_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS report_count
        FROM ticket_reports tr
        WHERE tr.ticket_id = t.id
      ) report_stats ON true
      LEFT JOIN LATERAL (
        SELECT
          ta.state,
          ta.assignment_type,
          ta.distance_meters,
          ta.created_at
        FROM ticket_assignments ta
        WHERE ta.ticket_id = t.id
          AND ta.resolver_user_id = $1
        ORDER BY ta.created_at DESC
        LIMIT 1
      ) latest_assignment ON true
      LEFT JOIN LATERAL (
        SELECT
          tvs.id,
          tvs.wa_center_session_id,
          tvs.status,
          tvs.requested_by,
          tvs.target_type,
          tvs.created_at
        FROM ticket_voice_sessions tvs
        WHERE tvs.ticket_id = t.id
          AND tvs.resolver_user_id = $1
          AND tvs.target_type = 'RESOLVER'
          AND tvs.status NOT IN ('FAILED','ENDED','EXPIRED','NO_ANSWER')
        ORDER BY tvs.created_at DESC
        LIMIT 1
      ) latest_voice ON true
      WHERE t.control_center_id = $2
        AND t.state NOT IN ('CLOSED','CANCELLED','RESOLVED')
        AND (
          t.assigned_resolver_id = $1
          OR latest_assignment.state = 'PENDING'
          OR t.assigned_resolver_id IS NULL
        )
      ORDER BY
        CASE
          WHEN t.assigned_resolver_id = $1 THEN 0
          WHEN latest_assignment.state = 'PENDING' THEN 1
          ELSE 2
        END,
        t.priority ASC,
        t.created_at DESC
      `,
      [user_id, resolver.control_center_id]
    );

    res.json({
      status: "ok",
      updated_at: nowChile(),
      resolver,
      location: locationResult.rows[0] || null,
      reconciliation,
      platform_settings: publicSettingsPayload(resolverPlatformSettings),
      tickets: ticketsResult.rows,
      counts: {
        tickets: ticketsResult.rows.length,
        assigned_to_me: ticketsResult.rows.filter(t => t.assigned_resolver_id === user_id).length,
        pending_for_me: ticketsResult.rows.filter(t => t.assignment_state === "PENDING").length,
        unassigned: ticketsResult.rows.filter(t => !t.assigned_resolver_id).length
      }
    });

  } catch (error) {
    console.error("[RESOLVER STATE ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/tickets/:id/take", async (req, res) => {
  if (!checkIdentityAccess(req, res, ["RESOLVER", "ADMIN", "SUPER_ADMIN"], req.body?.resolver_user_id, "Sesión de resolutor requerida")) return;
  try {
    const { id } = req.params;
    const { resolver_user_id } = req.body;

    if (!resolver_user_id) {
      return res.status(400).json({
        status: "error",
        message: "resolver_user_id is required"
      });
    }

    const resolverResult = await pool.query(
      `
      SELECT id, control_center_id, role, full_name
      FROM users
      WHERE id = $1
        AND is_active = true
      `,
      [resolver_user_id]
    );

    if (resolverResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Resolver not found"
      });
    }

    const resolver = resolverResult.rows[0];

    if (resolver.role !== "RESOLVER") {
      return res.status(403).json({
        status: "error",
        message: "User is not a resolver"
      });
    }

    const ticketResult = await pool.query(
      `
      SELECT *
      FROM tickets
      WHERE id = $1
      `,
      [id]
    );

    if (ticketResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Ticket not found"
      });
    }

    const ticket = ticketResult.rows[0];

    if (ticket.control_center_id !== resolver.control_center_id) {
      return res.status(403).json({
        status: "error",
        message: "Ticket belongs to another control center"
      });
    }

    if (["CLOSED", "CANCELLED", "RESOLVED"].includes(ticket.state)) {
      return res.status(409).json({
        status: "error",
        message: "Ticket is already closed"
      });
    }

    if (
      ticket.assigned_resolver_id &&
      ticket.assigned_resolver_id !== resolver_user_id
    ) {
      return res.status(409).json({
        status: "error",
        message: "Ticket is assigned to another resolver"
      });
    }

    await pool.query(
      `
      INSERT INTO ticket_assignments (
        ticket_id,
        resolver_user_id,
        assignment_type,
        state,
        accepted_at,
        notified_at
      )
      VALUES ($1,$2,'MANUAL','ACCEPTED',NOW(),NOW())
      `,
      [id, resolver_user_id]
    );

    const update = await pool.query(
      `
      UPDATE tickets
      SET
        assigned_resolver_id = $1,
        state = 'ACCEPTED_BY_RESOLVER',
        assigned_at = COALESCE(assigned_at, NOW()),
        updated_at = NOW()
      WHERE id = $2
      RETURNING *
      `,
      [resolver_user_id, id]
    );

    await pool.query(
      `
      UPDATE resolver_locations
      SET
        status = 'BUSY',
        updated_at = NOW()
      WHERE user_id = $1
      `,
      [resolver_user_id]
    );

    await pool.query(
      `
      INSERT INTO ticket_actions (
        ticket_id,
        actor_user_id,
        actor_role,
        action_type,
        description,
        metadata
      )
      VALUES ($1,$2,'RESOLVER','RESOLVER_TAKE_CASE',$3,$4)
      `,
      [
        id,
        resolver_user_id,
        `Resolutor tomó el caso: ${resolver.full_name}`,
        JSON.stringify({ resolver_user_id, resolver_name: resolver.full_name })
      ]
    );

    res.json({
      status: "ok",
      message: "Ticket taken by resolver",
      ticket: update.rows[0]
    });

  } catch (error) {
    console.error("[TAKE TICKET ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});





/*
   =========================================================
   SUPER ADMIN / MULTI-COMUNA
   =========================================================

   SUPER_ADMIN crea centros, primer administrador municipal,
   geocercas comunales y Unidades Vecinales.
   =========================================================
*/

async function ensureSuperAdminSchema() {
  await ensureGeofenceSchema();
  await ensureSectorSchema();
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`).catch(() => null);
  await pool.query(`
    ALTER TABLE control_centers
      ADD COLUMN IF NOT EXISTS municipality TEXT,
      ADD COLUMN IF NOT EXISTS region TEXT,
      ADD COLUMN IF NOT EXISTS country TEXT DEFAULT 'Chile',
      ADD COLUMN IF NOT EXISTS municipality_logo_url TEXT,
      ADD COLUMN IF NOT EXISTS product_logo_url TEXT,
      ADD COLUMN IF NOT EXISTS brand_primary_color TEXT,
      ADD COLUMN IF NOT EXISTS brand_secondary_color TEXT,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_control_centers_code_unique ON control_centers(code)`);
}

function requireSuperAdmin(req, res) {
  return checkRoleAccess(req, res, ["SUPER_ADMIN"], "Se requiere usuario SUPER_ADMIN");
}

function geoJsonFromRequestBody(body) {
  const input = body?.boundary_geojson || body?.geojson || body;
  if (!input) return null;
  if (input.type === "FeatureCollection") {
    const feature = (input.features || []).find((f) => f?.geometry);
    return feature ? normalizeGeoJsonGeometry(feature.geometry) : null;
  }
  return normalizeGeoJsonGeometry(input);
}

function inferGeoJsonCenter(geometry) {
  const bounds = getGeoJsonBounds(geometry);
  if (!bounds) return { latitude: null, longitude: null, bounds: null };
  return {
    latitude: (bounds.minLat + bounds.maxLat) / 2,
    longitude: (bounds.minLon + bounds.maxLon) / 2,
    bounds
  };
}

app.get("/superadmin/control-centers", async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    await ensureSuperAdminSchema();
    const result = await pool.query(`
      SELECT
        cc.id, cc.code, cc.name, cc.municipality, cc.region, cc.country,
        cc.municipality_logo_url, cc.product_logo_url, cc.brand_primary_color, cc.brand_secondary_color,
        cc.latitude, cc.longitude, cc.map_center_lat, cc.map_center_lon, cc.map_zoom,
        cc.geofence_buffer_meters, cc.boundary_geojson->>'type' AS boundary_type,
        COUNT(u.id)::int AS users_count,
        COUNT(u.id) FILTER (WHERE u.role = 'ADMIN')::int AS admins_count,
        COUNT(u.id) FILTER (WHERE u.role = 'OPERATOR')::int AS operators_count,
        COUNT(u.id) FILTER (WHERE u.role = 'RESOLVER')::int AS resolvers_count,
        COUNT(u.id) FILTER (WHERE u.role = 'NEIGHBOR')::int AS neighbors_count,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id', u.id,
              'full_name', u.full_name,
              'phone', u.phone,
              'email', u.email,
              'declared_address', u.declared_address,
              'is_active', u.is_active,
              'validation_status', u.validation_status,
              'created_at', u.created_at,
              'updated_at', u.updated_at
            )
            ORDER BY u.created_at DESC
          ) FILTER (WHERE u.role = 'ADMIN'),
          '[]'::jsonb
        ) AS admins
      FROM control_centers cc
      LEFT JOIN users u ON u.control_center_id = cc.id
      GROUP BY cc.id
      ORDER BY cc.region NULLS LAST, cc.municipality NULLS LAST, cc.code
    `);
    res.json({ status: "ok", total: result.rows.length, control_centers: result.rows });
  } catch (error) {
    console.error("[SUPERADMIN CONTROL CENTERS LIST ERROR]", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.get("/superadmin/emergency-categories", async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const includeDisabled = String(req.query.include_disabled || 'true').toLowerCase() !== 'false';
    const categories = await loadEmergencyCategoryCatalog({ includeDisabled });
    res.json({ status: "ok", total: categories.length, categories });
  } catch (error) {
    console.error("[SUPERADMIN EMERGENCY CATEGORIES LIST ERROR]", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.put("/superadmin/emergency-categories", async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    await ensureEmergencyCategoryCatalogSchema();
    const categories = normalizeEmergencyCategoryCatalog(req.body?.categories || req.body || []);

    if (!categories.length) {
      return res.status(400).json({ status: "error", message: "Debe enviar al menos una categoría" });
    }

    for (const category of categories) {
      await pool.query(
        `
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
          allow_sirens,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
        ON CONFLICT (category_type) DO UPDATE SET
          title = EXCLUDED.title,
          icon = EXCLUDED.icon,
          color = EXCLUDED.color,
          priority = EXCLUDED.priority,
          enabled = EXCLUDED.enabled,
          display_order = EXCLUDED.display_order,
          sensitive = EXCLUDED.sensitive,
          allow_voice = EXCLUDED.allow_voice,
          allow_evidence = EXCLUDED.allow_evidence,
          allow_nearby_notifications = EXCLUDED.allow_nearby_notifications,
          allow_sirens = EXCLUDED.allow_sirens,
          updated_at = NOW()
        `,
        [
          category.type,
          category.title,
          category.icon,
          category.color,
          category.priority,
          category.enabled !== false,
          category.order,
          category.sensitive === true,
          category.allow_voice !== false,
          category.allow_evidence !== false,
          category.allow_nearby_notifications === true,
          category.allow_sirens === true
        ]
      );
    }

    const saved = await refreshEmergencyCategoryCatalogCache();
    res.json({ status: "ok", message: "Catálogo de categorías actualizado", total: saved.length, categories: saved });
  } catch (error) {
    console.error("[SUPERADMIN EMERGENCY CATEGORIES SAVE ERROR]", error);
    res.status(400).json({ status: "error", message: error.message });
  }
});

app.post("/superadmin/control-centers", async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    await ensureSuperAdminSchema();
    const code = String(req.body?.code || "").trim().toUpperCase();
    const name = String(req.body?.name || "").trim();
    const municipality = String(req.body?.municipality || "").trim() || null;
    const region = String(req.body?.region || "").trim() || null;
    const country = String(req.body?.country || "Chile").trim() || "Chile";
    const latitude = req.body?.latitude == null || req.body.latitude === "" ? null : Number(req.body.latitude);
    const longitude = req.body?.longitude == null || req.body.longitude === "" ? null : Number(req.body.longitude);
    const mapZoom = Number(req.body?.map_zoom || 13);
    const buffer = Number(req.body?.geofence_buffer_meters || 100);
    const municipalityLogoUrl = String(req.body?.municipality_logo_url || "").trim() || null;
    const productLogoUrl = String(req.body?.product_logo_url || "").trim() || null;
    const brandPrimaryColor = String(req.body?.brand_primary_color || "").trim() || null;
    const brandSecondaryColor = String(req.body?.brand_secondary_color || "").trim() || null;

    if (!code || !/^CC-[A-Z0-9-]{2,40}$/.test(code)) {
      return res.status(400).json({ status: "error", message: "code debe tener formato CC-COMUNA" });
    }
    if (!name) return res.status(400).json({ status: "error", message: "name is required" });

    const result = await pool.query(`
      INSERT INTO control_centers (
        code, name, municipality, region, country, latitude, longitude,
        map_center_lat, map_center_lon, map_zoom, geofence_buffer_meters,
        municipality_logo_url, product_logo_url, brand_primary_color, brand_secondary_color, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
      ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name,
        municipality = EXCLUDED.municipality,
        region = EXCLUDED.region,
        country = EXCLUDED.country,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        map_center_lat = EXCLUDED.map_center_lat,
        map_center_lon = EXCLUDED.map_center_lon,
        map_zoom = EXCLUDED.map_zoom,
        geofence_buffer_meters = EXCLUDED.geofence_buffer_meters,
        municipality_logo_url = COALESCE(EXCLUDED.municipality_logo_url, control_centers.municipality_logo_url),
        product_logo_url = COALESCE(EXCLUDED.product_logo_url, control_centers.product_logo_url),
        brand_primary_color = COALESCE(EXCLUDED.brand_primary_color, control_centers.brand_primary_color),
        brand_secondary_color = COALESCE(EXCLUDED.brand_secondary_color, control_centers.brand_secondary_color),
        updated_at = NOW()
      RETURNING *
    `, [
      code, name, municipality, region, country, latitude, longitude, mapZoom, buffer,
      municipalityLogoUrl, productLogoUrl, brandPrimaryColor, brandSecondaryColor
    ]);

    res.json({ status: "ok", control_center: result.rows[0] });
  } catch (error) {
    console.error("[SUPERADMIN CONTROL CENTER UPSERT ERROR]", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.post("/superadmin/control-centers/:code/boundary", async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    await ensureSuperAdminSchema();
    const code = String(req.params.code || "").trim().toUpperCase();
    const boundary = geoJsonFromRequestBody(req.body);
    if (!boundary) return res.status(400).json({ status: "error", message: "GeoJSON Polygon/MultiPolygon requerido" });
    const center = inferGeoJsonCenter(boundary);
    const mapZoom = Number(req.body?.map_zoom || 13);
    const buffer = Number(req.body?.geofence_buffer_meters || 100);

    const result = await pool.query(`
      UPDATE control_centers
      SET boundary_geojson = $2::jsonb,
          geofence_buffer_meters = $3,
          map_center_lat = COALESCE($4, map_center_lat),
          map_center_lon = COALESCE($5, map_center_lon),
          latitude = COALESCE(latitude, $4),
          longitude = COALESCE(longitude, $5),
          map_zoom = $6,
          updated_at = NOW()
      WHERE code = $1
      RETURNING id, code, name, municipality, region, latitude, longitude, map_center_lat, map_center_lon, map_zoom, geofence_buffer_meters, boundary_geojson->>'type' AS boundary_type
    `, [code, JSON.stringify(boundary), buffer, center.latitude, center.longitude, mapZoom]);

    if (!result.rows.length) return res.status(404).json({ status: "error", message: "Centro de control no encontrado" });
    res.json({ status: "ok", control_center: result.rows[0], bounds: center.bounds });
  } catch (error) {
    console.error("[SUPERADMIN BOUNDARY ERROR]", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.post("/superadmin/control-centers/:code/admin", async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const code = String(req.params.code || req.body?.control_center_code || "").trim().toUpperCase();
    const result = await adminCreateOrUpdateUser({
      ...(req.body || {}),
      control_center_code: code,
      role: "ADMIN",
      validation_status: req.body?.validation_status || "VALIDATED",
      is_active: req.body?.is_active ?? true
    }, req.panel_session);
    res.json({ status: "ok", message: "Administrador municipal creado/actualizado", operation: result.operation, user: result.user });
  } catch (error) {
    console.error("[SUPERADMIN CREATE MUNICIPAL ADMIN ERROR]", error);
    res.status(400).json({ status: "error", message: error.message });
  }
});

/*
   =========================================================
   ADMIN USERS / MUNICIPAL VALIDATION
   =========================================================
*/

function checkAdminToken(req, res) {
  const expected = process.env.ADMIN_TOKEN || "";
  const legacyAdminToken =
    req.headers["x-admin-token"] ||
    "";

  // Compatibilidad: si se define ADMIN_TOKEN, sigue funcionando como llave maestra.
  if (expected && legacyAdminToken === expected) {
    req.admin_legacy_token = true;
    return true;
  }

  // Nuevo control de acceso por sesión de usuario ADMIN/SUPER_ADMIN.
  return checkRoleAccess(req, res, ["ADMIN", "SUPER_ADMIN"], "Se requiere usuario ADMIN para acceder al mantenedor");
}

function requestedControlCenterForSession(req, requestedCode, fallback = "CC-VINA") {
  const session = req.panel_session || panelSessionFromRequest(req);
  if (session) req.panel_session = session;
  if (isSuperAdminSession(session)) {
    return String(requestedCode || session.control_center_code || fallback).trim().toUpperCase();
  }
  if (session?.control_center_code) {
    return String(session.control_center_code).trim().toUpperCase();
  }
  return String(requestedCode || fallback).trim().toUpperCase();
}

async function adminResolveControlCenter(reqOrCode, maybeCode) {
  const requestedCode = typeof reqOrCode === "object" && reqOrCode?.headers
    ? requestedControlCenterForSession(reqOrCode, maybeCode || reqOrCode.params?.code || reqOrCode.query?.control_center_code)
    : String(reqOrCode || maybeCode || "CC-VINA").trim().toUpperCase();
  const result = await pool.query(
    `SELECT id, code, name FROM control_centers WHERE code = $1 LIMIT 1`,
    [requestedCode || 'CC-VINA']
  );
  return result.rows[0] || null;
}

async function requireSameControlCenterForUser(req, res, userId) {
  if (req.admin_legacy_token || isSuperAdminSession(req.panel_session)) return true;
  const result = await pool.query(`SELECT control_center_id FROM users WHERE id = $1 LIMIT 1`, [userId]);
  if (!result.rows.length) {
    res.status(404).json({ status: "error", message: "User not found" });
    return false;
  }
  if (String(result.rows[0].control_center_id) !== String(req.panel_session?.control_center_id)) {
    res.status(403).json({ status: "error", message: "No puedes administrar usuarios de otro centro de control" });
    return false;
  }
  return true;
}


function normalizeBrandAsset(value, label = "logo") {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const isHttp = /^https:\/\//i.test(raw);
  const isDataImage = /^data:image\/(png|jpe?g|webp|svg\+xml);base64,/i.test(raw);
  if (!isHttp && !isDataImage) {
    throw new Error(`${label} debe ser una URL https o una imagen base64 data:image válida`);
  }
  if (raw.length > 1500000) {
    throw new Error(`${label} es demasiado grande. Usa una imagen menor a 1 MB o una URL pública`);
  }
  return raw;
}

function normalizeBrandColor(value, label = "color") {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (!/^#[0-9a-fA-F]{6}$/.test(raw)) {
    throw new Error(`${label} debe tener formato #RRGGBB`);
  }
  return raw.toUpperCase();
}

app.get("/admin/control-centers/:code/branding", async (req, res) => {
  if (!checkAdminToken(req, res)) return;
  try {
    await ensureSuperAdminSchema();
    const requestedCode = requestedControlCenterForSession(req, req.params.code || "CC-VINA");
    const result = await pool.query(`
      SELECT id, code, name, municipality, region,
             municipality_logo_url, product_logo_url,
             brand_primary_color, brand_secondary_color
      FROM control_centers
      WHERE code = $1
      LIMIT 1
    `, [requestedCode]);
    if (!result.rows.length) return res.status(404).json({ status: "error", message: "Centro de control no encontrado" });
    res.json({ status: "ok", control_center: result.rows[0] });
  } catch (error) {
    console.error("[ADMIN GET BRANDING ERROR]", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.put("/admin/control-centers/:code/branding", async (req, res) => {
  if (!checkAdminToken(req, res)) return;
  try {
    await ensureSuperAdminSchema();
    const requestedCode = requestedControlCenterForSession(req, req.params.code || "CC-VINA");
    const municipalityLogoUrl = normalizeBrandAsset(req.body?.municipality_logo_url, "Logo municipal");
    const productLogoUrl = normalizeBrandAsset(req.body?.product_logo_url, "Logo producto");
    const brandPrimaryColor = normalizeBrandColor(req.body?.brand_primary_color, "Color principal");
    const brandSecondaryColor = normalizeBrandColor(req.body?.brand_secondary_color, "Color secundario");

    const result = await pool.query(`
      UPDATE control_centers
      SET municipality_logo_url = $2,
          product_logo_url = $3,
          brand_primary_color = $4,
          brand_secondary_color = $5,
          updated_at = NOW()
      WHERE code = $1
      RETURNING id, code, name, municipality, region,
                municipality_logo_url, product_logo_url,
                brand_primary_color, brand_secondary_color
    `, [requestedCode, municipalityLogoUrl, productLogoUrl, brandPrimaryColor, brandSecondaryColor]);

    if (!result.rows.length) return res.status(404).json({ status: "error", message: "Centro de control no encontrado" });
    res.json({ status: "ok", message: "Branding actualizado", control_center: result.rows[0] });
  } catch (error) {
    console.error("[ADMIN PUT BRANDING ERROR]", error);
    res.status(400).json({ status: "error", message: error.message });
  }
});

app.get("/admin/control-centers/:code/settings", async (req, res) => {
  if (!checkAdminToken(req, res)) return;

  try {
    const requestedCode = requestedControlCenterForSession(req, req.params.code || 'CC-VINA');
    const row = await getControlCenterSettingsByCode(requestedCode);
    if (!row) {
      return res.status(404).json({ status: "error", message: "Centro de control no encontrado" });
    }
    res.json(adminSettingsPayload(row));
  } catch (error) {
    console.error("[ADMIN GET CONTROL CENTER SETTINGS ERROR]", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.put("/admin/control-centers/:code/settings", async (req, res) => {
  if (!checkAdminToken(req, res)) return;

  try {
    await ensureControlCenterSettingsSchema();
    const cc = await adminResolveControlCenter(req, req.params.code || 'CC-VINA');
    if (!cc) {
      return res.status(404).json({ status: "error", message: "Centro de control no encontrado" });
    }

    const current = await getControlCenterSettingsById(cc.id);
    const currentSettings = current?.settings || DEFAULT_CONTROL_CENTER_SETTINGS;
    const nextSettings = normalizeControlCenterSettings(deepMergeSettings(currentSettings, req.body?.settings || req.body || {}));
    // La licencia comercial es propiedad de VS&TI/SuperAdmin. Un ADMIN
    // municipal puede administrar contenido, pero no auto-habilitar el módulo.
    nextSettings.communications_module = normalizeControlCenterSettings(currentSettings).communications_module;
    const actorId = req.panel_session?.sub || null;

    await pool.query(
      `
      INSERT INTO control_center_settings (control_center_id, settings, updated_by, updated_at)
      VALUES ($1,$2::jsonb,$3,NOW())
      ON CONFLICT (control_center_id) DO UPDATE
      SET settings = EXCLUDED.settings,
          updated_by = EXCLUDED.updated_by,
          updated_at = NOW()
      `,
      [cc.id, JSON.stringify(nextSettings), actorId]
    );

    await pool.query(
      `
      INSERT INTO control_center_settings_audit (control_center_id, actor_user_id, old_settings, new_settings)
      VALUES ($1,$2,$3::jsonb,$4::jsonb)
      `,
      [cc.id, actorId, JSON.stringify(currentSettings), JSON.stringify(nextSettings)]
    );

    const saved = await getControlCenterSettingsById(cc.id);
    res.json(adminSettingsPayload(saved));
  } catch (error) {
    console.error("[ADMIN PUT CONTROL CENTER SETTINGS ERROR]", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

async function ensureCommunicationsSchema() {
  if (communicationsSchemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS municipal_announcements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
      audience_type TEXT NOT NULL DEFAULT 'BROADCAST',
      target_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      media_type TEXT NOT NULL DEFAULT 'NONE',
      media_url TEXT,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT municipal_announcements_audience_check CHECK (audience_type IN ('BROADCAST','PERSONAL')),
      CONSTRAINT municipal_announcements_media_check CHECK (media_type IN ('NONE','IMAGE','VIDEO')),
      CONSTRAINT municipal_announcements_status_check CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED'))
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_municipal_announcements_cc_status_dates
    ON municipal_announcements(control_center_id, status, starts_at, ends_at)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS municipal_announcement_reads (
      announcement_id UUID NOT NULL REFERENCES municipal_announcements(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (announcement_id, user_id)
    )
  `);
  communicationsSchemaReady = true;
}

function normalizeCommunicationsLicense(raw = {}) {
  return normalizeControlCenterSettings({ communications_module: raw }).communications_module;
}

function normalizeAnnouncementInput(body = {}) {
  const audienceType = String(body.audience_type || 'BROADCAST').trim().toUpperCase();
  const mediaType = String(body.media_type || 'NONE').trim().toUpperCase();
  const status = String(body.status || 'DRAFT').trim().toUpperCase();
  if (!['BROADCAST', 'PERSONAL'].includes(audienceType)) throw new Error('Audiencia inválida');
  if (!['NONE', 'IMAGE', 'VIDEO'].includes(mediaType)) throw new Error('Tipo de contenido inválido');
  if (!['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(status)) throw new Error('Estado inválido');
  const title = String(body.title || '').trim().slice(0, 180);
  const text = String(body.body || '').trim().slice(0, 5000);
  if (!title) throw new Error('El título es obligatorio');
  let mediaUrl = String(body.media_url || '').trim().slice(0, 2000) || null;
  if (mediaUrl) {
    const parsed = new URL(mediaUrl);
    if (parsed.protocol !== 'https:') throw new Error('La URL multimedia debe usar HTTPS');
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.toLowerCase();
    if (mediaType === 'VIDEO') {
      const supportedVideoHost = ['youtube.com', 'm.youtube.com', 'youtu.be', 'youtube-nocookie.com', 'vimeo.com', 'player.vimeo.com'].includes(host);
      const directVideo = /\.(mp4|webm|m4v|mov|m3u8)$/.test(path);
      if (!supportedVideoHost && !directVideo) {
        throw new Error('Video no permitido. Usa YouTube, Vimeo o un archivo directo MP4/WebM/M4V/MOV/M3U8');
      }
    }
    if (mediaType === 'IMAGE' && !/\.(png|jpe?g|webp|gif|avif)$/.test(path)) {
      throw new Error('Imagen no permitida. Usa una URL directa PNG, JPG, WebP, GIF o AVIF');
    }
  }
  if (mediaType === 'NONE') mediaUrl = null;
  if (mediaType !== 'NONE' && !mediaUrl) throw new Error('Debes indicar una URL multimedia HTTPS');
  const startsAt = body.starts_at ? new Date(body.starts_at) : null;
  const endsAt = body.ends_at ? new Date(body.ends_at) : null;
  if (startsAt && Number.isNaN(startsAt.getTime())) throw new Error('Fecha de inicio inválida');
  if (endsAt && Number.isNaN(endsAt.getTime())) throw new Error('Fecha de término inválida');
  if (startsAt && endsAt && endsAt <= startsAt) throw new Error('La fecha de término debe ser posterior al inicio');
  return {
    audienceType,
    targetUserId: audienceType === 'PERSONAL' ? String(body.target_user_id || '').trim() || null : null,
    title,
    body: text,
    mediaType,
    mediaUrl,
    status,
    startsAt: startsAt?.toISOString() || null,
    endsAt: endsAt?.toISOString() || null
  };
}

app.get('/superadmin/control-centers/:code/communications-license', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const row = await getControlCenterSettingsByCode(String(req.params.code || '').toUpperCase());
    if (!row) return res.status(404).json({ status: 'error', message: 'Centro de control no encontrado' });
    res.json({ status: 'ok', control_center: { code: row.control_center_code, name: row.control_center_name }, license: row.settings.communications_module });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.put('/superadmin/control-centers/:code/communications-license', async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    await ensureControlCenterSettingsSchema();
    const row = await getControlCenterSettingsByCode(String(req.params.code || '').toUpperCase());
    if (!row) return res.status(404).json({ status: 'error', message: 'Centro de control no encontrado' });
    const currentSettings = row.settings || DEFAULT_CONTROL_CENTER_SETTINGS;
    const nextSettings = normalizeControlCenterSettings({
      ...currentSettings,
      communications_module: normalizeCommunicationsLicense(req.body?.license || req.body || {})
    });
    await pool.query(`
      INSERT INTO control_center_settings (control_center_id, settings, updated_by, updated_at)
      VALUES ($1,$2::jsonb,$3,NOW())
      ON CONFLICT (control_center_id) DO UPDATE SET settings=EXCLUDED.settings, updated_by=EXCLUDED.updated_by, updated_at=NOW()
    `, [row.control_center_id, JSON.stringify(nextSettings), req.panel_session?.sub || null]);
    await pool.query(`
      INSERT INTO control_center_settings_audit (control_center_id, actor_user_id, old_settings, new_settings)
      VALUES ($1,$2,$3::jsonb,$4::jsonb)
    `, [row.control_center_id, req.panel_session?.sub || null, JSON.stringify(currentSettings), JSON.stringify(nextSettings)]);
    res.json({ status: 'ok', license: nextSettings.communications_module });
  } catch (error) {
    res.status(400).json({ status: 'error', message: error.message });
  }
});

app.get('/admin/control-centers/:code/announcements', async (req, res) => {
  if (!checkAdminToken(req, res)) return;
  try {
    await ensureCommunicationsSchema();
    const cc = await adminResolveControlCenter(req, req.params.code);
    if (!cc) return res.status(404).json({ status: 'error', message: 'Centro de control no encontrado' });
    const settings = await getControlCenterSettingsById(cc.id);
    const license = settings?.settings?.communications_module || DEFAULT_CONTROL_CENTER_SETTINGS.communications_module;
    const rows = await pool.query(`
      SELECT a.*, u.full_name AS target_user_name, u.phone AS target_user_phone,
             (SELECT COUNT(*)::int FROM municipal_announcement_reads r WHERE r.announcement_id=a.id) AS opened_count
      FROM municipal_announcements a
      LEFT JOIN users u ON u.id=a.target_user_id
      WHERE a.control_center_id=$1
      ORDER BY a.created_at DESC
      LIMIT 200
    `, [cc.id]);
    res.json({ status: 'ok', license, announcements: rows.rows });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/admin/control-centers/:code/announcements', async (req, res) => {
  if (!checkAdminToken(req, res)) return;
  try {
    await ensureCommunicationsSchema();
    const cc = await adminResolveControlCenter(req, req.params.code);
    if (!cc) return res.status(404).json({ status: 'error', message: 'Centro de control no encontrado' });
    const settings = await getControlCenterSettingsById(cc.id);
    const license = settings?.settings?.communications_module || DEFAULT_CONTROL_CENTER_SETTINGS.communications_module;
    if (!license.enabled) return res.status(403).json({ status: 'error', code: 'COMMUNICATIONS_MODULE_NOT_LICENSED', message: 'El módulo de Comunicaciones no está contratado para este Centro de Control' });
    const input = normalizeAnnouncementInput(req.body || {});
    if (input.audienceType === 'BROADCAST' && !license.municipal_broadcasts) return res.status(403).json({ status: 'error', message: 'Los anuncios municipales no están incluidos en la licencia' });
    if (input.audienceType === 'PERSONAL' && !license.personal_notifications) return res.status(403).json({ status: 'error', message: 'Los avisos individuales no están incluidos en la licencia' });
    if (input.mediaType === 'VIDEO' && !license.video) return res.status(403).json({ status: 'error', message: 'Los videos no están incluidos en la licencia' });
    if (input.audienceType === 'PERSONAL' && !input.targetUserId) throw new Error('Debes seleccionar un vecino destinatario');
    if (input.targetUserId) {
      const target = await pool.query(`SELECT id FROM users WHERE id=$1 AND control_center_id=$2 AND role='NEIGHBOR' AND is_active=true LIMIT 1`, [input.targetUserId, cc.id]);
      if (!target.rows.length) throw new Error('El destinatario no es un vecino activo de este Centro de Control');
    }
    const activeCount = await pool.query(`SELECT COUNT(*)::int AS total FROM municipal_announcements WHERE control_center_id=$1 AND status='PUBLISHED' AND (ends_at IS NULL OR ends_at>NOW())`, [cc.id]);
    if (input.status === 'PUBLISHED' && Number(activeCount.rows[0]?.total || 0) >= Number(license.max_active_announcements || 20)) return res.status(409).json({ status: 'error', message: 'Se alcanzó el máximo de anuncios activos de la licencia' });
    const created = await pool.query(`
      INSERT INTO municipal_announcements (control_center_id,audience_type,target_user_id,title,body,media_type,media_url,status,starts_at,ends_at,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
    `, [cc.id,input.audienceType,input.targetUserId,input.title,input.body,input.mediaType,input.mediaUrl,input.status,input.startsAt,input.endsAt,req.panel_session?.sub || null]);
    res.status(201).json({ status: 'ok', announcement: created.rows[0] });
  } catch (error) {
    res.status(400).json({ status: 'error', message: error.message });
  }
});

app.patch('/admin/control-centers/:code/announcements/:id', async (req, res) => {
  if (!checkAdminToken(req, res)) return;
  try {
    await ensureCommunicationsSchema();
    const cc = await adminResolveControlCenter(req, req.params.code);
    if (!cc) return res.status(404).json({ status: 'error', message: 'Centro de control no encontrado' });
    const settings = await getControlCenterSettingsById(cc.id);
    if (!settings?.settings?.communications_module?.enabled) return res.status(403).json({ status: 'error', message: 'Módulo de Comunicaciones no contratado' });
    const current = await pool.query('SELECT * FROM municipal_announcements WHERE id=$1 AND control_center_id=$2', [req.params.id, cc.id]);
    if (!current.rows.length) return res.status(404).json({ status: 'error', message: 'Anuncio no encontrado' });
    const input = normalizeAnnouncementInput({ ...current.rows[0], ...(req.body || {}) });
    const updated = await pool.query(`
      UPDATE municipal_announcements SET audience_type=$3,target_user_id=$4,title=$5,body=$6,media_type=$7,media_url=$8,status=$9,starts_at=$10,ends_at=$11,updated_at=NOW()
      WHERE id=$1 AND control_center_id=$2 RETURNING *
    `, [req.params.id,cc.id,input.audienceType,input.targetUserId,input.title,input.body,input.mediaType,input.mediaUrl,input.status,input.startsAt,input.endsAt]);
    res.json({ status: 'ok', announcement: updated.rows[0] });
  } catch (error) {
    res.status(400).json({ status: 'error', message: error.message });
  }
});

app.get('/neighbor/announcements', async (req, res) => {
  if (!checkAuthenticatedAccess(req, res, ['NEIGHBOR'], 'Sesión de vecino requerida')) return;
  try {
    await ensureCommunicationsSchema();
    const settings = await getControlCenterSettingsById(req.panel_session.control_center_id);
    const license = settings?.settings?.communications_module || DEFAULT_CONTROL_CENTER_SETTINGS.communications_module;
    if (!license.enabled) return res.json({ status: 'ok', enabled: false, announcements: [] });
    const rows = await pool.query(`
      SELECT a.id,a.audience_type,a.title,a.body,a.media_type,a.media_url,a.starts_at,a.ends_at,a.created_at,
             (r.user_id IS NOT NULL) AS opened
      FROM municipal_announcements a
      LEFT JOIN municipal_announcement_reads r ON r.announcement_id=a.id AND r.user_id=$2
      WHERE a.control_center_id=$1 AND a.status='PUBLISHED'
        AND (a.starts_at IS NULL OR a.starts_at<=NOW()) AND (a.ends_at IS NULL OR a.ends_at>NOW())
        AND (a.audience_type='BROADCAST' OR a.target_user_id=$2)
      ORDER BY (a.audience_type='PERSONAL') DESC, a.created_at DESC LIMIT 50
    `, [req.panel_session.control_center_id, req.panel_session.sub]);
    res.json({ status: 'ok', enabled: true, license, announcements: rows.rows });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/neighbor/announcements/:id/read', async (req, res) => {
  if (!checkAuthenticatedAccess(req, res, ['NEIGHBOR'], 'Sesión de vecino requerida')) return;
  try {
    await ensureCommunicationsSchema();
    const allowed = await pool.query(`SELECT id FROM municipal_announcements WHERE id=$1 AND control_center_id=$2 AND (audience_type='BROADCAST' OR target_user_id=$3)`, [req.params.id,req.panel_session.control_center_id,req.panel_session.sub]);
    if (!allowed.rows.length) return res.status(404).json({ status: 'error', message: 'Anuncio no encontrado' });
    await pool.query(`INSERT INTO municipal_announcement_reads (announcement_id,user_id,opened_at) VALUES ($1,$2,NOW()) ON CONFLICT (announcement_id,user_id) DO UPDATE SET opened_at=EXCLUDED.opened_at`, [req.params.id,req.panel_session.sub]);
    res.json({ status: 'ok' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get("/admin/control-centers/:code/sirens", async (req, res) => {
  if (!checkAdminToken(req, res)) return;

  try {
    await ensureControlCenterSettingsSchema();
    const cc = await adminResolveControlCenter(req, req.params.code || 'CC-VINA');
    if (!cc) return res.status(404).json({ status: "error", message: "Centro de control no encontrado" });

    const result = await pool.query(
      `
      SELECT *
      FROM sirens
      WHERE control_center_id = $1
      ORDER BY name ASC
      `,
      [cc.id]
    );

    res.json({ status: "ok", control_center: cc, total: result.rows.length, sirens: result.rows });
  } catch (error) {
    console.error("[ADMIN GET SIRENS ERROR]", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.post("/admin/control-centers/:code/sirens", async (req, res) => {
  if (!checkAdminToken(req, res)) return;

  try {
    await ensureControlCenterSettingsSchema();
    const cc = await adminResolveControlCenter(req, req.params.code || 'CC-VINA');
    if (!cc) return res.status(404).json({ status: "error", message: "Centro de control no encontrado" });

    const payload = req.body || {};
    const id = String(payload.id || '').trim();
    const name = String(payload.name || '').trim();
    if (!id || !name) {
      return res.status(400).json({ status: "error", message: "id y name son obligatorios" });
    }

    const result = await pool.query(
      `
      INSERT INTO sirens (
        id, control_center_id, name, latitude, longitude, location,
        enabled, activation_mode, default_duration_seconds, max_duration_seconds,
        cooldown_seconds, metadata, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,NOW())
      ON CONFLICT (id) DO UPDATE
      SET control_center_id = EXCLUDED.control_center_id,
          name = EXCLUDED.name,
          latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude,
          location = EXCLUDED.location,
          enabled = EXCLUDED.enabled,
          activation_mode = EXCLUDED.activation_mode,
          default_duration_seconds = EXCLUDED.default_duration_seconds,
          max_duration_seconds = EXCLUDED.max_duration_seconds,
          cooldown_seconds = EXCLUDED.cooldown_seconds,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
      RETURNING *
      `,
      [
        id,
        cc.id,
        name,
        payload.latitude === '' || payload.latitude == null ? null : Number(payload.latitude),
        payload.longitude === '' || payload.longitude == null ? null : Number(payload.longitude),
        payload.location || null,
        payload.enabled !== false,
        String(payload.activation_mode || 'MANUAL_ONLY').toUpperCase(),
        clampPolicyNumber(payload.default_duration_seconds, 60, 5, 600),
        clampPolicyNumber(payload.max_duration_seconds, 180, 10, 900),
        clampPolicyNumber(payload.cooldown_seconds, 120, 0, 3600),
        JSON.stringify(payload.metadata || {})
      ]
    );

    res.json({ status: "ok", siren: result.rows[0] });
  } catch (error) {
    console.error("[ADMIN UPSERT SIREN ERROR]", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.post("/admin/control-centers/:code/sirens/:id/active", async (req, res) => {
  if (!checkAdminToken(req, res)) return;

  try {
    await ensureControlCenterSettingsSchema();
    const cc = await adminResolveControlCenter(req, req.params.code || 'CC-VINA');
    if (!cc) return res.status(404).json({ status: "error", message: "Centro de control no encontrado" });

    const enabled = req.body?.enabled !== false;
    const result = await pool.query(
      `UPDATE sirens SET enabled=$3, updated_at=NOW() WHERE id=$1 AND control_center_id=$2 RETURNING *`,
      [req.params.id, cc.id, enabled]
    );

    if (!result.rows.length) return res.status(404).json({ status: "error", message: "Sirena no encontrada" });
    res.json({ status: "ok", siren: result.rows[0] });
  } catch (error) {
    console.error("[ADMIN SIREN ACTIVE ERROR]", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});


function normalizeAdminDeviceType(value) {
  const type = String(value || 'PHYSICAL_SOS').trim().toUpperCase();
  if (['PHYSICAL_SOS', 'GPS_TRACKER', 'COMMUNITY_BUTTON', 'FIXED_BUTTON'].includes(type)) return type;
  return 'PHYSICAL_SOS';
}

function sanitizeDeviceMetadata(payload = {}, existingMetadata = {}) {
  return {
    ...(existingMetadata && typeof existingMetadata === 'object' ? existingMetadata : {}),
    enabled: payload.enabled !== false,
    sim_phone: String(payload.sim_phone || payload.phone || '').trim() || null,
    registered_address: String(payload.registered_address || payload.address || payload.location || '').trim() || null,
    owner_name: String(payload.owner_name || '').trim() || null,
    ident: String(payload.ident || payload.device_ident || '').trim() || null,
    device_model: String(payload.device_model || payload.model || '').trim() || null,
    heartbeat_max_seconds: clampPolicyNumber(payload.heartbeat_max_seconds, 900, 60, 86400),
    notes: String(payload.notes || '').trim() || null,
    sector_code: String(payload.sector_code || '').trim() || null,
    sector_name: String(payload.sector_name || '').trim() || null,
    siren_id: String(payload.siren_id || '').trim() || null
  };
}

app.get("/admin/control-centers/:code/devices", async (req, res) => {
  if (!checkAdminToken(req, res)) return;

  try {
    const cc = await adminResolveControlCenter(req, req.params.code || 'CC-VINA');
    if (!cc) return res.status(404).json({ status: "error", message: "Centro de control no encontrado" });

    const type = req.query.type ? normalizeAdminDeviceType(req.query.type) : null;
    const params = [cc.id];
    let typeSql = '';
    if (type) {
      params.push(type);
      typeSql = `AND type = $${params.length}`;
    }

    const result = await pool.query(
      `
      SELECT
        id,
        control_center_id,
        name,
        type,
        platform_id,
        last_latitude,
        last_longitude,
        last_seen,
        status,
        metadata,
        created_at,
        updated_at
      FROM devices
      WHERE control_center_id = $1
        ${typeSql}
      ORDER BY name ASC, id ASC
      `,
      params
    );

    res.json({ status: "ok", control_center: cc, total: result.rows.length, devices: result.rows });
  } catch (error) {
    console.error("[ADMIN GET DEVICES ERROR]", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.post("/admin/control-centers/:code/devices", async (req, res) => {
  if (!checkAdminToken(req, res)) return;

  try {
    const cc = await adminResolveControlCenter(req, req.params.code || 'CC-VINA');
    if (!cc) return res.status(404).json({ status: "error", message: "Centro de control no encontrado" });

    const payload = req.body || {};
    const id = String(payload.id || payload.device_id || payload.platform_id || '').trim();
    const name = String(payload.name || '').trim();
    if (!id || !name) {
      return res.status(400).json({ status: "error", message: "id/device_id y name son obligatorios" });
    }

    const existing = await pool.query(`SELECT metadata FROM devices WHERE id = $1 LIMIT 1`, [id]);
    const existingMetadata = existing.rows[0]?.metadata || {};
    const metadata = sanitizeDeviceMetadata(payload, existingMetadata);
    const type = normalizeAdminDeviceType(payload.type || 'PHYSICAL_SOS');
    const platformId = String(payload.platform_id || id).trim();

    const result = await pool.query(
      `
      INSERT INTO devices (
        id,
        control_center_id,
        name,
        type,
        platform_id,
        last_latitude,
        last_longitude,
        status,
        metadata,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,NOW())
      ON CONFLICT (id) DO UPDATE
      SET control_center_id = EXCLUDED.control_center_id,
          name = EXCLUDED.name,
          type = EXCLUDED.type,
          platform_id = EXCLUDED.platform_id,
          last_latitude = EXCLUDED.last_latitude,
          last_longitude = EXCLUDED.last_longitude,
          status = EXCLUDED.status,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
      RETURNING *
      `,
      [
        id,
        cc.id,
        name,
        type,
        platformId || null,
        payload.latitude === '' || payload.latitude == null ? null : Number(payload.latitude),
        payload.longitude === '' || payload.longitude == null ? null : Number(payload.longitude),
        String(payload.status || 'OFFLINE').toUpperCase(),
        JSON.stringify(metadata)
      ]
    );

    res.json({ status: "ok", device: result.rows[0] });
  } catch (error) {
    console.error("[ADMIN UPSERT DEVICE ERROR]", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.post("/admin/control-centers/:code/devices/:id/active", async (req, res) => {
  if (!checkAdminToken(req, res)) return;

  try {
    const cc = await adminResolveControlCenter(req, req.params.code || 'CC-VINA');
    if (!cc) return res.status(404).json({ status: "error", message: "Centro de control no encontrado" });

    const enabled = req.body?.enabled !== false;
    const result = await pool.query(
      `
      UPDATE devices
      SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{enabled}', to_jsonb($3::boolean), true),
          updated_at = NOW()
      WHERE id = $1
        AND control_center_id = $2
      RETURNING *
      `,
      [req.params.id, cc.id, enabled]
    );

    if (!result.rows.length) return res.status(404).json({ status: "error", message: "Dispositivo no encontrado" });
    res.json({ status: "ok", device: result.rows[0] });
  } catch (error) {
    console.error("[ADMIN DEVICE ACTIVE ERROR]", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

const VALID_USER_ROLES = [
  "NEIGHBOR",
  "RESOLVER",
  "OPERATOR",
  "ADMIN",
  "SUPER_ADMIN"
];

const VALID_VALIDATION_STATUSES = [
  "PENDING_VERIFICATION",
  "PROVISIONAL_ACTIVE",
  "VALIDATED",
  "REJECTED",
  "SUSPENDED"
];


function defaultValidationStatusForRole(role) {
  return role === "NEIGHBOR" ? "PROVISIONAL_ACTIVE" : "VALIDATED";
}

function normalizeAdminBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

async function adminCreateOrUpdateUser(payload, actorSession = null) {
  const {
    control_center_code = "CC-VINA",
    full_name,
    phone,
    role = "NEIGHBOR",
    validation_status,
    is_active,
    rut,
    email,
    declared_address,
    latitude,
    longitude,
    emergency_contacts
  } = payload;

  if (!full_name || !phone) {
    throw new Error("full_name and phone are required");
  }

  if (!VALID_USER_ROLES.includes(role)) {
    throw new Error(`Invalid role: ${role}`);
  }

  if (!isSuperAdminSession(actorSession) && role === "SUPER_ADMIN") {
    throw new Error("Solo SUPER_ADMIN puede crear o actualizar usuarios SUPER_ADMIN");
  }

  const effectiveControlCenterCode = isSuperAdminSession(actorSession)
    ? String(control_center_code || actorSession?.control_center_code || "CC-VINA").trim().toUpperCase()
    : String(actorSession?.control_center_code || control_center_code || "CC-VINA").trim().toUpperCase();

  const finalValidationStatus = validation_status || defaultValidationStatusForRole(role);

  if (!VALID_VALIDATION_STATUSES.includes(finalValidationStatus)) {
    throw new Error(`Invalid validation_status: ${finalValidationStatus}`);
  }

  let finalIsActive = normalizeAdminBoolean(
    is_active,
    !["REJECTED", "SUSPENDED", "PENDING_VERIFICATION"].includes(finalValidationStatus)
  );

  if (["REJECTED", "SUSPENDED", "PENDING_VERIFICATION"].includes(finalValidationStatus)) {
    finalIsActive = false;
  }

  const ccResult = await pool.query(
    `
    SELECT id, code, name
    FROM control_centers
    WHERE code = $1
    `,
    [effectiveControlCenterCode]
  );

  if (ccResult.rows.length === 0) {
    throw new Error(`Unknown control_center_code: ${control_center_code}`);
  }

  const controlCenter = ccResult.rows[0];
  const cleanPhone = normalizePhoneForAuth(phone);

  const existingResult = await pool.query(
    `
    SELECT *
    FROM users
    WHERE phone = $1
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [cleanPhone]
  );

  let user;
  let operation;

  if (existingResult.rows.length > 0) {
    const updateResult = await pool.query(
      `
      UPDATE users
      SET
        control_center_id = $1,
        role = $2,
        validation_status = $3,
        is_active = $4,
        full_name = $5,
        rut = $6,
        email = $7,
        declared_address = $8,
        latitude = $9,
        longitude = $10,
        updated_at = NOW()
      WHERE id = $11
      RETURNING *
      `,
      [
        controlCenter.id,
        role,
        finalValidationStatus,
        finalIsActive,
        full_name,
        rut || null,
        email || null,
        declared_address || null,
        latitude ?? null,
        longitude ?? null,
        existingResult.rows[0].id
      ]
    );

    user = updateResult.rows[0];
    operation = "updated";
  } else {
    const insertResult = await pool.query(
      `
      INSERT INTO users (
        control_center_id,
        role,
        validation_status,
        is_active,
        full_name,
        rut,
        phone,
        email,
        declared_address,
        latitude,
        longitude
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
      `,
      [
        controlCenter.id,
        role,
        finalValidationStatus,
        finalIsActive,
        full_name,
        rut || null,
        cleanPhone,
        email || null,
        declared_address || null,
        latitude ?? null,
        longitude ?? null
      ]
    );

    user = insertResult.rows[0];
    operation = "created";
  }

  if (Array.isArray(emergency_contacts)) {
    await pool.query(
      `DELETE FROM emergency_contacts WHERE user_id = $1`,
      [user.id]
    );

    for (const [index, contact] of emergency_contacts.entries()) {
      if (!contact.name || !contact.phone) continue;

      await pool.query(
        `
        INSERT INTO emergency_contacts (
          user_id,
          name,
          relationship,
          phone,
          priority
        )
        VALUES ($1,$2,$3,$4,$5)
        `,
        [
          user.id,
          contact.name,
          contact.relationship || null,
          normalizePhoneForAuth(contact.phone),
          contact.priority || index + 1
        ]
      );
    }
  }

  return {
    operation,
    user,
    control_center: controlCenter
  };
}

app.get("/admin/users", async (req, res) => {
  if (!checkAdminToken(req, res)) return;

  try {
    const {
      control_center_code = "CC-VINA",
      role,
      validation_status,
      q,
      limit
    } = req.query;

    const effectiveControlCenterCode = requestedControlCenterForSession(req, control_center_code);
    const params = [effectiveControlCenterCode];
    const where = ["cc.code = $1"];

    if (role && role !== "ALL") {
      params.push(role);
      where.push(`u.role = $${params.length}`);
    }

    if (validation_status && validation_status !== "ALL") {
      params.push(validation_status);
      where.push(`u.validation_status = $${params.length}`);
    }

    if (q) {
      params.push(`%${String(q).trim()}%`);
      where.push(`(
        u.full_name ILIKE $${params.length}
        OR u.phone ILIKE $${params.length}
        OR COALESCE(u.rut,'') ILIKE $${params.length}
        OR COALESCE(u.email,'') ILIKE $${params.length}
        OR COALESCE(u.declared_address,'') ILIKE $${params.length}
      )`);
    }

    const maxLimit = Math.min(Number(limit || 200), 500);
    params.push(maxLimit);

    const result = await pool.query(
      `
      SELECT
        u.id,
        u.full_name,
        u.role,
        u.phone,
        u.email,
        u.rut,
        u.declared_address,
        u.latitude,
        u.longitude,
        u.validation_status,
        u.is_active,
        u.created_at,
        u.updated_at,
        cc.code AS control_center_code,
        cc.name AS control_center_name,
        COUNT(t.id)::int AS tickets_count,
        MAX(t.created_at) AS last_ticket_at
      FROM users u
      JOIN control_centers cc
        ON cc.id = u.control_center_id
      LEFT JOIN tickets t
        ON t.citizen_user_id = u.id
      WHERE ${where.join(" AND ")}
      GROUP BY
        u.id,
        cc.code,
        cc.name
      ORDER BY
        u.created_at DESC
      LIMIT $${params.length}
      `,
      params
    );

    res.json({
      status: "ok",
      total: result.rows.length,
      users: result.rows
    });

  } catch (error) {
    console.error("[ADMIN USERS ERROR]", error);
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});


app.post("/admin/users", async (req, res) => {
  if (!checkAdminToken(req, res)) return;

  try {
    const result = await adminCreateOrUpdateUser(req.body || {}, req.panel_session);

    res.json({
      status: "ok",
      message: result.operation === "created" ? "User created" : "User updated",
      operation: result.operation,
      user: result.user
    });
  } catch (error) {
    console.error("[ADMIN CREATE USER ERROR]", error);
    res.status(400).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/admin/users/bulk", async (req, res) => {
  if (!checkAdminToken(req, res)) return;

  try {
    const users = Array.isArray(req.body.users)
      ? req.body.users
      : [];

    if (users.length === 0) {
      return res.status(400).json({
        status: "error",
        message: "users must be a non-empty array"
      });
    }

    if (users.length > 200) {
      return res.status(400).json({
        status: "error",
        message: "Bulk user creation is limited to 200 users per request"
      });
    }

    const results = [];

    for (const [index, userPayload] of users.entries()) {
      try {
        const result = await adminCreateOrUpdateUser(userPayload, req.panel_session);
        results.push({
          index,
          status: "ok",
          operation: result.operation,
          user: result.user
        });
      } catch (error) {
        results.push({
          index,
          status: "error",
          message: error.message,
          input: userPayload
        });
      }
    }

    res.json({
      status: "ok",
      total: results.length,
      created: results.filter(r => r.operation === "created").length,
      updated: results.filter(r => r.operation === "updated").length,
      failed: results.filter(r => r.status === "error").length,
      results
    });

  } catch (error) {
    console.error("[ADMIN BULK USERS ERROR]", error);
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.get("/admin/users/:id", async (req, res) => {
  if (!checkAdminToken(req, res)) return;

  try {
    const { id } = req.params;

    const userResult = await pool.query(
      `
      SELECT
        u.*,
        cc.code AS control_center_code,
        cc.name AS control_center_name
      FROM users u
      JOIN control_centers cc
        ON cc.id = u.control_center_id
      WHERE u.id = $1
      `,
      [id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    const contactsResult = await pool.query(
      `
      SELECT
        id,
        name,
        relationship,
        phone,
        priority
      FROM emergency_contacts
      WHERE user_id = $1
      ORDER BY priority ASC, created_at ASC
      `,
      [id]
    );

    const ticketsResult = await pool.query(
      `
      SELECT
        id,
        source_type,
        alert_type,
        title,
        state,
        priority,
        latitude,
        longitude,
        created_at,
        resolved_at,
        closed_at
      FROM tickets
      WHERE citizen_user_id = $1
      ORDER BY created_at DESC
      LIMIT 20
      `,
      [id]
    );

    const resolverLocationResult = await pool.query(
      `
      SELECT
        latitude,
        longitude,
        accuracy,
        status,
        updated_at
      FROM resolver_locations
      WHERE user_id = $1
      `,
      [id]
    );

    res.json({
      status: "ok",
      user: userResult.rows[0],
      emergency_contacts: contactsResult.rows,
      tickets: ticketsResult.rows,
      resolver_location: resolverLocationResult.rows[0] || null
    });

  } catch (error) {
    console.error("[ADMIN USER DETAIL ERROR]", error);
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/admin/users/:id/validation", async (req, res) => {
  if (!checkAdminToken(req, res)) return;

  try {
    const { id } = req.params;
    if (!(await requireSameControlCenterForUser(req, res, id))) return;
    const { validation_status, operator_user_id, reason } = req.body;

    if (!VALID_VALIDATION_STATUSES.includes(validation_status)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid validation_status"
      });
    }

    const result = await pool.query(
      `
      UPDATE users
      SET
        validation_status = $1,
        is_active = CASE
          WHEN $1 IN ('REJECTED', 'SUSPENDED', 'PENDING_VERIFICATION') THEN false
          WHEN $1 IN ('VALIDATED', 'PROVISIONAL_ACTIVE') THEN true
          ELSE is_active
        END,
        updated_at = NOW()
      WHERE id = $2
      RETURNING id, full_name, phone, role, validation_status, is_active, updated_at
      `,
      [validation_status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    console.log("[ADMIN USER VALIDATION]", {
      user_id: id,
      validation_status,
      operator_user_id: operator_user_id || null,
      reason: reason || null
    });

    res.json({
      status: "ok",
      message: "Validation status updated",
      user: result.rows[0]
    });

  } catch (error) {
    console.error("[ADMIN USER VALIDATION ERROR]", error);
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/admin/users/:id/role", async (req, res) => {
  if (!checkAdminToken(req, res)) return;

  try {
    const { id } = req.params;
    if (!(await requireSameControlCenterForUser(req, res, id))) return;
    const { role } = req.body;

    if (!VALID_USER_ROLES.includes(role)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid role"
      });
    }

    if (!isSuperAdminSession(req.panel_session) && role === "SUPER_ADMIN") {
      return res.status(403).json({ status: "error", message: "Solo SUPER_ADMIN puede asignar el rol SUPER_ADMIN" });
    }

    const result = await pool.query(
      `
      UPDATE users
      SET
        role = $1,
        updated_at = NOW()
      WHERE id = $2
      RETURNING id, full_name, phone, role, validation_status, is_active, updated_at
      `,
      [role, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    res.json({
      status: "ok",
      message: "Role updated",
      user: result.rows[0]
    });

  } catch (error) {
    console.error("[ADMIN USER ROLE ERROR]", error);
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/admin/users/:id/active", async (req, res) => {
  if (!checkAdminToken(req, res)) return;

  try {
    const { id } = req.params;
    if (!(await requireSameControlCenterForUser(req, res, id))) return;
    const { is_active } = req.body;

    const result = await pool.query(
      `
      UPDATE users
      SET
        is_active = $1,
        validation_status = CASE
          WHEN $1 = true AND validation_status = 'SUSPENDED' THEN 'PROVISIONAL_ACTIVE'
          ELSE validation_status
        END,
        updated_at = NOW()
      WHERE id = $2
      RETURNING id, full_name, phone, role, validation_status, is_active, updated_at
      `,
      [is_active === true, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    res.json({
      status: "ok",
      message: "Active state updated",
      user: result.rows[0]
    });

  } catch (error) {
    console.error("[ADMIN USER ACTIVE ERROR]", error);
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/admin/users/:id/update", async (req, res) => {
  if (!checkAdminToken(req, res)) return;

  try {
    const { id } = req.params;
    if (!(await requireSameControlCenterForUser(req, res, id))) return;
    const {
      full_name,
      rut,
      email,
      declared_address,
      latitude,
      longitude
    } = req.body;

    const result = await pool.query(
      `
      UPDATE users
      SET
        full_name = COALESCE($1, full_name),
        rut = $2,
        email = $3,
        declared_address = $4,
        latitude = $5,
        longitude = $6,
        updated_at = NOW()
      WHERE id = $7
      RETURNING *
      `,
      [
        full_name || null,
        rut || null,
        email || null,
        declared_address || null,
        latitude ?? null,
        longitude ?? null,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "User not found"
      });
    }

    res.json({
      status: "ok",
      message: "User updated",
      user: result.rows[0]
    });

  } catch (error) {
    console.error("[ADMIN USER UPDATE ERROR]", error);
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/admin/users/:id/contacts", async (req, res) => {
  if (!checkAdminToken(req, res)) return;

  try {
    const { id } = req.params;
    if (!(await requireSameControlCenterForUser(req, res, id))) return;
    const contacts = Array.isArray(req.body.contacts)
      ? req.body.contacts
      : [];

    await pool.query("BEGIN");

    await pool.query(
      `DELETE FROM emergency_contacts WHERE user_id = $1`,
      [id]
    );

    for (const [index, contact] of contacts.entries()) {
      if (!contact.name || !contact.phone) continue;

      await pool.query(
        `
        INSERT INTO emergency_contacts (
          user_id,
          name,
          relationship,
          phone,
          priority
        )
        VALUES ($1,$2,$3,$4,$5)
        `,
        [
          id,
          contact.name,
          contact.relationship || null,
          contact.phone,
          contact.priority || index + 1
        ]
      );
    }

    await pool.query("COMMIT");

    res.json({
      status: "ok",
      message: "Contacts updated"
    });

  } catch (error) {
    await pool.query("ROLLBACK");
    console.error("[ADMIN USER CONTACTS ERROR]", error);
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});



/* =========================================================
   CONTROL CENTER SECTORS v28.8 - PERSISTENCIA + CLASIFICACIÓN OFICIAL UV
   ========================================================= */

let sectorSchemaReady = false;
let sectorCache = new Map();
const SECTOR_CACHE_TTL_MS = Number(process.env.SECTOR_CACHE_TTL_MS || 60000);

async function ensureSectorSchema() {
  if (sectorSchemaReady) return;

  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS control_center_sectors (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      control_center_code TEXT NOT NULL,
      sector_code TEXT NOT NULL,
      sector_name TEXT NOT NULL,
      source TEXT,
      official_level TEXT,
      geometry_geojson JSONB NOT NULL,
      properties JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(control_center_code, sector_code)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_control_center_sectors_code ON control_center_sectors(control_center_code)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_control_center_sectors_sector_code ON control_center_sectors(control_center_code, sector_code)`);

  await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS event_sector_code TEXT`).catch(() => null);
  await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS event_sector_name TEXT`).catch(() => null);
  await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS event_sector_method TEXT`).catch(() => null);
  await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS event_sector_source TEXT`).catch(() => null);
  await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS event_sector_updated_at TIMESTAMPTZ`).catch(() => null);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tickets_event_sector_code ON tickets(control_center_id, event_sector_code)`).catch(() => null);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tickets_event_sector_name ON tickets(control_center_id, event_sector_name)`).catch(() => null);

  sectorSchemaReady = true;
}

function clearSectorCache(controlCenterCode) {
  if (controlCenterCode) sectorCache.delete(String(controlCenterCode).toUpperCase());
  else sectorCache.clear();
}

async function getControlCenterByCode(code) {
  const result = await pool.query(
    `SELECT id, code, name FROM control_centers WHERE code = $1 LIMIT 1`,
    [code]
  );
  return result.rows[0] || null;
}

async function getControlCenterCodeById(controlCenterId) {
  const result = await pool.query(`SELECT code FROM control_centers WHERE id = $1 LIMIT 1`, [controlCenterId]);
  return result.rows[0]?.code || null;
}

async function loadSectorsForControlCenter(controlCenterCode, { force = false } = {}) {
  await ensureSectorSchema();
  const key = String(controlCenterCode || '').toUpperCase();
  const cached = sectorCache.get(key);
  if (!force && cached && (Date.now() - cached.loadedAt) < SECTOR_CACHE_TTL_MS) return cached.sectors;

  const result = await pool.query(
    `
    SELECT
      id,
      control_center_code,
      sector_code,
      sector_name,
      source,
      official_level,
      geometry_geojson,
      properties
    FROM control_center_sectors
    WHERE control_center_code = $1
    ORDER BY sector_name ASC
    `,
    [key]
  );

  const sectors = result.rows.map((row) => ({
    ...row,
    geometry_geojson: typeof row.geometry_geojson === 'string' ? JSON.parse(row.geometry_geojson) : row.geometry_geojson,
    properties: typeof row.properties === 'string' ? JSON.parse(row.properties) : (row.properties || {})
  }));

  sectorCache.set(key, { loadedAt: Date.now(), sectors });
  return sectors;
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i][0]);
    const yi = Number(ring[i][1]);
    const xj = Number(ring[j][0]);
    const yj = Number(ring[j][1]);
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonGeometry(lat, lon, geometry) {
  if (!geometry || lat == null || lon == null) return false;
  const type = geometry.type;
  const coordinates = geometry.coordinates;
  if (!coordinates) return false;

  const inPolygon = (polygon) => {
    if (!Array.isArray(polygon) || !polygon.length) return false;
    const outer = polygon[0];
    if (!pointInRing(lon, lat, outer)) return false;
    for (let h = 1; h < polygon.length; h++) {
      if (pointInRing(lon, lat, polygon[h])) return false;
    }
    return true;
  };

  if (type === 'Polygon') return inPolygon(coordinates);
  if (type === 'MultiPolygon') return coordinates.some((polygon) => inPolygon(polygon));
  return false;
}

async function classifySectorForPoint(controlCenterCode, latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return {
      event_sector_code: null,
      event_sector_name: 'Sector no informado',
      event_sector_method: 'Sin coordenadas de evento',
      event_sector_source: null
    };
  }

  const sectors = await loadSectorsForControlCenter(controlCenterCode);
  for (const sector of sectors) {
    if (pointInPolygonGeometry(lat, lon, sector.geometry_geojson)) {
      return {
        event_sector_code: sector.sector_code,
        event_sector_name: sector.sector_name,
        event_sector_method: sector.official_level || 'point_in_polygon_sector',
        event_sector_source: sector.source || 'control_center_sectors',
        properties: sector.properties || {}
      };
    }
  }

  return {
    event_sector_code: null,
    event_sector_name: 'Dentro de la comuna, sin unidad vecinal identificada',
    event_sector_method: 'No intersecta sectores cargados',
    event_sector_source: 'control_center_sectors'
  };
}

async function classifyAndPersistTicketSector(ticket) {
  if (!ticket || !ticket.id || !ticket.control_center_id) return ticket;
  try {
    await ensureSectorSchema();
    const controlCenterCode = ticket.control_center_code || await getControlCenterCodeById(ticket.control_center_id);
    if (!controlCenterCode) return ticket;
    const sector = await classifySectorForPoint(controlCenterCode, ticket.latitude, ticket.longitude);
    const result = await pool.query(
      `
      UPDATE tickets
      SET
        event_sector_code = $2,
        event_sector_name = $3,
        event_sector_method = $4,
        event_sector_source = $5,
        event_sector_updated_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [
        ticket.id,
        sector.event_sector_code,
        sector.event_sector_name,
        sector.event_sector_method,
        sector.event_sector_source
      ]
    );
    return result.rows[0] || ticket;
  } catch (error) {
    console.warn('[TICKET SECTOR CLASSIFY WARNING]', ticket?.id, error.message);
    return ticket;
  }
}

function getFeatureProperty(props, names, fallback = null) {
  for (const name of names) {
    if (props && props[name] != null && String(props[name]).trim() !== '') return String(props[name]).trim();
  }
  return fallback;
}

app.get('/admin/control-centers/:code/sectors', async (req, res) => {
  if (!checkAdminToken(req, res)) return;
  try {
    const code = requestedControlCenterForSession(req, req.params.code);
    await ensureSectorSchema();
    const sectors = await loadSectorsForControlCenter(code, { force: true });
    res.json({
      status: 'ok',
      control_center_code: code,
      count: sectors.length,
      sectors: sectors.map((s) => ({
        id: s.id,
        sector_code: s.sector_code,
        sector_name: s.sector_name,
        source: s.source,
        official_level: s.official_level,
        geometry_type: s.geometry_geojson?.type || null,
        properties: s.properties || {}
      }))
    });
  } catch (error) {
    console.error('[SECTORS LIST ERROR]', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/admin/control-centers/:code/sectors/bulk', async (req, res) => {
  if (!checkAdminToken(req, res)) return;
  try {
    const code = requestedControlCenterForSession(req, req.params.code);
    await ensureSectorSchema();
    const cc = await getControlCenterByCode(code);
    if (!cc) return res.status(404).json({ status: 'error', message: 'Centro de control no encontrado' });

    const geojson = req.body;
    if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
      return res.status(400).json({ status: 'error', message: 'Se requiere GeoJSON FeatureCollection de sectores' });
    }

    let inserted = 0;
    let skipped = 0;
    await pool.query('BEGIN');
    await pool.query(`DELETE FROM control_center_sectors WHERE control_center_code = $1`, [code]);

    for (const [idx, feature] of geojson.features.entries()) {
      const props = feature.properties || {};
      if (!feature.geometry) { skipped++; continue; }

      const sectorCode = getFeatureProperty(props, ['sector_code','code','CODIGO','codigo','ID','id','uv_carto','UV_CARTO'], `SEC-${String(idx + 1).padStart(3, '0')}`);
      const sectorName = getFeatureProperty(props, ['sector_name','name','NOMBRE','nombre','SECTOR','sector','UNIDAD','unidad','barrio'], sectorCode);
      const source = getFeatureProperty(props, ['source','FUENTE','fuente'], 'GeoJSON cargado por administrador');
      const officialLevel = getFeatureProperty(props, ['official_level','nivel_oficial','type','tipo','TIPO'], 'sector_operativo');

      await pool.query(
        `
        INSERT INTO control_center_sectors (
          control_center_code,
          sector_code,
          sector_name,
          source,
          official_level,
          geometry_geojson,
          properties,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,NOW())
        ON CONFLICT (control_center_code, sector_code)
        DO UPDATE SET
          sector_name = EXCLUDED.sector_name,
          source = EXCLUDED.source,
          official_level = EXCLUDED.official_level,
          geometry_geojson = EXCLUDED.geometry_geojson,
          properties = EXCLUDED.properties,
          updated_at = NOW()
        `,
        [
          code,
          String(sectorCode),
          String(sectorName),
          source,
          officialLevel,
          JSON.stringify(feature.geometry),
          JSON.stringify(props)
        ]
      );
      inserted++;
    }

    await pool.query('COMMIT');
    clearSectorCache(code);

    res.json({
      status: 'ok',
      control_center_code: code,
      inserted,
      skipped,
      message: 'Sectores persistidos en PostgreSQL. Ejecuta reclassify-tickets para actualizar tickets existentes.'
    });
  } catch (error) {
    try { await pool.query('ROLLBACK'); } catch (_) {}
    console.error('[SECTORS BULK ERROR]', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/admin/control-centers/:code/sectors/reclassify-tickets', async (req, res) => {
  if (!checkAdminToken(req, res)) return;
  try {
    const code = requestedControlCenterForSession(req, req.params.code);
    const limit = Math.min(Number(req.body?.limit || req.query?.limit || 500), 5000);
    await ensureSectorSchema();

    const cc = await getControlCenterByCode(code);
    if (!cc) return res.status(404).json({ status: 'error', message: 'Centro de control no encontrado' });

    const tickets = await pool.query(
      `
      SELECT id, control_center_id, latitude, longitude, alert_type, state, created_at
      FROM tickets
      WHERE control_center_id = $1
        AND latitude IS NOT NULL
        AND longitude IS NOT NULL
      ORDER BY created_at DESC
      LIMIT $2
      `,
      [cc.id, limit]
    );

    let updated = 0;
    let withoutSector = 0;
    const sample = [];

    for (const ticket of tickets.rows) {
      const before = ticket;
      const after = await classifyAndPersistTicketSector({ ...ticket, control_center_code: code });
      if (after?.event_sector_name) updated++;
      if (!after?.event_sector_code) withoutSector++;
      if (sample.length < 10) {
        sample.push({
          id: before.id,
          alert_type: before.alert_type,
          state: before.state,
          latitude: before.latitude,
          longitude: before.longitude,
          event_sector_code: after?.event_sector_code || null,
          event_sector_name: after?.event_sector_name || null,
          event_sector_method: after?.event_sector_method || null
        });
      }
    }

    res.json({
      status: 'ok',
      control_center_code: code,
      scanned: tickets.rows.length,
      updated,
      without_sector: withoutSector,
      sample
    });
  } catch (error) {
    console.error('[SECTORS RECLASSIFY ERROR]', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/debug/sector/lookup', async (req, res) => {
  if (!requireAdminTokenIfConfigured(req, res)) return;
  try {
    const { control_center_code = 'CC-VINA', latitude, longitude } = req.body || {};
    await ensureSectorSchema();
    const sector = await classifySectorForPoint(String(control_center_code).toUpperCase(), latitude, longitude);
    res.json({ status: 'ok', control_center_code, latitude, longitude, sector });
  } catch (error) {
    console.error('[SECTOR LOOKUP ERROR]', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});



// Preparar esquema de sectores al iniciar para que /tickets, mapa y Luc-IA puedan leer columnas event_sector_*.
ensureSectorSchema().catch((error) => {
  console.warn('[SECTOR SCHEMA STARTUP WARNING]', error.message);
});

/* kotto insertamos endpoints todo antes de ir a Flespi */ 
startFlespiMqtt();


app.listen(PORT, () => {
		console.log(`VS&TI SOS Middleware v28.8 persistent sectors running on port ${PORT}`);
		});
