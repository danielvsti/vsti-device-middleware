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

const RISK_PHASES = new Set(["INITIAL", "RESIDUAL"]);
const FREQUENCY_SOURCES = new Set(["PROFESSIONAL_ESTIMATE", "SYSTEM_SUGGESTION"]);
const PNR_STATUSES = new Set(["DRAFT", "PUBLISHED", "ARCHIVED"]);
const PNR_TYPES = new Set(["PROCEDURE", "STANDARD", "RULE"]);
const CRITICAL_CONTROL_TYPES = new Set(["PREVENTIVE", "MITIGATING", "RECOVERY"]);
const CLOSURE_DECISIONS = new Set(["APPROVED", "REJECTED"]);
const INVESTIGATION_METHODS = new Set(["FIVE_WHYS", "ICAM", "BOW_TIE", "OTHER"]);
const MAX_PNR_BYTES = 12 * 1024 * 1024;

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

function jsonArray(value, maxItems = 50, maxBytes = 30_000) {
  if (!Array.isArray(value)) return [];
  const normalized = value.slice(0, maxItems);
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error("El detalle estructurado excede el tamaño permitido");
  }
  return normalized;
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

function riskLevel(score) {
  if (score >= 17) return "CRITICAL";
  if (score >= 10) return "HIGH";
  if (score >= 5) return "MODERATE";
  return "LOW";
}

function pnrDocumentBuffer(body = {}) {
  const raw = text(body.document_base64, 18_000_000).replace(/^data:application\/pdf;base64,/i, "");
  if (!raw) return null;
  const buffer = Buffer.from(raw, "base64");
  if (!buffer.length) throw new Error("El archivo PNR está vacío o no es Base64 válido");
  if (buffer.length > MAX_PNR_BYTES) throw new Error("El PDF PNR supera el máximo de 12 MB");
  if (buffer.subarray(0, 4).toString("ascii") !== "%PDF") throw new Error("El documento PNR debe ser un PDF válido");
  return buffer;
}

