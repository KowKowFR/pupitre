#!/usr/bin/env bash
#
# Vérifie l'export des logs :
#
#   1. l'export texte d'un déploiement existant renvoie du contenu, avec les
#      bons en-têtes HTTP (content-type, content-disposition)
#   2. l'export JSONL produit des lignes qui passent toutes `jq -e .`
#   3. le nombre de lignes exportées correspond EXACTEMENT au contenu de la base
#      — c'est ce qui prouve que la pagination ne tronque rien
#   4. un identifiant inexistant renvoie 404, un identifiant mal formé 422
#   5. `deployment:read` est requis : un utilisateur sans cette permission → 403
#   6. l'export laisse une trace dans le journal d'audit
#
# Usage :
#   ./scripts/verify-export.sh
#   BASE_URL=http://localhost:3200 ./scripts/verify-export.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
ROLE_KEY="${ROLE_KEY:-export-verification}"
GUEST_EMAIL="${GUEST_EMAIL:-export-test@example.test}"
GUEST_PASSWORD="${GUEST_PASSWORD:-motdepasse-tres-long}"
CLIENT_IP="${CLIENT_IP:-198.51.100.77}"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
GUEST_JAR="$WORK/guest.jar"
BODY="$WORK/body.json"
HDR="$WORK/headers.txt"
OUT="$WORK/export.out"
trap 'rm -rf "$WORK"' EXIT

command -v jq >/dev/null || { echo "jq est requis"; exit 1; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
info() { printf '    \033[2m%s\033[0m\n' "$1"; }

req() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -H "x-forwarded-for: $CLIENT_IP" -b "$JAR" -c "$JAR")
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}

# Télécharge un export en conservant en-têtes et corps séparément.
download() {
  local path="$1" jar="${2:-$JAR}"
  curl -s -D "$HDR" -o "$OUT" -w '%{http_code}' \
    -H "origin: $BASE_URL" -H "x-forwarded-for: $CLIENT_IP" \
    -b "$jar" -c "$jar" "$BASE_URL$path"
}

header_of() { tr -d '\r' < "$HDR" | grep -i "^$1:" | head -1 | cut -d' ' -f2-; }

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }

login() {
  local code
  for _ in 1 2 3 4 5; do
    code=$(req POST /api/auth/sign-in/email \
      "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
    case "$code" in
      200) assert_admin; return 0 ;;
      429) sleep 6 ;;
      *)   break ;;
    esac
  done
  code=$(req POST /api/auth/sign-up/email \
    "{\"name\":\"Admin\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
  [ "$code" = "200" ] || fail "connexion impossible (HTTP $code) : $(cat "$BODY")"
  assert_admin
}

assert_admin() {
  local role
  role=$(jq -r '.user.role // empty' "$BODY")
  [ "$role" = "admin" ] && return 0
  fail "« $ADMIN_EMAIL » a le rôle « ${role:-aucun} », pas « admin » — voir /admin/users"
}

step "1. Connexion"
login
pass "connecté en tant que $ADMIN_EMAIL"

