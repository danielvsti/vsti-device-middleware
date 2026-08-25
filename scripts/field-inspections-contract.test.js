const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const safety = fs.readFileSync(path.join(root, 'safety-module.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'db/migrations/20260824_resolver_field_inspections.sql'), 'utf8');
const categoryMigration = fs.readFileSync(path.join(root, 'db/migrations/20260824_resolver_field_inspection_categories.sql'), 'utf8');

assert.match(server, /resolver_inspection_policy:\s*\{[\s\S]*enabled:\s*true/, 'Debe existir una política configurable por Centro de Control');
assert.match(server, /resolver_inspection_policy: normalized\.resolver_inspection_policy/, 'La App Resolutor debe recibir únicamente la política normalizada de su Centro');
assert.match(server, /registerSafetyModule\([\s\S]*createTicket/, 'El módulo debe reutilizar el flujo transaccional de tickets');

assert.match(safety, /mobileFieldInspectionContext/, 'El flujo debe autenticar al resolutor y aislarlo por Centro de Control');
assert.match(safety, /app\.post\("\/resolver\/field-inspections"/, 'Debe existir el registro de inspecciones en terreno');
assert.match(safety, /source_type:\s*"RESOLVER_INSPECTION"/, 'La alerta debe conservar un origen identificable');
assert.match(safety, /source_event_id:\s*inspection\.id/, 'La alerta debe quedar vinculada a la inspección original');
assert.match(safety, /linked_ticket_id=\$2/, 'La inspección debe conservar el ticket generado');
assert.match(safety, /latitude,longitude,accuracy,source_vertical,alert_requested/, 'La inspección debe persistir GPS y vertical');
assert.match(safety, /FIELD_INSPECTION_ALERT_CREATED/, 'La creación de alerta debe quedar auditada');
assert.match(safety, /FIELD_INSPECTION_EVIDENCE/, 'La evidencia debe incorporarse a la bitácora del ticket');
assert.match(safety, /\["RESOLVER", "OPERATOR", "ADMIN", "SUPER_ADMIN"\]/, 'La evidencia vinculada debe ser visible solo a roles operacionales autorizados');
assert.match(safety, /e\.control_center_id=\$3/, 'La lectura de evidencia debe permanecer aislada por Centro de Control');
assert.match(safety, /resolverInspectionCategories/, 'Las categorías deben resolverse desde configuración del Centro');
assert.match(safety, /category_type/, 'La clasificación elegida debe persistir incluso cuando no se crea una alerta');
assert.match(safety, /if \(!inspectionCategory\)/, 'Toda inspección de terreno debe usar una categoría autorizada');

assert.match(migration, /ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION/, 'La migración debe persistir georreferencia');
assert.match(migration, /idx_safety_inspections_field_history/, 'La consulta de historial debe contar con índice específico');
assert.match(migration, /idx_safety_inspections_linked_ticket/, 'El vínculo inspección-ticket debe ser indexado');
assert.match(categoryMigration, /ADD COLUMN IF NOT EXISTS category_type VARCHAR\(80\)/, 'La migración debe persistir la categoría de la inspección');
assert.match(categoryMigration, /idx_safety_inspections_cc_category/, 'La clasificación debe contar con índice por Centro de Control');

console.log('Resolver field inspections contract OK');
