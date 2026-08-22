const apply = process.argv.includes("--apply");
const codeArg = process.argv.find((item) => item.startsWith("--control-center="));
const controlCenterCode = String(codeArg?.split("=")[1] || "CC-VINA").trim().toUpperCase();

const assets = [
  ["CAMERA", "DEMO-CAM-001", "Cámara demo borde costero", -33.0168, -71.5576, "SHAREABLE"],
  ["IOT", "DEMO-IOT-001", "Sensor demo sector cerro", -33.0302, -71.5268, "RESTRICTED"],
  ["LPR", "DEMO-LPR-001", "Pórtico LPR demo acceso comunal", -33.0435, -71.4898, "RESTRICTED"]
];

const factors = [
  ["INFORMAL_COMMERCE", "Comercio informal recurrente (demo)", 3, -33.0217, -71.5512, "demo-factor-commerce"],
  ["ABANDONED_PROPERTY", "Predio abandonado para seguimiento (demo)", 2, -33.0351, -71.5324, "demo-factor-property"],
  ["POOR_LIGHTING", "Iluminación deficiente reportada (demo)", 3, -33.0278, -71.5201, "demo-factor-lighting"]
];

async function main() {
  if (!apply) {
    console.log(`Dry-run: se prepararían ${assets.length} activos y ${factors.length} factores sintéticos en ${controlCenterCode}.`);
    console.log("Para aplicar conscientemente: node scripts/seed-city-demo-readiness.js --apply --control-center=CC-VINA");
    return;
  }

  // PostgreSQL solo se carga cuando existe una intención explícita de escribir.
  // Así el dry-run sirve como preflight aun si las dependencias no están instaladas.
  const pool = require("../db");

  try {
    const center = await pool.query(`SELECT id, code, name FROM control_centers WHERE code=$1 LIMIT 1`, [controlCenterCode]);
    if (!center.rows.length) throw new Error(`Centro de control no encontrado: ${controlCenterCode}`);
    const cc = center.rows[0];

    for (const [type, code, name, latitude, longitude, sharing] of assets) {
      await pool.query(`
        INSERT INTO city_security_assets (control_center_id,asset_type,code,name,description,latitude,longitude,status,owner_organization,sharing_status,retention_days,capabilities,metadata)
        VALUES ($1,$2,$3,$4,'Dato sintético para demostración ejecutiva', $5,$6,'ACTIVE',$7,$8,30,$9,$10)
        ON CONFLICT (control_center_id,code) DO UPDATE SET name=EXCLUDED.name,latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,sharing_status=EXCLUDED.sharing_status,updated_at=NOW()
      `, [cc.id,type,code,name,latitude,longitude,cc.name,sharing,JSON.stringify({ demo:true }),JSON.stringify({ demo:true })]);
    }

    for (const [type, title, severity, latitude, longitude, demoKey] of factors) {
      await pool.query(`
        INSERT INTO city_criminogenic_observations (control_center_id,factor_type,title,description,severity,status,latitude,longitude,source_type,metadata)
        SELECT $1,$2,$3,'Dato sintético para demostración; no corresponde a una denuncia real',$4,'OPEN',$5,$6,'DEMO_SEED',$7
        WHERE NOT EXISTS (SELECT 1 FROM city_criminogenic_observations WHERE control_center_id=$1 AND metadata->>'demo_key'=$8)
      `, [cc.id,type,title,severity,latitude,longitude,JSON.stringify({ demo:true,demo_key:demoKey }),demoKey]);
    }

    console.log(`Datos sintéticos preparados en ${cc.code}: ${assets.length} activos y ${factors.length} factores.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
