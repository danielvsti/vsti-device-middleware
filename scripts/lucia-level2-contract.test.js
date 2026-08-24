const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

assert.match(server, /function luciaLevel2Requested/, 'Lucía debe reconocer solicitudes de patrullaje y despliegue');
assert.match(server, /intent === "patrol_recommendation"/, 'Lucía debe tener un intent explícito para recomendación preventiva');
assert.match(server, /methodology_version: "LUCIA_PATROL_V1"/, 'El motor debe versionar su metodología');
assert.match(server, /35% volumen \+ 25% prioridad \+ 20% recurrencia \+ 10% corroboración \+ 10% presión operativa/, 'La fórmula debe ser explícita y auditable');
assert.match(server, /NEIGHBOR_FALSE_ALARM_CANCELLED/, 'El análisis debe descontar falsas alarmas auditadas');
assert.match(server, /runLuciaLevel2Plan/, 'Debe existir un orquestador separado para el plan Nivel 2');
assert.match(server, /LUCIA_LEVEL2_RESOLVERS_SQL/, 'El plan debe considerar equipos disponibles con GPS reciente');
assert.match(server, /status: "ADVISORY"/, 'El plan debe declararse recomendación y no despacho autónomo');
assert.match(server, /no representa probabilidad de delito ni predicción criminológica/, 'La interfaz de datos debe evitar sobreprometer predicción');
assert.match(server, /analysis_level, methodology_version, result_summary/, 'La auditoría debe registrar nivel, metodología y resumen');
assert.match(server, /Recomendación de solo lectura; no asigna ni despacha recursos/, 'Debe exigir validación humana');
assert.match(server, /control_center_id = \$1/, 'Toda consulta de Nivel 2 debe estar aislada por Centro de Control');

console.log('Lucía Level 2 contract OK');
