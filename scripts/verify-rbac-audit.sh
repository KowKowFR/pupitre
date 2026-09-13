#!/usr/bin/env bash
#
# RBAC et journal d'activité : un refus est refusé, et il laisse une trace.
#
#   1. Créer un utilisateur viewer
#   2. Se connecter en tant que viewer
#   3. POST /api/deployments  →  403
#   4. La tentative refusée apparaît dans audit_logs avec l'acteur et l'IP
#
# Usage :
#   ./scripts/verify-rbac-audit.sh
#   BASE_URL=http://localhost:3100 ./scripts/verify-rbac-audit.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
VIEWER_EMAIL="${VIEWER_EMAIL:-viewer@example.test}"
VIEWER_PASSWORD="${VIEWER_PASSWORD:-motdepasse-tres-long}"
# IP simulée derrière un reverse proxy : c'est elle qu'on doit retrouver en base.
CLIENT_IP="${CLIENT_IP:-198.51.100.42}"

JAR_DIR="$(mktemp -d)"
ADMIN_JAR="$JAR_DIR/admin.jar"
VIEWER_JAR="$JAR_DIR/viewer.jar"
trap 'rm -rf "$JAR_DIR"' EXIT

command -v jq >/dev/null || { echo "jq est requis"; exit 1; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# curl → écrit le corps dans $BODY, retourne le code HTTP sur stdout
BODY="$JAR_DIR/body.json"
req() {
  local method="$1" path="$2" jar="${3:-}" data="${4:-}"
  # `Origin` est envoyé comme le ferait un navigateur : Better Auth s'en sert
  # comme protection CSRF sur les requêtes authentifiées.
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -H "x-forwarded-for: $CLIENT_IP")
  [ -n "$jar" ] && args+=(-b "$jar" -c "$jar")
  [ -n "$data" ] && args+=(-d "$data")
  curl "${args[@]}"
}

step "0. Le panel répond"
code=$(req GET /api/health)
[ "$code" = "200" ] || fail "GET /api/health → HTTP $code"
jq -e '.status == "ok" and .db == "ok" and .redis == "ok"' "$BODY" >/dev/null \
  || fail "/api/health : $(cat "$BODY")"
pass "/api/health → $(jq -c '{status,db,redis}' "$BODY")"

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }

step "1. Un administrateur existe (bootstrap si nécessaire)"
code=$(req POST /api/auth/sign-in/email "$ADMIN_JAR" \
  "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
if [ "$code" != "200" ]; then
  code=$(req POST /api/auth/sign-up/email "$ADMIN_JAR" \
    "{\"name\":\"Admin de vérification\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
  [ "$code" = "200" ] || fail "impossible de créer l'administrateur (HTTP $code) : $(cat "$BODY")
     → si des comptes existent déjà, relancez avec ADMIN_EMAIL/ADMIN_PASSWORD d'un compte admin"
  pass "administrateur créé — le premier compte reçoit le rôle admin"
else
  pass "connecté en tant que $ADMIN_EMAIL"
fi
ADMIN_ROLE=$(jq -r '.user.role // "?"' "$BODY")
[ "$ADMIN_ROLE" = "admin" ] || fail "le compte $ADMIN_EMAIL a le rôle « $ADMIN_ROLE », pas « admin »"

step "2. Créer un utilisateur viewer"
code=$(req POST /api/admin/users "$ADMIN_JAR" \
  "{\"name\":\"Vera Viewer\",\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\",\"role\":\"viewer\"}")
case "$code" in
  201) pass "viewer créé : $(jq -c '{email,roles}' "$BODY")" ;;
  409) pass "le viewer existait déjà" ;;
  *)   fail "POST /api/admin/users → HTTP $code : $(cat "$BODY")" ;;
esac

# Un compte qui existe déjà garde le rôle qu'un autre script lui a donné : la
# création répond 409 sans rien corriger. Sans ce réalignement, l'étape 4
# testait un « viewer » devenu operator — donc titulaire de deployment:create —
# et recevait un 422 de validation là où elle attendait un 403. Un test qui
# dépend de l'ordre d'exécution de ses voisins ne prouve rien.
VIEWER_ACCOUNT_ID=$(psql_q "select id from users where email = '$VIEWER_EMAIL';")
[ -n "$VIEWER_ACCOUNT_ID" ] || fail "compte « $VIEWER_EMAIL » introuvable après création"
code=$(req PATCH "/api/admin/users/$VIEWER_ACCOUNT_ID/role" "$ADMIN_JAR" '{"role":"viewer"}')
[ "$code" = "200" ] || fail "réalignement du rôle → HTTP $code : $(cat "$BODY")"
pass "rôle réaligné sur « viewer », quel que soit son état d'avant"

