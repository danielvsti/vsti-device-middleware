#!/bin/bash
set -euo pipefail

# ============================================================
# Seed demo realista SOS Quilpue
# - Usa/crea CC-QUILPUE ya cargado con geocerca
# - Cancela tickets abiertos del centro, sin borrar historial
# - Crea/actualiza usuarios demo de Quilpue porque el centro nuevo parte vacío
# - Despierta/reubica resolutores en puntos separados visualmente
# - Crea tickets por API movil real dentro de Quilpue
# ============================================================

: "${DATABASE_URL:?Debes definir DATABASE_URL con la External Database URL de Render}"

SOS_API_BASE="${SOS_API_BASE:-https://api.queltu.com}"
CONTROL_CENTER_CODE="${CONTROL_CENTER_CODE:-CC-QUILPUE}"
TICKET_COUNT="${TICKET_COUNT:-10}"
DRY_RUN="${DRY_RUN:-false}"
AUTO_ASSIGN="${AUTO_ASSIGN:-false}"
CLEAN_ALL_OPEN_TICKETS="${CLEAN_ALL_OPEN_TICKETS:-true}"
SEED_DEMO_USERS="${SEED_DEMO_USERS:-true}"
WAKE_RESOLVERS="${WAKE_RESOLVERS:-true}"
RUN_ID="${RUN_ID:-$(date +%Y%m%d_%H%M%S)}"

TMP_DIR="/tmp/sos_quilpue_demo_${RUN_ID}_$$"
NEIGHBORS_FILE="$TMP_DIR/neighbors.tsv"
CREATED_TICKETS_FILE="$TMP_DIR/created_ticket_ids.txt"
mkdir -p "$TMP_DIR"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

say() { echo "$@"; }

bool_true() {
  case "${1:-}" in
    true|TRUE|1|yes|YES|si|SI|sí|SÍ) return 0 ;;
    *) return 1 ;;
  esac
}

json_get_ticket_id() {
  python3 -c '
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    print("")
    raise SystemExit(0)
for path in [
    ("ticket_id",),
    ("ticket", "id"),
    ("data", "ticket_id"),
    ("data", "ticket", "id"),
    ("event", "ticket_id"),
]:
    cur = data
    ok = True
    for key in path:
        if isinstance(cur, dict) and key in cur:
            cur = cur[key]
        else:
            ok = False
            break
    if ok and cur:
        print(cur)
        break
else:
    print("")
'
}

say "============================================================"
say "Seed demo limpio SOS Quilpue"
say "============================================================"
say "API:                    $SOS_API_BASE"
say "Centro de control:      $CONTROL_CENTER_CODE"
say "Tickets a generar:      $TICKET_COUNT"
say "Limpiar tickets abiertos: $CLEAN_ALL_OPEN_TICKETS"
say "Crear/actualizar usuarios demo: $SEED_DEMO_USERS"
say "Wake resolutores:       $WAKE_RESOLVERS"
say "Auto-asignar:           $AUTO_ASSIGN"
say "Dry run:                $DRY_RUN"
say "Run ID:                 $RUN_ID"
say "============================================================"

say "== 0) Validando centro de control y geocerca =="
CC_ID=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At -c "
SELECT id
FROM control_centers
WHERE code = '${CONTROL_CENTER_CODE}'
LIMIT 1;
")

if [ -z "$CC_ID" ]; then
  echo "ERROR: No existe control_center ${CONTROL_CENTER_CODE}. Carga primero quilpue_boundary.geojson." >&2
  exit 1
fi

BOUNDARY_TYPE=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At -c "
SELECT COALESCE(boundary_geojson->>'type', '')
FROM control_centers
WHERE id = '${CC_ID}'::uuid;
")

if [ -z "$BOUNDARY_TYPE" ]; then
  echo "ERROR: ${CONTROL_CENTER_CODE} existe, pero no tiene boundary_geojson cargado." >&2
  exit 1
fi

say "Centro OK: $CONTROL_CENTER_CODE / $CC_ID / boundary=${BOUNDARY_TYPE}"

