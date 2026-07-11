# Sprint 0 de blindaje

## Autenticación OTP

Los accesos de Vecino, Resolutor, Operador, Admin y Superadmin usan el mismo flujo:

1. El cliente envía teléfono, tipo de panel y sin código.
2. La API crea un desafío OTP y responde `requires_verification: true`.
3. El cliente reenvía la solicitud incluyendo `code`.
4. La API verifica el código y entrega una sesión HMAC limitada por rol, usuario, municipio y vencimiento.

En producción configurar `OTP_PROVIDER=twilio_verify` y las tres credenciales de Twilio Verify. También usar `OTP_REQUIRE_DELIVERY=true`.

## Modo demo

El modo demo no se activa automáticamente. En el servicio demo configurar:

```env
OTP_DEMO_MODE=true
OTP_EXPOSE_DEMO_CODE=true
SOS_SECURITY_DEMO_MODE=true
OTP_REQUIRE_DELIVERY=false
OTP_DEFAULT_CHANNEL=demo
```

Los frontends pueden definir `window.SOS_CONFIG.DEMO_MODE = true` para solicitar explícitamente el canal `demo`. Si no lo hacen, `OTP_DEFAULT_CHANNEL=demo` conserva el flujo de laboratorio. El código solo se expone cuando el desafío fue creado realmente con canal `demo`; nunca se mezcla con un desafío Twilio.

Nunca habilitar estas variables en producción municipal.

## Variables obligatorias en Render

- `SOS_SESSION_SECRET`
- `VSTI_TOKEN`
- `ADMIN_TOKEN`
- `OTP_HASH_SECRET`
- `CORS_ALLOWED_ORIGINS`
- `DATABASE_URL`
- Credenciales `TWILIO_*`

### Allowlist CORS del despliegue actual

```env
CORS_ALLOWED_ORIGINS=https://sos-admin-ipp7.onrender.com,https://sos-dashboard-3695.onrender.com,https://mapa.sos.vsti.cl,https://sos-pwa.onrender.com,https://sos-resolver-pwa.onrender.com,https://sos-superadmin.onrender.com,capacitor://localhost,http://localhost
```

`mapa.sos.vsti.cl` debe servir el panel exclusivamente mediante HTTPS. No agregar `http://mapa.sos.vsti.cl` a producción: una página operacional cargada sin TLS podría exponer la sesión OTP.

Usar secretos diferentes por ambiente. Después del despliegue, rotar cualquier token histórico que haya estado incluido en código o logs.

## Rutas cerradas

- Las rutas `/debug/*` requieren `SOS_DEBUG_ENDPOINTS_ENABLED=true` y `ADMIN_TOKEN`.
- Sirenas y reconocimientos físicos requieren sesión operacional.
- Tickets, bitácoras y medios requieren pertenencia al caso o rol operacional del mismo centro.
- GPS y transiciones de resolutores requieren sesión RESOLVER coincidente.
- Eventos móviles requieren sesión NEIGHBOR coincidente.

## Despliegue

1. Configurar las variables de producción en Render.
2. Desplegar primero la API.
3. Desplegar inmediatamente todos los frontends actualizados.
4. Validar OTP Vecino, Resolutor, Operador, Admin y Superadmin.
5. Validar aislamiento entre dos centros de control.
6. Confirmar que `/debug/users` devuelve 404 sin habilitación y que las sirenas devuelven 401 sin sesión.
