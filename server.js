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

const express = require("express");
const mqtt = require("mqtt");
const cors = require("cors");
const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.VSTI_TOKEN || "VSTI_MIDDLEWARE_2026_Q7xF92Lp_4MNd8Rk_91AB";

const SAYVU_API_URL = process.env.SAYVU_API_URL || "";
const SAYVU_TOKEN = process.env.SAYVU_TOKEN || "";
const FLESPI_TOKEN = process.env.FLESPI_TOKEN || "";
const FLESPI_MQTT_URL = "mqtts://mqtt.flespi.io:8883";

const gpsDevices = {};

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
    location: "Libertad con 5 Norte, Viña del Mar"
  }
];

app.get("/public/map-state", (req, res) => {
  const now = Date.now();
  

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
    sirens: sirensForMap
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

startFlespiMqtt();


app.listen(PORT, () => {
  console.log(`VS&TI Device Middleware v2.0 running on port ${PORT}`);
});