say "== 1) Limpiando tickets abiertos/visibles del centro =="
if bool_true "$CLEAN_ALL_OPEN_TICKETS"; then
  if bool_true "$DRY_RUN"; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
    SELECT
      COUNT(*) AS tickets_que_serian_cancelados
    FROM tickets
    WHERE control_center_id = '${CC_ID}'::uuid
      AND state NOT IN ('CLOSED','RESOLVED','CANCELLED');
    "
  else
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
    WITH target_tickets AS (
      SELECT id, source_event_id
      FROM tickets
      WHERE control_center_id = '${CC_ID}'::uuid
        AND state NOT IN ('CLOSED','RESOLVED','CANCELLED')
    ),
    cancelled_tickets AS (
      UPDATE tickets t
      SET
        state = 'CANCELLED',
        assigned_resolver_id = NULL,
        updated_at = NOW()
      WHERE t.id IN (SELECT id FROM target_tickets)
      RETURNING t.id, t.source_event_id
    ),
    cancelled_events AS (
      UPDATE mobile_events m
      SET
        state = 'CANCELLED',
        cancelled = true,
        cancelled_at = NOW(),
        updated_at = NOW()
      WHERE m.id IN (
        SELECT source_event_id
        FROM cancelled_tickets
        WHERE source_event_id IS NOT NULL
      )
      RETURNING m.id
    )
    SELECT
      (SELECT COUNT(*) FROM cancelled_tickets) AS tickets_cancelados,
      (SELECT COUNT(*) FROM cancelled_events) AS eventos_mobile_cancelados;
    "
  fi
else
  say "Limpieza omitida porque CLEAN_ALL_OPEN_TICKETS=false"
fi

say "== 2) Creando/actualizando usuarios demo de Quilpue =="
if bool_true "$SEED_DEMO_USERS"; then
  if bool_true "$DRY_RUN"; then
    say "DRY_RUN: se crearían/actualizarían 6 resolutores y 10 vecinos demo en ${CONTROL_CENTER_CODE}."
  else
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE
  cc_id uuid := '${CC_ID}'::uuid;
  s record;
  existing_id uuid;
BEGIN
  FOR s IN
    SELECT *
    FROM (VALUES
      ('RESOLVER','Resolutor Quilpue 01 - Centro','+56943100001','Base municipal Quilpue',-33.04750::double precision,-71.44210::double precision),
      ('RESOLVER','Resolutor Quilpue 02 - Estacion','+56943100002','Estacion Quilpue',-33.04900::double precision,-71.44010::double precision),
      ('RESOLVER','Resolutor Quilpue 03 - El Belloto','+56943100003','Base Troncal El Belloto',-33.04100::double precision,-71.40850::double precision),
      ('RESOLVER','Resolutor Quilpue 04 - Los Pinos','+56943100004','Base Los Pinos',-33.05700::double precision,-71.45350::double precision),
      ('RESOLVER','Resolutor Quilpue 05 - Valencia','+56943100005','Base Valencia',-33.06250::double precision,-71.43000::double precision),
      ('RESOLVER','Resolutor Quilpue 06 - Pompeya','+56943100006','Base Pompeya',-33.05320::double precision,-71.44750::double precision),

      ('NEIGHBOR','Vecina Quilpue 101 - Belloto Norte','+56943100101','Domicilio demo 101, Belloto Norte',-33.03450::double precision,-71.41850::double precision),
      ('NEIGHBOR','Vecino Quilpue 102 - Belloto Sur','+56943100102','Domicilio demo 102, Belloto Sur',-33.04980::double precision,-71.40650::double precision),
      ('NEIGHBOR','Vecina Quilpue 103 - Marga Marga','+56943100103','Domicilio demo 103, Marga Marga',-33.05200::double precision,-71.42150::double precision),
      ('NEIGHBOR','Vecino Quilpue 104 - Retiro','+56943100104','Domicilio demo 104, Retiro',-33.06600::double precision,-71.45600::double precision),
      ('NEIGHBOR','Vecina Quilpue 105 - Teniente Serrano','+56943100105','Domicilio demo 105, Teniente Serrano',-33.05650::double precision,-71.43250::double precision),
      ('NEIGHBOR','Vecino Quilpue 106 - El Sol','+56943100106','Domicilio demo 106, El Sol',-33.04120::double precision,-71.44920::double precision),
      ('NEIGHBOR','Vecina Quilpue 107 - Pompeya Sur','+56943100107','Domicilio demo 107, Pompeya Sur',-33.05950::double precision,-71.44250::double precision),
      ('NEIGHBOR','Vecino Quilpue 108 - Los Pinos Alto','+56943100108','Domicilio demo 108, Los Pinos Alto',-33.06280::double precision,-71.45150::double precision),
      ('NEIGHBOR','Vecina Quilpue 109 - Paso Hondo','+56943100109','Domicilio demo 109, Paso Hondo',-33.06750::double precision,-71.42400::double precision),
      ('NEIGHBOR','Vecino Quilpue 110 - Valencia Alto','+56943100110','Domicilio demo 110, Valencia Alto',-33.06900::double precision,-71.43350::double precision)
    ) AS seed(role, full_name, phone, declared_address, latitude, longitude)
  LOOP
    SELECT id
    INTO existing_id
    FROM users
    WHERE phone = s.phone
    ORDER BY created_at DESC
    LIMIT 1;

    IF existing_id IS NULL THEN
      INSERT INTO users (
        control_center_id,
        role,
        validation_status,
        is_active,
        full_name,
        phone,
        declared_address,
        latitude,
        longitude
      )
      VALUES (
        cc_id,
        s.role,
        'VALIDATED',
        true,
        s.full_name,
        s.phone,
        s.declared_address,
        s.latitude,
        s.longitude
      );
    ELSE
      UPDATE users
      SET
        control_center_id = cc_id,
        role = s.role,
        validation_status = 'VALIDATED',
        is_active = true,
        full_name = s.full_name,
        declared_address = s.declared_address,
        latitude = s.latitude,
        longitude = s.longitude,
        updated_at = NOW()
      WHERE id = existing_id;
    END IF;
  END LOOP;
