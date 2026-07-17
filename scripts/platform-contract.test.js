const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function occurrences(value, needle) {
  return value.split(needle).length - 1;
}

function requireSingleRoute(signature) {
  const count = occurrences(server, signature);
  assert(count === 1, `${signature} debe existir exactamente una vez; encontradas: ${count}`);
}

for (const signature of [
  "app.post(\"/auth/mobile/refresh\"",
  "app.post(\"/mobile/push/register\"",
  "app.post(\"/mobile/push/unregister\"",
  "app.get(\"/settings/emergency-categories\"",
  "app.post(\"/tickets/:id/location-request\"",
  "app.get(\"/public/location-request/:token\"",
  "app.post(\"/public/location-request/:token/position\"",
  "app.post(\"/integrations/wa-center/voice-events\"",
  "app.get('/superadmin/control-centers/:code/communications-license'",
  "app.put('/superadmin/control-centers/:code/communications-license'",
  "app.get('/admin/control-centers/:code/announcements'",
  "app.post('/admin/control-centers/:code/announcements'",
  "app.patch('/admin/control-centers/:code/announcements/:id'",
  "app.get('/neighbor/announcements'",
  "app.post('/neighbor/announcements/:id/read'",
  "app.get('/public/announcement-video/:provider/:videoId'",
  "app.get(\"/admin/control-centers/:code/devices\"",
  "app.post(\"/admin/control-centers/:code/devices\"",
  "app.post(\"/admin/control-centers/:code/devices/:id/active\"",
  "app.delete(\"/admin/control-centers/:code/devices/:id\""
]) {
  requireSingleRoute(signature);
}

for (const expected of [
  "mobile_refresh_sessions",
  "mobile_push_devices",
  "emergency_category_catalog",
  "municipal_announcements",
  "municipal_announcement_reads",
  "ticket_voice_sessions",
  "ticket_voice_events"
]) {
  assert(server.includes(expected), `El backend debe conservar ${expected}`);
}

assert(
  server.includes('allowedHeaders: ["Content-Type", "Authorization", "Cache-Control"'),
  "CORS debe aceptar Cache-Control usado por los paneles"
);
for (const origin of [
  "capacitor://localhost",
  "ionic://localhost",
  "http://localhost",
  "https://localhost"
]) {
  assert(server.includes(`"${origin}"`), `CORS debe conservar el origen nativo ${origin}`);
}

assert(
  server.includes('process.env.SOS_PUBLIC_BASE_URL || "https://api.queltu.com"'),
  "La API pública canónica debe ser api.queltu.com"
);
assert(
  server.includes("process.env.SOS_PWA_BASE_URL || 'https://app.queltu.com'"),
  "Los QR deben usar app.queltu.com por defecto"
);
assert(
  server.includes("WA_CENTER_CALLBACK_URL_OVERRIDE"),
  "Debe conservarse la política de callback global de WA-Center"
);
assert(
  server.includes("record: platformSettings.voice_policy?.recording_enabled !== false"),
  "La solicitud de voz debe enviar la política de grabación por sesión"
);

for (const migration of [
  "db/migrations/20260709_emergency_category_catalog.sql",
  "db/migrations/20260712_municipal_communications.sql"
]) {
  const fullPath = path.join(root, migration);
  assert(fs.existsSync(fullPath), `Falta la migración ${migration}`);
  assert(fs.readFileSync(fullPath, "utf8").includes("CREATE TABLE IF NOT EXISTS"), `${migration} debe ser idempotente`);
}

assert(
  packageJson.scripts?.test?.includes("platform-contract.test.js"),
  "npm test debe ejecutar el contrato de plataforma"
);

console.log("Platform contract OK");
