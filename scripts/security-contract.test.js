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
  'app.post("/public/mobile/ack"'
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

console.log("Security contract OK");