END \$\$;
SQL
  fi
else
  say "Creación/actualización de usuarios omitida porque SEED_DEMO_USERS=false"
fi

say "== 3) Despertando y reubicando resolutores separados de tickets =="
if bool_true "$WAKE_RESOLVERS"; then
  if bool_true "$DRY_RUN"; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
    WITH resolvers AS (
      SELECT
        u.id,
        u.full_name,
        ROW_NUMBER() OVER (ORDER BY u.phone, u.full_name) AS rn
      FROM users u
      WHERE u.role = 'RESOLVER'
        AND u.is_active = true
        AND u.control_center_id = '${CC_ID}'::uuid
    ),
    resolver_points AS (
      SELECT *
      FROM (VALUES
        (1, -33.04750::double precision, -71.44210::double precision, 'Base Municipalidad / Centro'),
        (2, -33.04900::double precision, -71.44010::double precision, 'Estacion Quilpue'),
        (3, -33.04100::double precision, -71.40850::double precision, 'Troncal / El Belloto'),
        (4, -33.05700::double precision, -71.45350::double precision, 'Los Pinos'),
        (5, -33.06250::double precision, -71.43000::double precision, 'Valencia'),
        (6, -33.05320::double precision, -71.44750::double precision, 'Pompeya')
      ) AS p(rn, latitude, longitude, label)
    )
    SELECT
      r.full_name,
      p.label,
      p.latitude,
      p.longitude,
      'AVAILABLE' AS nuevo_status
    FROM resolvers r
    JOIN resolver_points p ON p.rn = r.rn
    ORDER BY r.rn;
    "
  else
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL
WITH resolvers AS (
  SELECT
    u.id,
    u.control_center_id,
    u.full_name,
    ROW_NUMBER() OVER (ORDER BY u.phone, u.full_name) AS rn
  FROM users u
  WHERE u.role = 'RESOLVER'
    AND u.is_active = true
    AND u.control_center_id = '${CC_ID}'::uuid
),
resolver_points AS (
  SELECT *
  FROM (VALUES
    (1, -33.04750::double precision, -71.44210::double precision, 'Base Municipalidad / Centro'),
    (2, -33.04900::double precision, -71.44010::double precision, 'Estacion Quilpue'),
    (3, -33.04100::double precision, -71.40850::double precision, 'Troncal / El Belloto'),
    (4, -33.05700::double precision, -71.45350::double precision, 'Los Pinos'),
    (5, -33.06250::double precision, -71.43000::double precision, 'Valencia'),
    (6, -33.05320::double precision, -71.44750::double precision, 'Pompeya')
  ) AS p(rn, latitude, longitude, label)
)
INSERT INTO resolver_locations (
  user_id,
  control_center_id,
  latitude,
  longitude,
  accuracy,
  status,
  updated_at
)
SELECT
  r.id,
  r.control_center_id,
  p.latitude,
  p.longitude,
  12,
  'AVAILABLE',
  NOW()
FROM resolvers r
JOIN resolver_points p ON p.rn = r.rn
ON CONFLICT (user_id)
DO UPDATE SET
  latitude = EXCLUDED.latitude,
  longitude = EXCLUDED.longitude,
  accuracy = EXCLUDED.accuracy,
  status = 'AVAILABLE',
  updated_at = NOW();
