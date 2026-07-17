#!/bin/bash
set -euo pipefail

# ============================================================
# Seed demo realista SOS Olmué
# - Limpia/cancela tickets visibles del centro CC-OLMUE
# - Despierta/reubica resolutores separados visualmente
# - Crea tickets con vecinos existentes por API móvil real
# - Mantiene todos los puntos dentro de Olmué
# ============================================================

: "${DATABASE_URL:?Debes definir DATABASE_URL con la External Database URL de Render}"

SOS_API_BASE="${SOS_API_BASE:-https://api.queltu.com}"
CONTROL_CENTER_CODE="${CONTROL_CENTER_CODE:-CC-OLMUE}"
TICKET_COUNT="${TICKET_COUNT:-10}"
DRY_RUN="${DRY_RUN:-false}"
AUTO_ASSIGN="${AUTO_ASSIGN:-false}"
CLEAN_ALL_OPEN_TICKETS="${CLEAN_ALL_OPEN_TICKETS:-true}"
WAKE_RESOLVERS="${WAKE_RESOLVERS:-true}"
REPAIR_DEMO_USERS="${REPAIR_DEMO_USERS:-true}"
RUN_ID="${RUN_ID:-$(date +%Y%m%d_%H%M%S)}"

TMP_DIR="/tmp/sos_olmue_demo_${RUN_ID}_$$"
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
say "Seed demo limpio SOS Olmué"
say "============================================================"
say "API:                    $SOS_API_BASE"
say "Centro de control:      $CONTROL_CENTER_CODE"
say "Tickets a generar:      $TICKET_COUNT"
say "Limpiar tickets abiertos: $CLEAN_ALL_OPEN_TICKETS"
say "Wake resolutores:       $WAKE_RESOLVERS"
say "Reparar usuarios demo:  $REPAIR_DEMO_USERS"
say "Auto-asignar:           $AUTO_ASSIGN"
say "Dry run:                $DRY_RUN"
say "Run ID:                 $RUN_ID"
say "============================================================"

say "== 0) Validando centro de control =="
CC_ID=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At -c "
SELECT id
FROM control_centers
WHERE code = '${CONTROL_CENTER_CODE}'
LIMIT 1;
")

if [ -z "$CC_ID" ]; then
  echo "ERROR: No existe control_center ${CONTROL_CENTER_CODE}" >&2
  exit 1
fi
say "Centro OK: $CONTROL_CENTER_CODE / $CC_ID"

say "== 0b) Reparando usuarios demo Olmué existentes =="
if bool_true "$REPAIR_DEMO_USERS"; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
  UPDATE users
  SET
    role = 'NEIGHBOR',
    validation_status = COALESCE(NULLIF(validation_status, ''), 'PROVISIONAL_ACTIVE'),
    is_active = true,
    control_center_id = '${CC_ID}'::uuid,
    updated_at = NOW()
  WHERE email LIKE 'vecino.olmue.%@demo.sos.local';

  UPDATE users
  SET
    role = 'RESOLVER',
    validation_status = COALESCE(NULLIF(validation_status, ''), 'VALIDATED'),
    is_active = true,
    control_center_id = '${CC_ID}'::uuid,
    updated_at = NOW()
  WHERE email LIKE 'resolutor.olmue.%@demo.sos.local';

  SELECT role, validation_status, is_active, COUNT(*)
  FROM users
  WHERE control_center_id = '${CC_ID}'::uuid
    AND (
      email LIKE 'vecino.olmue.%@demo.sos.local'
      OR email LIKE 'resolutor.olmue.%@demo.sos.local'
    )
  GROUP BY role, validation_status, is_active
  ORDER BY role, validation_status;
  "
else
  say "Reparación de usuarios demo omitida porque REPAIR_DEMO_USERS=false"
fi

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

