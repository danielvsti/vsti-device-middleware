const crypto = require("crypto");

const required = [
  "WA_CENTER_WEBHOOK_SECRET",
  "PANEL_TOKEN",
  "TICKET_ID",
  "WA_CENTER_SESSION_ID",
  "RECORDING_URL"
];

for (const name of required) {
  if (!process.env[name]) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(2);
  }
}

const baseUrl = String(process.env.SOS_BASE_URL || "https://sos.vsti.cl").replace(/\/+$/, "");
const ticketId = process.env.TICKET_ID;
const recordingUrl = process.env.RECORDING_URL;

async function main() {
  const webhookResponse = await fetch(`${baseUrl}/integrations/wa-center/voice-events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-WA-Center-Webhook-Secret": process.env.WA_CENTER_WEBHOOK_SECRET
    },
    body: JSON.stringify({
      event_id: `codex-recording-test-${crypto.randomUUID()}`,
      event: "RECORDING_AVAILABLE",
      session_id: process.env.WA_CENTER_SESSION_ID,
      external_reference: `sos-ticket-${ticketId}`,
      duration_seconds: Number(process.env.DURATION_SECONDS || 12),
      recording_id: process.env.RECORDING_ID || `test-recording-${Date.now()}`,
      recording_url: recordingUrl
    })
  });
  const webhookBody = await webhookResponse.json().catch(() => ({}));
  if (!webhookResponse.ok) throw new Error(`Webhook HTTP ${webhookResponse.status}: ${webhookBody.message || "unknown error"}`);
  if (!webhookBody.matched) throw new Error("WA-Center session was not correlated with the ticket");

  const detailResponse = await fetch(`${baseUrl}/tickets/${encodeURIComponent(ticketId)}`, {
    headers: { Authorization: `Bearer ${process.env.PANEL_TOKEN}` }
  });
  const detail = await detailResponse.json().catch(() => ({}));
  if (!detailResponse.ok) throw new Error(`Ticket detail HTTP ${detailResponse.status}: ${detail.message || "unknown error"}`);

  const stored = (detail.voice_sessions || []).find((session) => session.recording_url === recordingUrl);
  if (!stored) throw new Error("Recording URL was not persisted in ticket_voice_sessions");

  console.log(JSON.stringify({
    status: "ok",
    ticket_id: ticketId,
    voice_session_id: stored.id,
    wa_center_session_id: stored.wa_center_session_id,
    recording_url: stored.recording_url,
    duration_seconds: stored.duration_seconds
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