SQL

    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
    SELECT
      u.full_name,
      rl.status,
      ROUND(rl.latitude::numeric, 5) AS lat,
      ROUND(rl.longitude::numeric, 5) AS lon,
      rl.updated_at
    FROM resolver_locations rl
    JOIN users u ON u.id = rl.user_id
    WHERE u.control_center_id = '${CC_ID}'::uuid
      AND u.role = 'RESOLVER'
      AND u.is_active = true
    ORDER BY u.phone, u.full_name;
    "
  fi
else
  say "Wake/reubicacion de resolutores omitida porque WAKE_RESOLVERS=false"
fi

say "== 4) Seleccionando vecinos existentes de ${CONTROL_CENTER_CODE} =="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At -F $'\t' -c "
SELECT
  u.id,
  COALESCE(NULLIF(u.full_name, ''), 'Vecino ' || LEFT(u.id::text, 8)) AS full_name,
  COALESCE(NULLIF(u.phone, ''), '+56900000000') AS phone
FROM users u
WHERE u.control_center_id = '${CC_ID}'::uuid
  AND u.role = 'NEIGHBOR'
  AND u.is_active = true
  AND COALESCE(u.validation_status, 'VALIDATED') NOT IN ('PENDING_VERIFICATION','REJECTED','SUSPENDED')
ORDER BY u.phone NULLS LAST, u.full_name NULLS LAST, u.created_at DESC
LIMIT ${TICKET_COUNT};
" > "$NEIGHBORS_FILE"

NEIGHBOR_COUNT=$(wc -l < "$NEIGHBORS_FILE" | tr -d ' ')
if [ "$NEIGHBOR_COUNT" -lt "$TICKET_COUNT" ]; then
  echo "ERROR: Hay solo $NEIGHBOR_COUNT vecinos habilitados en $CONTROL_CENTER_CODE y se pidieron $TICKET_COUNT." >&2
  echo "Deja SEED_DEMO_USERS=true o baja TICKET_COUNT." >&2
  exit 1
fi
say "Vecinos seleccionados: $NEIGHBOR_COUNT"

# Puntos de tickets: todos dentro de Quilpue y separados visualmente de los resolutores.
# Los resolutores quedan en bases/centros; los tickets quedan en sectores residenciales alrededor.
declare -a TICKET_SECTOR=(
  "Belloto Norte"
  "Belloto Sur"
  "Marga Marga"
  "Retiro"
  "Teniente Serrano"
  "El Sol"
  "Pompeya Sur"
  "Los Pinos Alto"
  "Paso Hondo"
  "Valencia Alto"
)
declare -a TICKET_LAT=(
  "-33.03450"
  "-33.04980"
  "-33.05200"
  "-33.06600"
  "-33.05650"
  "-33.04120"
  "-33.05950"
  "-33.06280"
  "-33.06750"
  "-33.06900"
)
declare -a TICKET_LON=(
  "-71.41850"
  "-71.40650"
  "-71.42150"
  "-71.45600"
  "-71.43250"
  "-71.44920"
  "-71.44250"
  "-71.45150"
  "-71.42400"
  "-71.43350"
)
declare -a ALERT_TYPE=(
  "SECURITY"
  "MEDICAL"
  "FIRE"
  "VIF"
  "FALL_DETECTED"
  "SOS_MANUAL"
  "RISK"
  "OTHER"
  "SECURITY"
  "MEDICAL"
)
declare -a TITLE=(
  "Seguridad ciudadana"
  "Emergencia medica"
  "Amago de incendio"
  "Alerta VIF"
  "Caida detectada"
  "SOS manual"
  "Riesgo en via publica"
  "Otro requerimiento"
  "Seguridad ciudadana"
  "Emergencia medica"
)
declare -a PRIORITY=(
  "2"
  "1"
  "1"
  "1"
  "1"
  "1"
  "2"
  "3"
  "2"
  "1"
)

: > "$CREATED_TICKETS_FILE"

