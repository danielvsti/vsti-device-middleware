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
app.use(cors());
app.use(express.json({ limit: "30mb" }));

const UPLOAD_DIR = process.env.SOS_UPLOAD_DIR || "/tmp/sos_uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOAD_DIR));


app.get("/debug/db", async (req, res) => {
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
const TOKEN = process.env.VSTI_TOKEN || "VSTI_MIDDLEWARE_2026_Q7xF92Lp_4MNd8Rk_91AB";

const SAYVU_API_URL = process.env.SAYVU_API_URL || "";
const SAYVU_TOKEN = process.env.SAYVU_TOKEN || "";
const FLESPI_TOKEN = process.env.FLESPI_TOKEN || "";
const FLESPI_MQTT_URL = "mqtts://mqtt.flespi.io:8883";

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
	const token = req.query.token || req.headers["x-vsti-token"];
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
   PANEL ACCESS SESSIONS
   =========================================================

   Control de acceso para paneles operacionales:
   - SOS-MAP / Central: OPERATOR o ADMIN
   - SOS-ADMIN: ADMIN

   En esta etapa el login es por teléfono registrado y activo. En producción
   puede conectarse al mismo flujo OTP usado por vecinos.
   =========================================================
*/

const SESSION_SECRET = process.env.SOS_SESSION_SECRET || process.env.ADMIN_TOKEN || TOKEN || "SOS_SESSION_DEV_SECRET";
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

  return req.headers["x-sos-token"] || req.query.sos_token || "";
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

function checkRoleAccess(req, res, allowedRoles, message = "Unauthorized panel request") {
  const session = panelSessionFromRequest(req);

  if (!session || !allowedRoles.includes(session.role)) {
    res.status(401).json({
      status: "error",
      message
    });
    return false;
  }

  req.panel_session = session;
  return true;
}

function allowedRolesForPanel(panelType) {
  const normalized = String(panelType || "CONTROL_CENTER").toUpperCase();

  if (normalized === "ADMIN") return ["ADMIN"];
  if (normalized === "CONTROL_CENTER") return ["OPERATOR", "ADMIN"];
  if (normalized === "RESOLVER") return ["RESOLVER", "ADMIN"];

  return ["OPERATOR", "ADMIN"];
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

async function ensureGeofenceSchema() {
  if (geofenceSchemaReady) return;

  await pool.query(`
    ALTER TABLE control_centers
      ADD COLUMN IF NOT EXISTS boundary_geojson JSONB,
      ADD COLUMN IF NOT EXISTS geofence_buffer_meters INTEGER DEFAULT 100,
      ADD COLUMN IF NOT EXISTS map_center_lat DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS map_center_lon DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS map_zoom INTEGER DEFAULT 13
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
    `, [req.params.code]);
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
    `, [req.params.code, JSON.stringify(boundary), buffer, centerLat, centerLon, mapZoom]);

    if (!result.rows.length) return res.status(404).json({ status: 'error', message: 'Unknown control center' });
    res.json({ status: 'ok', message: 'Geofence updated', control_center: result.rows[0], bounds });
  } catch (error) {
    console.error('[SET GEOFENCE ERROR]', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/debug/geofence/check', async (req, res) => {
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

  const profile = getPhysicalSosButtonProfile(normalized);
  const existingTicket = await findOpenPhysicalDeviceTicket(normalized, profile);

  if (existingTicket) {
    console.log("[PHYSICAL SOS] Open ticket already exists", {
      ticket_id: existingTicket.id,
      source_event_id: normalized.event_id,
      device_id: profile.id
    });

    return existingTicket;
  }

  const controlCenterId = await getControlCenterIdByCode(profile.control_center_code);

  if (!controlCenterId) {
    console.warn("[PHYSICAL SOS] Control center not found", profile.control_center_code);
    return null;
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




async function createTicket({
  control_center_id,
  citizen_user_id = null,
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
      citizen_user_id,
      citizen_user_id ? "NEIGHBOR" : "SYSTEM",
      "TICKET_CREATED",
      "Ticket creado por alerta entrante",
      metadata
    ]
  );
const assignment = await autoAssignResolver(ticket);
  return assignment?.ticket || ticket;
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
const OTP_DEMO_MODE = process.env.OTP_DEMO_MODE !== "false";
const OTP_DEFAULT_CHANNEL = process.env.OTP_DEFAULT_CHANNEL || "demo";

let authOtpTableReady = false;

function normalizePhoneForAuth(phone) {
  return String(phone || "").trim().replace(/\s+/g, "");
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
  const requested = String(channel || OTP_DEFAULT_CHANNEL || "demo").toLowerCase();

  if (["sms", "whatsapp", "email", "demo"].includes(requested)) {
    if (requested === "email" && !email) return "demo";
    return requested;
  }

  return email ? "email" : "demo";
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
  let result = { sent: false, channel, reason: "demo_mode_or_not_configured" };

  try {
    if (channel === "sms") {
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
    }
  } catch (error) {
    console.error("[OTP DELIVERY ERROR]", error.message);
    result = { sent: false, channel, error: error.message };
  }

  if (!result.sent || OTP_DEMO_MODE) {
    console.log("[OTP DEMO CODE]", {
      phone,
      email: email || null,
      channel,
      purpose,
      code,
      expires_minutes: OTP_TTL_MINUTES
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

  return {
    channel: selectedChannel,
    delivery,
    demo_code: OTP_DEMO_MODE ? code : undefined,
    expires_minutes: OTP_TTL_MINUTES
  };
}

async function verifyOtpForPhone({ phone, code, purpose = null }) {
  await ensureAuthOtpTable();

  const cleanPhone = normalizePhoneForAuth(phone);
  const codeHash = hashOtpCode(cleanPhone, String(code || "").trim());

  const result = await pool.query(
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
version: "2.0-v15-neighbor-status",
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
		const now = Date.now();


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
    created_at,
    updated_at
  FROM mobile_events
  WHERE state IN ('ACTIVE', 'ACKNOWLEDGED')
  ORDER BY user_id, created_at DESC
`);

const mobileEventsForMap = mobileResult.rows;


		const devicesForMap = Object.values(gpsDevices).map((d) => {
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







		const sirensForMap = publicSirens.map((s) => {
				const state = sirenStates[s.id] || {
state: "OFF",
relay: false,
event_id: null,
source: null,
updated_at: null,
expires_at: Date.now()
};

const expired = state.expires_at && now > state.expires_at;

return {
id: s.id,
name: s.name,
latitude: s.latitude,
longitude: s.longitude,
location: s.location,
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
  mobile_events: mobileEventsForMap
});

});

app.post("/public/sirens/activate", (req, res) => {
		const { siren_id, duration_seconds } = req.body;

		if (!siren_id) {
		return res.status(400).json({
status: "error",
message: "siren_id is required"
});
		}

		const siren = publicSirens.find((s) => s.id === siren_id);

		if (!siren) {
		return res.status(404).json({
status: "error",
message: "Unknown siren_id"
});
		}

		const duration = Number(duration_seconds || 60);
		const expiresAt = Date.now() + duration * 1000;

sirenStates[siren_id] = {
state: "ON",
       relay: true,
       event_id: `PUBLIC-MAP-${Date.now()}`,
       source: "public-map",
       updated_at: nowChile(),
       expires_at: expiresAt
};

res.json({
status: "ok",
message: "Siren activated",
siren_id,
duration_seconds: duration
});
});

app.post("/public/sirens/deactivate", (req, res) => {
		const { siren_id } = req.body;

		if (!siren_id) {
		return res.status(400).json({
status: "error",
message: "siren_id is required"
});
		}

		const siren = publicSirens.find((s) => s.id === siren_id);

		if (!siren) {
		return res.status(404).json({
status: "error",
message: "Unknown siren_id"
});
		}

		sirenStates[siren_id] = {
state: "OFF",
       relay: false,
       event_id: `PUBLIC-MAP-OFF-${Date.now()}`,
       source: "public-map",
       updated_at: nowChile(),
       expires_at: Date.now()
		};

res.json({
status: "ok",
message: "Siren deactivated",
siren_id
});
});

app.post("/public/devices/ack-sos", (req, res) => {
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
      control_center_code = "CC-VINA"
    } = req.body;

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

    const userResult = await pool.query(
      `
      SELECT
        u.id,
        u.control_center_id,
        u.role,
        u.validation_status,
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
        jurisdiction_reason
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',false,false,$9,$10)
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
        jurisdiction.reason
      ]
    );

    const event = result.rows[0];
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
        jurisdiction_distance_meters: jurisdiction.distance_meters ?? null
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

    console.log("[MOBILE SOS DB]", event);

    res.json({
      status: "ok",
      message: "Mobile SOS received",
      event_id: event.id,
      state: event.state,
      received_at: event.created_at,
      ticket_id: ticket ? ticket.id : null,
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
        ? `${event.resolver_name} fue asignado a tu caso.`
        : "Un resolutor municipal fue asignado a tu caso.",
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

  let headline = "La central ya recibió tu emergencia.";
  let detail = "Puedes agregar información mientras se gestiona el caso.";

  if (state === "ASSIGNED") {
    headline = "Resolutor asignado.";
    detail = event.resolver_name
      ? `${event.resolver_name} fue asignado a tu caso.`
      : "Un resolutor municipal fue asignado a tu caso.";
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

    res.json({
      status: "ok",
      event,
      ticket_state: event.ticket_state || null,
      effective_state: effectiveState,
      neighbor_progress: neighborProgress,
      pending_call_request: pendingCallRequest
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
    const { user_id } = req.query;

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
        r.phone AS resolver_phone
      FROM mobile_events m
      LEFT JOIN tickets t
        ON t.source_type = 'MOBILE_APP'
       AND t.source_event_id = m.id
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
        neighbor_progress: null
      });
    }

    const event = result.rows[0];
    const terminalTicketStates = ["RESOLVED", "CLOSED", "CANCELLED"];
    const effectiveState = terminalTicketStates.includes(event.ticket_state)
      ? event.ticket_state
      : (event.ticket_state || event.state);

    event.effective_state = effectiveState;

    res.json({
      status: "ok",
      active: true,
      event,
      ticket_id: event.ticket_id || null,
      ticket_state: event.ticket_state || null,
      effective_state: effectiveState,
      neighbor_progress: buildNeighborProgress(event)
    });

  } catch (error) {
    console.error("[MOBILE ACTIVE CASE ERROR]", error);

    res.status(500).json({
      status: "error",
      message: "Database error getting active mobile case"
    });
  }
});



app.post("/auth/panel-login", async (req, res) => {
  try {
    const {
      phone,
      panel_type = "CONTROL_CENTER"
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

    const token = createPanelSessionToken(user, panel_type);

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

    res.json({
      status: "ok",
      session,
      user: result.rows[0]
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

app.post("/auth/register", async (req, res) => {
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

    if (!control_center_code) {
      return res.status(400).json({
        status: "error",
        message: "control_center_code is required"
      });
    }

    if (!full_name || !phone || !declared_address) {
      return res.status(400).json({
        status: "error",
        message: "full_name, phone and declared_address are required"
      });
    }

    const ccResult = await pool.query(
      `
      SELECT id, code, name
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
    const cleanPhone = normalizePhoneForAuth(phone);

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
          longitude
        )
        VALUES (
          $1,
          'NEIGHBOR',
          'PROVISIONAL_ACTIVE',
          $2,$3,$4,$5,$6,$7,$8
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
        control_center_code: controlCenter.code
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
      user: publicUserPayload(user, controlCenter)
    });

  } catch (error) {
    console.error("[AUTH REGISTER ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message || "Database error registering user"
    });
  }
});

