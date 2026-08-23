const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'db/migrations/20260822_city_sla_readiness.sql'), 'utf8');
const offlineMigration = fs.readFileSync(path.join(root, 'db/migrations/20260822_mobile_offline_idempotency.sql'), 'utf8');
const resolverOfflineMigration = fs.readFileSync(path.join(root, 'db/migrations/20260822_resolver_offline_actions.sql'), 'utf8');
const cityCompliance = fs.readFileSync(path.join(root, 'city-compliance.js'), 'utf8');
const enRouteHandler = server.match(/app\.post\("\/tickets\/:id\/en-route"[\s\S]*?app\.post\("\/tickets\/:id\/on-site"/)?.[0] || '';
const onSiteHandler = server.match(/app\.post\("\/tickets\/:id\/on-site"[\s\S]*?app\.post\("\/tickets\/:id\/resolve"/)?.[0] || '';

assert.match(server, /sla_policy:\s*\{[\s\S]*automatic_reassignment_enabled:\s*true/, 'Debe existir política SLA configurable por Centro de Control');
assert.match(server, /require_central_acknowledgement:\s*false/, 'La confirmación humana de Central debe ser explícita y opcional');
assert.match(server, /policy\.require_central_acknowledgement === true\s*\? minutesAfter/, 'Solo los tickets supervisados deben tener vencimiento de confirmación');
assert.match(server, /by_priority/, 'SLA debe aceptar overrides por prioridad');
assert.match(server, /by_category/, 'SLA debe aceptar overrides por categoría');
assert.match(server, /function effectiveTicketSla/, 'Debe resolver la política efectiva por ticket');
assert.match(server, /SLA_ACCEPTANCE_EXPIRED/, 'Debe auditar vencimientos de aceptación');
assert.match(server, /expirePendingTicketAssignments/, 'Debe barrer asignaciones vencidas');
assert.match(server, /ASSIGNMENT_NOT_PENDING_OR_EXPIRED/, 'Una aceptación tardía debe fallar cerrada');
assert.match(
  server,
  /UPPER\(COALESCE\(rejected_assignments\.state,''\)\) IN \('REJECTED','EXPIRED'\)/,
  'La cola no debe devolver un ticket al mismo resolutor después de vencer su aceptación'
);
assert.match(
  server,
  /rejected_actions\.action_type IN \('RESOLVER_REJECTED','SLA_ACCEPTANCE_EXPIRED'\)/,
  'La auditoría de vencimiento también debe excluir al resolutor en la cola'
);
assert.match(
  server,
  /activeTickets\.length === 0 && \["EN_ROUTE", "ON_SITE"\]\.includes\(currentStatus\)/,
  'La reconciliación no debe convertir una pausa manual BUSY en AVAILABLE'
);
assert.match(
  server,
  /\["EN_ROUTE", "ON_SITE"\]\.includes\(requestedStatus\) && activeTickets\.length === 0/,
  'El GPS debe conservar BUSY como pausa manual cuando no hay tickets activos'
);
assert.match(
  server,
  /reason: 'AUTO_ASSIGNMENT_DISABLED_BY_CONTROL_CENTER'/,
  'El pulso GPS no debe tomar tickets de la cola cuando el Centro opera en modo manual'
);
assert.match(
  server,
  /operator_dispatch_override: true/,
  'El operador debe poder ordenar una autoasignación explícita aunque el modo automático esté deshabilitado'
);
assert.match(
  server,
  /CENTRAL_ASSISTED_ASSIGNED/,
  'La asignación asistida solicitada por Central debe distinguirse de una autoasignación autónoma'
);
assert.match(
  server,
  /CENTRAL_OPERATOR_REQUEST/,
  'La asignación asistida debe conservar su origen humano en auditoría'
);
assert.match(
  server,
  /\$3::boolean = true[\s\S]*t\.assigned_resolver_id IS NULL[\s\S]*AUTO_ASSIGNMENT_HELD_FOR_CREDIBILITY_REVIEW/,
  'Los tickets en revisión manual no deben aparecer como disponibles para los resolutores'
);
assert.match(
  server,
  /code: "CENTRAL_DISPATCH_REQUIRED"/,
  'Un resolutor no debe poder tomar directamente un ticket retenido para revisión de Central'
);
assert.match(server, /startTicketSlaMaintenance\(\)/, 'El mantenimiento SLA debe iniciar con la API');
assert.match(server, /MAP SLA RECONCILIATION WARNING/, 'El mapa debe reconciliar vencimientos aunque el barrido de fondo se haya interrumpido');
assert.match(server, /RESOLVER SLA RECONCILIATION WARNING/, 'La bandeja del resolutor debe reconciliar vencimientos al actualizarse');
assert.match(server, /latest_assignment_accept_due_at/, 'El mapa debe recibir la fecha límite exacta de aceptación móvil');
assert.match(server, /assignment_accept_due_at/, 'La App Resolutor debe recibir su fecha límite de aceptación');
assert.match(server, /state = CASE WHEN state = 'ACTIVE' THEN 'ACKNOWLEDGED' ELSE state END/, 'Confirmar en Central no debe retroceder un ticket ya asignado');
assert.match(server, /Central confirmó la revisión del ticket/, 'La confirmación humana debe quedar descrita de forma operacional');
assert.match(server, /state IN \('ACTIVE','ACKNOWLEDGED'\)/, 'Confirmar en Central no debe sacar al ticket de la cola automática');
assert.match(server, /sla_policy_snapshot->>'require_central_acknowledgement'/, 'Dashboard debe ignorar falsos vencimientos cuando Central no exige confirmación');
assert.match(server, /mobileSosRateLimit/, 'Debe limitar ráfagas de activaciones SOS por usuario y origen');
assert.match(server, /function assessNeighborAbuseRisk/, 'Debe evaluar señales históricas de reincidencia sin depender de IA opaca');
assert.match(server, /mode: 'FLAG_ONLY'/, 'La clasificación preventiva nunca debe bloquear automáticamente una emergencia');
assert.match(server, /RAPID_REPEATED_ACTIVATIONS/, 'Debe detectar ráfagas de activaciones repetidas');
assert.match(server, /REPEATED_FALSE_ALARM_CANCELLATIONS/, 'Debe considerar falsas alarmas declaradas y auditadas');
assert.match(server, /ABUSE_RISK_FLAGGED/, 'Las señales de validación deben quedar auditadas en el ticket');
assert.match(server, /'VIF', 'VIF_SILENT_SHAKE', 'FALL_DETECTED'/, 'VIF y alertas automáticas sensibles deben excluirse de la clasificación');
assert.match(server, /nunca bloquea automáticamente una emergencia/, 'La advertencia debe declarar expresamente su límite operacional');
assert.match(server, /function assessAlertOperationalTrust/, 'Debe calcular separadamente la credibilidad del vecino y del evento');
assert.match(server, /ALERT = \(CITIZEN \/ 100\) \* \(EVENT \/ 100\) \* 100/, 'F(Alerta) debe combinar ambos rankings de forma explícita');
assert.match(server, /citizen_threshold:\s*60/, 'El umbral general de credibilidad del vecino debe ser configurable');
assert.match(server, /event_threshold:\s*60/, 'El umbral general de credibilidad del evento debe ser configurable');
assert.match(server, /alert_threshold:\s*60/, 'El umbral combinado F(Alerta) debe ser configurable');
assert.match(server, /INDEPENDENT_NEARBY_CORROBORATION/, 'El evento debe considerar reportes similares de otros vecinos en radio y ventana configurados');
assert.match(server, /AUTO_ASSIGNMENT_HELD_FOR_CREDIBILITY_REVIEW/, 'Un ranking bajo ordinario debe retener la asignación automática hasta revisión de Central');
assert.match(server, /CENTRAL_CREDIBILITY_REVIEW_REQUIRED/, 'El resolutor no debe tomar un ticket retenido antes de la revisión central');
assert.match(server, /CRITICAL_CONTINUE_WITH_PRIORITY_REVIEW/, 'Las categorías críticas deben continuar con revisión prioritaria en paralelo');
assert.match(server, /ALERT_CREDIBILITY_REVIEW_COMPLETED/, 'La autorización humana debe liberar el hold y quedar auditada');
assert.match(server, /NEIGHBOR_FALSE_ALARM_CANCELLED/, 'La cancelación del vecino debe quedar explícita en la bitácora del ticket');
assert.match(server, /reason: 'FALSE_ALARM'/, 'La cancelación debe conservar la causal de falsa alarma');
assert.match(server, /hasValidMediaSignature/, 'Debe proteger evidencia con enlaces firmados y vencimiento');
assert.match(server, /signProtectedMediaUrls/, 'Debe firmar URLs de evidencia solo al responder a sesiones autorizadas');
assert.match(server, /findMobileSosIdempotentReplay/, 'Debe reconciliar reintentos offline sin duplicar incidentes');
assert.match(server, /resolver_action_receipts/, 'Debe reconciliar acciones offline del resolutor');
assert.match(server, /en-route\|on-site\|resolve\|messages\|media/, 'La idempotencia debe cubrir estados, antecedentes y evidencia offline');
assert.match(enRouteHandler, /state IN \([^)]*'ACCEPTED_BY_RESOLVER'/, 'Un caso aceptado debe poder avanzar a en camino al sincronizar');
assert.match(onSiteHandler, /state IN \([^)]*'ACCEPTED_BY_RESOLVER'/, 'Un caso aceptado debe poder avanzar directamente a en sitio al sincronizar una cola offline');
assert.match(server, /client_action_id:\s*client_action_id\s*\|\|\s*undefined/, 'Mensajes y medios deben conservar la clave idempotente en auditoría');
assert.match(server, /session\?\.sub\s*\|\|\s*null/, 'La evidencia debe registrar al actor autenticado');
assert.match(server, /WHATSAPP_OPERATOR/, 'El ingreso manual debe distinguir WhatsApp atendido por operador');
assert.match(server, /PHONE_14XX/, 'El ingreso manual debe distinguir el canal telefónico municipal');
assert.match(server, /intake_mode: "OPERATOR_MANUAL"/, 'El ticket debe declarar que la recepción no fue automatizada');
assert.match(migration, /accept_due_at TIMESTAMPTZ/, 'La fecha límite de aceptación debe persistirse');
assert.match(migration, /sla_policy_snapshot JSONB/, 'La política aplicada debe quedar congelada para auditoría');
assert.match(offlineMigration, /client_request_id TEXT/, 'La clave idempotente offline debe persistirse');
assert.match(offlineMigration, /UNIQUE INDEX/, 'Los reintentos offline deben tener unicidad por usuario');
assert.match(resolverOfflineMigration, /client_action_id TEXT PRIMARY KEY/, 'Las acciones del resolutor deben ser idempotentes');
assert.match(cityCompliance, /city_security_assets/, 'Debe existir inventario geoespacial de cámaras, IoT y LPR');
assert.match(cityCompliance, /city_criminogenic_observations/, 'Debe existir clasificación de factores criminógenos');
assert.match(cityCompliance, /city_external_api_audit/, 'Todo acceso externo debe ser auditable');
assert.match(cityCompliance, /privacy_profile:\s*"NO_DIRECT_PERSONAL_IDENTIFIERS"/, 'La API externa de incidentes debe excluir identificadores personales directos');
assert.match(cityCompliance, /detections_available:false/, 'No debe sobreprometer lecturas LPR inexistentes');

console.log('City readiness contract OK');
