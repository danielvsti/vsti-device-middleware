# Contrato SOS Municipal ↔ WA-Center para llamadas y grabaciones

## 1. Creación de una llamada desde SOS

SOS invoca `POST {WA_CENTER_BASE_URL}/voice/sessions` con autenticación
`Authorization: Bearer {WA_CENTER_API_TOKEN}`.

```json
{
  "external_reference": "sos-ticket-<ticket_uuid>",
  "mode": "BRIDGE",
  "expires_in_seconds": 900,
  "record": true,
  "supervision": true,
  "participants": [
    { "role": "party_a", "type": "webrtc", "label": "vecino" },
    { "role": "party_b", "type": "webrtc", "label": "central" }
  ],
  "callback_url": "https://api.queltu.com/integrations/wa-center/voice-events"
}
```

WA-Center debe responder al menos `session_id`, `status` y las credenciales
WebRTC de cada participante.

## 2. Webhook de estados y grabación

WA-Center invoca el `callback_url` usando uno de estos mecanismos:

- `X-WA-Center-Webhook-Secret: {WA_CENTER_WEBHOOK_SECRET}`; o
- `Authorization: Bearer {WA_CENTER_WEBHOOK_SECRET}`.

Campos de correlación obligatorios:

- `event_id`: identificador único del webhook para reintentos idempotentes.
- `session_id`: identificador estable de la sesión en WA-Center.
- `external_reference`: referencia entregada por SOS, sin modificar.
- `event`: `SESSION_CREATED`, `RINGING`, `CONNECTED`, `ENDED`,
  `FAILED`, `NO_ANSWER`, `REJECTED`, `EXPIRED` o `RECORDING_AVAILABLE`.

Campos adicionales según el evento:

- `participant_role`: `party_a` o `party_b`.
- `duration_seconds`: duración total de la llamada.
- `failure_reason`: causa técnica cuando corresponda.
- `recording_id`: identificador estable de la grabación.
- `recording_url`: URL HTTPS reproducible por los paneles; también se acepta
  `{ "recording": { "id": "...", "url": "https://..." } }`.

Ejemplo final:

```json
{
  "event_id": "evt-recording-987",
  "event": "RECORDING_AVAILABLE",
  "session_id": "wa-session-123",
  "external_reference": "sos-ticket-550e8400-e29b-41d4-a716-446655440000",
  "duration_seconds": 184,
  "recording_id": "rec-987",
  "recording_url": "https://media.wa-center.vsti.cl/recordings/rec-987.mp3"
}
```

La URL debe ser estable o renovable. Si expira, WA-Center deberá proporcionar
un endpoint autenticado para obtener una URL firmada nueva; el reproductor no
debe depender de una URL que expire antes del período municipal de retención.

## 3. Llamada entrante al teléfono municipal

Para llamadas externas, WA-Center debe entregar a SOS:

- `session_id` y/o `call_id` (al menos uno, estable y único);
- `caller_phone` y `called_phone`;
- `started_at`, `answered_at`, `ended_at`;
- `duration_seconds`;
- `recording_id` y `recording_url` cuando estén disponibles;
- `external_reference` si fue asignada por SOS;
- estado y causa de término.

El operador crea el ticket mediante `POST /tickets/manual` con
`source_type = PHONE_CALL` generado por el backend. Puede incluir
`wa_center_session_id`, `wa_center_call_id`, `recording_url` y
`duration_seconds`. Los webhooks posteriores que reutilicen el mismo
`session_id` quedan vinculados al ticket y su grabación aparece en la ficha.

## 4. Reglas de seguridad

- Nunca enviar tokens o secretos dentro de URLs.
- Usar TLS/HTTPS y validar el secreto del webhook.
- No incluir credenciales WebRTC en reportes o respuestas de detalle.
- La grabación debe conservar trazabilidad, control de acceso y política de
  retención municipal.
- Reintentar webhooks conservando el mismo `event_id`; SOS descarta duplicados.
