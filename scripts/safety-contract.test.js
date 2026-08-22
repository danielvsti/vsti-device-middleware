"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const safety = fs.readFileSync(path.join(root, "safety-module.js"), "utf8");
const safetyMigration = fs.readFileSync(path.join(root, "db/migrations/20260814_safety_operations.sql"), "utf8");
const inspectionImageMigration = fs.readFileSync(path.join(root, "db/migrations/20260817_safety_inspection_image_evidence.sql"), "utf8");
const hsePortalMigration = fs.readFileSync(path.join(root, "db/migrations/20260816_hse_professional_portal.sql"), "utf8");

assert.match(server, /registerSafetyModule\s*\(/, "server.js debe registrar el módulo Safety");
assert.match(server, /VERTICAL_CONTROL_CENTER_DEFAULTS/, "deben existir defaults por vertical");
assert.match(server, /MINING[\s\S]*Trabajador[\s\S]*Profesional HSE/, "MINING debe parametrizar terminología visible");
assert.match(server, /INDUSTRY[\s\S]*Colaborador[\s\S]*Equipo de Emergencia/, "INDUSTRY debe parametrizar terminología visible");
assert.match(server, /DEFAULT_CONTROL_CENTER_SETTINGS[\s\S]*vertical: 'CITY'/, "CITY debe seguir siendo la vertical predeterminada para compatibilidad");
assert.match(server, /CITY: \{\}/, "CITY no debe alterar los valores operacionales existentes");
assert.match(server, /isNewControlCenter[\s\S]*delete currentSettings\.terminology/, "un Centro nuevo debe aplicar la terminología predeterminada de su vertical");
assert.match(server, /carriesCitySeedTerminology[\s\S]*delete currentSettings\.terminology/, "MINING e INDUSTRY deben reparar la terminología CITY sembrada por compatibilidad");

for (const table of [
  "safety_incidents", "safety_actions", "safety_inspections", "safety_critical_controls",
  "safety_control_verifications", "safety_behavior_observations", "safety_camera_events",
  "safety_pnr_documents", "safety_ticket_risk_assessments"
]) {
  assert.ok(safety.includes(table), `falta contrato para ${table}`);
}

assert.match(safety, /control_center_id UUID NOT NULL/g, "las entidades Safety deben pertenecer a un Centro de Control");
assert.match(safety, /checkAdminToken\(req, res\)/, "las rutas administrativas deben requerir autenticación");
assert.match(safety, /SAFETY_MODULE_NOT_LICENSED/, "las mutaciones deben exigir licencia Safety activa");
assert.match(server, /nextSettings\.safety_modules = normalizedCurrent\.safety_modules/, "ADMIN no debe auto-habilitar su licencia Safety");
assert.match(safety, /checkRoleAccess\(req, res, \["OPERATOR", "ADMIN", "SUPER_ADMIN"\]/, "el dashboard debe validar roles");
assert.match(safety, /CAMERA_AI_WEBHOOK_SECRET/, "el webhook de cámaras debe requerir secreto independiente");
assert.match(safety, /x-queltu-camera-secret/, "el webhook debe validar el header de integración");
assert.match(safety, /Integración de cámaras no configurada/, "la integración debe fallar cerrada si no hay secreto");
assert.match(safety, /CAMERA_AI_NOT_LICENSED/, "el webhook debe respetar la licencia Camera AI del Centro de Control");
assert.doesNotMatch(safety, /wa-center\.vsti\.cl|mqtt\.flespi\.io/, "Safety no debe modificar integraciones existentes");
assert.match(safetyMigration, /CREATE TABLE IF NOT EXISTS safety_incidents/, "debe existir migración idempotente de Safety");
assert.match(safetyMigration, /control_center_id UUID NOT NULL/g, "la migración debe segregar datos por Centro de Control");
assert.match(safetyMigration, /ALTER TABLE users ADD COLUMN IF NOT EXISTS work_area/, "los trabajadores deben poder tener un área laboral");
assert.match(safety, /\/admin\/control-centers\/:code\/safety\/pnr/, "ADMIN debe gestionar la biblioteca PNR");
assert.match(safety, /PNR_TYPES = new Set\(\["PROCEDURE", "STANDARD", "RULE"\]\)/, "la biblioteca debe distinguir Procedimientos, Normas y Reglas");
assert.match(safety, /CRITICAL_CONTROL_TYPES = new Set\(\["PREVENTIVE", "MITIGATING", "RECOVERY"\]\)/, "los controles críticos deben distinguir su tipo operacional");
assert.match(safetyMigration, /safety_critical_controls ADD COLUMN IF NOT EXISTS work_area/, "los controles críticos deben poder filtrarse por área de trabajo");
assert.match(safetyMigration, /safety_critical_controls ADD COLUMN IF NOT EXISTS control_type/, "los controles críticos deben poder filtrarse por tipo");
assert.match(safety, /app\.patch\("\/admin\/control-centers\/:code\/safety\/pnr\/:id"/, "ADMIN debe poder mantener metadatos y documentos PNR existentes");
assert.match(safety, /\/admin\/control-centers\/:code\/safety\/pnr\/:id\/content/, "ADMIN debe poder previsualizar documentos PNR activos o archivados");
assert.match(safety, /\/mobile\/safety\/pnr/, "la app Trabajador debe consultar PNR aplicables");
assert.match(safety, /\/resolver\/tickets\/:ticketId\/safety\/risk/, "la app HSE debe registrar riesgo por ticket");
assert.match(safety, /\/resolver\/tickets\/:ticketId\/safety\/inspections/, "la app HSE debe registrar inspecciones asociadas al ticket");
assert.match(safety, /app\.post\("\/resolver\/safety\/inspections"/, "la app HSE debe crear inspecciones autónomas");
assert.match(safety, /\/resolver\/safety\/inspections\/:inspectionId\/evidence/, "la inspección autónoma debe admitir evidencia multimedia");
assert.match(safetyMigration, /safety_inspections ADD COLUMN IF NOT EXISTS evidence JSONB/, "las inspecciones deben persistir metadatos de evidencia");
assert.match(safetyMigration, /CREATE TABLE IF NOT EXISTS safety_inspection_evidence/, "la evidencia HSE debe persistir fuera del filesystem efímero");
assert.match(safetyMigration, /media_type IN \('audio','image','video'\)/, "la evidencia HSE debe admitir audio, foto y video");
assert.match(inspectionImageMigration, /media_type IN \('audio','image','video'\)/, "la migración incremental debe habilitar fotografías en instalaciones existentes");
assert.match(server, /\["audio", "image", "video"\]\.includes\(mediaType\)/, "el almacenamiento común debe aceptar fotografías HSE");
assert.match(safety, /\["audio", "image", "video"\]\.includes\(mediaType\)/, "el endpoint de inspección HSE debe aceptar fotografías");
assert.match(safety, /\/resolver\/safety\/inspections\/:inspectionId\/evidence\/:evidenceId\/content/, "la evidencia HSE debe poder recuperarse posteriormente");
assert.match(safety, /\/resolver\/tickets\/:ticketId\/safety\/control-verifications/, "la app HSE debe verificar controles críticos asociados al ticket");
assert.match(safety, /\/resolver\/tickets\/:ticketId\/safety\/closure-request/, "el Profesional HSE debe solicitar aprobación del cierre");
assert.match(safety, /\/hse\/supervisor\/closure-requests/, "el Supervisor HSE debe revisar y decidir solicitudes de cierre");
assert.match(safety, /\/hse\/professional\/cases/, "el Profesional HSE debe tener una bandeja histórica separada de la PWA");
assert.match(safety, /\/hse\/professional\/tickets\/:ticketId\/workspace/, "el portal HSE debe exponer un espacio de investigación por ticket");
assert.match(safety, /\/hse\/professional\/tickets\/:ticketId\/investigation/, "el portal HSE debe mantener el análisis de causa raíz");
assert.match(safety, /\/hse\/professional\/tickets\/:ticketId\/actions/, "el portal HSE debe gestionar acciones correctivas y preventivas");
assert.match(safety, /\/hse\/professional\/tickets\/:ticketId\/risk/, "el portal HSE debe evaluar riesgo incluso después de la atención operativa");
assert.match(safety, /\/hse\/professional\/tickets\/:ticketId\/closure-request/, "el portal HSE debe solicitar cierre con autorización histórica propia");
assert.match(safety, /INVESTIGATION_METHODS = new Set\(\["FIVE_WHYS", "ICAM", "BOW_TIE", "OTHER"\]\)/, "la investigación debe declarar una metodología trazable");
assert.match(hsePortalMigration, /problem_statement TEXT/, "la investigación debe persistir la definición del problema");
assert.match(hsePortalMigration, /event_sequence JSONB/, "la investigación debe persistir la secuencia del evento");
assert.match(hsePortalMigration, /immediate_causes JSONB/, "la investigación debe persistir causas inmediatas estructuradas");
assert.match(hsePortalMigration, /contributing_factors JSONB/, "la investigación debe persistir factores contribuyentes estructurados");
assert.match(safety, /severity \* frequency/, "el puntaje de riesgo debe usar una matriz 5x5");
assert.match(safety, /PROFESSIONAL_ESTIMATE/, "la frecuencia debe aceptar estimación profesional");
assert.match(safety, /SYSTEM_SUGGESTION/, "la frecuencia debe soportar sugerencia estadística trazable");
assert.match(safety, /INSUFFICIENT_HISTORY/, "la sugerencia debe fallar de forma explícita cuando la muestra es insuficiente");

console.log("Safety contract tests: OK");
