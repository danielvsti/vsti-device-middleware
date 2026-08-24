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
  sourceBetween("function luciaPeriodDays", "function luciaLevel2Requested"),
  sourceBetween("function luciaLevel2Requested", "const LUCIA_PDF_DIR"),
  sourceBetween("function luciaRequestedAlertType", "function luciaGuidedSuggestions"),
  sourceBetween("function luciaIntent", "function luciaBuildSafeQuery"),
  sourceBetween("function validateLuciaSql", "async function runLuciaReadOnly"),
  "this.luciaIntent = luciaIntent; this.luciaResolveContextualFollowup = luciaResolveContextualFollowup; this.validateLuciaSql = validateLuciaSql;"
].join("\n"), sandbox);

assert.equal(
  sandbox.luciaIntent("Dame un resumen ejecutivo de los últimos 30 días y señala la prioridad principal."),
  "executive_summary",
  "La palabra principal no debe coincidir con la abreviatura INC"
);
assert.equal(
  sandbox.luciaResolveContextualFollowup(
    "Haz lo mismo, pero de noche y amplíalo a 90 días.",
    [
      { role: "user", content: "Sugiere un plan de patrullaje preventivo con 2 patrullas para los últimos 30 días." },
      { role: "assistant", content: "Plan preventivo calculado." }
    ]
  ),
  "Sugiere un plan de patrullaje preventivo noche con 2 patrullas usando los últimos 90 días"
);
assert.equal(
  sandbox.luciaResolveContextualFollowup(
    "Ahora repítelo para 90 días.",
    [{ role: "user", content: "Dame un resumen ejecutivo de los últimos 30 días." }]
  ),
  "Dame un resumen ejecutivo de los últimos 90 días"
);
assert.equal(
  sandbox.luciaIntent("Muéstrame los tickets INC de los últimos 30 días"),
  "tickets_by_alert_type",
  "La abreviatura INC aislada debe seguir siendo compatible"
);
assert.equal(
  sandbox.luciaIntent("Compáralo con el período anterior"),
  "period_comparison",
  "Lucía debe reconocer comparaciones conversacionales como una consulta segura"
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
assert.match(server, /dialogue_state: nextDialogueState/, "El backend debe devolver memoria conversacional estructurada");
assert.match(server, /structured_context: Boolean\(dialogueState\)/, "El backend debe auditar el uso de contexto estructurado");
assert.match(
  server,
  /OPENAI_INTERPRETATION/,
  "El uso de OpenAI para comprender un seguimiento debe distinguirse de la redacción generativa"
);

console.log("Lucía routing regression OK");
