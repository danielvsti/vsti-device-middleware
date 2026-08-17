"use strict";

const API = String(process.env.QUELTU_API_URL || "https://api.queltu.com").replace(/\/$/, "");
const CONTROL_CENTER = "CC-JAGUAR-DEMO";
const ADMIN_PHONE = String(process.env.JAGUAR_ADMIN_PHONE || "+5531988815047").trim();
const TEST_WORKER_PHONE = String(process.env.JAGUAR_TEST_WORKER_PHONE || "+551111000001").trim();

// Geocerca operacional para la demostración de Complexo Caeté / Mina Pilar.
// No representa un deslinde legal o catastral de Jaguar Mining. Debe reemplazarse
// por el GeoJSON oficial de la compañía antes de una puesta en producción real.
const BOUNDARY = {
  type: "Polygon",
  coordinates: [[
    [-43.6825, -19.8755],
    [-43.6725, -19.8725],
    [-43.6610, -19.8745],
    [-43.6570, -19.8825],
    [-43.6595, -19.8925],
    [-43.6685, -19.8985],
    [-43.6785, -19.8970],
    [-43.6840, -19.8890],
    [-43.6825, -19.8755]
  ]]
};

const WORK_AREAS = [
  { name: "Mina Subterrânea", latitude: -19.8842, longitude: -43.6718 },
  { name: "Planta de Beneficiamento", latitude: -19.8818, longitude: -43.6687 },
  { name: "Manutenção / Oficina", latitude: -19.8865, longitude: -43.6664 },
  { name: "Depósito de Explosivos", latitude: -19.8912, longitude: -43.6751 },
  { name: "Acesso e Superfície", latitude: -19.8787, longitude: -43.6638 }
];

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

async function loginPanel(phone) {
  const challenge = await request("/auth/panel-login", {
    method: "POST",
    body: { phone, panel_type: "ADMIN", channel: "demo" }
  });
  if (!challenge.demo_code) throw new Error("OTP demo no expuesto para la cuenta ADMIN");
  return request("/auth/panel-login", {
    method: "POST",
    body: { phone, panel_type: "ADMIN", code: challenge.demo_code, channel: "demo" }
  });
}

async function loginWorker(phone) {
  const challenge = await request("/auth/request-code", {
    method: "POST",
    body: { phone, channel: "demo", purpose: "LOGIN" }
  });
  if (!challenge.demo_code) throw new Error("OTP demo no expuesto para el trabajador de prueba");
  return request("/auth/verify-code", {
    method: "POST",
    body: { phone, code: challenge.demo_code, purpose: "LOGIN" }
  });
}

function tokenFrom(payload) {
  return payload.token || payload.access_token || payload.session_token || payload.mobile_access_token;
}

function pointInRing(longitude, latitude, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [x1, y1] = ring[index].map(Number);
    const [x2, y2] = ring[previous].map(Number);
    const crosses = ((y1 > latitude) !== (y2 > latitude))
      && (longitude < ((x2 - x1) * (latitude - y1)) / ((y2 - y1) || 1e-12) + x1);
    if (crosses) inside = !inside;
  }
  return inside;
}

function boundsOf(polygon) {
  const points = polygon.coordinates[0];
  const longitudes = points.map(point => Number(point[0]));
  const latitudes = points.map(point => Number(point[1]));
  return {
    min_longitude: Math.min(...longitudes),
    max_longitude: Math.max(...longitudes),
    min_latitude: Math.min(...latitudes),
    max_latitude: Math.max(...latitudes)
  };
}

