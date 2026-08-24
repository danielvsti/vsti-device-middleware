const assert = require("node:assert/strict");

process.env.OPENAI_API_KEY = "test-key-not-real";
process.env.OPENAI_MODEL = "gpt-5.6-luna";
process.env.OPENAI_TIMEOUT_MS = "3000";

const {
  redactLuciaText,
  sanitizeConversation,
  interpretLuciaQuestion,
  conversationalizeLuciaAnswer
} = require("../lucia-openai");

assert.equal(redactLuciaText("Llame al +56912345678"), "Llame al [TELEFONO_PROTEGIDO]");
assert.equal(redactLuciaText("ID 43627a79-bddb-4ed6-87ef-335dc7c26424"), "ID [ID_PROTEGIDO]");
assert.equal(sanitizeConversation(new Array(9).fill({ role: "user", content: "consulta" })).length, 6);

let capturedBody = null;
global.fetch = async (_url, options) => {
  capturedBody = JSON.parse(options.body);
  return {
    ok: true,
    json: async () => ({
      output: [{
        content: [{
          type: "output_text",
          text: JSON.stringify({
            intent: "patrol_recommendation",
            canonical_question: "Sugiere un plan de patrullaje nocturno con 2 patrullas usando los últimos 90 días",
            confidence: 0.96,
            needs_clarification: false,
            clarification_question: ""
          })
        }]
      }]
    })
  };
};

(async () => {
  const interpreted = await interpretLuciaQuestion({
    question: "Haz lo mismo pero para la noche y 90 días",
    conversation: [{ role: "user", content: "Dame un plan con dos patrullas" }]
  });
  assert.equal(interpreted.ok, true);
  assert.equal(interpreted.interpretation.intent, "patrol_recommendation");
  assert.equal(capturedBody.store, false, "Las respuestas no deben persistirse como estado de aplicación");
  assert.equal(capturedBody.model, "gpt-5.6-luna");
  assert.equal(capturedBody.text.format.type, "json_schema");
  assert.equal(Object.hasOwn(capturedBody, "tools"), false, "OpenAI no debe recibir herramientas ni acceso SQL");

  global.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    const serialized = JSON.stringify(capturedBody);
    assert.equal(serialized.includes("Claudio Alejandro"), false, "No se debe enviar el nombre del resolutor");
    assert.equal(serialized.includes("+56912345678"), false, "No se debe enviar el teléfono");
    const token = serialized.match(/\[DATO_PROTEGIDO_\d+\]/)?.[0];
    return {
      ok: true,
      json: async () => ({ output: [{ content: [{ type: "output_text", text: `El equipo ${token} lidera el período según QUELTU.` }] }] })
    };
  };

  const conversational = await conversationalizeLuciaAnswer({
    question: "¿Quién lidera?",
    answer: "Claudio Alejandro lidera con 12 casos.",
    intent: "resolver_performance",
    rows: [{ resolutor: "Claudio Alejandro", telefono: "+56912345678", tickets_cerrados: 12 }]
  });
  assert.equal(conversational.ok, true);
  assert.match(conversational.text, /Claudio Alejandro/);
  assert.equal(capturedBody.store, false);
  assert.equal(Object.hasOwn(capturedBody, "tools"), false);
  assert.match(
    capturedBody.input[0].content,
    /sujeto, período y denominador/,
    "La redacción debe conservar la relación semántica de cada cifra"
  );
  assert.match(capturedBody.input[0].content, /No uses Markdown/, "La respuesta visible debe ser texto plano");

  global.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({
      error: {
        code: "unsupported_parameter",
        type: "invalid_request_error",
        param: "text.format"
      }
    })
  });
  const failed = await conversationalizeLuciaAnswer({
    question: "Resume la operación",
    answer: "No hay tickets sin asignar.",
    intent: "unassigned_tickets",
    rows: []
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "http_400_unsupported_parameter_invalid_request_error_text_format");
  assert.equal(failed.reason.includes("test-key-not-real"), false, "El diagnóstico no debe exponer la API key");

  console.log("Lucía OpenAI hybrid contract OK");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
