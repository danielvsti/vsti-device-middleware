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

async function autoAssignResolver(ticket) {
  if (!ticket.latitude || !ticket.longitude) {
    return null;
  }

  const result = await pool.query(
    `
    SELECT
      u.id,
      u.full_name,
      rl.latitude,
      rl.longitude,
      rl.status
    FROM resolver_locations rl
    JOIN users u ON u.id = rl.user_id
    WHERE rl.control_center_id = $1
      AND rl.status = 'AVAILABLE'
      AND u.role = 'RESOLVER'
      AND u.is_active = true
    `,
    [ticket.control_center_id]
  );

  if (result.rows.length === 0) {
    await pool.query(
      `
      INSERT INTO ticket_actions (
        ticket_id,
        actor_role,
        action_type,
        description
      )
      VALUES ($1,'SYSTEM','NO_RESOLVER_AVAILABLE',$2)
      `,
      [
        ticket.id,
        "No hay resolutores disponibles para asignación automática"
      ]
    );

    return null;
  }

  const ranked = result.rows
    .map((resolver) => ({
      ...resolver,
      distance_meters: distanceMeters(
        Number(ticket.latitude),
        Number(ticket.longitude),
        Number(resolver.latitude),
        Number(resolver.longitude)
      )
    }))
    .sort((a, b) => a.distance_meters - b.distance_meters);

  const selected = ranked[0];

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
        distance_meters: Math.round(selected.distance_meters)
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

  const ticket = ticketResult.rows[0];

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
await autoAssignResolver(ticket);
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
        cc.code AS control_center_code
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
        cancelled
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',false,false)
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
        battery ?? null
      ]
    );

    const event = result.rows[0];

    const ticket = await createTicket({
      control_center_id: controlCenterId,
      citizen_user_id: citizenUserId,
      source_type: "MOBILE_APP",
      source_event_id: event.id,
      alert_type: alert_type || "SOS_MANUAL",
      title: title || "SOS móvil",
      description: description || "Alerta SOS generada desde aplicación móvil",
      latitude: event.latitude,
      longitude: event.longitude,
      accuracy: event.accuracy,
      priority: Number(priority || 1),
      metadata: {
        mobile_event_id: event.id,
        phone: citizen.phone || phone,
        battery,
        source,
        alert_type,
        title,
        priority,
        control_center_code: citizen.control_center_code || control_center_code,
        citizen_validation_status: citizen.validation_status,
        anonymous_user_id: user_id
      }
    });

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

    await pool.query(
      `
      UPDATE tickets
      SET
        state = 'CANCELLED',
        closed_at = COALESCE(closed_at, NOW()),
        updated_at = NOW()
      WHERE source_type = 'MOBILE_APP'
        AND source_event_id = $1
        AND state NOT IN ('CLOSED','RESOLVED','CANCELLED')
      `,
      [event_id]
    );

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

    await pool.query(
      `
      UPDATE ticket_assignments
      SET
        state = 'REJECTED',
        rejected_at = NOW()
      WHERE ticket_id = $1
        AND resolver_user_id = $2
        AND state = 'PENDING'
      `,
      [id, resolver_user_id]
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
      VALUES ($1,$2,'RESOLVER','RESOLVER_REJECTED',$3,$4)
      `,
      [
        id,
        resolver_user_id,
        "Resolutor rechazó el caso",
        JSON.stringify({
          reject_reason: reject_reason || null
        })
      ]
    );

    const ticketResult = await pool.query(
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

    const reassignment = await autoAssignResolver(ticketResult.rows[0]);

    res.json({
      status: "ok",
      message: "Ticket rejected by resolver",
      ticket: reassignment?.ticket || ticketResult.rows[0],
      reassigned: !!reassignment,
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


app.get("/dashboard/map-state", async (req, res) => {
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
      SELECT id, code, name, latitude, longitude
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
        t.created_at,
        t.acknowledged_at,
        t.assigned_at,
        t.resolved_at,
        t.closed_at,
        u.full_name AS citizen_name,
        u.phone AS citizen_phone,
        r.full_name AS resolver_name
      FROM tickets t
      LEFT JOIN users u ON u.id = t.citizen_user_id
      LEFT JOIN users r ON r.id = t.assigned_resolver_id
      WHERE t.control_center_id = $1
        AND t.state NOT IN ('CLOSED', 'CANCELLED')
      ORDER BY t.created_at DESC
      `,
      [controlCenter.id]
    );

    const resolversResult = await pool.query(
      `
      SELECT
        u.id,
        u.full_name,
        u.phone,
        rl.latitude,
        rl.longitude,
        rl.accuracy,
        rl.status,
        rl.updated_at
      FROM resolver_locations rl
      JOIN users u ON u.id = rl.user_id
      WHERE rl.control_center_id = $1
        AND u.role = 'RESOLVER'
        AND u.is_active = true
      `,
      [controlCenter.id]
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
        cc.code AS control_center_code,
        cc.name AS control_center_name,

        citizen.full_name AS citizen_name,
        citizen.phone AS citizen_phone,
        citizen.email AS citizen_email,
        citizen.declared_address,

        resolver.full_name AS resolver_name,
        resolver.phone AS resolver_phone

      FROM tickets t

      JOIN control_centers cc
        ON cc.id = t.control_center_id

      LEFT JOIN users citizen
        ON citizen.id = t.citizen_user_id

      LEFT JOIN users resolver
        ON resolver.id = t.assigned_resolver_id

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
      status = "AVAILABLE"
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
        Number(latitude),
        Number(longitude),
        accuracy,
        status
      ]
    );

    res.json({
      status: "ok",
      message: "Resolver location updated",
      resolver_location: result.rows[0]
    });

  } catch (error) {
    console.error("[RESOLVER LOCATION MVP ERROR]", error);

    res.status(500).json({
      status: "error",
      message: error.message
    });
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
  if (!expected) return true;

  const token =
    req.headers["x-admin-token"] ||
    req.query.admin_token ||
    "";

  if (token !== expected) {
    res.status(401).json({
      status: "error",
      message: "Unauthorized admin request"
    });
    return false;
  }

  return true;
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


/* kotto insertamos endpoints todo antes de ir a Flespi */ 
startFlespiMqtt();


app.listen(PORT, () => {
		console.log(`VS&TI Device Middleware v2.0 running on port ${PORT}`);
		});

