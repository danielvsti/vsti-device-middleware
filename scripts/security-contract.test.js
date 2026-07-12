const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function routeBlock(signature, size = 900) {
  const index = server.indexOf(signature);
  assert(index >= 0, `No se encontró ${signature}`);
  return server.slice(index, index + size);
}

assert(!server.includes("SOS_SESSION_DEV_SECRET"), "No debe existir el secreto de sesión histórico");
assert(!server.includes("VSTI_MIDDLEWARE_2026_Q7xF92Lp_4MNd8Rk_91AB"), "No debe existir el token histórico de dispositivos");
assert(server.includes("OTP_PROVIDER"), "Debe existir configuración de proveedor OTP");
assert(server.includes("TWILIO_VERIFY_SERVICE_SID"), "Debe existir integración Twilio Verify");
assert(server.includes('selectedChannel === "demo" && OTP_DEMO_MODE && OTP_EXPOSE_DEMO_CODE'), "El código demo solo debe exponerse para desafíos demo");
assert(server.includes("CORS_ALLOWED_ORIGINS"), "Debe existir allowlist CORS");
assert(server.includes("SOS_PUBLIC_ORIGINS.includes(normalizedOrigin)"), "CORS debe permitir el origen propio del formulario GPS público");
assert(server.includes('isPublicLocationSubmission && origin === "null"'), "CORS debe aceptar Origin null solamente en el POST GPS firmado de WhatsApp iOS");
assert(server.includes('/^\\/public\\/location-request\\/[^/]+\\/position$/'), "La excepción Origin null debe quedar limitada a la ruta GPS pública");
assert(server.includes('"Cache-Control"'), "CORS debe permitir Cache-Control usado por paneles web");

for (const signature of [
  'app.get("/debug/users"',
  'app.post("/debug/set-role"',
  'app.get("/debug/db"'
]) {
  assert(routeBlock(signature).includes("requireDebugAccess"), `${signature} debe exigir acceso debug`);
}

for (const signature of [
  'app.post("/public/sirens/activate"',
  'app.post("/public/sirens/deactivate"',
  'app.post("/public/mobile/ack"',
  'app.get("/settings/emergency-categories"',
  'app.post("/tickets/manual"',
  'app.post("/tickets/:id/location-request"'
]) {
  assert(routeBlock(signature).includes("checkRoleAccess"), `${signature} debe exigir rol operacional`);
}

for (const signature of [
  'app.post("/public/mobile/sos"',
  'app.post("/resolver/location"',
  'app.get("/resolver/:user_id/state"'
]) {
  assert(routeBlock(signature).includes("checkIdentityAccess"), `${signature} debe validar identidad`);
}

for (const signature of [
  'app.get("/tickets/:id"',
  'app.post("/tickets/:id/messages"',
  'app.post("/tickets/:id/media"'
]) {
  assert(routeBlock(signature).includes("checkTicketParticipantAccess"), `${signature} debe validar pertenencia al ticket`);
}

const panelLoginSql = routeBlock('app.post("/auth/panel-login"', 2200);
assert(!panelLoginSql.includes("source_event."), "El login de panel no debe referenciar tablas de eventos sin JOIN");

const ticketDetailSql = routeBlock('app.get("/tickets/:id"', 4200);
assert(ticketDetailSql.includes("LEFT JOIN mobile_events source_event"), "El detalle del ticket debe enlazar el evento móvil");
assert(ticketDetailSql.includes("LEFT JOIN municipal_qr_points qr_point"), "El detalle del ticket debe enlazar la atribución QR");
assert(routeBlock('app.get("/tickets/:id"', 9000).includes("location_requests"), "El detalle del ticket debe incluir trazabilidad de solicitudes GPS");
assert(routeBlock('app.get("/tickets/:id"', 9000).includes("destination_phone AS recipient"), "La auditoría GPS debe usar las columnas reales del esquema");
const resolverLocationSql = routeBlock('app.post("/resolver/location"', 6200);
assert(resolverLocationSql.includes("const rawLonNum = Number(longitude)"), "La ruta GPS del resolutor debe declarar la longitud recibida");
assert(resolverLocationSql.includes("LONGITUDE_HEMISPHERE_SIGN"), "La ruta GPS del resolutor debe defenderse de hemisferio invertido");

const mobileSosSql = routeBlock('app.post("/public/mobile/sos"', 2600);
assert(!mobileSosSql.includes("rawLonNum"), "La corrección del simulador no debe contaminar la creación de SOS vecino");

const manualTicketSql = routeBlock('app.post("/tickets/manual"', 9000);
assert(manualTicketSql.includes('source_type: "PHONE_CALL"'), "El ingreso telefónico debe usar una fuente de ticket diferenciada");
assert(manualTicketSql.includes("wa_center_session_id"), "El ticket telefónico debe permitir asociar la sesión de WA-Center");

const waWebhookSql = routeBlock('app.post("/integrations/wa-center/voice-events"', 6200);
assert(waWebhookSql.includes("provider_event_id"), "El webhook de WA-Center debe deduplicar eventos del proveedor");
assert(waWebhookSql.includes("wa_center_call_id"), "El webhook de WA-Center debe correlacionar llamadas municipales externas");

const locationRequestSql = routeBlock('app.post("/tickets/:id/location-request"', 5200);
assert(locationRequestSql.includes("crypto.randomBytes(32)"), "El enlace GPS debe usar un token criptográficamente aleatorio");
assert(locationRequestSql.includes("token_hash"), "El token GPS debe almacenarse únicamente como hash");
const publicLocationPage = routeBlock('app.get("/public/location-request/:token"', 7000);
assert(publicLocationPage.includes('geolocation=(self)'), "La página GPS pública debe habilitar geolocalización del mismo origen");
assert(publicLocationPage.includes('method="post"'), "La página GPS debe enviar mediante formulario HTML nativo compatible con Safari");
assert(publicLocationPage.includes("form.submit()"), "La página GPS debe evitar transportes JavaScript incompatibles con WhatsApp iOS");
assert(!publicLocationPage.includes("fetch("), "La página GPS no debe depender de fetch en el navegador embebido");
assert(!publicLocationPage.includes("new XMLHttpRequest()"), "La página GPS no debe depender de XMLHttpRequest en el navegador embebido");
const dashboardMapState = routeBlock('app.get("/dashboard/map-state"', 1800);
assert(dashboardMapState.includes('Cache-Control'), "El estado del mapa operacional no debe quedar almacenado en caché");
const locationSubmitSql = routeBlock('app.post("/public/location-request/:token/position"', 5200);
assert(locationSubmitSql.includes("status='COMPLETED'"), "El enlace GPS debe quedar consumido después de utilizarse");
assert(locationSubmitSql.includes("LOCATION_SHARED"), "La ubicación compartida debe dejar trazabilidad operacional");
assert(locationSubmitSql.includes("absoluteAccuracyLimit"), "El GPS telefónico debe conservar ubicación aproximada con advertencia antes de descartarla");

console.log("Security contract OK");
