"use strict";

const API = String(process.env.QUELTU_API_BASE || "https://api.queltu.com").replace(/\/+$/, "");
const CODE = String(process.env.QUELTU_CONTROL_CENTER_CODE || "CC-MINA-DEMO").toUpperCase();
const ADMIN_TOKEN = process.env.QUELTU_ADMIN_TOKEN || process.env.ADMIN_TOKEN || "";

if (!ADMIN_TOKEN) {
  console.error("Define QUELTU_ADMIN_TOKEN con la llave administrativa del entorno demo.");
  process.exit(1);
}

const headers = { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN };

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.status !== "ok") throw new Error(`${response.status} ${data.message || path}`);
  return data;
}

async function create(resource, payload) {
  const data = await request(`/admin/control-centers/${encodeURIComponent(CODE)}/safety/${resource}`, {
    method: "POST", body: JSON.stringify(payload)
  });
  console.log(`✓ ${resource}`, Object.values(data)[1]?.id || "OK");
}

async function main() {
  const current = await request(`/admin/control-centers/${encodeURIComponent(CODE)}/settings`);
  await request(`/admin/control-centers/${encodeURIComponent(CODE)}/settings`, {
    method: "PUT",
    body: JSON.stringify({ settings: { ...current.settings, vertical: "MINING", safety_modules: { enabled: true, incidents: true, inspections: true, critical_controls: true, behavior_observations: true, camera_ai: false } } })
  });
  console.log(`✓ ${CODE} configurado como MINING`);

  await create("incidents", { title: "Cuasi accidente durante interacción equipo-persona", event_type: "NEAR_MISS", severity: "HIGH", potential_severity: "CRITICAL", area: "Mina subterránea · Nivel 850", description: "Equipo móvil ingresó al área de exclusión durante maniobra. Sin lesionados.", immediate_actions: "Detención de tarea, segregación del área y charla operacional.", occurred_at: new Date(Date.now() - 6 * 3600000).toISOString() });
  await create("inspections", { title: "Inspección preoperacional de equipo móvil", inspection_type: "PRE_OPERATIONAL", area: "Taller Mina", status: "COMPLETED", result: "PARTIAL", score: 82, notes: "Se detecta alarma de retroceso con volumen bajo.", completed_at: new Date(Date.now() - 4 * 3600000).toISOString() });
  await create("critical-controls", { code: "CC-VEH-01", hazard: "Interacción equipo-persona", name: "Segregación efectiva", verification_question: "¿La segregación física y las zonas de exclusión están implementadas y operativas?", performance_standard: "100% de barreras instaladas, visibles y sin accesos no controlados." });
  await create("behavior-observations", { observation_type: "AT_RISK", category: "Uso de EPP", area: "Planta de procesos", description: "Trabajador en zona de ruido sin protección auditiva visible.", feedback: "Se detuvo la tarea, se reforzó el estándar y se entregó protección adecuada." });
  await create("actions", { title: "Revisar y calibrar alarmas de retroceso", description: "Verificar la totalidad de los equipos del turno y documentar resultado.", priority: "HIGH", owner_name: "Jefatura Mantenimiento Mina", due_date: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10) });
  await create("camera-events", { provider: "MANUAL_DEMO", external_event_id: `demo-ppe-${Date.now()}`, event_type: "PPE_NON_COMPLIANCE", confidence: 0.94, camera_name: "CAM-PLANTA-04", area: "Acceso planta de procesos", metadata: { demo: true, detection: "missing_hard_hat" } });
  console.log("\nDemo Safety MINING preparada. No se cargaron secretos ni archivos multimedia.");
}

main().catch(error => { console.error("ERROR:", error.message); process.exit(1); });
