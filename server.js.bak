const express = require("express");
const app = express();

app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.VSTI_TOKEN || "VSTI_MIDDLEWARE_2026_Q7xF92Lp_4MNd8Rk_91AB";

const sirenStates = {};

function checkToken(req, res) {
  const token = req.query.token || req.headers["x-vsti-token"];
  if (token !== TOKEN) {
    res.status(401).json({ status: "error", message: "Unauthorized" });
    return false;
  }
  return true;
}

function nowChile() {
  return new Date().toLocaleString("sv-SE", { timeZone: "America/Santiago" });
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "VS&TI Device Middleware",
    endpoints: ["/endpoint", "/sirens/command", "/sirens/status", "/sirens"]
  });
});

app.post("/endpoint", (req, res) => {
  if (!checkToken(req, res)) return;

  console.log("NEW DEVICE MESSAGE");
  console.log(JSON.stringify(req.body, null, 2));

  res.json({
    status: "ok",
    message: "Device data received",
    received_at: nowChile()
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
  console.log(`VS&TI Device Middleware running on port ${PORT}`);
});



