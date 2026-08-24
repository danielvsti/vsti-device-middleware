const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const server = fs.readFileSync(path.resolve(__dirname, "..", "server.js"), "utf8");

function sourceBetween(start, end) {
  const from = server.indexOf(start);
  const to = server.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `No se pudo extraer ${start}`);
  return server.slice(from, to);
}

const sandbox = {};
vm.runInNewContext([
  sourceBetween("function normalizeLuciaText", "function luciaPeriodDays"),
  sourceBetween("function luciaLevel2Requested", "const LUCIA_PDF_DIR"),
  sourceBetween("function luciaRequestedAlertType", "function luciaGuidedSuggestions"),
  sourceBetween("function luciaIntent", "function luciaBuildSafeQuery"),
  sourceBetween("function validateLuciaSql", "async function runLuciaReadOnly"),
  "this.luciaIntent = luciaIntent; this.validateLuciaSql = validateLuciaSql;"
].join("\n"), sandbox);

assert.equal(
  sandbox.luciaIntent("Dame un resumen ejecutivo de los últimos 30 días y señala la prioridad principal."),
  "executive_summary",
  "La palabra principal no debe coincidir con la abreviatura INC"
);
assert.equal(
  sandbox.luciaIntent("Muéstrame los tickets INC de los últimos 30 días"),
  "tickets_by_alert_type",
  "La abreviatura INC aislada debe seguir siendo compatible"
);
assert.doesNotThrow(() => sandbox.validateLuciaSql(
  "SELECT 'Zonificación oficial; fallback por coordenada' AS metodo FROM tickets WHERE control_center_id = $1 LIMIT 1"
));
assert.throws(
  () => sandbox.validateLuciaSql("SELECT 1 FROM tickets WHERE control_center_id = $1 LIMIT 1; SELECT 2"),
  /múltiples sentencias/
);
assert.match(
  server,
  /safeToConversationalize = !\["unknown", "guided_help", "ambiguous_severity", "executive_summary"\]/,
  "Una consulta no comprendida no debe reusar cifras del historial conversacional"
);
assert.match(
  server,
  /OPENAI_INTERPRETATION/,
  "El uso de OpenAI para comprender un seguimiento debe distinguirse de la redacción generativa"
);

console.log("Lucía routing regression OK");