function registerSafetyModule({
  app,
  pool,
  checkAdminToken,
  checkRoleAccess,
  checkTicketParticipantAccess,
  requestedControlCenterForSession,
  adminResolveControlCenter,
  getControlCenterSettingsById,
  syncMobileEventStateFromTicket,
  releaseResolverFromTicket,
  storeUploadedMedia
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
          evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
          notes TEXT,
          inspector_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          created_by UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_safety_inspections_cc_date ON safety_inspections(control_center_id, COALESCE(scheduled_at, created_at) DESC);

        CREATE TABLE IF NOT EXISTS safety_inspection_evidence (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          inspection_id UUID NOT NULL REFERENCES safety_inspections(id) ON DELETE CASCADE,
          control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
          media_type VARCHAR(20) NOT NULL,
          file_name VARCHAR(255),
          mime_type VARCHAR(120) NOT NULL,
          size_bytes INTEGER NOT NULL,
          content BYTEA NOT NULL,
          created_by UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          CONSTRAINT safety_inspection_evidence_media_type CHECK (media_type IN ('audio','image','video'))
        );
        ALTER TABLE safety_inspection_evidence
          DROP CONSTRAINT IF EXISTS safety_inspection_evidence_media_type;
        ALTER TABLE safety_inspection_evidence
          ADD CONSTRAINT safety_inspection_evidence_media_type
          CHECK (media_type IN ('audio','image','video'));
        CREATE INDEX IF NOT EXISTS idx_safety_inspection_evidence_inspection
          ON safety_inspection_evidence(inspection_id, created_at);

        CREATE TABLE IF NOT EXISTS safety_critical_controls (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
          code VARCHAR(50) NOT NULL,
          hazard VARCHAR(180) NOT NULL,
          name VARCHAR(180) NOT NULL,
          control_type VARCHAR(32),
          work_area VARCHAR(180),
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

        ALTER TABLE users ADD COLUMN IF NOT EXISTS work_area VARCHAR(180);

        CREATE TABLE IF NOT EXISTS safety_pnr_documents (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
          code VARCHAR(80) NOT NULL,
          title VARCHAR(220) NOT NULL,
          document_type VARCHAR(24) NOT NULL DEFAULT 'PROCEDURE',
          work_area VARCHAR(180),
          version VARCHAR(40) NOT NULL,
          status VARCHAR(24) NOT NULL DEFAULT 'PUBLISHED',
          summary TEXT,
          effective_from DATE,
          effective_until DATE,
          file_name VARCHAR(255),
          mime_type VARCHAR(100),
          document_data BYTEA,
          document_url TEXT,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_by UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
          UNIQUE(control_center_id, code, version),
          CHECK (document_data IS NOT NULL OR document_url IS NOT NULL)
        );
        CREATE INDEX IF NOT EXISTS idx_safety_pnr_cc_area ON safety_pnr_documents(control_center_id, work_area, active, status);

        CREATE TABLE IF NOT EXISTS safety_ticket_risk_assessments (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
          ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
          phase VARCHAR(20) NOT NULL DEFAULT 'INITIAL',
          severity SMALLINT NOT NULL CHECK (severity BETWEEN 1 AND 5),
          frequency SMALLINT NOT NULL CHECK (frequency BETWEEN 1 AND 5),
          score SMALLINT NOT NULL CHECK (score BETWEEN 1 AND 25),
          risk_level VARCHAR(20) NOT NULL,
          frequency_source VARCHAR(40) NOT NULL DEFAULT 'PROFESSIONAL_ESTIMATE',
          suggestion_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          notes TEXT,
          assessed_by UUID REFERENCES users(id) ON DELETE SET NULL,
          assessed_at TIMESTAMP NOT NULL DEFAULT NOW(),
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_safety_ticket_risk_ticket ON safety_ticket_risk_assessments(ticket_id, assessed_at DESC);

        ALTER TABLE safety_incidents ADD COLUMN IF NOT EXISTS investigation_notes TEXT;
        ALTER TABLE safety_incidents ADD COLUMN IF NOT EXISTS recommendations TEXT;
        ALTER TABLE safety_incidents ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;
        ALTER TABLE safety_incidents ADD COLUMN IF NOT EXISTS investigation_method VARCHAR(40) DEFAULT 'FIVE_WHYS';
        ALTER TABLE safety_incidents ADD COLUMN IF NOT EXISTS problem_statement TEXT;
        ALTER TABLE safety_incidents ADD COLUMN IF NOT EXISTS event_sequence JSONB NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE safety_incidents ADD COLUMN IF NOT EXISTS immediate_causes JSONB NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE safety_incidents ADD COLUMN IF NOT EXISTS contributing_factors JSONB NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE safety_incidents ADD COLUMN IF NOT EXISTS lessons_learned TEXT;
        ALTER TABLE safety_incidents ADD COLUMN IF NOT EXISTS conclusion TEXT;
        ALTER TABLE safety_inspections ADD COLUMN IF NOT EXISTS linked_ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL;
        ALTER TABLE safety_inspections ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE safety_critical_controls ADD COLUMN IF NOT EXISTS control_type VARCHAR(32);
        ALTER TABLE safety_critical_controls ADD COLUMN IF NOT EXISTS work_area VARCHAR(180);
        ALTER TABLE safety_control_verifications ADD COLUMN IF NOT EXISTS ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_safety_critical_controls_cc_filters ON safety_critical_controls(control_center_id, work_area, control_type, active);
        CREATE INDEX IF NOT EXISTS idx_safety_inspections_ticket ON safety_inspections(linked_ticket_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_safety_control_verifications_ticket ON safety_control_verifications(ticket_id, verified_at DESC);

        CREATE TABLE IF NOT EXISTS safety_ticket_closure_requests (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
          ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
          incident_id UUID REFERENCES safety_incidents(id) ON DELETE SET NULL,
          status VARCHAR(24) NOT NULL DEFAULT 'REQUESTED',
          request_summary TEXT NOT NULL,
          requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
          requested_at TIMESTAMP NOT NULL DEFAULT NOW(),
          decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
          decided_at TIMESTAMP,
          decision_notes TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_safety_closure_requests_cc_status ON safety_ticket_closure_requests(control_center_id, status, requested_at DESC);
        CREATE INDEX IF NOT EXISTS idx_safety_closure_requests_ticket ON safety_ticket_closure_requests(ticket_id, requested_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS uq_safety_closure_request_pending_ticket ON safety_ticket_closure_requests(ticket_id) WHERE status='REQUESTED';
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
    const [incidents, actions, inspections, controls, observations, cameraEvents, pnrDocuments, stats] = await Promise.all([
      pool.query(`SELECT * FROM safety_incidents WHERE control_center_id=$1 ORDER BY occurred_at DESC LIMIT $2`, [controlCenterId, bounded]),
      pool.query(`SELECT * FROM safety_actions WHERE control_center_id=$1 ORDER BY created_at DESC LIMIT $2`, [controlCenterId, bounded]),
      pool.query(`SELECT * FROM safety_inspections WHERE control_center_id=$1 ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT $2`, [controlCenterId, bounded]),
      pool.query(`SELECT c.*, v.result AS latest_result, v.verified_at AS latest_verified_at FROM safety_critical_controls c LEFT JOIN LATERAL (SELECT result, verified_at FROM safety_control_verifications WHERE control_id=c.id ORDER BY verified_at DESC LIMIT 1) v ON TRUE WHERE c.control_center_id=$1 ORDER BY c.code LIMIT $2`, [controlCenterId, bounded]),
      pool.query(`SELECT * FROM safety_behavior_observations WHERE control_center_id=$1 ORDER BY observed_at DESC LIMIT $2`, [controlCenterId, bounded]),
      pool.query(`SELECT * FROM safety_camera_events WHERE control_center_id=$1 ORDER BY occurred_at DESC LIMIT $2`, [controlCenterId, bounded]),
      pool.query(`SELECT id,code,title,document_type,work_area,version,status,summary,effective_from,effective_until,file_name,mime_type,document_url,active,created_at,updated_at,(document_data IS NOT NULL) AS has_uploaded_file FROM safety_pnr_documents WHERE control_center_id=$1 ORDER BY active DESC, code, created_at DESC LIMIT $2`, [controlCenterId, bounded]),
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
      camera_events: cameraEvents.rows,
      pnr_documents: pnrDocuments.rows
    };
  }

  async function frequencySuggestion(controlCenterId, ticket) {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS sample_size
       FROM tickets
       WHERE control_center_id=$1
         AND alert_type=$2
         AND created_at >= NOW() - INTERVAL '365 days'`,
      [controlCenterId, ticket.alert_type]
    );
    const sampleSize = Number(result.rows[0]?.sample_size || 0);
    if (sampleSize < 5) {
      return { available: false, sample_size: sampleSize, period_days: 365, alert_type: ticket.alert_type, reason: "INSUFFICIENT_HISTORY" };
    }
    const value = sampleSize >= 52 ? 5 : sampleSize >= 12 ? 4 : sampleSize >= 4 ? 3 : sampleSize >= 2 ? 2 : 1;
    return { available: true, value, sample_size: sampleSize, period_days: 365, alert_type: ticket.alert_type, method: "ANNUAL_OCCURRENCE_BANDS_V1" };
  }

  async function ticketSafetyContext(ticketId) {
    const result = await pool.query(
      `SELECT t.id,t.control_center_id,t.title,t.description,t.state,t.priority,t.latitude,t.longitude,t.accuracy,
              t.created_at,t.updated_at,t.acknowledged_at,t.assigned_at,t.resolved_at,t.closed_at,
              t.alert_type,t.event_sector_name,t.citizen_user_id,t.assigned_resolver_id,
              cc.code AS control_center_code,cc.name AS control_center_name,
              COALESCE(u.work_area, '') AS citizen_work_area,
              u.full_name AS citizen_name,
              resolver.full_name AS resolver_name
       FROM tickets t
       JOIN control_centers cc ON cc.id=t.control_center_id
       LEFT JOIN users u ON u.id=t.citizen_user_id
       LEFT JOIN users resolver ON resolver.id=t.assigned_resolver_id
       WHERE t.id=$1`,
      [ticketId]
    );
    return result.rows[0] || null;
  }

  async function ensureTicketIncident(ticket, createdBy = null) {
    const existing = await pool.query(
      `SELECT * FROM safety_incidents WHERE linked_ticket_id=$1 ORDER BY created_at ASC LIMIT 1`,
      [ticket.id]
    );
    if (existing.rows.length) return existing.rows[0];
    const created = await pool.query(
      `INSERT INTO safety_incidents(
         control_center_id,linked_ticket_id,title,event_type,severity,occurred_at,area,description,
         investigation_status,created_by,updated_by
       ) VALUES($1,$2,$3,$4,'MEDIUM',$5,$6,$7,'OPEN',$8,$8)
       RETURNING *`,
      [
        ticket.control_center_id,
        ticket.id,
        text(ticket.title, 180) || `Caso ${String(ticket.id).slice(0, 8)}`,
        text(ticket.alert_type || "INCIDENT", 80).toUpperCase(),
        ticket.created_at || new Date().toISOString(),
        text(ticket.citizen_work_area || ticket.event_sector_name, 180) || null,
        text(ticket.description, 8000) || null,
        createdBy
      ]
    );
    return created.rows[0];
  }

  async function applicablePnr(controlCenterId, area) {
    const normalizedArea = text(area, 180);
    const result = await pool.query(
      `SELECT id,code,title,document_type,work_area,version,status,summary,effective_from,effective_until,file_name,mime_type,document_url,updated_at,
              (document_data IS NOT NULL) AS has_uploaded_file
       FROM safety_pnr_documents
       WHERE control_center_id=$1 AND active=true AND status='PUBLISHED'
         AND (effective_from IS NULL OR effective_from <= CURRENT_DATE)
         AND (effective_until IS NULL OR effective_until >= CURRENT_DATE)
         AND (work_area IS NULL OR work_area='' OR UPPER(work_area)='ALL' OR ($2 <> '' AND LOWER(work_area)=LOWER($2)))
       ORDER BY CASE WHEN work_area IS NULL OR work_area='' OR UPPER(work_area)='ALL' THEN 1 ELSE 0 END, code, version DESC`,
      [controlCenterId, normalizedArea]
    );
    return result.rows;
  }

  async function mobileSafetyContext(req, res, allowedRoles) {
    if (!checkRoleAccess(req, res, allowedRoles, "Sesión móvil requerida")) return null;
    await ensureSchema();
    const session = req.panel_session;
    const settingsRow = await getControlCenterSettingsById(session.control_center_id);
    if (!safetyEnabled(settingsRow?.settings) || String(settingsRow?.settings?.vertical || "CITY").toUpperCase() !== "MINING") {
      res.status(403).json({ status: "error", code: "SAFETY_MODULE_NOT_AVAILABLE", message: "Seguridad Operacional no está habilitada para este Centro de Control" });
      return null;
    }
    return { session, settings: settingsRow.settings };
  }

  async function professionalTicketContext(req, res, ticketId) {
    const context = await mobileSafetyContext(req, res, ["RESOLVER"]);
    if (!context) return null;
    const result = await pool.query(
      `SELECT t.id
       FROM tickets t
       WHERE t.id=$1
         AND t.control_center_id=$2
         AND (
           t.assigned_resolver_id=$3
           OR EXISTS (
             SELECT 1 FROM ticket_assignments ta
             WHERE ta.ticket_id=t.id AND ta.resolver_user_id=$3
           )
         )
       LIMIT 1`,
      [ticketId, context.session.control_center_id, context.session.sub]
    );
    if (!result.rows.length) {
      res.status(403).json({ status: "error", message: "Caso no asignado a este Profesional HSE" });
      return null;
    }
    return context;
  }

  async function updateInvestigation(ticket, incident, body, actor) {
    if (String(incident.investigation_status || "").toUpperCase() === "CLOSED") {
      throw new Error("La investigación ya fue cerrada por el Supervisor HSE");
    }
    const status = enumValue(body?.investigation_status, SAFETY_STATUSES.incident, "INVESTIGATING");
    if (status === "CLOSED") throw new Error("El cierre debe ser aprobado por el Supervisor HSE");
    const method = enumValue(body?.investigation_method, INVESTIGATION_METHODS, "FIVE_WHYS");
    const rootCauses = jsonArray(body?.root_causes, 30);
    const eventSequence = jsonArray(body?.event_sequence, 100, 60_000);
    const immediateCauses = jsonArray(body?.immediate_causes, 40);
    const contributingFactors = jsonArray(body?.contributing_factors, 40);
    const result = await pool.query(
      `UPDATE safety_incidents SET
         description=COALESCE($2,description),
         immediate_actions=$3,
         root_causes=$4::jsonb,
         investigation_notes=$5,
         recommendations=$6,
         investigation_status=$7,
         investigation_method=$8,
         problem_statement=$9,
         event_sequence=$10::jsonb,
         immediate_causes=$11::jsonb,
         contributing_factors=$12::jsonb,
         lessons_learned=$13,
         conclusion=$14,
         updated_by=$15,
         updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [
        incident.id,
        text(body?.description, 8000) || null,
        text(body?.immediate_actions, 8000) || null,
        JSON.stringify(rootCauses),
        text(body?.investigation_notes, 12000) || null,
        text(body?.recommendations, 8000) || null,
        status,
        method,
        text(body?.problem_statement, 8000) || null,
        JSON.stringify(eventSequence),
        JSON.stringify(immediateCauses),
        JSON.stringify(contributingFactors),
        text(body?.lessons_learned, 8000) || null,
        text(body?.conclusion, 8000) || null,
        actor
      ]
    );
    await pool.query(
      `INSERT INTO ticket_actions(ticket_id,actor_user_id,actor_role,action_type,description,metadata)
       VALUES($1,$2,'RESOLVER','HSE_INVESTIGATION_UPDATED',$3,$4::jsonb)`,
      [ticket.id, actor, "Profesional HSE actualizó la investigación del caso", JSON.stringify({ incident_id: incident.id, investigation_status: status, investigation_method: method })]
    );
    return result.rows[0];
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

  app.post("/admin/control-centers/:code/safety/pnr", async (req, res) => {
    try {
      const context = await resolveAdminContext(req, res); if (!context) return;
      const body = req.body || {};
      const documentData = pnrDocumentBuffer(body);
      const documentUrl = httpsUrlOrNull(body.document_url);
      if (!documentData && !documentUrl) throw new Error("Debes cargar un PDF o indicar una URL HTTPS");
      const status = enumValue(body.status, PNR_STATUSES, "PUBLISHED");
      const result = await pool.query(
        `INSERT INTO safety_pnr_documents(control_center_id,code,title,document_type,work_area,version,status,summary,effective_from,effective_until,file_name,mime_type,document_data,document_url,active,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT(control_center_id,code,version) DO UPDATE SET title=EXCLUDED.title,document_type=EXCLUDED.document_type,work_area=EXCLUDED.work_area,status=EXCLUDED.status,summary=EXCLUDED.summary,effective_from=EXCLUDED.effective_from,effective_until=EXCLUDED.effective_until,file_name=COALESCE(EXCLUDED.file_name,safety_pnr_documents.file_name),mime_type=COALESCE(EXCLUDED.mime_type,safety_pnr_documents.mime_type),document_data=COALESCE(EXCLUDED.document_data,safety_pnr_documents.document_data),document_url=COALESCE(EXCLUDED.document_url,safety_pnr_documents.document_url),active=EXCLUDED.active,updated_at=NOW()
         RETURNING id,code,title,document_type,work_area,version,status,summary,effective_from,effective_until,file_name,mime_type,document_url,active,created_at,updated_at,(document_data IS NOT NULL) AS has_uploaded_file`,
        [context.center.id, required(body.code, "Código", 80).toUpperCase(), required(body.title, "Título", 220), enumValue(body.document_type, PNR_TYPES, "PROCEDURE"), text(body.work_area, 180) || null, required(body.version, "Versión", 40), status, text(body.summary, 5000) || null, body.effective_from || null, body.effective_until || null, text(body.file_name, 255) || (documentData ? `${text(body.code, 80) || "PNR"}.pdf` : null), documentData ? "application/pdf" : text(body.mime_type, 100) || null, documentData, documentUrl, body.active !== false, actorId(req)]
      );
      res.status(201).json({ status: "ok", pnr_document: result.rows[0] });
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  app.patch("/admin/control-centers/:code/safety/pnr/:id", async (req, res) => {
    try {
      const context = await resolveAdminContext(req, res); if (!context) return;
      const body = req.body || {};
      const has = field => Object.prototype.hasOwnProperty.call(body, field);
      const status = has("status") ? enumValue(body.status, PNR_STATUSES, null) : null;
      const documentType = has("document_type") ? enumValue(body.document_type, PNR_TYPES, null) : null;
      if (has("status") && !status) throw new Error("Estado PNR inválido");
      if (has("document_type") && !documentType) throw new Error("Tipo PNR inválido");
      const documentData = has("document_base64") ? pnrDocumentBuffer(body) : null;
      const requestedDocumentUrl = has("document_url") && body.document_url ? httpsUrlOrNull(body.document_url) : null;
      const documentUrl = documentData ? null : requestedDocumentUrl;
      const replaceDocument = Boolean(documentData || documentUrl);
      const assignments = [];
      const values = [req.params.id, context.center.id];
      const assign = (column, value, cast = "") => {
        values.push(value);
        assignments.push(`${column}=$${values.length}${cast}`);
      };
      if (has("code")) assign("code", required(body.code, "Código", 80).toUpperCase());
      if (has("title")) assign("title", required(body.title, "Título", 220));
      if (has("document_type")) assign("document_type", documentType);
      if (has("work_area")) assign("work_area", text(body.work_area, 180) || null);
      if (has("version")) assign("version", required(body.version, "Versión", 40));
      if (has("summary")) assign("summary", text(body.summary, 5000) || null);
      if (has("effective_from")) assign("effective_from", body.effective_from || null, "::date");
      if (has("effective_until")) assign("effective_until", body.effective_until || null, "::date");
      if (has("status")) assign("status", status);
      if (has("active")) assign("active", typeof body.active === "boolean" ? body.active : true);
      if (replaceDocument) {
        assign("file_name", documentData ? text(body.file_name, 255) || `${text(body.code, 80) || "PNR"}.pdf` : null);
        assign("mime_type", documentData ? "application/pdf" : null);
        assign("document_data", documentData, "::bytea");
        assign("document_url", documentUrl);
      }
      if (!assignments.length) throw new Error("No hay cambios para guardar");
      const result = await pool.query(
        `UPDATE safety_pnr_documents SET ${assignments.join(",")},updated_at=NOW() WHERE id=$1 AND control_center_id=$2 RETURNING id,code,title,document_type,work_area,version,status,summary,effective_from,effective_until,file_name,mime_type,document_url,active,created_at,updated_at,(document_data IS NOT NULL) AS has_uploaded_file`,
        values
      );
      if (!result.rows.length) return res.status(404).json({ status: "error", message: "PNR no encontrado" });
      res.json({ status: "ok", pnr_document: result.rows[0] });
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  app.get("/admin/control-centers/:code/safety/pnr/:id/content", async (req, res) => {
    try {
      const context = await resolveAdminContext(req, res); if (!context) return;
      const result = await pool.query(`SELECT file_name,mime_type,document_data,document_url FROM safety_pnr_documents WHERE id=$1 AND control_center_id=$2`, [req.params.id, context.center.id]);
      if (!result.rows.length) return res.status(404).send("PNR no encontrado");
      const document = result.rows[0];
      if (document.document_data) {
        const safeFileName = (text(document.file_name, 180) || "pnr.pdf").replace(/["\r\n\\]/g, "_");
        res.setHeader("Content-Type", document.mime_type || "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${safeFileName}"`);
        res.setHeader("Cache-Control", "private, no-store");
        return res.send(document.document_data);
      }
      if (document.document_url) return res.redirect(302, document.document_url);
      return res.status(404).send("El PNR no tiene un documento disponible");
    } catch (error) { res.status(500).send(error.message); }
  });

  app.get("/mobile/safety/pnr", async (req, res) => {
    try {
      const context = await mobileSafetyContext(req, res, ["NEIGHBOR", "RESOLVER", "ADMIN", "SUPER_ADMIN"]); if (!context) return;
      let area = "";
      if (req.query.ticket_id) {
        if (!(await checkTicketParticipantAccess(req, res, req.query.ticket_id))) return;
        const ticket = await ticketSafetyContext(req.query.ticket_id);
        if (!ticket) return res.status(404).json({ status: "error", message: "Ticket no encontrado" });
        area = ticket.citizen_work_area || ticket.event_sector_name || "";
      } else {
        const userResult = await pool.query(`SELECT work_area FROM users WHERE id=$1 AND control_center_id=$2`, [context.session.sub, context.session.control_center_id]);
        area = userResult.rows[0]?.work_area || "";
      }
      const documents = await applicablePnr(context.session.control_center_id, area);
      res.json({ status: "ok", enabled: true, vertical: "MINING", work_area: area || null, documents });
    } catch (error) { res.status(500).json({ status: "error", message: error.message }); }
  });

  app.get("/mobile/safety/pnr/:id/content", async (req, res) => {
    try {
      const context = await mobileSafetyContext(req, res, ["NEIGHBOR", "RESOLVER", "ADMIN", "SUPER_ADMIN"]); if (!context) return;
      const result = await pool.query(`SELECT file_name,mime_type,document_data,document_url FROM safety_pnr_documents WHERE id=$1 AND control_center_id=$2 AND active=true AND status='PUBLISHED'`, [req.params.id, context.session.control_center_id]);
      if (!result.rows.length) return res.status(404).send("PNR no encontrado");
      const document = result.rows[0];
      if (document.document_data) {
        res.setHeader("Content-Type", document.mime_type || "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${text(document.file_name || "PNR.pdf", 200).replace(/[\"\\]/g, "_")}"`);
        res.setHeader("Cache-Control", "private, max-age=300");
        return res.send(document.document_data);
      }
      return res.redirect(302, document.document_url);
    } catch (error) { res.status(500).send(error.message); }
  });

  app.get("/hse/professional/cases", async (req, res) => {
    try {
      const context = await mobileSafetyContext(req, res, ["RESOLVER"]); if (!context) return;
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
      const status = text(req.query.status, 32).toUpperCase();
      const search = text(req.query.q, 120);
      const result = await pool.query(
        `SELECT
           t.id,t.title,t.description,t.alert_type,t.state,t.priority,t.latitude,t.longitude,
           t.event_sector_name,t.created_at,t.updated_at,t.resolved_at,t.closed_at,
           citizen.full_name AS citizen_name,citizen.phone AS citizen_phone,
           COALESCE(incident.id::text,'') AS incident_id,
           COALESCE(incident.investigation_status,'OPEN') AS investigation_status,
           incident.investigation_method,incident.area,incident.problem_statement,incident.updated_at AS investigation_updated_at,
           initial_risk.score AS initial_risk_score,initial_risk.risk_level AS initial_risk_level,
           residual_risk.score AS residual_risk_score,residual_risk.risk_level AS residual_risk_level,
           closure.status AS closure_status,closure.requested_at AS closure_requested_at,
           COALESCE(action_stats.open_actions,0)::int AS open_actions,
           COALESCE(action_stats.overdue_actions,0)::int AS overdue_actions
         FROM tickets t
         LEFT JOIN users citizen ON citizen.id=t.citizen_user_id
         LEFT JOIN LATERAL (
           SELECT si.* FROM safety_incidents si WHERE si.linked_ticket_id=t.id ORDER BY si.created_at ASC LIMIT 1
         ) incident ON true
         LEFT JOIN LATERAL (
           SELECT score,risk_level FROM safety_ticket_risk_assessments r WHERE r.ticket_id=t.id AND r.phase='INITIAL' ORDER BY r.assessed_at DESC LIMIT 1
         ) initial_risk ON true
         LEFT JOIN LATERAL (
           SELECT score,risk_level FROM safety_ticket_risk_assessments r WHERE r.ticket_id=t.id AND r.phase='RESIDUAL' ORDER BY r.assessed_at DESC LIMIT 1
         ) residual_risk ON true
         LEFT JOIN LATERAL (
           SELECT status,requested_at FROM safety_ticket_closure_requests c WHERE c.ticket_id=t.id ORDER BY c.requested_at DESC LIMIT 1
         ) closure ON true
         LEFT JOIN LATERAL (
           SELECT
             COUNT(*) FILTER (WHERE a.status IN ('OPEN','IN_PROGRESS'))::int AS open_actions,
             COUNT(*) FILTER (WHERE a.status IN ('OPEN','IN_PROGRESS') AND a.due_date < CURRENT_DATE)::int AS overdue_actions
           FROM safety_actions a WHERE a.source_id=incident.id
         ) action_stats ON true
         WHERE t.control_center_id=$2
           AND (
             t.assigned_resolver_id=$1
             OR EXISTS (SELECT 1 FROM ticket_assignments ta WHERE ta.ticket_id=t.id AND ta.resolver_user_id=$1)
           )
           AND (
             $4='' OR
             ($4='ACTIVE' AND COALESCE(incident.investigation_status,'OPEN') <> 'CLOSED') OR
             COALESCE(incident.investigation_status,'OPEN')=$4
           )
           AND (
             $5='' OR t.title ILIKE '%' || $5 || '%' OR t.alert_type ILIKE '%' || $5 || '%' OR
             COALESCE(t.event_sector_name,'') ILIKE '%' || $5 || '%' OR COALESCE(citizen.full_name,'') ILIKE '%' || $5 || '%'
           )
         ORDER BY
           CASE COALESCE(incident.investigation_status,'OPEN') WHEN 'OPEN' THEN 0 WHEN 'INVESTIGATING' THEN 1 WHEN 'ACTION_PLAN' THEN 2 ELSE 3 END,
           COALESCE(incident.updated_at,t.updated_at,t.created_at) DESC
         LIMIT $3`,
        [context.session.sub, context.session.control_center_id, limit, status, search]
      );
      res.json({ status: "ok", cases: result.rows, count: result.rows.length });
    } catch (error) { res.status(500).json({ status: "error", message: error.message }); }
  });

  app.get("/hse/professional/tickets/:ticketId/workspace", async (req, res) => {
    try {
      const context = await professionalTicketContext(req, res, req.params.ticketId); if (!context) return;
      const ticket = await ticketSafetyContext(req.params.ticketId);
      if (!ticket) return res.status(404).json({ status: "error", message: "Ticket no encontrado" });
      const incident = await ensureTicketIncident(ticket, actorId(req));
      const [documents, assessments, suggestion, closure, controls, inspections, verifications, actions, timeline, notes, reports, voiceSessions] = await Promise.all([
        applicablePnr(ticket.control_center_id, ticket.citizen_work_area || ticket.event_sector_name || ""),
        pool.query(`SELECT r.*,u.full_name AS assessed_by_name FROM safety_ticket_risk_assessments r LEFT JOIN users u ON u.id=r.assessed_by WHERE r.ticket_id=$1 ORDER BY r.assessed_at DESC`, [ticket.id]),
        frequencySuggestion(ticket.control_center_id, ticket),
        pool.query(`SELECT c.*,requester.full_name AS requested_by_name,decider.full_name AS decided_by_name FROM safety_ticket_closure_requests c LEFT JOIN users requester ON requester.id=c.requested_by LEFT JOIN users decider ON decider.id=c.decided_by WHERE c.ticket_id=$1 ORDER BY c.requested_at DESC LIMIT 1`, [ticket.id]),
        pool.query(`SELECT id,code,hazard,name,control_type,work_area,verification_question,performance_standard,active FROM safety_critical_controls WHERE control_center_id=$1 AND active=true ORDER BY code`, [ticket.control_center_id]),
        pool.query(`SELECT * FROM safety_inspections WHERE linked_ticket_id=$1 ORDER BY created_at DESC`, [ticket.id]),
        pool.query(`SELECT v.*,c.code AS control_code,c.name AS control_name FROM safety_control_verifications v JOIN safety_critical_controls c ON c.id=v.control_id WHERE v.ticket_id=$1 ORDER BY v.verified_at DESC`, [ticket.id]),
        pool.query(`SELECT a.*,owner.full_name AS owner_user_name FROM safety_actions a LEFT JOIN users owner ON owner.id=a.owner_user_id WHERE a.control_center_id=$1 AND a.source_id=$2 ORDER BY a.created_at DESC`, [ticket.control_center_id, incident.id]),
        pool.query(`SELECT ta.id,ta.action_type,ta.actor_role,ta.description,ta.metadata,ta.created_at,u.full_name AS actor_name FROM ticket_actions ta LEFT JOIN users u ON u.id=ta.actor_user_id WHERE ta.ticket_id=$1 ORDER BY ta.created_at ASC`, [ticket.id]),
        pool.query(`SELECT tn.id,tn.note,tn.created_at,u.full_name AS author_name FROM ticket_notes tn LEFT JOIN users u ON u.id=tn.author_user_id WHERE tn.ticket_id=$1 ORDER BY tn.created_at ASC`, [ticket.id]),
        pool.query(`SELECT id,reporter_name,reporter_phone,latitude,longitude,accuracy,alert_type,title,description,is_primary_report,created_at FROM ticket_reports WHERE ticket_id=$1 ORDER BY created_at ASC`, [ticket.id]),
        pool.query(`SELECT id,status,target_type,requested_by,started_at,connected_at,ended_at,duration_seconds,recording_url,created_at FROM ticket_voice_sessions WHERE ticket_id=$1 ORDER BY created_at DESC LIMIT 20`, [ticket.id])
      ]);
      res.json({
        status: "ok",
        ticket,
        incident,
        pnr_documents: documents,
        risk_assessments: assessments.rows,
        frequency_suggestion: suggestion,
        closure_request: closure.rows[0] || null,
        critical_controls: controls.rows,
        inspections: inspections.rows,
        control_verifications: verifications.rows,
        corrective_actions: actions.rows,
        timeline: timeline.rows,
        notes: notes.rows,
        reports: reports.rows,
        voice_sessions: voiceSessions.rows,
        scale: { severity: { 1: "Leve", 2: "Menor", 3: "Seria", 4: "Grave", 5: "Crítica" }, frequency: { 1: "Rara", 2: "Poco probable", 3: "Posible", 4: "Probable", 5: "Frecuente" } }
      });
    } catch (error) { res.status(500).json({ status: "error", message: error.message }); }
  });

  app.patch("/hse/professional/tickets/:ticketId/investigation", async (req, res) => {
    try {
      const context = await professionalTicketContext(req, res, req.params.ticketId); if (!context) return;
      const ticket = await ticketSafetyContext(req.params.ticketId);
      if (!ticket) return res.status(404).json({ status: "error", message: "Ticket no encontrado" });
      const incident = await ensureTicketIncident(ticket, actorId(req));
      const updated = await updateInvestigation(ticket, incident, req.body || {}, actorId(req));
      res.json({ status: "ok", incident: updated });
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  app.post("/hse/professional/tickets/:ticketId/actions", async (req, res) => {
    try {
      const context = await professionalTicketContext(req, res, req.params.ticketId); if (!context) return;
      const ticket = await ticketSafetyContext(req.params.ticketId);
      if (!ticket) return res.status(404).json({ status: "error", message: "Ticket no encontrado" });
      const incident = await ensureTicketIncident(ticket, actorId(req));
      const body = req.body || {};
      const actionType = enumValue(body.action_type, new Set(["CORRECTIVE", "PREVENTIVE"]), "CORRECTIVE");
      const priority = enumValue(body.priority, new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]), "MEDIUM");
      const result = await pool.query(
        `INSERT INTO safety_actions(control_center_id,source_type,source_id,title,description,action_type,priority,owner_name,due_date,status,evidence,created_by)
         VALUES($1,'HSE_INVESTIGATION',$2,$3,$4,$5,$6,$7,$8,'OPEN',$9::jsonb,$10) RETURNING *`,
        [ticket.control_center_id, incident.id, required(body.title, "Título", 180), text(body.description, 5000) || null, actionType, priority, text(body.owner_name, 180) || null, body.due_date || null, JSON.stringify(jsonArray(body.evidence, 20)), actorId(req)]
      );
      await pool.query(
        `INSERT INTO ticket_actions(ticket_id,actor_user_id,actor_role,action_type,description,metadata)
         VALUES($1,$2,'RESOLVER','HSE_ACTION_CREATED',$3,$4::jsonb)`,
        [ticket.id, actorId(req), "Profesional HSE creó una acción correctiva/preventiva", JSON.stringify({ safety_action_id: result.rows[0].id, priority })]
      );
      res.status(201).json({ status: "ok", action: result.rows[0] });
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  app.patch("/hse/professional/tickets/:ticketId/actions/:actionId", async (req, res) => {
    try {
      const context = await professionalTicketContext(req, res, req.params.ticketId); if (!context) return;
      const status = enumValue(req.body?.status, SAFETY_STATUSES.action, null);
      if (!status) throw new Error("Estado de acción inválido");
      const result = await pool.query(
        `UPDATE safety_actions a SET status=$4,updated_at=NOW()
         FROM safety_incidents i
         WHERE a.id=$1 AND a.control_center_id=$2 AND a.source_id=i.id AND i.linked_ticket_id=$3
         RETURNING a.*`,
        [req.params.actionId, context.session.control_center_id, req.params.ticketId, status]
      );
      if (!result.rows.length) return res.status(404).json({ status: "error", message: "Acción no encontrada" });
      res.json({ status: "ok", action: result.rows[0] });
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  app.post("/hse/professional/tickets/:ticketId/risk", async (req, res) => {
    try {
      const context = await professionalTicketContext(req, res, req.params.ticketId); if (!context) return;
      const ticket = await ticketSafetyContext(req.params.ticketId);
      if (!ticket) return res.status(404).json({ status: "error", message: "Ticket no encontrado" });
      const severity = numberOrNull(req.body?.severity, 1, 5);
      const frequency = numberOrNull(req.body?.frequency, 1, 5);
      if (!Number.isInteger(severity) || !Number.isInteger(frequency)) throw new Error("Gravedad y frecuencia deben ser enteros entre 1 y 5");
      const phase = enumValue(req.body?.phase, RISK_PHASES, "INITIAL");
      const frequencySource = enumValue(req.body?.frequency_source, FREQUENCY_SOURCES, "PROFESSIONAL_ESTIMATE");
      const suggestion = await frequencySuggestion(ticket.control_center_id, ticket);
      if (frequencySource === "SYSTEM_SUGGESTION" && (!suggestion.available || Number(suggestion.value) !== frequency)) {
        throw new Error("La frecuencia seleccionada no coincide con una sugerencia estadística vigente");
      }
      const score = severity * frequency;
      const result = await pool.query(
        `INSERT INTO safety_ticket_risk_assessments(control_center_id,ticket_id,phase,severity,frequency,score,risk_level,frequency_source,suggestion_metadata,notes,assessed_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) RETURNING *`,
        [ticket.control_center_id, ticket.id, phase, severity, frequency, score, riskLevel(score), frequencySource, JSON.stringify(suggestion), text(req.body?.notes, 5000) || null, actorId(req)]
      );
      const incident = await ensureTicketIncident(ticket, actorId(req));
      await pool.query(
        `INSERT INTO ticket_actions(ticket_id,actor_user_id,actor_role,action_type,description,metadata)
         VALUES($1,$2,'RESOLVER','HSE_RISK_ASSESSED',$3,$4::jsonb)`,
        [ticket.id, actorId(req), `Profesional HSE registró evaluación de riesgo ${phase === "RESIDUAL" ? "residual" : "inicial"}`, JSON.stringify({ incident_id: incident.id, risk_assessment_id: result.rows[0].id, phase, score, risk_level: riskLevel(score) })]
      );
      res.status(201).json({ status: "ok", risk_assessment: result.rows[0], frequency_suggestion: suggestion });
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  app.post("/hse/professional/tickets/:ticketId/closure-request", async (req, res) => {
    try {
      const context = await professionalTicketContext(req, res, req.params.ticketId); if (!context) return;
      const ticket = await ticketSafetyContext(req.params.ticketId);
      if (!ticket) return res.status(404).json({ status: "error", message: "Ticket no encontrado" });
      const residualRisk = await pool.query(
        `SELECT id,score,risk_level FROM safety_ticket_risk_assessments WHERE ticket_id=$1 AND phase='RESIDUAL' ORDER BY assessed_at DESC LIMIT 1`,
        [ticket.id]
      );
      if (!residualRisk.rows.length) throw new Error("Registra la evaluación de riesgo residual antes de solicitar el cierre");
      const incident = await ensureTicketIncident(ticket, actorId(req));
      if (String(incident.investigation_status || "").toUpperCase() === "CLOSED") {
        return res.status(409).json({ status: "error", message: "La investigación ya fue cerrada por el Supervisor HSE" });
      }
      const requestSummary = required(req.body?.request_summary, "Resumen de cierre", 6000);
      const result = await pool.query(
        `INSERT INTO safety_ticket_closure_requests(control_center_id,ticket_id,incident_id,status,request_summary,requested_by)
         VALUES($1,$2,$3,'REQUESTED',$4,$5)
         ON CONFLICT(ticket_id) WHERE status='REQUESTED'
         DO UPDATE SET incident_id=EXCLUDED.incident_id,request_summary=EXCLUDED.request_summary,
                       requested_by=EXCLUDED.requested_by,requested_at=NOW(),updated_at=NOW()
         RETURNING *`,
        [ticket.control_center_id, ticket.id, incident.id, requestSummary, actorId(req)]
      );
      await pool.query(`UPDATE safety_incidents SET investigation_status='ACTION_PLAN',updated_by=$2,updated_at=NOW() WHERE id=$1`, [incident.id, actorId(req)]);
      await pool.query(
        `INSERT INTO ticket_actions(ticket_id,actor_user_id,actor_role,action_type,description,metadata)
         VALUES($1,$2,'RESOLVER','HSE_CLOSURE_REQUESTED',$3,$4::jsonb)`,
        [ticket.id, actorId(req), "Profesional HSE solicitó aprobación del cierre desde el portal de investigación", JSON.stringify({ closure_request_id: result.rows[0].id, residual_risk: residualRisk.rows[0] })]
      );
      res.status(201).json({ status: "ok", closure_request: result.rows[0] });
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  app.get("/resolver/tickets/:ticketId/safety", async (req, res) => {
    try {
      const context = await mobileSafetyContext(req, res, ["RESOLVER", "ADMIN", "SUPER_ADMIN"]); if (!context) return;
      if (!(await checkTicketParticipantAccess(req, res, req.params.ticketId))) return;
      const ticket = await ticketSafetyContext(req.params.ticketId);
      if (!ticket) return res.status(404).json({ status: "error", message: "Ticket no encontrado" });
      const [documents, assessments, suggestion, incidentResult, closureResult, controlsResult, inspectionsResult, verificationsResult] = await Promise.all([
        applicablePnr(ticket.control_center_id, ticket.citizen_work_area || ticket.event_sector_name || ""),
        pool.query(`SELECT r.*,u.full_name AS assessed_by_name FROM safety_ticket_risk_assessments r LEFT JOIN users u ON u.id=r.assessed_by WHERE r.ticket_id=$1 ORDER BY r.assessed_at DESC`, [ticket.id]),
        frequencySuggestion(ticket.control_center_id, ticket),
        pool.query(`SELECT * FROM safety_incidents WHERE linked_ticket_id=$1 ORDER BY created_at ASC LIMIT 1`, [ticket.id]),
        pool.query(`SELECT c.*, requester.full_name AS requested_by_name, decider.full_name AS decided_by_name FROM safety_ticket_closure_requests c LEFT JOIN users requester ON requester.id=c.requested_by LEFT JOIN users decider ON decider.id=c.decided_by WHERE c.ticket_id=$1 ORDER BY c.requested_at DESC LIMIT 1`, [ticket.id]),
        pool.query(`SELECT id,code,hazard,name,control_type,work_area,verification_question,performance_standard,active FROM safety_critical_controls WHERE control_center_id=$1 AND active=true ORDER BY code`, [ticket.control_center_id]),
        pool.query(`SELECT * FROM safety_inspections WHERE linked_ticket_id=$1 ORDER BY created_at DESC`, [ticket.id]),
        pool.query(`SELECT v.*,c.code AS control_code,c.name AS control_name FROM safety_control_verifications v JOIN safety_critical_controls c ON c.id=v.control_id WHERE v.ticket_id=$1 ORDER BY v.verified_at DESC`, [ticket.id])
      ]);
      res.json({
        status: "ok",
        ticket: {
          id: ticket.id,
          title: ticket.title,
          state: ticket.state,
          alert_type: ticket.alert_type,
          work_area: ticket.citizen_work_area || ticket.event_sector_name || null,
          citizen_name: ticket.citizen_name || null,
          resolver_name: ticket.resolver_name || null
        },
        pnr_documents: documents,
        risk_assessments: assessments.rows,
        incident: incidentResult.rows[0] || null,
        closure_request: closureResult.rows[0] || null,
        critical_controls: controlsResult.rows,
        inspections: inspectionsResult.rows,
        control_verifications: verificationsResult.rows,
        frequency_suggestion: suggestion,
        scale: { severity: { 1: "Leve", 2: "Menor", 3: "Seria", 4: "Grave", 5: "Crítica" }, frequency: { 1: "Rara", 2: "Poco probable", 3: "Posible", 4: "Probable", 5: "Frecuente" } }
      });
    } catch (error) { res.status(500).json({ status: "error", message: error.message }); }
  });

  app.post("/resolver/tickets/:ticketId/safety/risk", async (req, res) => {
    try {
      const context = await mobileSafetyContext(req, res, ["RESOLVER", "ADMIN", "SUPER_ADMIN"]); if (!context) return;
      if (!(await checkTicketParticipantAccess(req, res, req.params.ticketId))) return;
      const ticket = await ticketSafetyContext(req.params.ticketId);
      if (!ticket) return res.status(404).json({ status: "error", message: "Ticket no encontrado" });
      const severity = numberOrNull(req.body?.severity, 1, 5);
      const frequency = numberOrNull(req.body?.frequency, 1, 5);
      if (!Number.isInteger(severity) || !Number.isInteger(frequency)) throw new Error("Gravedad y frecuencia deben ser enteros entre 1 y 5");
      const phase = enumValue(req.body?.phase, RISK_PHASES, "INITIAL");
      const frequencySource = enumValue(req.body?.frequency_source, FREQUENCY_SOURCES, "PROFESSIONAL_ESTIMATE");
      const suggestion = await frequencySuggestion(ticket.control_center_id, ticket);
      if (frequencySource === "SYSTEM_SUGGESTION" && (!suggestion.available || Number(suggestion.value) !== frequency)) throw new Error("La frecuencia seleccionada no coincide con una sugerencia estadística vigente");
      const score = severity * frequency;
      const result = await pool.query(
        `INSERT INTO safety_ticket_risk_assessments(control_center_id,ticket_id,phase,severity,frequency,score,risk_level,frequency_source,suggestion_metadata,notes,assessed_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) RETURNING *`,
        [ticket.control_center_id, ticket.id, phase, severity, frequency, score, riskLevel(score), frequencySource, JSON.stringify(suggestion), text(req.body?.notes, 5000) || null, actorId(req)]
      );
      await pool.query(
        `INSERT INTO safety_incidents(control_center_id,linked_ticket_id,title,event_type,severity,occurred_at,area,description,investigation_status,created_by)
         SELECT t.control_center_id,t.id,t.title,t.alert_type,$2,t.created_at,t.event_sector_name,t.description,'OPEN',$3 FROM tickets t WHERE t.id=$1
         AND NOT EXISTS(SELECT 1 FROM safety_incidents si WHERE si.linked_ticket_id=t.id)`,
        [ticket.id, ({ LOW: "LOW", MODERATE: "MEDIUM", HIGH: "HIGH", CRITICAL: "CRITICAL" })[riskLevel(score)], actorId(req)]
      );
      res.status(201).json({ status: "ok", risk_assessment: result.rows[0], frequency_suggestion: suggestion });
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  app.patch("/resolver/tickets/:ticketId/safety/investigation", async (req, res) => {
    try {
      const context = await mobileSafetyContext(req, res, ["RESOLVER", "ADMIN", "SUPER_ADMIN"]); if (!context) return;
      if (!(await checkTicketParticipantAccess(req, res, req.params.ticketId))) return;
      const ticket = await ticketSafetyContext(req.params.ticketId);
      if (!ticket) return res.status(404).json({ status: "error", message: "Ticket no encontrado" });
      if (["RESOLVED", "CLOSED", "CANCELLED"].includes(String(ticket.state || "").toUpperCase())) {
        return res.status(409).json({ status: "error", message: "El caso ya está finalizado y no admite cambios operativos" });
      }
      const incident = await ensureTicketIncident(ticket, actorId(req));
      const updated = await updateInvestigation(ticket, incident, req.body || {}, actorId(req));
      res.json({ status: "ok", incident: updated });
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  app.get("/resolver/safety/inspections", async (req, res) => {
    try {
      const context = await mobileSafetyContext(req, res, ["RESOLVER"]); if (!context) return;
      const limit = Math.max(1, Math.min(30, Number(req.query.limit) || 10));
      const result = await pool.query(
        `SELECT id,title,inspection_type,area,completed_at,status,result,score,notes,evidence,created_at,updated_at
         FROM safety_inspections
         WHERE control_center_id=$1 AND inspector_user_id=$2 AND linked_ticket_id IS NULL
         ORDER BY COALESCE(completed_at, created_at) DESC
         LIMIT $3`,
        [context.session.control_center_id, context.session.sub, limit]
      );
      res.json({ status: "ok", inspections: result.rows });
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  app.post("/resolver/safety/inspections", async (req, res) => {
    try {
      const context = await mobileSafetyContext(req, res, ["RESOLVER"]); if (!context) return;
      const body = req.body || {};
      const textEvidence = jsonArray(body.text_evidence, 30, 100_000)
        .map((item) => ({
          media_type: "text",
          text: text(item?.text, 3000),
          created_at: dateOrNull(item?.created_at) || new Date().toISOString(),
          created_by: actorId(req)
        }))
        .filter((item) => item.text);
      const result = await pool.query(
        `INSERT INTO safety_inspections(
           control_center_id,title,inspection_type,area,completed_at,status,result,score,
           responses,findings,evidence,notes,inspector_user_id,created_by
         ) VALUES($1,$2,$3,$4,NOW(),'COMPLETED',$5,$6,'[]'::jsonb,'[]'::jsonb,$7::jsonb,$8,$9,$9)
         RETURNING *`,
        [
          context.session.control_center_id,
          required(body.title, "Título de inspección", 180),
          text(body.inspection_type || "ROUTINE_INSPECTION", 80).toUpperCase(),
          text(body.area, 180) || null,
          enumValue(body.result, SAFETY_STATUSES.inspectionResult, "NOT_EVALUATED"),
          numberOrNull(body.score, 0, 100),
          JSON.stringify(textEvidence),
          text(body.notes, 5000) || null,
          actorId(req)
        ]
      );
      res.status(201).json({ status: "ok", inspection: result.rows[0] });
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  app.post("/resolver/safety/inspections/:inspectionId/evidence", async (req, res) => {
    try {
      const context = await mobileSafetyContext(req, res, ["RESOLVER"]); if (!context) return;
      if (typeof storeUploadedMedia !== "function") throw new Error("Almacenamiento de evidencia no configurado");
      const inspection = await pool.query(
        `SELECT id FROM safety_inspections
         WHERE id=$1 AND control_center_id=$2 AND inspector_user_id=$3 AND linked_ticket_id IS NULL
         LIMIT 1`,
        [req.params.inspectionId, context.session.control_center_id, context.session.sub]
      );
      if (!inspection.rows.length) return res.status(404).json({ status: "error", message: "Inspección no encontrada" });

      const mediaType = text(req.body?.media_type, 20).toLowerCase();
      if (!["audio", "image", "video"].includes(mediaType)) throw new Error("La evidencia debe ser audio, foto o video");
      const uploaded = storeUploadedMedia(req, {
        scopeId: req.params.inspectionId,
        mediaType,
        dataUrl: req.body?.data_url,
        fileName: text(req.body?.file_name, 255) || null,
        prefix: "hse-inspection"
      });
      const stored = await pool.query(
        `INSERT INTO safety_inspection_evidence(
           inspection_id,control_center_id,media_type,file_name,mime_type,size_bytes,content,created_by
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id,media_type,file_name,mime_type,size_bytes,created_at`,
        [
          req.params.inspectionId,
          context.session.control_center_id,
          uploaded.media_type,
          uploaded.file_name,
          uploaded.mime_type,
          uploaded.size_bytes,
          uploaded.content_buffer,
          actorId(req)
        ]
      );
      const evidence = {
        ...stored.rows[0],
        media_url: `/resolver/safety/inspections/${encodeURIComponent(req.params.inspectionId)}/evidence/${encodeURIComponent(stored.rows[0].id)}/content`
      };
      const updated = await pool.query(
        `UPDATE safety_inspections
         SET evidence=COALESCE(evidence,'[]'::jsonb) || $2::jsonb, updated_at=NOW()
         WHERE id=$1
         RETURNING id,evidence,updated_at`,
        [req.params.inspectionId, JSON.stringify([evidence])]
      );
      res.status(201).json({ status: "ok", evidence, inspection: updated.rows[0] });
    } catch (error) {
      const status = Number(error.statusCode) || 400;
      res.status(status).json({ status: "error", message: error.message });
    }
  });

  app.get("/resolver/safety/inspections/:inspectionId/evidence/:evidenceId/content", async (req, res) => {
    try {
      const context = await mobileSafetyContext(req, res, ["RESOLVER", "ADMIN", "SUPER_ADMIN"]); if (!context) return;
      const result = await pool.query(
        `SELECT e.content,e.mime_type,e.file_name,e.size_bytes,i.inspector_user_id
         FROM safety_inspection_evidence e
         JOIN safety_inspections i ON i.id=e.inspection_id
         WHERE e.id=$1 AND e.inspection_id=$2 AND e.control_center_id=$3
         LIMIT 1`,
        [req.params.evidenceId, req.params.inspectionId, context.session.control_center_id]
      );
      if (!result.rows.length) return res.status(404).json({ status: "error", message: "Evidencia no encontrada" });
      const evidence = result.rows[0];
      if (String(context.session.role || "").toUpperCase() === "RESOLVER" && String(evidence.inspector_user_id) !== String(context.session.sub)) {
        return res.status(403).json({ status: "error", message: "Evidencia no autorizada" });
      }
      res.setHeader("Content-Type", evidence.mime_type || "application/octet-stream");
      res.setHeader("Content-Length", evidence.size_bytes);
      res.setHeader("Content-Disposition", `inline; filename="${String(evidence.file_name || "evidencia").replace(/[\r\n\"]/g, "")}"`);
      res.send(evidence.content);
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  app.post("/resolver/tickets/:ticketId/safety/inspections", async (req, res) => {
    try {
      const context = await mobileSafetyContext(req, res, ["RESOLVER", "ADMIN", "SUPER_ADMIN"]); if (!context) return;
      if (!(await checkTicketParticipantAccess(req, res, req.params.ticketId))) return;
      const ticket = await ticketSafetyContext(req.params.ticketId);
      if (!ticket) return res.status(404).json({ status: "error", message: "Ticket no encontrado" });
      const body = req.body || {};
      const result = await pool.query(
        `INSERT INTO safety_inspections(
           control_center_id,linked_ticket_id,title,inspection_type,area,completed_at,status,result,score,
           responses,findings,notes,inspector_user_id,created_by
         ) VALUES($1,$2,$3,$4,$5,NOW(),'COMPLETED',$6,$7,'[]'::jsonb,$8::jsonb,$9,$10,$10)
         RETURNING *`,
        [
          ticket.control_center_id,
          ticket.id,
          required(body.title, "Título de inspección", 180),
          text(body.inspection_type || "FIELD_INSPECTION", 80).toUpperCase(),
          text(body.area || ticket.citizen_work_area || ticket.event_sector_name, 180) || null,
          enumValue(body.result, SAFETY_STATUSES.inspectionResult, "NOT_EVALUATED"),
          numberOrNull(body.score, 0, 100),
          JSON.stringify(Array.isArray(body.findings) ? body.findings : []),
          text(body.notes, 5000) || null,
          actorId(req)
        ]
      );
      await pool.query(
        `INSERT INTO ticket_actions(ticket_id,actor_user_id,actor_role,action_type,description,metadata)
         VALUES($1,$2,'RESOLVER','HSE_INSPECTION_COMPLETED',$3,$4::jsonb)`,
        [ticket.id, actorId(req), "Profesional HSE registró una inspección en terreno", JSON.stringify({ inspection_id: result.rows[0].id, result: result.rows[0].result })]
      );
      res.status(201).json({ status: "ok", inspection: result.rows[0] });
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  app.post("/resolver/tickets/:ticketId/safety/control-verifications", async (req, res) => {
    try {
      const context = await mobileSafetyContext(req, res, ["RESOLVER", "ADMIN", "SUPER_ADMIN"]); if (!context) return;
      if (!(await checkTicketParticipantAccess(req, res, req.params.ticketId))) return;
      const ticket = await ticketSafetyContext(req.params.ticketId);
      if (!ticket) return res.status(404).json({ status: "error", message: "Ticket no encontrado" });
      const body = req.body || {};
      const resultValue = enumValue(body.result, SAFETY_STATUSES.verification, null);
      if (!resultValue) throw new Error("Resultado de verificación inválido");
      const result = await pool.query(
        `INSERT INTO safety_control_verifications(
           control_center_id,control_id,ticket_id,result,area,evidence,notes,verified_by,verified_at
         )
         SELECT $1,id,$3,$4,$5,$6::jsonb,$7,$8,NOW()
         FROM safety_critical_controls WHERE id=$2 AND control_center_id=$1 AND active=true
         RETURNING *`,
        [
          ticket.control_center_id,
          body.control_id,
          ticket.id,
          resultValue,
          text(body.area || ticket.citizen_work_area || ticket.event_sector_name, 180) || null,
          JSON.stringify(Array.isArray(body.evidence) ? body.evidence : []),
          text(body.notes, 3000) || null,
          actorId(req)
        ]
      );
      if (!result.rows.length) return res.status(404).json({ status: "error", message: "Control crítico no encontrado" });
      await pool.query(
        `INSERT INTO ticket_actions(ticket_id,actor_user_id,actor_role,action_type,description,metadata)
         VALUES($1,$2,'RESOLVER','HSE_CRITICAL_CONTROL_VERIFIED',$3,$4::jsonb)`,
        [ticket.id, actorId(req), "Profesional HSE verificó un control crítico", JSON.stringify({ verification_id: result.rows[0].id, control_id: body.control_id, result: resultValue })]
      );
      res.status(201).json({ status: "ok", verification: result.rows[0] });
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  app.post("/resolver/tickets/:ticketId/safety/closure-request", async (req, res) => {
    try {
      const context = await mobileSafetyContext(req, res, ["RESOLVER", "ADMIN", "SUPER_ADMIN"]); if (!context) return;
      if (!(await checkTicketParticipantAccess(req, res, req.params.ticketId))) return;
      const ticket = await ticketSafetyContext(req.params.ticketId);
      if (!ticket) return res.status(404).json({ status: "error", message: "Ticket no encontrado" });
      if (["RESOLVED", "CLOSED", "CANCELLED"].includes(String(ticket.state || "").toUpperCase())) {
        return res.status(409).json({ status: "error", message: "El caso ya está finalizado" });
      }
      const residualRisk = await pool.query(
        `SELECT id,score,risk_level FROM safety_ticket_risk_assessments WHERE ticket_id=$1 AND phase='RESIDUAL' ORDER BY assessed_at DESC LIMIT 1`,
        [ticket.id]
      );
      if (!residualRisk.rows.length) throw new Error("Registra la evaluación de riesgo residual antes de solicitar el cierre");
      const incident = await ensureTicketIncident(ticket, actorId(req));
      const requestSummary = required(req.body?.request_summary, "Resumen de cierre", 6000);
      const result = await pool.query(
        `INSERT INTO safety_ticket_closure_requests(
           control_center_id,ticket_id,incident_id,status,request_summary,requested_by
         ) VALUES($1,$2,$3,'REQUESTED',$4,$5)
         ON CONFLICT(ticket_id) WHERE status='REQUESTED'
         DO UPDATE SET incident_id=EXCLUDED.incident_id,request_summary=EXCLUDED.request_summary,
                       requested_by=EXCLUDED.requested_by,requested_at=NOW(),updated_at=NOW()
         RETURNING *`,
        [ticket.control_center_id, ticket.id, incident.id, requestSummary, actorId(req)]
      );
      await pool.query(
        `UPDATE safety_incidents SET investigation_status='ACTION_PLAN',updated_by=$2,updated_at=NOW() WHERE id=$1`,
        [incident.id, actorId(req)]
      );
      await pool.query(
        `INSERT INTO ticket_actions(ticket_id,actor_user_id,actor_role,action_type,description,metadata)
         VALUES($1,$2,'RESOLVER','HSE_CLOSURE_REQUESTED',$3,$4::jsonb)`,
        [ticket.id, actorId(req), "Profesional HSE solicitó aprobación del cierre", JSON.stringify({ closure_request_id: result.rows[0].id, residual_risk: residualRisk.rows[0] })]
      );
      res.status(201).json({ status: "ok", closure_request: result.rows[0] });
    } catch (error) { res.status(400).json({ status: "error", message: error.message }); }
  });

  app.get("/hse/supervisor/closure-requests", async (req, res) => {
    if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Sesión de Supervisor HSE requerida")) return;
    try {
      await ensureSchema();
      let centerId = req.panel_session.control_center_id;
      if (String(req.panel_session.role || "").toUpperCase() === "SUPER_ADMIN" && req.query.control_center_code) {
        const center = await adminResolveControlCenter(req, req.query.control_center_code);
        if (!center) return res.status(404).json({ status: "error", message: "Centro de Control no encontrado" });
        centerId = center.id;
      }
      if (!centerId) return res.status(400).json({ status: "error", message: "Centro de Control requerido" });
      const settingsRow = await getControlCenterSettingsById(centerId);
      if (!safetyEnabled(settingsRow?.settings) || String(settingsRow?.settings?.vertical || "CITY").toUpperCase() !== "MINING") {
        return res.status(403).json({ status: "error", message: "El portal Supervisor HSE no está habilitado para este Centro de Control" });
      }
      const status = text(req.query.status || "REQUESTED", 24).toUpperCase();
      const result = await pool.query(
        `SELECT c.*,t.title AS ticket_title,t.alert_type,t.state AS ticket_state,t.event_sector_name,
                requester.full_name AS requested_by_name,resolver.full_name AS resolver_name,
                incident.investigation_status,incident.investigation_notes,incident.immediate_actions,
                incident.root_causes,incident.recommendations,
                risk.score AS residual_risk_score,risk.risk_level AS residual_risk_level
         FROM safety_ticket_closure_requests c
         JOIN tickets t ON t.id=c.ticket_id
         LEFT JOIN users requester ON requester.id=c.requested_by
         LEFT JOIN users resolver ON resolver.id=t.assigned_resolver_id
         LEFT JOIN safety_incidents incident ON incident.id=c.incident_id
         LEFT JOIN LATERAL (
           SELECT score,risk_level FROM safety_ticket_risk_assessments
           WHERE ticket_id=t.id AND phase='RESIDUAL' ORDER BY assessed_at DESC LIMIT 1
         ) risk ON TRUE
         WHERE c.control_center_id=$1 AND ($2='ALL' OR c.status=$2)
         ORDER BY CASE WHEN c.status='REQUESTED' THEN 0 ELSE 1 END,c.requested_at DESC
         LIMIT 100`,
        [centerId, status]
      );
      res.json({ status: "ok", closure_requests: result.rows });
    } catch (error) { res.status(500).json({ status: "error", message: error.message }); }
  });

  app.post("/hse/supervisor/closure-requests/:id/decision", async (req, res) => {
    if (!checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Sesión de Supervisor HSE requerida")) return;
    const decision = enumValue(req.body?.decision, CLOSURE_DECISIONS, null);
    if (!decision) return res.status(400).json({ status: "error", message: "Decisión inválida" });
    const decisionNotes = text(req.body?.decision_notes, 6000) || null;
    if (decision === "REJECTED" && !decisionNotes) return res.status(400).json({ status: "error", message: "Indica el motivo del rechazo" });
    await ensureSchema();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const requestResult = await client.query(
        `SELECT c.*,t.state AS ticket_state FROM safety_ticket_closure_requests c
         JOIN tickets t ON t.id=c.ticket_id
         WHERE c.id=$1 FOR UPDATE`,
        [req.params.id]
      );
      if (!requestResult.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ status: "error", message: "Solicitud no encontrada" });
      }
      const closure = requestResult.rows[0];
      if (String(req.panel_session.role || "").toUpperCase() !== "SUPER_ADMIN" && String(closure.control_center_id) !== String(req.panel_session.control_center_id)) {
        await client.query("ROLLBACK");
        return res.status(403).json({ status: "error", message: "Solicitud de otro Centro de Control" });
      }
      if (closure.status !== "REQUESTED") {
        await client.query("ROLLBACK");
        return res.status(409).json({ status: "error", message: "La solicitud ya fue decidida" });
      }
      const updated = await client.query(
        `UPDATE safety_ticket_closure_requests SET status=$2,decided_by=$3,decided_at=NOW(),decision_notes=$4,updated_at=NOW()
         WHERE id=$1 RETURNING *`,
        [closure.id, decision, actorId(req), decisionNotes]
      );
      if (decision === "APPROVED") {
        await client.query(`UPDATE tickets SET state='RESOLVED',resolved_at=COALESCE(resolved_at,NOW()),updated_at=NOW() WHERE id=$1`, [closure.ticket_id]);
        await client.query(`UPDATE safety_incidents SET investigation_status='CLOSED',updated_by=$2,updated_at=NOW() WHERE id=$1`, [closure.incident_id, actorId(req)]);
      } else {
        await client.query(`UPDATE safety_incidents SET investigation_status='INVESTIGATING',updated_by=$2,updated_at=NOW() WHERE id=$1`, [closure.incident_id, actorId(req)]);
      }
      await client.query(
        `INSERT INTO ticket_actions(ticket_id,actor_user_id,actor_role,action_type,description,metadata)
         VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          closure.ticket_id,
          actorId(req),
          String(req.panel_session.role || "OPERATOR").toUpperCase(),
          decision === "APPROVED" ? "HSE_CLOSURE_APPROVED" : "HSE_CLOSURE_REJECTED",
          decision === "APPROVED" ? "Supervisor HSE aprobó el cierre" : "Supervisor HSE devolvió el caso al profesional HSE",
          JSON.stringify({ closure_request_id: closure.id, decision_notes: decisionNotes })
        ]
      );
      await client.query("COMMIT");
      if (decision === "APPROVED") {
        if (typeof syncMobileEventStateFromTicket === "function") await syncMobileEventStateFromTicket(closure.ticket_id, "RESOLVED");
        if (typeof releaseResolverFromTicket === "function") await releaseResolverFromTicket(closure.ticket_id, "HSE_CLOSURE_APPROVED");
      }
      res.json({ status: "ok", closure_request: updated.rows[0], ticket_state: decision === "APPROVED" ? "RESOLVED" : closure.ticket_state });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => null);
      res.status(400).json({ status: "error", message: error.message });
    } finally {
      client.release();
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
      const result = await pool.query(`INSERT INTO safety_critical_controls(control_center_id,code,hazard,name,control_type,work_area,verification_question,performance_standard,active,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(control_center_id,code) DO UPDATE SET hazard=EXCLUDED.hazard,name=EXCLUDED.name,control_type=EXCLUDED.control_type,work_area=EXCLUDED.work_area,verification_question=EXCLUDED.verification_question,performance_standard=EXCLUDED.performance_standard,active=EXCLUDED.active,updated_at=NOW() RETURNING *`, [context.center.id, required(body.code, "Código", 50).toUpperCase(), required(body.hazard, "Peligro", 180), required(body.name, "Nombre", 180), enumValue(body.control_type, CRITICAL_CONTROL_TYPES, "PREVENTIVE"), text(body.work_area, 180) || null, required(body.verification_question, "Pregunta de verificación", 2000), text(body.performance_standard, 3000) || null, body.active !== false, actorId(req)]);
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