step "3. Se connecter en tant que viewer"
code=$(req POST /api/auth/sign-in/email "$VIEWER_JAR" \
  "{\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\"}")
[ "$code" = "200" ] || fail "connexion viewer → HTTP $code : $(cat "$BODY")"
VIEWER_ID=$(jq -r '.user.id' "$BODY")
pass "connecté — id $VIEWER_ID"

step "4. POST /api/deployments en tant que viewer → 403"
code=$(req POST /api/deployments "$VIEWER_JAR" '{}')
[ "$code" = "403" ] || fail "attendu 403, reçu HTTP $code : $(cat "$BODY")"
jq -e '.error.code == "forbidden" and .error.details.permission == "deployment:create"' "$BODY" >/dev/null \
  || fail "corps inattendu : $(cat "$BODY")"
pass "403 — $(jq -r '.error.message' "$BODY")"

step "5. Le refus est dans audit_logs, avec l'acteur et l'IP"
code=$(req GET "/api/audit-logs?action=permission.denied&actorId=$VIEWER_ID&pageSize=1" "$ADMIN_JAR")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code : $(cat "$BODY")"

jq -e '.total > 0' "$BODY" >/dev/null || fail "aucune entrée permission.denied pour le viewer"
entry=$(jq -c '.items[0]' "$BODY")
jq -e --arg ip "$CLIENT_IP" --arg id "$VIEWER_ID" --arg mail "$VIEWER_EMAIL" '
  .items[0]
  | .actorId == $id
    and .actorEmail == $mail
    and .ip == $ip
    and .resourceId == "deployment:create"
    and .after.reason == "missing_permission"
' "$BODY" >/dev/null || fail "entrée incomplète : $entry"

pass "acteur   : $(jq -r '.items[0].actorEmail' "$BODY") ($(jq -r '.items[0].actorId' "$BODY"))"
pass "IP       : $(jq -r '.items[0].ip' "$BODY")"
pass "action   : $(jq -r '.items[0].action' "$BODY") → $(jq -r '.items[0].resourceId' "$BODY")"
pass "requête  : $(jq -r '.items[0].after.method + " " + .items[0].after.path' "$BODY")"

step "6. Contrôles complémentaires"
code=$(req POST /api/deployments "" '{}')
[ "$code" = "401" ] || fail "sans session, attendu 401, reçu $code"
pass "sans session → 401 (et non 403)"

code=$(req POST /api/admin/users "$VIEWER_JAR" \
  '{"name":"X","email":"x@example.test","password":"motdepasse-tres-long","role":"admin"}')
[ "$code" = "403" ] || fail "viewer sur POST /api/admin/users : attendu 403, reçu $code"
pass "viewer ne peut pas créer d'utilisateur → 403"

code=$(req GET /api/deployments "$VIEWER_JAR")
[ "$code" = "200" ] || fail "viewer sur GET /api/deployments : attendu 200, reçu $code"
pass "viewer garde la lecture → GET /api/deployments 200"

code=$(req GET /api/audit-logs "$VIEWER_JAR")
[ "$code" = "200" ] || fail "viewer sur GET /api/audit-logs : attendu 200 (audit:read), reçu $code"
pass "viewer a audit:read → GET /api/audit-logs 200"

# Ce qui compte ici, c'est que l'administrateur FRANCHISSE la garde de
# permission, pas ce qu'il obtient ensuite. La route a d'abord été un bouchon
# qui répondait 501 ; depuis que le pipeline existe, elle est réelle et répond
# 404 sur des identifiants inexistants. Les deux prouvent la même chose.
code=$(req POST /api/deployments "$ADMIN_JAR" \
  '{"applicationId":"00000000-0000-4000-8000-000000000000","targetId":"00000000-0000-4000-8000-000000000001","runtime":"docker"}')
case "$code" in
  401|403) fail "admin bloqué par la garde de permission (HTTP $code)" ;;
  404|501) pass "admin passe la garde → $code (et non 403)" ;;
  *)       fail "admin sur POST /api/deployments : reçu $code, attendu 404 ou 501" ;;
esac

code=$(req POST /api/auth/sign-out "$VIEWER_JAR" '{}')
[ "$code" = "200" ] || fail "déconnexion → HTTP $code"
code=$(req GET /api/audit-logs "$ADMIN_JAR")
jq -e --arg id "$VIEWER_ID" '[.items[] | select(.action == "auth.logout" and .actorId == $id)] | length > 0' "$BODY" >/dev/null \
  || fail "la déconnexion n'apparaît pas dans audit_logs"
pass "déconnexion tracée dans audit_logs"

printf '\n\033[32m✓ RBAC et journal des refus vérifiés.\033[0m\n\n'