say "== 2) Despertando y reubicando resolutores separados de tickets =="
if bool_true "$WAKE_RESOLVERS"; then
  if bool_true "$DRY_RUN"; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
    WITH resolvers AS (
      SELECT
        u.id,
        u.full_name,
        ROW_NUMBER() OVER (ORDER BY u.full_name) AS rn
      FROM users u
      WHERE u.role = 'RESOLVER'
        AND u.is_active = true
        AND u.control_center_id = '${CC_ID}'::uuid
    ),
    resolver_points AS (
      SELECT *
      FROM (VALUES
        (1, -32.99540::double precision, -71.18620::double precision, 'Base Centro / Plaza Olmué'),
        (2, -32.98250::double precision, -71.18250::double precision, 'Av. Eastman / Lo Narváez'),
        (3, -32.99010::double precision, -71.15500::double precision, 'El Granizo / acceso La Campana'),
        (4, -33.00975::double precision, -71.17032::double precision, 'Pelumpén / ruta interior'),
        (5, -33.06445::double precision, -71.11863::double precision, 'Quebrada Alvarado'),
        (6, -33.07374::double precision, -71.04799::double precision, 'Las Palmas'),
        (7, -33.04508::double precision, -71.04390::double precision, 'Rural oriente / Las Cruces'),
        (8, -32.98133::double precision, -71.17089::double precision, 'Narváez alto'),
        (9, -32.99751::double precision, -71.17231::double precision, 'Centro oriente'),
        (10, -33.01352::double precision, -71.05761::double precision, 'Sector La Campana oriente'),
        (11, -32.98819::double precision, -71.20909::double precision, 'Límite poniente / acceso comuna'),
        (12, -33.04751::double precision, -71.17108::double precision, 'Rural sur / conexión interior')
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
    ROW_NUMBER() OVER (ORDER BY u.full_name) AS rn
  FROM users u
  WHERE u.role = 'RESOLVER'
    AND u.is_active = true
    AND u.control_center_id = '${CC_ID}'::uuid
),
resolver_points AS (
  SELECT *
  FROM (VALUES
    (1, -32.99540::double precision, -71.18620::double precision, 'Base Centro / Plaza Olmué'),
    (2, -32.98250::double precision, -71.18250::double precision, 'Av. Eastman / Lo Narváez'),
    (3, -32.99010::double precision, -71.15500::double precision, 'El Granizo / acceso La Campana'),
    (4, -33.00975::double precision, -71.17032::double precision, 'Pelumpén / ruta interior'),
    (5, -33.06445::double precision, -71.11863::double precision, 'Quebrada Alvarado'),
    (6, -33.07374::double precision, -71.04799::double precision, 'Las Palmas'),
    (7, -33.04508::double precision, -71.04390::double precision, 'Rural oriente / Las Cruces'),
    (8, -32.98133::double precision, -71.17089::double precision, 'Narváez alto'),
    (9, -32.99751::double precision, -71.17231::double precision, 'Centro oriente'),
    (10, -33.01352::double precision, -71.05761::double precision, 'Sector La Campana oriente'),
    (11, -32.98819::double precision, -71.20909::double precision, 'Límite poniente / acceso comuna'),
    (12, -33.04751::double precision, -71.17108::double precision, 'Rural sur / conexión interior')
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
    ORDER BY u.full_name;
    "
  fi
else
  say "Wake/reubicacion de resolutores omitida porque WAKE_RESOLVERS=false"
fi

say "== 3) Seleccionando vecinos existentes de CC-OLMUE =="
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
ORDER BY u.full_name NULLS LAST, u.phone NULLS LAST, u.created_at DESC
LIMIT ${TICKET_COUNT};
" > "$NEIGHBORS_FILE"

NEIGHBOR_COUNT=$(wc -l < "$NEIGHBORS_FILE" | tr -d ' ')
if [ "$NEIGHBOR_COUNT" -lt "$TICKET_COUNT" ]; then
  echo "ERROR: Hay solo $NEIGHBOR_COUNT vecinos existentes habilitados en $CONTROL_CENTER_CODE y se pidieron $TICKET_COUNT." >&2
  echo "Baja TICKET_COUNT o crea/valida vecinos antes de correr la demo." >&2
  exit 1
fi
say "Vecinos seleccionados: $NEIGHBOR_COUNT"

# Puntos de tickets: todos dentro de Olmué, separados visualmente de los resolutores.
# Distribución pensada para demo municipal: centro, Lo Narváez, El Granizo, Quebrada Alvarado, Las Palmas y La Campana.
declare -a TICKET_SECTOR=(
  "Centro Olmué"
  "Lo Narváez"
  "El Granizo"
  "Quebrada Alvarado"
  "Las Palmas"
  "La Campana"
  "Pelumpén"
  "Narváez Alto"
  "Av. Eastman"
  "Rural Oriente"
  "Acceso poniente"
  "Rural Sur"
)
declare -a TICKET_LAT=(
  "-32.99620"
  "-32.98280"
  "-32.99070"
  "-33.06410"
  "-33.07320"
  "-33.01320"
  "-33.00920"
  "-32.98180"
  "-32.98220"
  "-33.04500"
  "-32.98840"
  "-33.04720"
)
declare -a TICKET_LON=(
  "-71.18570"
  "-71.18180"
  "-71.15580"
  "-71.11820"
  "-71.04840"
  "-71.05720"
  "-71.17090"
  "-71.17130"
  "-71.19220"
  "-71.04430"
  "-71.20860"
  "-71.17050"
)
declare -a ALERT_TYPE=(
  "SECURITY"
  "MEDICAL"
  "FIRE"
  "VIF"
  "RISK"
  "SOS_MANUAL"
  "OTHER"
  "SECURITY"
  "MEDICAL"
  "FIRE"
  "SOS_MANUAL"
  "RISK"
)
declare -a TITLE=(
  "Seguridad ciudadana"
  "Adulto mayor requiere asistencia"
  "Humo en sector rural"
  "Alerta VIF"
  "Riesgo en vía pública"
  "SOS manual"
  "Apoyo municipal"
  "Actividad sospechosa"
  "Emergencia médica"
  "Quema no autorizada"
  "Botón SOS activado"
  "Riesgo comunitario"
)
declare -a PRIORITY=(
  "2"
  "1"
  "1"
  "1"
  "2"
  "1"
  "3"
  "2"
  "1"
  "1"
  "2"
  "2"
)

: > "$CREATED_TICKETS_FILE"

say "== 4) Creando tickets por API móvil real =="
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
    "source": "seed_olmue_demo_limpia_separada",
    "alert_type": os.environ["ALERT"],
    "title": os.environ["CASE_TITLE"],
    "description": f"Ticket demo realista en {sector}, Olmue. Run {os.environ['RUN_ID']}. Generado por API movil real con vecino existente.",
    "priority": int(os.environ["PRI"]),
    "control_center_code": os.environ["CONTROL_CENTER_CODE"],
    "metadata": {
        "demo": True,
        "run_id": os.environ["RUN_ID"],
        "demo_sector": sector,
        "municipality": "Olmue",
        "visual_layout": "tickets_comuna_resolvers_base_rural"
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
      ${ADMIN_TOKEN:+-H "Authorization: Bearer $ADMIN_TOKEN"} \
      -d "$PAYLOAD")

    echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
    TICKET_ID=$(echo "$RESPONSE" | json_get_ticket_id)
    if [ -n "$TICKET_ID" ]; then
      echo "$TICKET_ID" >> "$CREATED_TICKETS_FILE"
    else
      say "AVISO: no pude leer ticket_id desde la respuesta anterior."
    fi
  fi

  i=$((i+1))
  if [ "$i" -ge "$TICKET_COUNT" ]; then
    break
  fi
  sleep 0.25
done < "$NEIGHBORS_FILE"

say "== 5) Auto-asignación opcional =="
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
  say "Auto-asignación omitida. AUTO_ASSIGN=$AUTO_ASSIGN DRY_RUN=$DRY_RUN"
fi

say "== 6) Resumen final para visualización =="
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
ORDER BY u.full_name;
"

say "============================================================"
say "Listo. Revisa SOS-MAP y Dashboard filtrando CC-OLMUE."
say "Layout demo: resolutores distribuidos; tickets en sectores urbanos/rurales de Olmué."
say "============================================================"