say "== 5) Creando tickets por API movil real =="
i=0
while IFS=$'\t' read -r USER_ID FULL_NAME PHONE; do
  [ -z "${USER_ID:-}" ] && continue
  idx=$(( i % ${#TICKET_SECTOR[@]} ))
  SECTOR="${TICKET_SECTOR[$idx]}"
  LAT="${TICKET_LAT[$idx]}"
  LON="${TICKET_LON[$idx]}"
  ALERT="${ALERT_TYPE[$idx]}"
  CASE_TITLE="${TITLE[$idx]}"
  PRI="${PRIORITY[$idx]}"

  PAYLOAD=$(USER_ID="$USER_ID" FULL_NAME="$FULL_NAME" PHONE="$PHONE" LAT="$LAT" LON="$LON" ALERT="$ALERT" CASE_TITLE="$CASE_TITLE" PRI="$PRI" SECTOR="$SECTOR" RUN_ID="$RUN_ID" CONTROL_CENTER_CODE="$CONTROL_CENTER_CODE" python3 - <<'PY'
import os, json
sector = os.environ["SECTOR"]
payload = {
    "user_id": os.environ["USER_ID"],
    "name": os.environ["FULL_NAME"],
    "phone": os.environ["PHONE"],
    "latitude": float(os.environ["LAT"]),
    "longitude": float(os.environ["LON"]),
    "accuracy": 14,
    "battery": 88,
    "source": "seed_quilpue_demo_10tkt_wakeresolv",
    "alert_type": os.environ["ALERT"],
    "title": os.environ["CASE_TITLE"],
    "description": f"Ticket demo realista en {sector}, Quilpue. Run {os.environ['RUN_ID']}. Generado por API movil real.",
    "priority": int(os.environ["PRI"]),
    "control_center_code": os.environ["CONTROL_CENTER_CODE"],
    "metadata": {
        "demo": True,
        "run_id": os.environ["RUN_ID"],
        "demo_sector": sector,
        "municipality": "Quilpue",
        "visual_layout": "tickets_residential_resolvers_bases"
    }
}
print(json.dumps(payload, ensure_ascii=False))
PY
)

  say ""
  say "Ticket $((i+1))/$TICKET_COUNT -> $SECTOR / $ALERT / vecino: $FULL_NAME"
  if bool_true "$DRY_RUN"; then
    echo "$PAYLOAD" | python3 -m json.tool
  else
    RESPONSE=$(curl -sS -X POST "$SOS_API_BASE/public/mobile/sos" \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD")

    echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
    TICKET_ID=$(echo "$RESPONSE" | json_get_ticket_id)
    if [ -n "$TICKET_ID" ]; then
      echo "$TICKET_ID" >> "$CREATED_TICKETS_FILE"
    else
      say "AVISO: no pude leer ticket_id desde la respuesta anterior. Si aparece out_of_jurisdiction, revisa geocerca de CC-QUILPUE."
    fi
  fi

  i=$((i+1))
  if [ "$i" -ge "$TICKET_COUNT" ]; then
    break
  fi
  sleep 0.25
done < "$NEIGHBORS_FILE"

say "== 6) Auto-asignacion opcional =="
if bool_true "$AUTO_ASSIGN" && ! bool_true "$DRY_RUN"; then
  while IFS= read -r TICKET_ID; do
    [ -z "$TICKET_ID" ] && continue
    say "Auto-assign: $TICKET_ID"
    curl -sS -X POST "$SOS_API_BASE/tickets/$TICKET_ID/auto-assign" \
      -H "Content-Type: application/json" \
      -d '{}' | python3 -m json.tool 2>/dev/null || true
    sleep 0.25
  done < "$CREATED_TICKETS_FILE"
else
  say "Auto-asignacion omitida. AUTO_ASSIGN=$AUTO_ASSIGN DRY_RUN=$DRY_RUN"
fi

say "== 7) Resumen final para visualizacion =="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
SELECT
  'TICKET' AS tipo,
  LEFT(t.id::text, 8) AS short_id,
  t.title,
  t.alert_type,
  t.state,
  COALESCE(t.event_sector_name, 'sector por API') AS sector,
  ROUND(t.latitude::numeric, 5) AS lat,
  ROUND(t.longitude::numeric, 5) AS lon,
  COALESCE(r.full_name, 'SIN RESOLUTOR') AS resolver
FROM tickets t
LEFT JOIN users r ON r.id = t.assigned_resolver_id
WHERE t.control_center_id = '${CC_ID}'::uuid
  AND t.state NOT IN ('CLOSED','RESOLVED','CANCELLED')
ORDER BY t.created_at DESC
LIMIT 20;
"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
SELECT
  'RESOLUTOR' AS tipo,
  u.full_name,
  rl.status,
  ROUND(rl.latitude::numeric, 5) AS lat,
  ROUND(rl.longitude::numeric, 5) AS lon,
  rl.updated_at
FROM resolver_locations rl
JOIN users u ON u.id = rl.user_id
WHERE u.control_center_id = '${CC_ID}'::uuid
  AND u.role = 'RESOLVER'
  AND u.is_active = true
ORDER BY u.phone, u.full_name;
"

say "============================================================"
say "Listo. Revisa SOS-MAP y Dashboard con CONTROL_CENTER_CODE=${CONTROL_CENTER_CODE}."
say "Layout demo: resolutores en bases/centro; tickets en sectores residenciales de Quilpue."
say "============================================================"