app.post("/auth/request-code", async (req, res) => {
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

app.post("/auth/verify-code", async (req, res) => {
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
      token: `otp-token-${user.id}`,
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

app.post("/auth/login-demo", async (req, res) => {
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
  try {
    const {
      control_center_code,
      state,
      limit
    } = req.query;

    if (!control_center_code) {
      return res.status(400).json({
        status: "error",
        message: "control_center_code is required"
      });
    }

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



app.post("/tickets/:id/acknowledge", async (req, res) => {
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
  if (!configured) return true;
  const provided = req.headers["x-admin-token"] || req.headers["authorization"]?.replace(/^Bearer\s+/i, "");
  if (provided === configured) return true;
  res.status(401).json({ status: "error", message: "ADMIN_TOKEN requerido" });
  return false;
}

function maxResolverGpsAccuracyMeters() {
  return Number(process.env.RESOLVER_GPS_MAX_ACCURACY_METERS || 150);
}

app.post("/debug/resolver-location", async (req, res) => {
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

    res.json({
      status: "ok",
      message: "Ticket resolved",
      ticket: ticketResult.rows[0]
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

    res.json({
      status: "ok",
      message: "Ticket rejected by resolver",
      ticket: reassignment?.ticket || releasedTicket,
      released: true,
      reassigned: !!reassignment,
      rejected_resolver_user_id: resolver_user_id,
      excluded_resolver_user_ids: excludedAfterReject,
      new_resolver: reassignment?.resolver || null
    });

  } catch (error) {
    console.error("[REJECT TICKET ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});


app.post("/tickets/:id/auto-assign", async (req, res) => {
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

app.get("/tickets/:id/actions", async (req, res) => {
  try {
    const { id } = req.params;

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

app.get("/dashboard/summary", async (req, res) => {
  try {
    await ensureGeofenceSchema();
    const { control_center_code } = req.query;

    if (!control_center_code) {
      return res.status(400).json({
        status: "error",
        message: "control_center_code is required"
      });
    }

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
  if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN"], "Se requiere usuario OPERATOR o ADMIN para acceder al dashboard")) return;

  try {
    await ensureGeofenceSchema();
    const days = Math.max(1, Math.min(365, Number(req.query.days || 30)));
    const requestedCode = dashboardAuthorizedControlCenterCode(req);

    const ccResult = await pool.query(
      `
      SELECT id, code, name,
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
          ROUND(latitude::numeric, 4) AS lat_key,
          ROUND(longitude::numeric, 4) AS lon_key
        FROM tickets
        WHERE control_center_id = $1
          AND created_at >= NOW() - ($2::int || ' days')::interval
          AND latitude IS NOT NULL
          AND longitude IS NOT NULL
      ), zones AS (
        SELECT
          lat_key,
          lon_key,
          COUNT(*)::int AS tickets_count,
          COUNT(*) FILTER (WHERE state NOT IN ('CLOSED','CANCELLED','RESOLVED'))::int AS open_count,
          MAX(created_at) AS last_ticket_at
        FROM geo
        GROUP BY lat_key, lon_key
      )
      SELECT
        lat_key::float AS latitude,
        lon_key::float AS longitude,
        tickets_count,
        open_count,
        last_ticket_at,
        COALESCE((
          SELECT g.alert_type
          FROM geo g
          WHERE g.lat_key = z.lat_key
            AND g.lon_key = z.lon_key
          GROUP BY g.alert_type
          ORDER BY COUNT(*) DESC
          LIMIT 1
        ), 'SIN_TIPO') AS top_alert_type
      FROM zones z
      ORDER BY tickets_count DESC, last_ticket_at DESC NULLS LAST
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
  // Regla estricta multi-comuna: la sesión manda.
  // El frontend puede enviar control_center_code, pero no se usa para escapar del centro del usuario.
  if (req.panel_session && req.panel_session.control_center_code) {
    return String(req.panel_session.control_center_code).trim().toUpperCase();
  }
  return String(req.query.control_center_code || "CC-VINA").trim().toUpperCase();
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
  if (/(top|ranking|mas|mayor|mejor).*(resolutor|funcionario|movil|equipo)|resolutor.*(atend|gestion|cerr|resolv)/.test(q)) return "resolver_performance";
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
    return {
      intent, days, limit,
      title: "Desempeño de resolutores",
      params: baseParams,
      sql: `
        SELECT
          u.full_name AS resolutor,
          u.phone AS telefono,
          COUNT(t.id)::int AS tickets_asignados,
          COUNT(t.id) FILTER (WHERE t.state IN ('RESOLVED','CLOSED'))::int AS tickets_cerrados,
          COUNT(t.id) FILTER (WHERE t.state IN ('ASSIGNED','EN_ROUTE','ON_SITE'))::int AS tickets_en_gestion,
          ROUND(AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.assigned_at)) / 60.0) FILTER (WHERE t.resolved_at IS NOT NULL AND t.assigned_at IS NOT NULL)::numeric, 1) AS min_promedio_resolucion
        FROM users u
        LEFT JOIN tickets t ON t.assigned_resolver_id = u.id
          AND t.control_center_id = $1
          AND t.created_at >= NOW() - ($2::int || ' days')::interval
        WHERE u.control_center_id = $1
          AND u.role = 'RESOLVER'
        GROUP BY u.id, u.full_name, u.phone
        ORDER BY tickets_asignados DESC, tickets_cerrados DESC, resolutor ASC
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
  if (queryDef.intent === "resolver_performance") return n ? `Encontré ${n} resolutores para el período. El ranking está ordenado por tickets asignados y cierres/resoluciones.` : "No encontré actividad de resolutores para ese período.";
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
  if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN"], "Se requiere usuario OPERATOR o ADMIN para usar Luc-IA")) return;

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
  if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN"], "Se requiere usuario OPERATOR o ADMIN para listar tickets")) return;

  try {
    const controlCenterCode = dashboardAuthorizedControlCenterCode(req);
    const cc = await pool.query("SELECT id, code, name FROM control_centers WHERE code = $1 LIMIT 1", [controlCenterCode]);
    if (!cc.rows.length) return res.status(404).json({ status: "error", message: "Centro de control no encontrado" });

    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(10, Math.max(1, Number(req.query.page_size || 10)));
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
  if (String(process.env.REQUIRE_CONTROL_PANEL_AUTH || "false").toLowerCase() === "true") {
    if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN"], "Se requiere usuario OPERATOR o ADMIN para acceder al panel de control")) return;
  }

  try {
    const { control_center_code } = req.query;

    if (!control_center_code) {
      return res.status(400).json({
        status: "error",
        message: "control_center_code is required"
      });
    }

    const ccResult = await pool.query(
      `
      SELECT id, code, name,
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
    const { id } = req.params;

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

        citizen.full_name AS citizen_name,
        citizen.phone AS citizen_phone,
        citizen.email AS citizen_email,
        citizen.declared_address,

        resolver.full_name AS resolver_name,
        resolver.phone AS resolver_phone,
        latest_assignment.state AS latest_assignment_state,
        latest_assignment.resolver_user_id AS latest_assignment_resolver_user_id,
        latest_assignment.rejected_at AS latest_assignment_rejected_at,
        latest_assignment.assignment_type AS latest_assignment_type

      FROM tickets t

      JOIN control_centers cc
        ON cc.id = t.control_center_id

      LEFT JOIN users citizen
        ON citizen.id = t.citizen_user_id

      LEFT JOIN users resolver
        ON resolver.id = t.assigned_resolver_id

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

    res.json({
      status: "ok",
      ticket,
      emergency_contacts: contactsResult.rows,
      actions: actionsResult.rows,
      notes: notesResult.rows
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

    const userResult = await pool.query(
      `
      SELECT id, control_center_id, role, full_name
      FROM users
      WHERE id = $1
        AND is_active = true
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

    res.json({
      status: "ok",
      message: effectiveStatus !== requestedStatus ? "Resolver location updated; operational status auto-corrected" : "Resolver location updated",
      requested_status: requestedStatus,
      effective_status: effectiveStatus,
      active_tickets_count: activeTickets.length,
      active_tickets: activeTickets,
      resolver_location: result.rows[0],
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
  try {
    const { id } = req.params;

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
        latest_assignment.distance_meters
      FROM tickets t
      LEFT JOIN users citizen
        ON citizen.id = t.citizen_user_id
      LEFT JOIN users resolver_user
        ON resolver_user.id = t.assigned_resolver_id
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
   ADMIN USERS / MUNICIPAL VALIDATION
   =========================================================
*/

function checkAdminToken(req, res) {
  const expected = process.env.ADMIN_TOKEN || "";
  const legacyAdminToken =
    req.headers["x-admin-token"] ||
    req.query.admin_token ||
    "";

  // Compatibilidad: si se define ADMIN_TOKEN, sigue funcionando como llave maestra.
  if (expected && legacyAdminToken === expected) {
    return true;
  }

  // Nuevo control de acceso por sesión de usuario ADMIN.
  return checkRoleAccess(req, res, ["ADMIN"], "Se requiere usuario ADMIN para acceder al mantenedor");
}

const VALID_USER_ROLES = [
  "NEIGHBOR",
  "RESOLVER",
  "OPERATOR",
  "ADMIN"
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

async function adminCreateOrUpdateUser(payload) {
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
    [control_center_code]
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

    const params = [control_center_code];
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
    const result = await adminCreateOrUpdateUser(req.body || {});

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
        const result = await adminCreateOrUpdateUser(userPayload);
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
    const { role } = req.body;

    if (!VALID_USER_ROLES.includes(role)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid role"
      });
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
    const code = String(req.params.code || '').toUpperCase();
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
    const code = String(req.params.code || '').toUpperCase();
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
    const code = String(req.params.code || '').toUpperCase();
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
