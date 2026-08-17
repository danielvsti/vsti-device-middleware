"use strict";

const API = String(process.env.QUELTU_API_URL || "https://api.queltu.com").replace(/\/$/, "");
const CONTROL_CENTER = "CC-JAGUAR-DEMO";
const ADMIN_PHONE = String(process.env.JAGUAR_ADMIN_PHONE || "+5531988815047").trim();
const PREFIX = "[DEMO JAGUAR HIST]";

async function request(path, { method = "GET", token = null, body = null, ok = [200, 201] } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!ok.includes(response.status)) {
    throw new Error(`${method} ${path} -> HTTP ${response.status}: ${data.message || raw.slice(0, 300)}`);
  }
  return data;
}

async function loginAdmin() {
  const challenge = await request("/auth/panel-login", {
    method: "POST",
    body: { phone: ADMIN_PHONE, panel_type: "ADMIN", channel: "demo" }
  });
  if (!challenge.demo_code) {
    throw new Error("El backend no expuso OTP demo; la carga histórica está deliberadamente limitada a modo demo");
  }
  return request("/auth/panel-login", {
    method: "POST",
    body: { phone: ADMIN_PHONE, panel_type: "ADMIN", code: challenge.demo_code, channel: "demo" }
  });
}

function tokenFrom(payload) {
  return payload.token || payload.access_token || payload.session_token || payload.panel_token;
}

async function main() {
  console.log(`== Carga histórica idempotente ${CONTROL_CENTER} ==`);
  const login = await loginAdmin();
  const token = tokenFrom(login);
  if (!token) throw new Error("La autenticación ADMIN no devolvió token");

  const result = await request(`/admin/control-centers/${CONTROL_CENTER}/demo/historical-cases`, {
    method: "POST",
    token,
    body: { confirm: "SEED_JAGUAR_HISTORY_V1" }
  });
  console.log(JSON.stringify({
    total: result.total,
    closed: result.closed,
    open: result.open,
    states: result.states,
    distinct_locations: result.distinct_locations,
    geofence_validation: result.geofence_validation,
    date_range: result.date_range
  }, null, 2));

  const ticketsPayload = await request("/tickets?limit=200", { token });
  const tickets = (ticketsPayload.tickets || []).filter((ticket) => String(ticket.title || "").startsWith(PREFIX));
  const stateCounts = tickets.reduce((counts, ticket) => {
    counts[ticket.state] = (counts[ticket.state] || 0) + 1;
    return counts;
  }, {});
  const locations = new Set(tickets.map((ticket) => `${ticket.latitude},${ticket.longitude}`));
  const timestamps = tickets.map((ticket) => new Date(ticket.created_at).getTime()).filter(Number.isFinite);
  console.log("== Verificación API ==");
  console.log(JSON.stringify({
    visible_cases: tickets.length,
    state_counts: stateCounts,
    unique_coordinates: locations.size,
    earliest: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
    latest: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null
  }, null, 2));

  if (tickets.length !== 30 || locations.size < 15) {
    throw new Error(`Verificación incompleta: ${tickets.length} casos y ${locations.size} coordenadas únicas`);
  }
}

main().catch((error) => {
  console.error("ERROR:", error.message);
  process.exitCode = 1;
});
