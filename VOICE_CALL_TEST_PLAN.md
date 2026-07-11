# Plan de prueba — ciclo de llamada SOS

## Precondiciones

- Backend con `WA_CENTER_VOICE_ENABLED=true`.
- `WA_CENTER_BASE_URL`, `WA_CENTER_API_TOKEN`, `WA_CENTER_WEBHOOK_SECRET` y `SOS_PUBLIC_BASE_URL` configurados en el ambiente, nunca en el repositorio.
- Un vecino, un resolutor y un ticket activo de prueba.
- App Vecino y App Resolutor desplegadas desde las ramas del mismo cambio.

## Validaciones estáticas

```bash
node --check server.js
node --check app.js # ejecutar en SOS-PWA y SOS-RESOLVER-PWA
```

## Casos funcionales

1. **Resolutor contesta**
   - Asignar el ticket al resolutor.
   - En Vecino, tocar `Llamar` una vez.
   - Confirmar overlay y ringback local.
   - En Resolutor, confirmar overlay `Llamada entrante` con el folio y tocar `Contestar`.
   - Verificar estado `CONNECTED`, audio bidireccional y detención inmediata del ringback.

2. **Resolutor rechaza**
   - Tocar `Rechazar` en Resolutor.
   - Verificar que Vecino muestre que no fue posible conectar.
   - Confirmar estado `REJECTED` y que WA-Center reciba `revoke`.

3. **Sin respuesta**
   - No contestar durante 45 segundos.
   - Verificar fin del ringback, estado `NO_ANSWER` y `revoke` de WA-Center.

4. **Vecino cuelga antes de conectar**
   - Tocar `Colgar` mientras suena.
   - Confirmar cierre inmediato de audio, polling y WebRTC.
   - Confirmar `revoke` y estado `ENDED`.

5. **Resolutor cuelga durante una llamada conectada**
   - Conectar la llamada y colgar desde Resolutor.
   - Confirmar `end` en WA-Center.
   - Verificar que Vecino detecte `ENDED` y cierre su overlay.

6. **Falla WA-Center**
   - Probar en un ambiente con WA-Center deshabilitado o inaccesible.
   - Verificar mensaje no técnico, estado `FAILED` y ausencia de timers, tracks o ringback.

7. **Sin resolutor asignado**
   - Iniciar llamada con ticket sin resolutor.
   - Confirmar en base de datos `target_type=CENTRAL`.
   - Atender desde el flujo de operador disponible en Central.

8. **Idempotencia**
   - Presionar `Colgar` dos veces o provocar simultáneamente hangup y webhook.
   - Confirmar un único estado terminal y que respuestas 404/409/410 de WA-Center se traten como sesión ya cerrada.

## Comprobación posterior

- `ticket_voice_sessions.status` debe ser `ENDED`, `REJECTED`, `NO_ANSWER` o `FAILED`.
- `ended_at` debe tener valor.
- Debe existir evento correspondiente en `ticket_voice_events` y bitácora en `ticket_actions`.
- No debe quedar ringback, timer de duración, polling de llamada, track local/remoto ni `RTCPeerConnection` activa.
- Mensaje, Audio, Video y Llamar deben continuar visibles y funcionales en App Vecino.

## Orden de despliegue

1. Middleware.
2. App Resolutor.
3. App Vecino.

El fallback a Central depende de que la interfaz de operador consuma las sesiones `target_type=CENTRAL`; si aún no lo hace, debe validarse como trabajo posterior antes de producción.
