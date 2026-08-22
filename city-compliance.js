const crypto = require("crypto");

function registerCityCompliance({ app, pool, checkRoleAccess, dashboardAuthorizedControlCenterCode }) {
  let schemaReady = false;

  async function ensureSchema() {
    if (schemaReady) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS city_security_assets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
        asset_type TEXT NOT NULL CHECK (asset_type IN ('CAMERA','IOT','LPR')),
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        latitude DOUBLE PRECISION NOT NULL,
        longitude DOUBLE PRECISION NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        owner_organization TEXT,
        sharing_status TEXT NOT NULL DEFAULT 'INTERNAL',
        retention_days INTEGER,
        capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(control_center_id, code)
      );
      CREATE INDEX IF NOT EXISTS idx_city_assets_cc_type ON city_security_assets(control_center_id, asset_type, status);

      CREATE TABLE IF NOT EXISTS city_criminogenic_observations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
        factor_type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        severity INTEGER NOT NULL DEFAULT 3 CHECK (severity BETWEEN 1 AND 5),
        status TEXT NOT NULL DEFAULT 'OPEN',
        latitude DOUBLE PRECISION NOT NULL,
        longitude DOUBLE PRECISION NOT NULL,
        sector_code TEXT,
        source_type TEXT NOT NULL DEFAULT 'OPERATOR_OBSERVATION',
        ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_at TIMESTAMPTZ,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_city_factors_cc_date ON city_criminogenic_observations(control_center_id, observed_at DESC);

      CREATE TABLE IF NOT EXISTS city_external_api_clients (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        control_center_id UUID NOT NULL REFERENCES control_centers(id) ON DELETE CASCADE,
        agency_name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        active BOOLEAN NOT NULL DEFAULT true,
        expires_at TIMESTAMPTZ,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS city_external_api_audit (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID REFERENCES city_external_api_clients(id) ON DELETE SET NULL,
        control_center_id UUID REFERENCES control_centers(id) ON DELETE SET NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        result_count INTEGER,
        request_ip TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_city_external_audit_cc_date ON city_external_api_audit(control_center_id, created_at DESC);
    `);
    schemaReady = true;
  }

  async function controlCenter(req) {
    const code = dashboardAuthorizedControlCenterCode(req);
    const result = await pool.query(`SELECT id, code, name FROM control_centers WHERE code = $1 LIMIT 1`, [code]);
    return result.rows[0] || null;
  }

  function operational(req, res) {
    return checkRoleAccess(req, res, ["OPERATOR", "ADMIN", "SUPER_ADMIN"], "Se requiere sesión operacional");
  }

  function administrative(req, res) {
    return checkRoleAccess(req, res, ["ADMIN", "SUPER_ADMIN"], "Se requiere sesión administradora");
  }

  function validCoordinates(latitude, longitude) {
    return Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))
      && Math.abs(Number(latitude)) <= 90 && Math.abs(Number(longitude)) <= 180;
  }

  function csvCell(value) {
    const raw = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    return `"${raw.replace(/"/g, '""')}"`;
  }

  function rowsToCsv(rows, fields) {
    return [fields.map(csvCell).join(","), ...rows.map((row) => fields.map((field) => csvCell(row[field])).join(","))].join("\n");
  }

  app.get("/city/assets", async (req, res) => {
    if (!operational(req, res)) return;
    try {
      await ensureSchema();
      const cc = await controlCenter(req);
      if (!cc) return res.status(404).json({ status: "error", message: "Centro de control no encontrado" });
      const params = [cc.id];
      let where = "control_center_id = $1";
      if (req.query.asset_type) { params.push(String(req.query.asset_type).toUpperCase()); where += ` AND asset_type = $${params.length}`; }
      const result = await pool.query(`SELECT * FROM city_security_assets WHERE ${where} ORDER BY asset_type, code`, params);
      res.json({ status: "ok", control_center: cc, total: result.rows.length, assets: result.rows });
    } catch (error) { res.status(500).json({ status: "error", message: error.message }); }
  });

  app.post("/city/assets", async (req, res) => {
    if (!administrative(req, res)) return;
    try {
      await ensureSchema();
      const cc = await controlCenter(req);
      if (!cc) return res.status(404).json({ status: "error", message: "Centro de control no encontrado" });
      const type = String(req.body?.asset_type || "").toUpperCase();
      if (!["CAMERA", "IOT", "LPR"].includes(type)) return res.status(400).json({ status: "error", message: "asset_type debe ser CAMERA, IOT o LPR" });
      if (!validCoordinates(req.body?.latitude, req.body?.longitude)) return res.status(400).json({ status: "error", message: "Coordenadas inválidas" });
      const result = await pool.query(`
        INSERT INTO city_security_assets (control_center_id,asset_type,code,name,description,latitude,longitude,status,owner_organization,sharing_status,retention_days,capabilities,metadata,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (control_center_id,code) DO UPDATE SET asset_type=EXCLUDED.asset_type,name=EXCLUDED.name,description=EXCLUDED.description,latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,status=EXCLUDED.status,owner_organization=EXCLUDED.owner_organization,sharing_status=EXCLUDED.sharing_status,retention_days=EXCLUDED.retention_days,capabilities=EXCLUDED.capabilities,metadata=EXCLUDED.metadata,updated_at=NOW()
        RETURNING *`, [cc.id,type,String(req.body.code||"").trim().slice(0,120),String(req.body.name||"").trim().slice(0,180),String(req.body.description||"").trim().slice(0,1000)||null,Number(req.body.latitude),Number(req.body.longitude),String(req.body.status||"ACTIVE").toUpperCase(),String(req.body.owner_organization||"").trim().slice(0,180)||null,String(req.body.sharing_status||"INTERNAL").toUpperCase(),req.body.retention_days==null?null:Math.max(0,Number(req.body.retention_days)),JSON.stringify(req.body.capabilities||{}),JSON.stringify(req.body.metadata||{}),req.panel_session?.sub||null]);
      res.status(201).json({ status: "ok", asset: result.rows[0] });
    } catch (error) { res.status(500).json({ status: "error", message: error.message }); }
  });

  app.get("/city/assets/export", async (req, res) => {
    if (!operational(req, res)) return;
    try {
      await ensureSchema();
      const cc = await controlCenter(req);
      const result = await pool.query(`SELECT id,asset_type,code,name,description,latitude,longitude,status,owner_organization,sharing_status,retention_days,capabilities,updated_at FROM city_security_assets WHERE control_center_id=$1 ORDER BY asset_type,code`, [cc.id]);
      if (String(req.query.format).toLowerCase() === "csv") {
        res.type("text/csv").setHeader("Content-Disposition", `attachment; filename=queltu-activos-${cc.code}.csv`);
        return res.send(rowsToCsv(result.rows, ["id","asset_type","code","name","latitude","longitude","status","owner_organization","sharing_status","retention_days","updated_at"]));
      }
      res.json({ type: "FeatureCollection", name: `QUELTU ${cc.code} cameras-iot-lpr`, features: result.rows.map((row) => ({ type: "Feature", id: row.id, geometry: { type: "Point", coordinates: [Number(row.longitude), Number(row.latitude)] }, properties: Object.fromEntries(Object.entries(row).filter(([key]) => !["latitude","longitude"].includes(key))) })) });
    } catch (error) { res.status(500).json({ status: "error", message: error.message }); }
  });

  const FACTOR_TYPES = new Set(["INCIVILITY","INFORMAL_COMMERCE","ABANDONED_PROPERTY","POOR_LIGHTING","ILLEGAL_DUMPING","OTHER"]);
  app.get("/city/criminogenic-factors", async (req, res) => {
    if (!operational(req, res)) return;
    try { await ensureSchema(); const cc = await controlCenter(req); const result = await pool.query(`SELECT * FROM city_criminogenic_observations WHERE control_center_id=$1 ORDER BY observed_at DESC LIMIT 2000`, [cc.id]); res.json({ status:"ok", factor_types:[...FACTOR_TYPES], total:result.rows.length, observations:result.rows }); }
    catch (error) { res.status(500).json({ status:"error", message:error.message }); }
  });

  app.post("/city/criminogenic-factors", async (req, res) => {
    if (!operational(req, res)) return;
    try {
      await ensureSchema(); const cc = await controlCenter(req); const type = String(req.body?.factor_type||"").toUpperCase();
      if (!FACTOR_TYPES.has(type)) return res.status(400).json({ status:"error", message:"Tipo de factor no permitido" });
      if (!validCoordinates(req.body?.latitude, req.body?.longitude)) return res.status(400).json({ status:"error", message:"Coordenadas inválidas" });
      const result = await pool.query(`INSERT INTO city_criminogenic_observations (control_center_id,factor_type,title,description,severity,status,latitude,longitude,sector_code,source_type,ticket_id,metadata,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [cc.id,type,String(req.body.title||type).trim().slice(0,180),String(req.body.description||"").trim().slice(0,2000)||null,Math.max(1,Math.min(5,Number(req.body.severity||3))),String(req.body.status||"OPEN").toUpperCase(),Number(req.body.latitude),Number(req.body.longitude),String(req.body.sector_code||"").trim().slice(0,120)||null,String(req.body.source_type||"OPERATOR_OBSERVATION").toUpperCase(),req.body.ticket_id||null,JSON.stringify(req.body.metadata||{}),req.panel_session?.sub||null]);
      res.status(201).json({ status:"ok", observation:result.rows[0] });
    } catch (error) { res.status(500).json({ status:"error", message:error.message }); }
  });

  app.get("/city/criminogenic-factors/report", async (req, res) => {
    if (!operational(req, res)) return;
    try {
      await ensureSchema(); const cc = await controlCenter(req);
      const result = await pool.query(`SELECT factor_type,status,severity,COUNT(*)::int AS count,MIN(observed_at) AS first_observed_at,MAX(observed_at) AS last_observed_at FROM city_criminogenic_observations WHERE control_center_id=$1 AND observed_at >= COALESCE($2::timestamptz, NOW()-INTERVAL '30 days') AND observed_at <= COALESCE($3::timestamptz,NOW()) GROUP BY factor_type,status,severity ORDER BY factor_type,severity`, [cc.id,req.query.from||null,req.query.to||null]);
      if (String(req.query.format).toLowerCase()==="csv") { res.type("text/csv").setHeader("Content-Disposition",`attachment; filename=queltu-factores-${cc.code}.csv`); return res.send(rowsToCsv(result.rows,["factor_type","status","severity","count","first_observed_at","last_observed_at"])); }
      res.json({ status:"ok", control_center:cc, generated_at:new Date().toISOString(), rows:result.rows });
    } catch (error) { res.status(500).json({ status:"error", message:error.message }); }
  });

  const ALLOWED_SCOPES = new Set(["ASSETS_READ","INCIDENTS_READ","LPR_READ"]);
  app.post("/admin/interoperability/clients", async (req, res) => {
    if (!administrative(req, res)) return;
    try {
      await ensureSchema(); const cc = await controlCenter(req); const scopes = [...new Set((req.body?.scopes||[]).map((item)=>String(item).toUpperCase()).filter((item)=>ALLOWED_SCOPES.has(item)))];
      if (!scopes.length) return res.status(400).json({ status:"error", message:"Indica al menos un alcance permitido" });
      const token = `qext_${crypto.randomBytes(32).toString("base64url")}`; const hash = crypto.createHash("sha256").update(token).digest("hex");
      const result = await pool.query(`INSERT INTO city_external_api_clients (control_center_id,agency_name,token_hash,scopes,expires_at,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,agency_name,scopes,expires_at,created_at`, [cc.id,String(req.body.agency_name||"").trim().slice(0,180),hash,scopes,req.body.expires_at||null,req.panel_session?.sub||null]);
      res.status(201).json({ status:"ok", client:result.rows[0], token, warning:"El token se muestra una sola vez; almacenar en un gestor de secretos." });
    } catch (error) { res.status(500).json({ status:"error", message:error.message }); }
  });

  async function externalAccess(req, res, scope) {
    await ensureSchema(); const raw = String(req.headers.authorization||"").replace(/^Bearer\s+/i,"").trim();
    if (!raw.startsWith("qext_")) { res.status(401).json({ status:"error", message:"Credencial externa requerida" }); return null; }
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const result = await pool.query(`SELECT c.*,cc.code AS control_center_code FROM city_external_api_clients c JOIN control_centers cc ON cc.id=c.control_center_id WHERE c.token_hash=$1 AND c.active=true AND (c.expires_at IS NULL OR c.expires_at>NOW()) AND $2=ANY(c.scopes) LIMIT 1`, [hash,scope]);
    if (!result.rows.length) { res.status(403).json({ status:"error", message:"Credencial sin alcance o vencida" }); return null; }
    await pool.query(`UPDATE city_external_api_clients SET last_used_at=NOW() WHERE id=$1`,[result.rows[0].id]); return result.rows[0];
  }

  async function auditExternal(client, req, scope, count) {
    await pool.query(`INSERT INTO city_external_api_audit (client_id,control_center_id,scope,resource,result_count,request_ip) VALUES ($1,$2,$3,$4,$5,$6)`, [client.id,client.control_center_id,scope,req.path,count,String(req.ip||"").slice(0,120)]);
  }

  app.get("/external/v1/city-assets", async (req,res)=>{ try { const client=await externalAccess(req,res,"ASSETS_READ"); if(!client)return; const result=await pool.query(`SELECT id,asset_type,code,name,latitude,longitude,status,owner_organization,sharing_status,capabilities,updated_at FROM city_security_assets WHERE control_center_id=$1 AND sharing_status IN ('SHAREABLE','RESTRICTED') ORDER BY asset_type,code`,[client.control_center_id]); await auditExternal(client,req,"ASSETS_READ",result.rows.length); res.json({status:"ok",control_center_code:client.control_center_code,total:result.rows.length,assets:result.rows}); } catch(error){res.status(500).json({status:"error",message:error.message});} });
  app.get("/external/v1/incidents", async (req,res)=>{ try { const client=await externalAccess(req,res,"INCIDENTS_READ"); if(!client)return; const limit=Math.min(1000,Math.max(1,Number(req.query.limit||200))); const result=await pool.query(`SELECT id,alert_type,title,state,priority,latitude,longitude,event_sector_code,event_sector_name,created_at,acknowledged_at,assigned_at,resolved_at,closed_at FROM tickets WHERE control_center_id=$1 AND created_at>=COALESCE($2::timestamptz,NOW()-INTERVAL '30 days') ORDER BY created_at DESC LIMIT $3`,[client.control_center_id,req.query.from||null,limit]); await auditExternal(client,req,"INCIDENTS_READ",result.rows.length); res.json({status:"ok",control_center_code:client.control_center_code,privacy_profile:"NO_DIRECT_PERSONAL_IDENTIFIERS",total:result.rows.length,incidents:result.rows}); } catch(error){res.status(500).json({status:"error",message:error.message});} });
  app.get("/external/v1/lpr", async (req,res)=>{ try { const client=await externalAccess(req,res,"LPR_READ"); if(!client)return; const result=await pool.query(`SELECT id,code,name,latitude,longitude,status,owner_organization,sharing_status,capabilities,updated_at FROM city_security_assets WHERE control_center_id=$1 AND asset_type='LPR' AND sharing_status IN ('SHAREABLE','RESTRICTED') ORDER BY code`,[client.control_center_id]); await auditExternal(client,req,"LPR_READ",result.rows.length); res.json({status:"ok",control_center_code:client.control_center_code,detections_available:false,note:"Este endpoint publica inventario LPR. La consulta de lecturas requiere integración y convenio específico.",total:result.rows.length,lpr_assets:result.rows}); } catch(error){res.status(500).json({status:"error",message:error.message});} });

  ensureSchema().catch((error) => console.warn("[CITY COMPLIANCE SCHEMA]", error.message));
}

module.exports = { registerCityCompliance };
