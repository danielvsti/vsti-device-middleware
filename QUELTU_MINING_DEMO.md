# QUELTU Safety Operations · Demo Minería

## Objetivo comercial

Mostrar QUELTU como una plataforma única de seguridad operacional que conecta respuesta inmediata con gestión preventiva. La demostración debe responder a cinco necesidades: datos de accidentes, inspecciones, controles críticos, observaciones conductuales y eventos provenientes de analítica de cámaras.

## Tres ediciones, un solo producto

- **QUELTU Ciudad (`CITY`)** conserva la operación municipal actual. Es el perfil predeterminado para todos los Centros existentes que no declaren vertical.
- **QUELTU Minería (`MINING`)** aplica terminología de trabajador, brigadista, compañía minera y área/faena, y puede contratar Safety Operations.
- **QUELTU Industria (`INDUSTRY`)** aplica terminología de colaborador, equipo de emergencia, planta y área, y utiliza el mismo módulo Safety.

No son forks de software. Comparten API, base de datos, roles técnicos y aplicaciones; cada Centro de Control mantiene separación de datos, configuración, marca, categorías y licencias. Esta decisión evita que las mejoras para Minería rompan o retrasen QUELTU Ciudad.

## Alcance implementado para el MVP

- Un mismo backend, base de datos y aplicaciones para `CITY`, `MINING` e `INDUSTRY`.
- Separación estricta por Centro de Control.
- Terminología visible por vertical, sin cambiar roles o endpoints técnicos.
- Registro de accidentes e incidentes, con severidad, área, investigación y acciones inmediatas.
- Registro de inspecciones y brechas de cumplimiento.
- Catálogo y verificación de controles críticos.
- Registro de conductas seguras y de riesgo, incluyendo retroalimentación.
- Acciones correctivas y preventivas con responsable, prioridad, vencimiento y estado.
- Bandeja de eventos de cámaras con proveedor, confianza, cámara, área y evidencia HTTPS.
- Dashboard ejecutivo con los indicadores principales.
- Webhook de cámaras cerrado por defecto y protegido por un secreto independiente.

## Límites que deben explicarse con transparencia

- El conector genérico para cámaras está preparado, pero cada proveedor requiere acordar su payload, autenticación, catálogo de eventos y retención de evidencia.
- El MVP no reemplaza todavía una suite EHS completa ni calcula indicadores regulatorios específicos de Brasil.
- Las funciones predictivas o de IA deben presentarse como una evolución que utilizará datos reales del piloto; no como un modelo ya entrenado para Jaguar Mining.
- El formulario web es el primer canal operativo. La captura offline y los flujos móviles especializados se incorporan después de validar el piloto.

## Preparación del Centro de Control

1. En SuperAdmin, crear un Centro de Control independiente, por ejemplo `CC-JAGUAR-DEMO`.
2. Seleccionar vertical `MINING` y habilitar Seguridad Operacional.
3. Crear un ADMIN del Centro de Control.
4. Entrar en Admin con ese usuario y abrir **Seguridad operacional**.
5. Cargar datos manualmente o ejecutar el seed controlado:

```bash
QUELTU_API_BASE=https://api.queltu.com \
QUELTU_CONTROL_CENTER_CODE=CC-JAGUAR-DEMO \
QUELTU_ADMIN_TOKEN='valor-del-entorno-demo' \
npm run seed:mining-demo
```

El script nunca contiene secretos y falla si no recibe la llave por variable de entorno.

## Guion sugerido de 12 minutos

1. **Contexto (1 min):** QUELTU conecta detección, respuesta, investigación y prevención.
2. **Incidente (2 min):** registrar un cuasi accidente de interacción equipo-persona.
3. **Inspección (2 min):** mostrar una inspección parcial y la brecha encontrada.
4. **Control crítico (2 min):** enseñar el estándar y su verificación.
5. **Conducta y acción (2 min):** registrar observación, feedback y compromiso con vencimiento.
6. **Cámaras (1 min):** ingresar un evento simulado y explicar el contrato de integración real.
7. **Dashboard (2 min):** revisar indicadores y proponer piloto con datos reales.

## Piloto recomendado

- Una operación o faena.
- Dos o tres procesos críticos.
- Entre 30 y 60 días.
- Catálogo acotado de controles críticos.
- Una fuente de eventos de cámara, si el proveedor puede entregar webhook y evidencia.
- Métricas: calidad y oportunidad del reporte, cierre de acciones, cumplimiento de inspecciones, efectividad de controles y tasa de conductas de riesgo.
