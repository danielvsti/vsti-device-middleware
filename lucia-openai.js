const DEFAULT_MODEL = "gpt-5.6-luna";
const DEFAULT_TIMEOUT_MS = 12000;

const SUPPORTED_INTENTS = Object.freeze([
  "guided_help",
  "patrol_recommendation",
  "ambiguous_severity",
  "high_priority_tickets",
  "sirens_summary",
  "platform_inventory",
  "resolver_rejections",
  "resolver_performance",
  "unassigned_tickets",
  "tickets_by_alert_type",
  "open_tickets",
  "vif_summary",
  "sla_risks",
  "critical_zones",
  "ticket_types",
  "executive_summary",
  "unknown"
]);

function openAiLuciaConfig() {
  return {
    configured: Boolean(String(process.env.OPENAI_API_KEY || "").trim()),
    model: String(process.env.OPENAI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    timeoutMs: Math.max(3000, Math.min(30000, Number(process.env.OPENAI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)))
  };
}

function redactLuciaText(value) {
  return String(value || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL_PROTEGIDO]")
    .replace(/\+?56\s*9(?:[\s.-]*\d){8}\b/g, "[TELEFONO_PROTEGIDO]")
    .replace(/\b\d{1,2}(?:\.\d{3}){2}-[0-9Kk]\b/g, "[RUT_PROTEGIDO]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[ID_PROTEGIDO]")
    .replace(/\b-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}\b/g, "[COORDENADA_PROTEGIDA]")
    .slice(0, 1200);
}

function sanitizeConversation(conversation) {
  if (!Array.isArray(conversation)) return [];
  return conversation
    .slice(-6)
    .map((turn) => ({
      role: turn?.role === "assistant" ? "assistant" : "user",
      content: redactLuciaText(turn?.content).slice(0, 600)
    }))
    .filter((turn) => turn.content.length >= 2);
}

function replaceAllLiteral(text, search, replacement) {
  if (!search || search.length < 3) return text;
  return String(text).split(search).join(replacement);
}

function buildPiiVault(rows) {
  const sensitiveKey = /(nombre|name|resolutor|resolver|vecino|citizen|telefono|phone|direccion|address|email|rut|ticket|\bid\b|latitude|longitude)/i;
  const values = [];
  for (const row of Array.isArray(rows) ? rows.slice(0, 50) : []) {
    for (const [key, raw] of Object.entries(row || {})) {
      if (!sensitiveKey.test(key) || raw == null) continue;
      const value = String(raw).trim();
      if (value.length >= 3 && value.length <= 240 && !values.includes(value)) values.push(value);
    }
  }
  return values.sort((a, b) => b.length - a.length).map((value, index) => ({
    token: `[DATO_PROTEGIDO_${index + 1}]`,
    value
  }));
}

function protectWithVault(value, vault) {
  let protectedText = String(value || "");
  for (const item of vault || []) protectedText = replaceAllLiteral(protectedText, item.value, item.token);
  return redactLuciaText(protectedText);
}

function restoreFromVault(value, vault) {
  let restored = String(value || "");
  for (const item of vault || []) restored = replaceAllLiteral(restored, item.token, item.value);
  return restored;
}

function responseOutputText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text.trim();
  const parts = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === "output_text" && typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

async function callOpenAiResponses({ input, text, maxOutputTokens = 400 }) {
  const config = openAiLuciaConfig();
  if (!config.configured) return { ok: false, reason: "not_configured", model: config.model, latency_ms: 0 };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.model,
        store: false,
        input,
        max_output_tokens: maxOutputTokens,
        ...(text ? { text } : {})
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      return { ok: false, reason: `http_${response.status}`, model: config.model, latency_ms: Date.now() - startedAt };
    }
    const payload = await response.json();
    const outputText = responseOutputText(payload);
    if (!outputText) return { ok: false, reason: "empty_response", model: config.model, latency_ms: Date.now() - startedAt };
    return { ok: true, text: outputText, model: config.model, latency_ms: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === "AbortError" ? "timeout" : "request_failed",
      model: config.model,
      latency_ms: Date.now() - startedAt
    };
  } finally {
    clearTimeout(timer);
  }
}

const INTERPRETATION_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    intent: { type: "string", enum: SUPPORTED_INTENTS },
    canonical_question: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    needs_clarification: { type: "boolean" },
    clarification_question: { type: "string" }
  },
  required: ["intent", "canonical_question", "confidence", "needs_clarification", "clarification_question"],
  additionalProperties: false
});