step "2. Un déploiement dont le journal n'est pas vide"
DEPLOYMENT_ID=$(psql_q "select d.id from deployments d
  join deployment_steps s on s.deployment_id = d.id
  group by d.id having sum(length(s.log)) > 0
  order by sum(length(s.log)) desc limit 1;")
[ -n "$DEPLOYMENT_ID" ] || fail "aucun déploiement avec des logs en base"

META=$(psql_q "select a.slug || '|' || d.version || '|' ||
  to_char((coalesce(d.finished_at, d.created_at) at time zone 'UTC'), 'YYYY-MM-DD')
  from deployments d join applications a on a.id = d.application_id
  where d.id = '$DEPLOYMENT_ID';")
SLUG="${META%%|*}"; REST="${META#*|}"; VERSION="${REST%%|*}"; STAMP="${REST#*|}"

# Référence : ce que la base contient, ligne par ligne, sans les vides.
DB_LINES=$(psql_q "select count(*) from deployment_steps s,
  unnest(string_to_array(s.log, E'\n')) as l
  where s.deployment_id = '$DEPLOYMENT_ID' and btrim(l) <> '';")

pass "déploiement $DEPLOYMENT_ID — $SLUG v$VERSION"
info "la base contient $DB_LINES ligne(s) de journal"

step "3. Export texte"
code=$(download "/api/deployments/$DEPLOYMENT_ID/logs/export?format=text")
[ "$code" = "200" ] || fail "export texte → HTTP $code : $(head -c 300 "$OUT")"
[ -s "$OUT" ] || fail "le fichier exporté est vide"

CT=$(header_of content-type)
[ "$CT" = "text/plain; charset=utf-8" ] || fail "content-type inattendu : « $CT »"
pass "content-type : $CT"

CD=$(header_of content-disposition)
EXPECTED="attachment; filename=\"$SLUG-v$VERSION-$STAMP.log\""
case "$CD" in
  "$EXPECTED"*) pass "content-disposition : $CD" ;;
  *) fail "content-disposition inattendu : « $CD » (attendu « $EXPECTED… »)" ;;
esac
grep -q "filename\*=UTF-8''" <<< "$CD" || fail "la forme RFC 6266 « filename* » manque"
pass "forme « filename* » présente (RFC 6266)"

grep -q "^# Deployment log" "$OUT" || fail "en-tête du fichier absent"
grep -q "^# Exported on " "$OUT" || fail "le fichier ne dit pas quand il a été exporté"
pass "en-tête : $(head -1 "$OUT")"

# Une entrée de journal peut tenir sur plusieurs lignes physiques : le bloc de
# diagnostic d'un rollback (« $ docker compose ps -a » et sa sortie) est UNE
# entrée en base. Compter les lignes du fichier comparerait des lignes physiques
# à des entrées logiques. On compte donc les débuts d'entrée, reconnaissables à
# leur horodatage en tête.
TEXT_LINES=$(grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' "$OUT" || true)
[ "$TEXT_LINES" = "$DB_LINES" ] \
  || fail "export texte : $TEXT_LINES ligne(s) exportée(s) pour $DB_LINES en base"
pass "$TEXT_LINES ligne(s) exportées = $DB_LINES ligne(s) en base"
info "$(grep -v '^#' "$OUT" | head -1)"

step "4. Export JSONL"
code=$(download "/api/deployments/$DEPLOYMENT_ID/logs/export?format=jsonl")
[ "$code" = "200" ] || fail "export jsonl → HTTP $code : $(head -c 300 "$OUT")"

CT=$(header_of content-type)
[ "$CT" = "application/x-ndjson; charset=utf-8" ] || fail "content-type inattendu : « $CT »"
pass "content-type : $CT"

CD=$(header_of content-disposition)
case "$CD" in
  "attachment; filename=\"$SLUG-v$VERSION-$STAMP.jsonl\""*) pass "content-disposition : $CD" ;;
  *) fail "content-disposition inattendu : « $CD »" ;;
esac

# Chaque ligne doit être un objet JSON à elle seule : c'est tout le contrat du
# format. On les valide une par une, pas en bloc.
bad=0
while IFS= read -r line; do
  jq -e . >/dev/null 2>&1 <<< "$line" || bad=$((bad + 1))
done < "$OUT"
[ "$bad" = "0" ] || fail "$bad ligne(s) JSONL invalide(s)"
JSONL_LINES=$(wc -l < "$OUT" | tr -d ' ')
pass "$JSONL_LINES ligne(s) passent toutes « jq -e . »"

[ "$JSONL_LINES" = "$DB_LINES" ] \
  || fail "export jsonl : $JSONL_LINES ligne(s) exportée(s) pour $DB_LINES en base"
pass "$JSONL_LINES ligne(s) exportées = $DB_LINES ligne(s) en base"

jq -e 'has("ts") and has("step") and has("stream") and has("line")' >/dev/null <<< "$(head -1 "$OUT")" \
  || fail "une ligne JSONL ne porte pas les quatre champs attendus"
pass "champs : $(head -1 "$OUT" | jq -c 'keys')"

step "5. Identifiants refusés"
code=$(download "/api/deployments/00000000-0000-4000-8000-000000000000/logs/export")
[ "$code" = "404" ] || fail "uuid inconnu : attendu 404, reçu $code"
pass "uuid inconnu → 404"

code=$(download "/api/deployments/pas-un-uuid/logs/export")
[ "$code" = "422" ] || fail "identifiant mal formé : attendu 422, reçu $code"
pass "identifiant mal formé → 422"

code=$(download "/api/deployments/$DEPLOYMENT_ID/logs/export?format=csv")
[ "$code" = "422" ] || fail "format inconnu : attendu 422, reçu $code"
pass "format inconnu → 422"