async function main() {
  console.log(`Corrigiendo exclusivamente ${CONTROL_CENTER} en ${API}...`);
  const adminLogin = await loginPanel(ADMIN_PHONE);
  const adminToken = tokenFrom(adminLogin);
  if (!adminToken) throw new Error("La autenticación ADMIN no devolvió token");
  if (String(adminLogin.user?.control_center_code || "").toUpperCase() !== CONTROL_CENTER) {
    throw new Error(`ABORTADO: la sesión pertenece a ${adminLogin.user?.control_center_code || "otro centro"}`);
  }
  if (String(adminLogin.user?.role || "").toUpperCase() !== "ADMIN") {
    throw new Error(`ABORTADO: se esperaba ADMIN y se recibió ${adminLogin.user?.role || "sin rol"}`);
  }

  const previous = await request(`/admin/control-centers/${CONTROL_CENTER}/geofence`, { token: adminToken });
  console.log("Geocerca anterior:", JSON.stringify({
    type: previous.control_center?.boundary_geojson?.type || null,
    center: [previous.control_center?.map_center_lat, previous.control_center?.map_center_lon],
    buffer_meters: previous.control_center?.geofence_buffer_meters,
    zoom: previous.control_center?.map_zoom
  }));

  const outside = WORK_AREAS.filter(area => !pointInRing(area.longitude, area.latitude, BOUNDARY.coordinates[0]));
  if (outside.length) throw new Error(`El polígono propuesto no contiene: ${outside.map(area => area.name).join(", ")}`);

  const updated = await request(`/admin/control-centers/${CONTROL_CENTER}/geofence`, {
    method: "POST",
    token: adminToken,
    body: {
      boundary_geojson: BOUNDARY,
      geofence_buffer_meters: 200,
      map_center_lat: -19.8850,
      map_center_lon: -43.6700,
      map_zoom: 14
    }
  });
  if (String(updated.control_center?.code || "").toUpperCase() !== CONTROL_CENTER) {
    throw new Error("La API no confirmó el Centro de Control esperado");
  }

  const confirmed = await request(`/admin/control-centers/${CONTROL_CENTER}/geofence`, { token: adminToken });
  const confirmedBoundary = confirmed.control_center?.boundary_geojson;
  if (!confirmedBoundary || confirmedBoundary.type !== "Polygon") {
    throw new Error("La lectura posterior no devolvió el Polygon guardado");
  }

  const users = await request(`/admin/users?control_center_code=${CONTROL_CENTER}&limit=500`, { token: adminToken });
  const worker = (users.users || []).find(user => user.phone === TEST_WORKER_PHONE && user.role === "NEIGHBOR");
  if (!worker) throw new Error(`No existe el trabajador de prueba ${TEST_WORKER_PHONE}`);

  const workerLogin = await loginWorker(TEST_WORKER_PHONE);
  const workerToken = tokenFrom(workerLogin);
  if (!workerToken) throw new Error("El login del trabajador no devolvió token");

  const testArea = WORK_AREAS[0];
  const sos = await request("/public/mobile/sos", {
    method: "POST",
    token: workerToken,
    body: {
      user_id: worker.id,
      name: worker.full_name,
      phone: worker.phone,
      latitude: testArea.latitude,
      longitude: testArea.longitude,
      accuracy: 8,
      battery: 90,
      source: "QUELTU_GEOFENCE_QA",
      alert_type: "NEAR_MISS",
      title: `[QA GEOFENCE] ${new Date().toISOString()}`,
      priority: 2,
      description: "Prueba automática de aceptación territorial; el evento será cancelado inmediatamente.",
      control_center_code: CONTROL_CENTER
    }
  });
  if (!sos.event_id) throw new Error("La prueba SOS fue aceptada sin devolver event_id");

  const cancelled = await request("/public/mobile/cancel", {
    method: "POST",
    token: workerToken,
    body: { event_id: sos.event_id, user_id: worker.id }
  });
  if (cancelled.state !== "CANCELLED") throw new Error("El evento QA no pudo cancelarse");

  console.log("\nGEOCERCA JAGUAR CORREGIDA");
  console.log(JSON.stringify({
    control_center: CONTROL_CENTER,
    boundary_type: confirmedBoundary.type,
    boundary_bounds: boundsOf(confirmedBoundary),
    map_center: {
      latitude: Number(confirmed.control_center.map_center_lat),
      longitude: Number(confirmed.control_center.map_center_lon),
      zoom: Number(confirmed.control_center.map_zoom)
    },
    buffer_meters: Number(confirmed.control_center.geofence_buffer_meters),
    work_areas_inside: WORK_AREAS.map(area => area.name),
    worker_sos_test: {
      accepted: sos.status === "ok",
      event_id: sos.event_id,
      ticket_id: sos.ticket_id || null,
      incident_linked: sos.incident_linked === true,
      cancelled: cancelled.state === "CANCELLED"
    }
  }, null, 2));
}

main().catch(error => {
  console.error(`CORRECCIÓN ABORTADA: ${error.message}`);
  process.exitCode = 1;
});
