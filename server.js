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

console.log(
  "DATABASE_URL configurada:",
  !!process.env.DATABASE_URL
);

const express = require("express");
const mqtt = require("mqtt");
const cors = require("cors");
const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));


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


const SOS_ACTIVE_MS = 60 * 1000;
const SOS_RECENT_MS = 10 * 60 * 1000;

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


	const shouldSendToSayVU = true;

	/*
	   const shouldSendToSayVU =
	   normalized.event_type === "SOS" ||
	   normalized.event_type === "LOCATION" ||
	   normalized.event_type === "LOW_BATTERY";

	   if (normalized.event_type === "KEEP_ALIVE") {
	   console.log("KEEP_ALIVE received. Internal monitoring only.");
	   return { normalized, forwarded: false };
	   }
	 */


	if (shouldSendToSayVU) {
		const result = await sendToSayVU(normalized);
		return { normalized, forwarded: true, result };
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







app.get("/", (req, res) => {
		res.json({
status: "ok",
service: "VS&TI Device Middleware",
version: "2.0",
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
  name: "Sirena Libertad / 5 Norte",
  latitude: -33.01895,
  longitude: -71.55090,
  location: "Libertad con 5 Norte, Viña del Mar",
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
      source
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
        name || "Usuario movil",
        phone || null,
        Number(latitude),
        Number(longitude),
        accuracy ?? null,
        battery ?? null
      ]
    );

    const event = result.rows[0];

const userResult = await pool.query(
  `
  SELECT id, control_center_id
  FROM users
  WHERE id = $1
  `,
  [user_id]
);

let ticket = null;

if (userResult.rows.length > 0) {
  const user = userResult.rows[0];

  ticket = await createTicket({
    control_center_id: user.control_center_id,
    citizen_user_id: user.id,
    source_type: "MOBILE_APP",
    source_event_id: event.id,
    alert_type: "SOS_MANUAL",
    title: "SOS móvil",
    description: "Alerta SOS generada desde aplicación móvil",
    latitude: event.latitude,
    longitude: event.longitude,
    accuracy: event.accuracy,
    priority: 1,
    metadata: {
      mobile_event_id: event.id,
      phone,
      battery,
      source
    }
  });
}






    console.log("[MOBILE SOS DB]", event);

    res.json({
      status: "ok",
      message: "Mobile SOS received",
      event_id: event.id,
      state: event.state,
     received_at: event.created_at,
ticket_id: ticket ? ticket.id : null
    });

  } catch (error) {
    console.error("[MOBILE SOS DB ERROR]", error);

    res.status(500).json({
      status: "error",
      message: "Database error creating mobile SOS"
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
      SELECT *
      FROM mobile_events
      WHERE id = $1
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

app.get("/public/mobile/status/:event_id", async (req, res) => {
  try {
    const { event_id } = req.params;

    const result = await pool.query(
      `
      SELECT *
      FROM mobile_events
      WHERE id = $1
      `,
      [event_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        message: "Unknown event_id"
      });
    }

    res.json({
      status: "ok",
      event: result.rows[0]
    });

  } catch (error) {
    console.error("[MOBILE STATUS DB ERROR]", error);

    res.status(500).json({
      status: "error",
      message: "Database error getting mobile SOS status"
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
      emergency_contacts
    } = req.body;

    if (!control_center_code) {
      return res.status(400).json({
        status: "error",
        message: "control_center_code is required"
      });
    }

    if (!full_name || !phone) {
      return res.status(400).json({
        status: "error",
        message: "full_name and phone are required"
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
        phone,
        email || null,
        declared_address || null,
        latitude ?? null,
        longitude ?? null
      ]
    );

    const user = userResult.rows[0];

    const contacts = Array.isArray(emergency_contacts)
      ? emergency_contacts
      : [];

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

    res.json({
      status: "ok",
      message: "User registered",
      user: {
        id: user.id,
        control_center_id: user.control_center_id,
        control_center_code: controlCenter.code,
        control_center_name: controlCenter.name,
        role: user.role,
        validation_status: user.validation_status,
        full_name: user.full_name,
        phone: user.phone,
        rut: user.rut,
        email: user.email,
        declared_address: user.declared_address
      }
    });

  } catch (error) {
    console.error("[AUTH REGISTER ERROR]", error);

    res.status(500).json({
      status: "error",
      message: "Database error registering user"
    });
  }
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
        u.declared_address
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


/* kotto insertamos endpoints todo antes de ir a Flespi */ 
startFlespiMqtt();


app.listen(PORT, () => {
		console.log(`VS&TI Device Middleware v2.0 running on port ${PORT}`);
		});