step "6. « deployment:read » est requis"
req DELETE "/api/admin/roles/$ROLE_KEY" >/dev/null 2>&1 || true
code=$(req POST /api/admin/roles \
  "{\"key\":\"$ROLE_KEY\",\"label\":\"Export — sans lecture\",\"permissions\":[\"target:read\"]}")
case "$code" in
  201) pass "rôle « $ROLE_KEY » créé, sans deployment:read" ;;
  409) pass "rôle « $ROLE_KEY » déjà présent" ;;
  *)   fail "POST /api/admin/roles → HTTP $code : $(cat "$BODY")" ;;
esac

code=$(req POST /api/admin/users \
  "{\"name\":\"Sans lecture\",\"email\":\"$GUEST_EMAIL\",\"password\":\"$GUEST_PASSWORD\",\"role\":\"$ROLE_KEY\"}")
case "$code" in
  201) pass "utilisateur $GUEST_EMAIL créé" ;;
  409) req PATCH "/api/admin/users/$(psql_q "select id from users where email = '$GUEST_EMAIL';")/role" \
         "{\"role\":\"$ROLE_KEY\"}" >/dev/null
       pass "utilisateur $GUEST_EMAIL déjà présent, réattribué à « $ROLE_KEY »" ;;
  *)   fail "POST /api/admin/users → HTTP $code : $(cat "$BODY")" ;;
esac
GUEST_ID=$(psql_q "select id from users where email = '$GUEST_EMAIL';")

for _ in 1 2 3 4 5; do
  code=$(curl -s -o "$BODY" -w '%{http_code}' -X POST "$BASE_URL/api/auth/sign-in/email" \
    -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -b "$GUEST_JAR" -c "$GUEST_JAR" \
    --data-binary "{\"email\":\"$GUEST_EMAIL\",\"password\":\"$GUEST_PASSWORD\"}")
  [ "$code" = "429" ] || break
  sleep 6
done
[ "$code" = "200" ] || fail "connexion de $GUEST_EMAIL impossible (HTTP $code) : $(cat "$BODY")"
pass "connecté en tant que $GUEST_EMAIL"

code=$(download "/api/deployments/$DEPLOYMENT_ID/logs/export?format=text" "$GUEST_JAR")
[ "$code" = "403" ] || fail "sans deployment:read : attendu 403, reçu $code — $(head -c 300 "$OUT")"
jq -e '.error.details.permission == "deployment:read"' >/dev/null < "$OUT" \
  || fail "le refus ne nomme pas la permission attendue : $(head -c 200 "$OUT")"
pass "export refusé → 403 (permission deployment:read)"

step "7. Traçabilité"
code=$(req GET "/api/audit-logs?action=deployment.logs.exported&pageSize=20")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
jq -e --arg id "$DEPLOYMENT_ID" \
  '[.items[] | select(.resourceId == $id)] | length >= 2' "$BODY" >/dev/null \
  || fail "les deux exports ne figurent pas au journal d'audit"
pass "audit : deployment.logs.exported"

jq -e --arg id "$DEPLOYMENT_ID" --argjson n "$DB_LINES" \
  '[.items[] | select(.resourceId == $id and .after.format == "jsonl" and .after.lines == $n)] | length > 0' \
  "$BODY" >/dev/null || fail "l'entrée d'audit ne porte pas le format et le compte de lignes"
info "$(jq -c --arg id "$DEPLOYMENT_ID" \
  'first(.items[] | select(.resourceId == $id)) | {action, actorEmail, after}' "$BODY")"
pass "format et nombre de lignes journalisés"

jq -e '[.items[] | select(.action == "permission.denied")] | length == 0' "$BODY" >/dev/null || true
code=$(req GET "/api/audit-logs?action=permission.denied&pageSize=10")
jq -e '[.items[] | select(.resourceId == "deployment:read")] | length > 0' "$BODY" >/dev/null \
  || fail "le refus de permission n'est pas journalisé"
pass "audit : permission.denied sur deployment:read"

step "8. Ménage"
req DELETE "/api/admin/users/$GUEST_ID" >/dev/null
req DELETE "/api/admin/roles/$ROLE_KEY" >/dev/null
pass "utilisateur et rôle de test supprimés"

printf '\n\033[32m✓ Export des logs vérifié.\033[0m\n'
printf '\033[2m  Écran : %s/deployments/%s\033[0m\n\n' "$BASE_URL" "$DEPLOYMENT_ID"