async function interpretLuciaQuestion({ question, conversation = [] }) {
  const safeQuestion = redactLuciaText(question);
  const safeConversation = sanitizeConversation(conversation);
  const result = await callOpenAiResponses({
    input: [
      {
        role: "developer",
        content: [
          "Eres la capa de comprensión de Lucía, copiloto municipal de QUELTU Ciudad.",
          "No consultas bases de datos, no inventas cifras, no generas SQL y no ejecutas acciones.",
          `Solo puedes clasificar en estas intenciones: ${SUPPORTED_INTENTS.join(", ")}.`,
          "Reescribe la solicitud como una pregunta operacional autosuficiente en español, conservando período, categoría, horario y cantidad de patrullas.",
          "Usa el contexto previo solo para resolver referencias como 'ahora', 'lo mismo' o 'y para 90 días'.",
          "Si falta un dato indispensable o la solicitud no corresponde al catálogo, marca needs_clarification=true."
        ].join("\n")
      },
      ...safeConversation,
      { role: "user", content: safeQuestion }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "lucia_safe_intent",
        strict: true,
        schema: INTERPRETATION_SCHEMA
      }
    },
    maxOutputTokens: 300
  });
  if (!result.ok) return result;
  try {
    const parsed = JSON.parse(result.text);
    if (!SUPPORTED_INTENTS.includes(parsed.intent)) return { ...result, ok: false, reason: "unsupported_intent" };
    return { ...result, interpretation: parsed };
  } catch (_) {
    return { ...result, ok: false, reason: "invalid_json" };
  }
}

function safePatrolEvidence(plan) {
  if (!plan) return null;
  return {
    sample_events: Number(plan.sample_events || 0),
    period_days: Number(plan.period_days || 0),
    time_window: plan.time_window ? { label: plan.time_window.label, hours: plan.time_window.hours } : null,
    overall_confidence: plan.overall_confidence ? {
      label: plan.overall_confidence.label,
      note: plan.overall_confidence.note
    } : null,
    recommendation_count: Array.isArray(plan.recommendations) ? plan.recommendations.length : 0,
    recommendations: (plan.recommendations || []).slice(0, 5).map((item) => ({
      rank: item.rank,
      sector: item.sector,
      score: item.score,
      confidence: item.confidence?.label,
      critical_hours: item.critical_hours,
      effective_events: item.effective_events
    })),
    route_count: Array.isArray(plan.routes) ? plan.routes.length : 0,
    available_resolver_count: Number(plan.available_resolvers_used || 0)
  };
}

async function conversationalizeLuciaAnswer({ question, answer, intent, rows = [], patrolPlan = null, conversation = [] }) {
  const vault = buildPiiVault(rows);
  const safeQuestion = protectWithVault(question, vault);
  const safeAnswer = protectWithVault(answer, vault);
  const safeConversation = sanitizeConversation(conversation).map((turn) => ({
    ...turn,
    content: protectWithVault(turn.content, vault)
  }));
  const evidence = {
    intent,
    deterministic_answer: safeAnswer,
    row_count: Array.isArray(rows) ? rows.length : 0,
    patrol_plan: safePatrolEvidence(patrolPlan)
  };
  const result = await callOpenAiResponses({
    input: [
      {
        role: "developer",
        content: [
          "Eres Lucía, copiloto operacional de seguridad municipal de QUELTU Ciudad.",
          "Responde en español claro, cálido, ejecutivo y conversacional, en máximo 120 palabras.",
          "La evidencia entregada por QUELTU es la única fuente de verdad: conserva exactamente sus cifras y no agregues hechos.",
          "No hagas predicción criminológica, no presentes correlaciones como causalidad y no prometas despacho automático.",
          "No reveles ni modifiques marcadores [DATO_PROTEGIDO_N].",
          "Si hay un plan preventivo, recalca que es una recomendación explicable sujeta a validación del operador.",
          "No menciones OpenAI ni detalles técnicos salvo que el usuario lo pregunte."
        ].join("\n")
      },
      ...safeConversation,
      {
        role: "user",
        content: `Pregunta actual: ${safeQuestion}\nEvidencia calculada por QUELTU:\n${JSON.stringify(evidence)}`
      }
    ],
    maxOutputTokens: 420
  });
  if (!result.ok) return result;
  return { ...result, text: restoreFromVault(result.text, vault) };
}

module.exports = {
  SUPPORTED_INTENTS,
  openAiLuciaConfig,
  redactLuciaText,
  sanitizeConversation,
  interpretLuciaQuestion,
  conversationalizeLuciaAnswer,
  responseOutputText
};
