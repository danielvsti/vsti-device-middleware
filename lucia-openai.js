// Lucía usa OpenAI solo para comprensión y redacción conversacional. El análisis,
// las cifras y los planes continúan en el motor determinista QUELTU. Este modelo
// tiene amplia disponibilidad y soporta Responses + Structured Outputs.
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 12000;

const SUPPORTED_INTENTS = Object.freeze([
  "guided_help",
  "patrol_recommendation",
  "period_comparison",
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
    .slice(-12)
    .map((turn) => ({
      role: turn?.role === "assistant" ? "assistant" : "user",
      content: redactLuciaText(turn?.content).slice(0, 600)
    }))
    .filter((turn) => turn.content.length >= 2);
}

const LUCIA_TIME_WINDOWS = Object.freeze(["ALL", "MADRUGADA", "MANANA", "TARDE", "NOCHE"]);
const LUCIA_ALERT_TYPES = Object.freeze(["FIRE", "MEDICAL", "VIF", "SECURITY", "FALL_DETECTED", "SOS_MANUAL", "RISK", "OTHER"]);

function sanitizeDialogueState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const intent = SUPPORTED_INTENTS.includes(state.intent) ? state.intent : null;
  if (!intent || intent === "unknown") return null;
  const periodDays = state.period_days == null || state.period_days === "" ? NaN : Number(state.period_days);
  const patrolUnits = state.patrol_units == null || state.patrol_units === "" ? NaN : Number(state.patrol_units);
  const timeWindow = LUCIA_TIME_WINDOWS.includes(state.time_window) ? state.time_window : "ALL";
  const alertType = LUCIA_ALERT_TYPES.includes(state.alert_type) ? state.alert_type : null;
  return {
    version: 1,
    intent,
    canonical_question: redactLuciaText(state.canonical_question).slice(0, 500),
    period_days: Number.isFinite(periodDays) ? Math.max(1, Math.min(365, Math.round(periodDays))) : 30,
    patrol_units: Number.isFinite(patrolUnits) ? Math.max(1, Math.min(10, Math.round(patrolUnits))) : null,
    time_window: timeWindow,
    alert_type: alertType,
    requested_detail: ["answer", "explain", "compare", "list", "plan"].includes(state.requested_detail)
      ? state.requested_detail
      : "answer"
  };
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

function safeOpenAiErrorPart(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

async function openAiHttpFailure(response, config, startedAt) {
  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    payload = null;
  }
  const error = payload?.error || {};
  const details = [error.code, error.type, error.param]
    .map(safeOpenAiErrorPart)
    .filter(Boolean);
  const reason = [`http_${response.status}`, ...new Set(details)].join("_");
  console.warn("[LUCIA OPENAI FALLBACK]", {
    status: response.status,
    reason,
    model: config.model
  });
  return {
    ok: false,
    reason,
    model: config.model,
    latency_ms: Date.now() - startedAt
  };
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
      return openAiHttpFailure(response, config, startedAt);
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
    clarification_question: { type: "string" },
    period_days: { type: ["integer", "null"], minimum: 1, maximum: 365 },
    patrol_units: { type: ["integer", "null"], minimum: 1, maximum: 10 },
    time_window: { type: ["string", "null"], enum: [...LUCIA_TIME_WINDOWS, null] },
    alert_type: { type: ["string", "null"], enum: [...LUCIA_ALERT_TYPES, null] },
    requested_detail: { type: "string", enum: ["answer", "explain", "compare", "list", "plan"] },
    followup: { type: "boolean" }
  },
  required: [
    "intent", "canonical_question", "confidence", "needs_clarification", "clarification_question",
    "period_days", "patrol_units", "time_window", "alert_type", "requested_detail", "followup"
  ],
  additionalProperties: false
});

async function interpretLuciaQuestion({ question, conversation = [], dialogueState = null }) {
  const safeQuestion = redactLuciaText(question);
  const safeConversation = sanitizeConversation(conversation);
  const safeDialogueState = sanitizeDialogueState(dialogueState);
  const result = await callOpenAiResponses({
    input: [
      {
        role: "developer",
        content: [
          "Eres la capa de comprensión de Lucía, copiloto municipal de QUELTU Ciudad.",
          "No consultas bases de datos, no inventas cifras, no generas SQL y no ejecutas acciones.",
          `Solo puedes clasificar en estas intenciones: ${SUPPORTED_INTENTS.join(", ")}.`,
          "Interpreta lenguaje natural, abreviaciones, elipsis y referencias conversacionales como 'eso', 'lo mismo', 'compáralo', 'por qué' o 'y de noche'.",
          "Reescribe siempre la solicitud como una pregunta operacional autosuficiente en español, conservando o heredando período, categoría, horario y cantidad de patrullas.",
          "Para comparar el período consultado con el período inmediatamente anterior usa period_comparison.",
          "requested_detail=explain significa explicar el resultado con evidencia; compare significa comparar; list significa listar registros; plan significa proponer cobertura preventiva.",
          "Usa el estado estructurado y el historial solo para resolver el contexto; nunca copies cifras de respuestas previas como hechos nuevos.",
          "Pregunta una aclaración solamente cuando sea imprescindible para seleccionar una consulta segura; no pidas datos que ya estén en el estado.",
          `Estado estructurado anterior: ${JSON.stringify(safeDialogueState || {})}`
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

async function conversationalizeLuciaAnswer({ question, answer, intent, rows = [], patrolPlan = null, conversation = [], requestedDetail = "answer" }) {
  const vault = buildPiiVault(rows);
  const safeQuestion = protectWithVault(question, vault);
  const safeAnswer = protectWithVault(answer, vault);
  const safeConversation = sanitizeConversation(conversation).map((turn) => ({
    ...turn,
    content: protectWithVault(turn.content, vault)
  }));
  const evidence = {
    intent,
    requested_detail: requestedDetail,
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
          "Conserva también el sujeto, período y denominador de cada cifra; no unas métricas que la evidencia presenta por separado.",
          "No uses Markdown ni asteriscos: entrega texto plano con párrafos o líneas breves.",
          "No hagas predicción criminológica, no presentes correlaciones como causalidad y no prometas despacho automático.",
          "No reveles ni modifiques marcadores [DATO_PROTEGIDO_N].",
          "Si hay un plan preventivo, recalca que es una recomendación explicable sujeta a validación del operador.",
          "No menciones OpenAI ni detalles técnicos salvo que el usuario lo pregunte.",
          "Responde directamente a la pregunta actual y reconoce el hilo anterior cuando sea un seguimiento.",
          "Cuando sea útil, termina con una invitación breve y contextual para profundizar, comparar o cambiar el período; no repitas una pregunta ya respondida."
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
  sanitizeDialogueState,
  interpretLuciaQuestion,
  conversationalizeLuciaAnswer,
  responseOutputText
};
