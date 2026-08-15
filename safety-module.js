"use strict";

const SAFETY_STATUSES = Object.freeze({
  incident: new Set(["OPEN", "INVESTIGATING", "ACTION_PLAN", "CLOSED"]),
  inspection: new Set(["PLANNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]),
  inspectionResult: new Set(["NOT_EVALUATED", "COMPLIANT", "PARTIAL", "NON_COMPLIANT"]),
  action: new Set(["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"]),
  verification: new Set(["EFFECTIVE", "FAILED", "NOT_APPLICABLE"]),
  observation: new Set(["SAFE", "AT_RISK"]),
  camera: new Set(["NEW", "ACKNOWLEDGED", "DISMISSED", "LINKED"])
});

function text(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function required(value, label, max = 500) {
  const normalized = text(value, max);
  if (!normalized) throw new Error(`${label} es obligatorio`);
  return normalized;
}

function enumValue(value, allowed, fallback) {
  const normalized = text(value, 64).toUpperCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function numberOrNull(value, min = -Infinity, max = Infinity) {
  if (value === "" || value == null) return null;
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) return null;
  return Math.min(max, Math.max(min, normalized));
}

function dateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function jsonObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function httpsUrlOrNull(value) {
  const raw = text(value, 2000);
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("La URL multimedia debe utilizar HTTPS");
  return url.toString();
}

function actorId(req) {
  const value = req.panel_session?.sub;
  return /^[0-9a-f-]{36}$/i.test(String(value || "")) ? value : null;
}

function safetyEnabled(settings) {
  return settings?.safety_modules?.enabled === true;
}

function registerSafetyModule({
  app,
  pool,
  checkAdminToken,
  checkRoleAccess,
  requestedControlCenterForSession,
  adminResolveControlCenter,
  getControlCenterSettingsById
}) {
  let schemaPromise = null;

  function ensureSchema() {
    if (schemaPromise) return schemaPromise;
    schemaPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS safety_incidents (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
          linked_ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,
          title VARCHAR(180) NOT NULL,
          event_type VARCHAR(80) NOT NULL DEFAULT 'ACCIDENT',
          severity VARCHAR(32) NOT NULL DEFAULT 'MEDIUM',
          potential_severity VARCHAR(32),
          occurred_at TIMESTAMP NOT NULL DEFAULT NOW(),
          area VARCHAR(180),
          description TEXT,
          investigation_status VARCHAR(32) NOT NULL DEFAULT 'OPEN',
          immediate_actions TEXT,
          root_causes JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_by UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_safety_incidents_cc_date ON safety_incidents(control_center_id, occurred_at DESC);

        CREATE TABLE IF NOT EXISTS safety_actions (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
          source_type VARCHAR(40) NOT NULL DEFAULT 'GENERAL',
          source_id UUID,
          title VARCHAR(180) NOT NULL,
          description TEXT,
          action_type VARCHAR(24) NOT NULL DEFAULT 'CORRECTIVE',
          priority VARCHAR(20) NOT NULL DEFAULT 'MEDIUM',
          owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          owner_name VARCHAR(180),
          due_date DATE,
          status VARCHAR(24) NOT NULL DEFAULT 'OPEN',
          evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_by UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_safety_actions_cc_status ON safety_actions(control_center_id, status, due_date);

        CREATE TABLE IF NOT EXISTS safety_inspection_templates (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
          name VARCHAR(180) NOT NULL,
          inspection_type VARCHAR(80) NOT NULL,
          description TEXT,
          checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_by UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS safety_inspections (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
          template_id UUID REFERENCES safety_inspection_templates(id) ON DELETE SET NULL,
          title VARCHAR(180) NOT NULL,
          inspection_type VARCHAR(80) NOT NULL,
          area VARCHAR(180),
          scheduled_at TIMESTAMP,
          completed_at TIMESTAMP,
          status VARCHAR(24) NOT NULL DEFAULT 'PLANNED',
          result VARCHAR(24) NOT NULL DEFAULT 'NOT_EVALUATED',
          score NUMERIC(5,2),
          responses JSONB NOT NULL DEFAULT '[]'::jsonb,
          findings JSONB NOT NULL DEFAULT '[]'::jsonb,
          notes TEXT,
          inspector_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          created_by UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_safety_inspections_cc_date ON safety_inspections(control_center_id, COALESCE(scheduled_at, created_at) DESC);

        CREATE TABLE IF NOT EXISTS safety_critical_controls (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
          code VARCHAR(50) NOT NULL,
          hazard VARCHAR(180) NOT NULL,
          name VARCHAR(180) NOT NULL,
          verification_question TEXT NOT NULL,
          performance_standard TEXT,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_by UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
          UNIQUE(control_center_id, code)
        );

        CREATE TABLE IF NOT EXISTS safety_control_verifications (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
          control_id UUID NOT NULL REFERENCES safety_critical_controls(id) ON DELETE CASCADE,
          inspection_id UUID REFERENCES safety_inspections(id) ON DELETE SET NULL,
          result VARCHAR(24) NOT NULL,
          area VARCHAR(180),
          evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
          notes TEXT,
          verified_by UUID REFERENCES users(id) ON DELETE SET NULL,
          verified_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_safety_control_verifications_cc_date ON safety_control_verifications(control_center_id, verified_at DESC);

        CREATE TABLE IF NOT EXISTS safety_behavior_observations (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
          observation_type VARCHAR(20) NOT NULL,
          category VARCHAR(100) NOT NULL,
          area VARCHAR(180),
          description TEXT NOT NULL,
          feedback TEXT,
          anonymous BOOLEAN NOT NULL DEFAULT FALSE,
          observed_at TIMESTAMP NOT NULL DEFAULT NOW(),
          observer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_safety_behavior_cc_date ON safety_behavior_observations(control_center_id, observed_at DESC);

        CREATE TABLE IF NOT EXISTS safety_camera_events (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
          provider VARCHAR(80) NOT NULL DEFAULT 'MANUAL_DEMO',
          external_event_id VARCHAR(180),
          event_type VARCHAR(100) NOT NULL,
          confidence NUMERIC(5,4),
          camera_id VARCHAR(120),
          camera_name VARCHAR(180),
          area VARCHAR(180),
          occurred_at TIMESTAMP NOT NULL DEFAULT NOW(),
          media_url TEXT,
          status VARCHAR(24) NOT NULL DEFAULT 'NEW',
          linked_ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_by UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uq_safety_camera_cc_provider_event ON safety_camera_events(control_center_id, provider, external_event_id) WHERE external_event_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_safety_camera_cc_date ON safety_camera_events(control_center_id, occurred_at DESC);
      `);
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
    return schemaPromise;
  }

  async function resolveAdminContext(req, res) {
    if (!checkAdminToken(req, res)) return null;
    await ensureSchema();
    const center = await adminResolveControlCenter(req, req.params.code || req.query.control_center_code);
    if (!center) {
      res.status(404).json({ status: "error", message: "Centro de Control no encontrado" });
      return null;
    }
    const settingsRow = await getControlCenterSettingsById(center.id);
    const context = { center, settings: settingsRow?.settings || {} };
    if (req.method !== "GET" && !safetyEnabled(context.settings)) {
      res.status(403).json({
        status: "error",
        code: "SAFETY_MODULE_NOT_LICENSED",
        message: "El módulo QUELTU Safety Operations no está habilitado para este Centro de Control"
      });
      return null;
    }
    return context;
  }

  async function listPayload(controlCenterId, limit = 40) {
    const bounded = Math.max(1, Math.min(100, Number(limit) || 40));
    const [incidents, actions, inspections, controls, observations, cameraEvents, stats] = await Promise.all([
      pool.query(`SELECT * FROM safety_incidents WHERE control_center_id=$1 ORDER BY occurred_at DESC LIMIT $2`, [controlCenterId, bounded]),
      pool.query(`SELECT * FROM safety_actions WHERE control_center_id=$1 ORDER BY created_at DESC LIMIT $2`, [controlCenterId, bounded]),
      pool.query(`SELECT * FROM safety_inspections WHERE control_center_id=$1 ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT $2`, [controlCenterId, bounded]),
      pool.query(`SELECT c.*, v.result AS latest_result, v.verified_at AS latest_verified_at FROM safety_critical_controls c LEFT JOIN LATERAL (SELECT result, verified_at FROM safety_control_verifications WHERE control_id=c.id ORDER BY verified_at DESC LIMIT 1) v ON TRUE WHERE c.control_center_id=$1 ORDER BY c.code LIMIT $2`, [controlCenterId, bounded]),
      pool.query(`SELECT * FROM safety_behavior_observations WHERE control_center_id=$1 ORDER BY observed_at DESC LIMIT $2`, [controlCenterId, bounded]),
      pool.query(`SELECT * FROM safety_camera_events WHERE control_center_id=$1 ORDER BY occurred_at DESC LIMIT $2`, [controlCenterId, bounded]),
      pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM safety_incidents WHERE control_center_id=$1 AND investigation_status <> 'CLOSED') AS open_incidents,
          (SELECT COUNT(*)::int FROM safety_inspections WHERE control_center_id=$1 AND result IN ('PARTIAL','NON_COMPLIANT')) AS inspection_gaps,
          (SELECT COUNT(*)::int FROM safety_control_verifications WHERE control_center_id=$1 AND result='FAILED') AS failed_controls,
          (SELECT COUNT(*)::int FROM safety_behavior_observations WHERE control_center_id=$1 AND observation_type='AT_RISK') AS at_risk_observations,
          (SELECT COUNT(*)::int FROM safety_actions WHERE control_center_id=$1 AND status IN ('OPEN','IN_PROGRESS')) AS open_actions,
          (SELECT COUNT(*)::int FROM safety_actions WHERE control_center_id=$1 AND status IN ('OPEN','IN_PROGRESS') AND due_date < CURRENT_DATE) AS overdue_actions,
          (SELECT COUNT(*)::int FROM safety_camera_events WHERE control_center_id=$1 AND status='NEW') AS new_camera_events
      `, [controlCenterId])
    ]);
    return {
      stats: stats.rows[0],
      incidents: incidents.rows,
      actions: actions.rows,
      inspections: inspections.rows,
      critical_controls: controls.rows,
      behavior_observations: observations.rows,
      camera_events: cameraEvents.rows
    };
  }

  app.get("/admin/control-centers/:code/safety/bootstrap", async (req, res) => {
    try {
      const context = await resolveAdminContext(req, res);
      if (!context) return;
      const data = await listPayload(context.center.id, req.query.limit);
      res.json({ status: "ok", control_center: context.center, enabled: safetyEnabled(context.settings), configuration: context.settings.safety_modules || {}, ...data });
    } catch (error) {
      console.error("[SAFETY BOOTSTRAP ERROR]", error);
      res.status(500).json({ status: "error", message: error.message });
    }
  });

  app.post("/admin/control-centers/:code/safety/incidents", async (req, res) => {
    try {
      const context = await resolveAdminContext(req, res); if (!context) return;
      const body = req.body || {};
      const result = await pool.query(`INSERT INTO safety_incidents(control_center_id,linked_ticket_id,title,event_type,severity,potential_severity,occurred_at,area,description,investigation_status,immediate_actions,root_causes,created_by) VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,NOW()),$8,$9,$10,$11,$12::jsonb,$13) RETURNING *`, [
        context.center.id, body.linked_ticket_id || null, required(body.title, "Título", 180), text(body.event_type || "ACCIDENT", 80).toUpperCase(), text(body.severity || "MEDIUM", 32).toUpperCase(), text(body.potential_severity, 32).toUpperCase() || null, dateOrNull(body.occurred_at), text(body.area, 180) || null, text(body.description, 8000) || null, enumValue(body.investigation_status, SAFETY_STATUSES.incident, "OPEN"), text(body.immediate_actions, 5000) || null, JSON.stringify(Array.isArray(body.root_causes) ? body.root_causes : []), actorId(req)
      ]);
      res.status(201).json({ status: "ok", incident: result.rows[0] });
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  app.post("/admin/control-centers/:code/safety/actions", async (req, res) => {
    try {
      const context = await resolveAdminContext(req, res); if (!context) return;
      const body = req.body || {};
      const result = await pool.query(`INSERT INTO safety_actions(control_center_id,source_type,source_id,title,description,action_type,priority,owner_user_id,owner_name,due_date,status,evidence,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) RETURNING *`, [context.center.id, text(body.source_type || "GENERAL", 40).toUpperCase(), body.source_id || null, required(body.title, "Título", 180), text(body.description, 5000) || null, text(body.action_type || "CORRECTIVE", 24).toUpperCase(), text(body.priority || "MEDIUM", 20).toUpperCase(), body.owner_user_id || null, text(body.owner_name, 180) || null, body.due_date || null, enumValue(body.status, SAFETY_STATUSES.action, "OPEN"), JSON.stringify(Array.isArray(body.evidence) ? body.evidence : []), actorId(req)]);
      res.status(201).json({ status: "ok", action: result.rows[0] });
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  app.patch("/admin/control-centers/:code/safety/actions/:id", async (req, res) => {
    try {
      const context = await resolveAdminContext(req, res); if (!context) return;
      const status = enumValue(req.body?.status, SAFETY_STATUSES.action, null);
      if (!status) return res.status(400).json({ status: "error", message: "Estado de acción inválido" });
      const result = await pool.query(`UPDATE safety_actions SET status=$3, updated_at=NOW() WHERE id=$1 AND control_center_id=$2 RETURNING *`, [req.params.id, context.center.id, status]);
      if (!result.rows.length) return res.status(404).json({ status: "error", message: "Acción no encontrada" });
      res.json({ status: "ok", action: result.rows[0] });
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  app.post("/admin/control-centers/:code/safety/inspections", async (req, res) => {
    try {
      const context = await resolveAdminContext(req, res); if (!context) return;
      const body = req.body || {};
      const result = await pool.query(`INSERT INTO safety_inspections(control_center_id,template_id,title,inspection_type,area,scheduled_at,completed_at,status,result,score,responses,findings,notes,inspector_user_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15) RETURNING *`, [context.center.id, body.template_id || null, required(body.title, "Título", 180), required(body.inspection_type, "Tipo de inspección", 80).toUpperCase(), text(body.area, 180) || null, dateOrNull(body.scheduled_at), dateOrNull(body.completed_at), enumValue(body.status, SAFETY_STATUSES.inspection, "PLANNED"), enumValue(body.result, SAFETY_STATUSES.inspectionResult, "NOT_EVALUATED"), numberOrNull(body.score, 0, 100), JSON.stringify(Array.isArray(body.responses) ? body.responses : []), JSON.stringify(Array.isArray(body.findings) ? body.findings : []), text(body.notes, 5000) || null, body.inspector_user_id || null, actorId(req)]);
      res.status(201).json({ status: "ok", inspection: result.rows[0] });
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  app.post("/admin/control-centers/:code/safety/critical-controls", async (req, res) => {
    try {
      const context = await resolveAdminContext(req, res); if (!context) return;
      const body = req.body || {};
      const result = await pool.query(`INSERT INTO safety_critical_controls(control_center_id,code,hazard,name,verification_question,performance_standard,active,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(control_center_id,code) DO UPDATE SET hazard=EXCLUDED.hazard,name=EXCLUDED.name,verification_question=EXCLUDED.verification_question,performance_standard=EXCLUDED.performance_standard,active=EXCLUDED.active,updated_at=NOW() RETURNING *`, [context.center.id, required(body.code, "Código", 50).toUpperCase(), required(body.hazard, "Peligro", 180), required(body.name, "Nombre", 180), required(body.verification_question, "Pregunta de verificación", 2000), text(body.performance_standard, 3000) || null, body.active !== false, actorId(req)]);
      res.status(201).json({ status: "ok", critical_control: result.rows[0] });
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  app.post("/admin/control-centers/:code/safety/critical-controls/:id/verifications", async (req, res) => {
    try {
      const context = await resolveAdminContext(req, res); if (!context) return;
      const body = req.body || {};
      const resultValue = enumValue(body.result, SAFETY_STATUSES.verification, null);
      if (!resultValue) return res.status(400).json({ status: "error", message: "Resultado de verificación inválido" });
      const result = await pool.query(`INSERT INTO safety_control_verifications(control_center_id,control_id,inspection_id,result,area,evidence,notes,verified_by,verified_at) SELECT $1,id,$3,$4,$5,$6::jsonb,$7,$8,COALESCE($9,NOW()) FROM safety_critical_controls WHERE id=$2 AND control_center_id=$1 RETURNING *`, [context.center.id, req.params.id, body.inspection_id || null, resultValue, text(body.area, 180) || null, JSON.stringify(Array.isArray(body.evidence) ? body.evidence : []), text(body.notes, 3000) || null, actorId(req), dateOrNull(body.verified_at)]);
      if (!result.rows.length) return res.status(404).json({ status: "error", message: "Control crítico no encontrado" });
      res.status(201).json({ status: "ok", verification: result.rows[0] });
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  app.post("/admin/control-centers/:code/safety/behavior-observations", async (req, res) => {
    try {
      const context = await resolveAdminContext(req, res); if (!context) return;
      const body = req.body || {};
      const type = enumValue(body.observation_type, SAFETY_STATUSES.observation, null);
      if (!type) return res.status(400).json({ status: "error", message: "Tipo de observación inválido" });
      const result = await pool.query(`INSERT INTO safety_behavior_observations(control_center_id,observation_type,category,area,description,feedback,anonymous,observed_at,observer_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8,NOW()),$9) RETURNING *`, [context.center.id, type, required(body.category, "Categoría", 100), text(body.area, 180) || null, required(body.description, "Descripción", 5000), text(body.feedback, 3000) || null, body.anonymous === true, dateOrNull(body.observed_at), actorId(req)]);
      res.status(201).json({ status: "ok", observation: result.rows[0] });
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  async function insertCameraEvent({ center, body, createdBy = null }) {
    return pool.query(`INSERT INTO safety_camera_events(control_center_id,provider,external_event_id,event_type,confidence,camera_id,camera_name,area,occurred_at,media_url,status,metadata,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,NOW()),$10,$11,$12::jsonb,$13) ON CONFLICT(control_center_id,provider,external_event_id) WHERE external_event_id IS NOT NULL DO UPDATE SET metadata=EXCLUDED.metadata,updated_at=NOW() RETURNING *`, [center.id, text(body.provider || "MANUAL_DEMO", 80).toUpperCase(), text(body.external_event_id, 180) || null, required(body.event_type, "Tipo de evento", 100).toUpperCase(), numberOrNull(body.confidence, 0, 1), text(body.camera_id, 120) || null, text(body.camera_name, 180) || null, text(body.area, 180) || null, dateOrNull(body.occurred_at), httpsUrlOrNull(body.media_url), enumValue(body.status, SAFETY_STATUSES.camera, "NEW"), JSON.stringify(jsonObject(body.metadata)), createdBy]);
  }

  app.post("/admin/control-centers/:code/safety/camera-events", async (req, res) => {
    try {
      const context = await resolveAdminContext(req, res); if (!context) return;
      const result = await insertCameraEvent({ center: context.center, body: req.body || {}, createdBy: actorId(req) });
      res.status(201).json({ status: "ok", camera_event: result.rows[0] });
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  app.get("/dashboard/safety/summary", async (req, res) => {
    if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Sesión de panel requerida")) return;
    try {
      await ensureSchema();
      const code = requestedControlCenterForSession(req, req.query.control_center_code);
      const center = await adminResolveControlCenter(req, code);
      if (!center) return res.status(404).json({ status: "error", message: "Centro de Control no encontrado" });
      const settingsRow = await getControlCenterSettingsById(center.id);
      const data = await listPayload(center.id, Math.min(20, Number(req.query.limit) || 10));
      res.json({ status: "ok", control_center: center, enabled: safetyEnabled(settingsRow?.settings), configuration: settingsRow?.settings?.safety_modules || {}, ...data });
    } catch (error) {
      console.error("[SAFETY DASHBOARD ERROR]", error);
      res.status(500).json({ status: "error", message: error.message });
    }
  });

  app.post("/integrations/camera-ai/events", async (req, res) => {
    const expected = process.env.CAMERA_AI_WEBHOOK_SECRET || "";
    if (!expected) return res.status(503).json({ status: "error", message: "Integración de cámaras no configurada" });
    if (req.headers["x-queltu-camera-secret"] !== expected) return res.status(401).json({ status: "error", message: "Webhook no autorizado" });
    try {
      await ensureSchema();
      const code = text(req.body?.control_center_code, 50).toUpperCase();
      const center = await adminResolveControlCenter(code);
      if (!center) return res.status(404).json({ status: "error", message: "Centro de Control no encontrado" });
      const settingsRow = await getControlCenterSettingsById(center.id);
      if (!safetyEnabled(settingsRow?.settings) || settingsRow?.settings?.safety_modules?.camera_ai !== true) {
        return res.status(403).json({
          status: "error",
          code: "CAMERA_AI_NOT_LICENSED",
          message: "La integración Camera AI no está habilitada para este Centro de Control"
        });
      }
      const result = await insertCameraEvent({ center, body: req.body || {} });
      res.status(202).json({ status: "ok", camera_event_id: result.rows[0].id });
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  ensureSchema().catch((error) => console.warn("[SAFETY SCHEMA STARTUP WARNING]", error.message));
}

module.exports = { registerSafetyModule };
