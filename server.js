const express = require("express");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.VSTI_TOKEN || "VSTI_MIDDLEWARE_2026_Q7xF92Lp_4MNd8Rk_91AB";

const SAYVU_API_URL = process.env.SAYVU_API_URL || "";
const SAYVU_TOKEN = process.env.SAYVU_TOKEN || "";

const devices = {};
const sirenStates = {};

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

  const shouldSendToSayVU =
    normalized.event_type === "SOS" ||
    normalized.event_type === "LOCATION" ||
    normalized.event_type === "LOW_BATTERY";

  if (normalized.event_type === "KEEP_ALIVE") {
    console.log("KEEP_ALIVE received. Internal monitoring only.");
    return { normalized, forwarded: false };
  }

  if (shouldSendToSayVU) {
    const result = await sendToSayVU(normalized);
    return { normalized, forwarded: true, result };
  }

  console.log("Message received but not forwarded.");
  console.log(JSON.stringify(normalized, null, 2));

  return { normalized, forwarded: false };
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
      "GET /sirens"
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

app.listen(PORT, () => {
  console.log(`VS&TI Device Middleware v2.0 running on port ${PORT}`);
});


