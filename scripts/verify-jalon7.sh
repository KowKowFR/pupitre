#!/usr/bin/env bash
#
# Critère de sortie du jalon 7 — cycle de vie.
#
#   1. Deux apps sur la MÊME cible Docker → deux ports distincts, deux règles ufw
#      (ou, si ufw est inactif, l'avertissement attendu et rien de cassé)
#   2. Destroy de la première → port libéré, règle retirée, la seconde intacte
#   3. Une v1 saine, puis une v2 dont le healthcheck échoue → rollback
#      automatique → l'URL répond toujours la v1, statut `rolled_back`,
#      diagnostic visible dans les logs
#   4. `pnpm typecheck` couvre scripts/test-parity.ts (il ne peut pas être joué :
#      aucun cluster K3s n'est enregistré)
#
# Le script emprunte exactement les mêmes routes que l'UI. Prérequis : une cible
# Docker déployable — `./scripts/setup-test-target.sh` en provisionne une.
#
# Usage :
#   ./scripts/verify-jalon7.sh
#   BASE_URL=http://localhost:3100 TARGET_NAME=ma-vm ./scripts/verify-jalon7.sh
#
# Relançable : les applications de test sont détruites puis recréées à chaque
# passage.
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
TARGET_NAME="${TARGET_NAME:-cible-de-verification}"
CLIENT_IP="${CLIENT_IP:-198.51.100.42}"
# Plage volontairement étroite : elle prouve que la plage est bien lue sur la
# cible, et elle reste dans les dix ports que le conteneur de test publie.
RANGE_START="${RANGE_START:-30000}"
RANGE_END="${RANGE_END:-30009}"
# Conteneur portant la cible de test : sert aux contrôles ufw « au plus près ».
TARGET_CONTAINER="${TARGET_CONTAINER:-ssh-target}"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
BODY="$WORK/body.json"
trap 'rm -rf "$WORK"' EXIT

command -v jq >/dev/null || { echo "jq est requis"; exit 1; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
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

# Better Auth limite les connexions répétées depuis une même IP. Les scripts de
# vérification s'enchaînent : on patiente plutôt que de retomber par erreur sur
# l'inscription, qui donnerait un message trompeur.
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

# Le compte doit être administrateur. Se contenter d'une connexion réussie
# laisserait le script échouer bien plus loin, sur un 403 énigmatique : c'est
# exactement ce qui arrive quand quelqu'un a déjà créé SON compte (qui devient
# admin), et que l'inscription de repli fabrique un simple viewer.
assert_admin() {
  local role
  role=$(jq -r '.user.role // empty' "$BODY")
  [ "$role" = "admin" ] && return 0

  printf '  \033[31m✗\033[0m %s\n' "« $ADMIN_EMAIL » a le rôle « ${role:-aucun} », pas « admin »."
  printf '    Le premier compte créé sur une base vierge devient administrateur ;\n'
  printf '    les suivants sont de simples viewers.\n\n'
  printf '    Deux issues :\n'
  printf '      1. relancez avec VOTRE compte admin :\n'
  printf '         ADMIN_EMAIL=vous@exemple.fr ADMIN_PASSWORD=... %s\n' "$0"
  printf '      2. ou promouvez ce compte depuis %s/admin/users\n' "$BASE_URL"
  exit 1
}

# ─── helpers métier ───────────────────────────────────────────────────────────

# AppSpec minimale : un service exposé, une image, une route de santé.
spec_json() {
  local name="$1" version="$2" image="$3" health_path="$4"
  jq -n --arg n "$name" --arg v "$version" --arg i "$image" --arg p "$health_path" \
    '{name:$n, version:$v, services:[{
        name:"web",
        source:{type:"image", ref:$i},
        port:80,
        exposed:true,
        healthcheck:{path:$p, intervalSec:2, timeoutSec:3, retries:4}
      }]}'
}

# AppSpec dont **la sonde du pipeline** échoue, mais dont le conteneur se porte
# bien.
#
# La nuance est nécessaire : `docker compose up --wait` refuse déjà de rendre la
# main si le healthcheck du conteneur échoue, et l'étape en défaut serait alors
# `deploy`, pas `healthcheck`. Or le rollback automatique se déclenche sur
# `healthcheck` — c'est là que la question « ce déploiement sert-il vraiment
# l'application ? » est posée.
#
# On sépare donc les deux sondes : `healthcheck.port` (80) est celui où le
# serveur écoute réellement, donc le conteneur est sain ; `port` (8080) est
# celui que le driver publie, et personne n'écoute derrière. Le pipeline sonde
# le port publié depuis la cible et trouve porte close : issue « injoignable ».
spec_json_broken() {
  local name="$1" version="$2" image="$3"
  jq -n --arg n "$name" --arg v "$version" --arg i "$image" \
    '{name:$n, version:$v, services:[{
        name:"web",
        source:{type:"image", ref:$i},
        port:8080,
        exposed:true,
        healthcheck:{path:"/", port:80, intervalSec:2, timeoutSec:3, retries:3}
      }]}'
}

# Crée l'application, ou remplace son AppSpec si elle existe déjà.
upsert_app() {
  local slug="$1" spec="$2" id code
  req GET /api/applications >/dev/null
  id=$(jq -r --arg s "$slug" '.items[] | select(.slug == $s) | .id' "$BODY" | head -1)

  if [ -n "$id" ]; then
    jq -n --argjson spec "$spec" '{appSpec:$spec}' > "$WORK/patch.json"
    code=$(req PATCH "/api/applications/$id" "@$WORK/patch.json")
    [ "$code" = "200" ] || fail "PATCH /api/applications/$id → HTTP $code : $(cat "$BODY")"
    printf '%s' "$id"
    return
  fi

  jq -n --argjson spec "$spec" '{appSpec:$spec}' > "$WORK/create.json"
  code=$(req POST /api/applications "@$WORK/create.json")
  [ "$code" = "201" ] || fail "POST /api/applications → HTTP $code : $(cat "$BODY")"
  jq -r .id "$BODY"
}

# Déploie et attend le verdict. Écho : "<deploymentId> <statut>".
deploy_and_wait() {
  local app_id="$1" target_id="$2" auto_rollback="${3:-true}" code id status
  code=$(req POST /api/deployments \
    "{\"applicationId\":\"$app_id\",\"targetId\":\"$target_id\",\"runtime\":\"docker\",\"proxy\":\"traefik\",\"autoRollback\":$auto_rollback}")
  [ "$code" = "202" ] || fail "POST /api/deployments → HTTP $code : $(cat "$BODY")"
  id=$(jq -r .id "$BODY")

  for _ in $(seq 1 150); do
    sleep 2
    req GET "/api/deployments/$id" >/dev/null
    status=$(jq -r .status "$BODY")
    case "$status" in
      success|failed|rolled_back|destroyed) printf '%s %s' "$id" "$status"; return ;;
    esac
  done
  fail "le déploiement $id n'a pas abouti en 5 minutes (statut « $status »)"
}

destroy_and_wait() {
  local id="$1" code status
  code=$(req DELETE "/api/deployments/$id")
  [ "$code" = "202" ] || fail "DELETE /api/deployments/$id → HTTP $code : $(cat "$BODY")"

  for _ in $(seq 1 90); do
    sleep 2
    req GET "/api/deployments/$id" >/dev/null
    status=$(jq -r .status "$BODY")
    [ "$status" = "destroyed" ] && return
  done
  fail "le déploiement $id n'a pas été détruit en 3 minutes (statut « $status »)"
}

# Journal complet d'un déploiement, toutes étapes confondues.
deployment_log() {
  req GET "/api/deployments/$1" >/dev/null
  jq -r '[.steps[].log] | join("")' "$BODY"
}

# `ufw status` sur la cible. Vide si l'on ne peut pas y accéder directement.
ufw_status() {
  docker compose exec -T "$TARGET_CONTAINER" sh -lc 'ufw status 2>/dev/null || true' 2>/dev/null || true
}

# ─── 1. Contexte ──────────────────────────────────────────────────────────────

step "1. Connexion et cible"
login
pass "connecté en tant que $ADMIN_EMAIL"

req GET /api/targets >/dev/null
TARGET_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY")
[ -n "$TARGET_ID" ] || fail "cible « $TARGET_NAME » introuvable — lancez ./scripts/setup-test-target.sh"
jq -e --arg n "$TARGET_NAME" \
  '.items[] | select(.name == $n) | .runtimesAvailable.docker.available == true' "$BODY" >/dev/null \
  || fail "la cible « $TARGET_NAME » n'a pas de runtime Docker — lancez un preflight"
pass "$TARGET_NAME — $TARGET_ID"

step "2. Plage de ports par cible"
code=$(req PATCH "/api/targets/$TARGET_ID" \
  "{\"portRangeStart\":$RANGE_START,\"portRangeEnd\":$RANGE_END}")
[ "$code" = "200" ] || fail "PATCH /api/targets/$TARGET_ID → HTTP $code : $(cat "$BODY")"
jq -e --argjson s "$RANGE_START" --argjson e "$RANGE_END" \
  '.portRangeStart == $s and .portRangeEnd == $e' "$BODY" >/dev/null \
  || fail "la plage n'a pas été enregistrée : $(jq -c '{portRangeStart, portRangeEnd}' "$BODY")"
pass "plage de « $TARGET_NAME » fixée à $RANGE_START-$RANGE_END"

# Une plage inversée doit être refusée — c'est une donnée, pas un vœu pieux.
code=$(req PATCH "/api/targets/$TARGET_ID" \
  "{\"portRangeStart\":$RANGE_END,\"portRangeEnd\":$RANGE_START}")
[ "$code" = "409" ] || fail "une plage inversée devrait être refusée (HTTP $code)"
pass "une plage inversée est refusée (HTTP 409)"

code=$(req GET "/api/targets/$TARGET_ID/ports")
[ "$code" = "200" ] || fail "GET /api/targets/$TARGET_ID/ports → HTTP $code : $(cat "$BODY")"
jq -e --argjson s "$RANGE_START" --argjson e "$RANGE_END" \
  '.range.min == $s and .range.max == $e and .capacity == ($e - $s + 1)' "$BODY" >/dev/null \
  || fail "GET /ports ne reflète pas la plage : $(jq -c '{range, capacity}' "$BODY")"
pass "GET /api/targets/:id/ports — plage, capacité, occupation, ports libres"
info "$(jq -c '{range, capacity, used, free}' "$BODY")"

# ─── 3. Deux applications, deux ports ─────────────────────────────────────────

step "3. Deux applications sur la même cible → deux ports distincts"

APP_A=$(upsert_app 'jalon7-alpha' "$(spec_json jalon7-alpha 1.0.0 docker.io/library/nginx:1.29-alpine /)")
APP_B=$(upsert_app 'jalon7-beta'  "$(spec_json jalon7-beta  1.0.0 docker.io/library/nginx:1.29-alpine /)")
pass "applications jalon7-alpha et jalon7-beta prêtes"

read -r DEPLOY_A STATUS_A <<< "$(deploy_and_wait "$APP_A" "$TARGET_ID")"
[ "$STATUS_A" = "success" ] \
  || fail "jalon7-alpha : statut « $STATUS_A » — $(deployment_log "$DEPLOY_A" | tail -c 500)"
req GET "/api/deployments/$DEPLOY_A" >/dev/null
PORT_A=$(jq -r '.publishedPort // empty' "$BODY")
pass "jalon7-alpha déployée — port $PORT_A"

read -r DEPLOY_B STATUS_B <<< "$(deploy_and_wait "$APP_B" "$TARGET_ID")"
[ "$STATUS_B" = "success" ] \
  || fail "jalon7-beta : statut « $STATUS_B » — $(deployment_log "$DEPLOY_B" | tail -c 500)"
req GET "/api/deployments/$DEPLOY_B" >/dev/null
PORT_B=$(jq -r '.publishedPort // empty' "$BODY")
pass "jalon7-beta déployée — port $PORT_B"

[ -n "$PORT_A" ] && [ -n "$PORT_B" ] || fail "un déploiement n'a publié aucun port"
[ "$PORT_A" != "$PORT_B" ] || fail "les deux applications ont reçu le même port ($PORT_A)"
pass "deux ports distincts : $PORT_A ≠ $PORT_B"

for port in "$PORT_A" "$PORT_B"; do
  [ "$port" -ge "$RANGE_START" ] && [ "$port" -le "$RANGE_END" ] \
    || fail "le port $port sort de la plage $RANGE_START-$RANGE_END déclarée par la cible"
done
pass "les deux ports tiennent dans la plage $RANGE_START-$RANGE_END de la cible"

for port in "$PORT_A" "$PORT_B"; do
  http=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://127.0.0.1:$port" || echo 000)
  [ "$http" = "200" ] || fail "http://127.0.0.1:$port → HTTP $http"
done
pass "les deux URLs répondent — HTTP 200 sur $PORT_A et $PORT_B"

req GET "/api/targets/$TARGET_ID/ports" >/dev/null
jq -e --argjson a "$PORT_A" --argjson b "$PORT_B" \
  '([.allocations[].port] | index($a)) != null and ([.allocations[].port] | index($b)) != null' \
  "$BODY" >/dev/null || fail "GET /ports ne montre pas les deux réservations"
jq -e '[.allocations[] | select(.applicationSlug == "jalon7-alpha")] | length == 1' "$BODY" >/dev/null \
  || fail "GET /ports n'attribue pas le port à la bonne application"
pass "GET /ports attribue chaque port à son application"
info "$(jq -rc '[.allocations[] | "\(.applicationSlug)→\(.port)"] | join("  ")' "$BODY")"

# ─── 4. Pare-feu ──────────────────────────────────────────────────────────────

step "4. Pare-feu UFW"
UFW_OUT="$(ufw_status)"
LOG_A="$(deployment_log "$DEPLOY_A")"

if printf '%s' "$UFW_OUT" | grep -qi 'Status: active'; then
  UFW_MODE=active
  printf '%s' "$UFW_OUT" | grep -q "$PORT_A/tcp" \
    || fail "aucune règle ufw pour le port $PORT_A"
  printf '%s' "$UFW_OUT" | grep "$PORT_A/tcp" | grep -q 'pupitre:jalon7-alpha' \
    || fail "la règle du port $PORT_A ne porte pas le commentaire « pupitre:jalon7-alpha »"
  printf '%s' "$UFW_OUT" | grep "$PORT_B/tcp" | grep -q 'pupitre:jalon7-beta' \
    || fail "la règle du port $PORT_B ne porte pas le commentaire « pupitre:jalon7-beta »"
  pass "deux règles ufw créées, chacune avec son commentaire pupitre:{slug}"
elif printf '%s' "$UFW_OUT" | grep -qi 'Status: inactive'; then
  UFW_MODE=inactive
  printf '%s' "$LOG_A" | grep -q 'ufw inactif' \
    || fail "ufw est inactif sur la cible, mais aucun avertissement dans les logs du déploiement"
  pass "ufw inactif sur la cible → avertissement émis, et rien n'a cassé"
  info "$(printf '%s' "$LOG_A" | grep -o 'ufw inactif[^"]*' | head -1)"
  warn "chemin « ufw actif » non testé ici : la cible de test ne l'active pas"
else
  UFW_MODE=unknown
  warn "impossible de lire « ufw status » sur $TARGET_CONTAINER — contrôle par les logs seuls"
  printf '%s' "$LOG_A" | grep -qE 'ufw (allow|inactif|absent)' \
    || fail "le déploiement n'a rien dit du pare-feu"
  pass "le déploiement a bien statué sur le pare-feu"
fi

# ─── 5. Destroy : le port est rendu, le voisin est intact ─────────────────────

step "5. Destroy de la première → port libéré, la seconde intacte"
destroy_and_wait "$DEPLOY_A"
pass "jalon7-alpha détruite"

req GET "/api/targets/$TARGET_ID/ports" >/dev/null
jq -e --argjson a "$PORT_A" '([.allocations[].port] | index($a)) == null' "$BODY" >/dev/null \
  || fail "le port $PORT_A est toujours réservé après le destroy"
pass "port $PORT_A libéré — il est de nouveau allouable"

jq -e --argjson b "$PORT_B" '([.allocations[].port] | index($b)) != null' "$BODY" >/dev/null \
  || fail "le destroy de jalon7-alpha a emporté la réservation de jalon7-beta"
pass "la réservation de jalon7-beta est intacte"

http=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://127.0.0.1:$PORT_B" || echo 000)
[ "$http" = "200" ] || fail "jalon7-beta ne répond plus après le destroy du voisin (HTTP $http)"
pass "jalon7-beta répond toujours — HTTP 200 sur $PORT_B"

http=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT_A" || echo 000)
[ "$http" != "200" ] || fail "jalon7-alpha répond encore sur $PORT_A après destruction"
pass "plus rien n'écoute sur $PORT_A"

if [ "$UFW_MODE" = active ]; then
  UFW_OUT="$(ufw_status)"
  printf '%s' "$UFW_OUT" | grep -q "$PORT_A/tcp" \
    && fail "la règle ufw du port $PORT_A survit au destroy"
  printf '%s' "$UFW_OUT" | grep "$PORT_B/tcp" | grep -q 'pupitre:jalon7-beta' \
    || fail "le destroy a emporté la règle ufw de jalon7-beta"
  pass "règle ufw de $PORT_A retirée par son commentaire, celle de $PORT_B intacte"
else
  LOG_A="$(deployment_log "$DEPLOY_A")"
  printf '%s' "$LOG_A" | grep -qE 'ufw (inactif|absent)' \
    || fail "le destroy n'a rien dit du pare-feu"
  pass "ufw $UFW_MODE : le destroy le signale et n'échoue pas"
fi

# ─── 6. Rollback automatique ──────────────────────────────────────────────────

step "6. v1 saine, v2 au healthcheck cassé → rollback automatique"

APP_C=$(upsert_app 'jalon7-rollback' \
  "$(spec_json jalon7-rollback 1.0.0 docker.io/library/nginx:1.29-alpine /)")
read -r DEPLOY_V1 STATUS_V1 <<< "$(deploy_and_wait "$APP_C" "$TARGET_ID")"
[ "$STATUS_V1" = "success" ] \
  || fail "la v1 devait réussir, statut « $STATUS_V1 » — $(deployment_log "$DEPLOY_V1" | tail -c 500)"
req GET "/api/deployments/$DEPLOY_V1" >/dev/null
PORT_C=$(jq -r '.publishedPort // empty' "$BODY")
V1_BODY="$(curl -s --max-time 15 "http://127.0.0.1:$PORT_C" || true)"
printf '%s' "$V1_BODY" | grep -qi 'nginx' \
  || fail "la v1 ne sert pas la page nginx attendue sur $PORT_C"
pass "v1 (nginx) déployée et saine — port $PORT_C"

# La v2 change d'image et publie un port derrière lequel rien n'écoute : le
# conteneur démarre et se déclare sain, mais l'application est injoignable par
# le chemin que le panel expose. C'est l'étape `healthcheck` qui le découvre —
# exactement le cas que le rollback automatique doit rattraper.
upsert_app 'jalon7-rollback' \
  "$(spec_json_broken jalon7-rollback 2.0.0 docker.io/library/httpd:2.4-alpine)" >/dev/null
read -r DEPLOY_V2 STATUS_V2 <<< "$(deploy_and_wait "$APP_C" "$TARGET_ID" true)"

[ "$STATUS_V2" = "rolled_back" ] \
  || fail "attendu « rolled_back », obtenu « $STATUS_V2 » — $(deployment_log "$DEPLOY_V2" | tail -c 800)"
pass "statut « rolled_back » — distinct de « failed »"

req GET "/api/deployments/$DEPLOY_V2" >/dev/null
jq -e '.failedStep == "healthcheck"' "$BODY" >/dev/null \
  || fail "l'étape en échec devrait être « healthcheck » : $(jq -r .failedStep "$BODY")"
jq -e '[.steps[] | select(.key == "rollback" and .status == "success")] | length == 1' "$BODY" >/dev/null \
  || fail "la step « rollback » n'a pas réussi : $(jq -c '[.steps[] | {key, status}]' "$BODY")"
pass "step « healthcheck » en échec, step « rollback » réussie"

# Le diagnostic est capturé avant que le rollback n'efface la scène.
HEALTH_ERROR=$(jq -r '[.steps[] | select(.key == "healthcheck") | .error] | join("")' "$BODY")
printf '%s' "$HEALTH_ERROR" | grep -q 'docker compose ps' \
  || fail "le diagnostic n'a pas été capturé dans deployment_steps.error"
printf '%s' "$HEALTH_ERROR" | grep -q 'docker compose logs' \
  || fail "les logs des services manquent au diagnostic"
printf '%s' "$HEALTH_ERROR" | grep -qi 'injoignable' \
  || fail "l'issue « unreachable » n'est pas nommée : $(printf '%s' "$HEALTH_ERROR" | head -c 120)"
pass "diagnostic capturé — docker compose ps + logs, issue « injoignable »"
info "$(printf '%s' "$HEALTH_ERROR" | head -1 | cut -c1-110)"

LOG_V2="$(deployment_log "$DEPLOY_V2")"
printf '%s' "$LOG_V2" | grep -q 'docker compose ps' \
  || fail "le diagnostic n'a pas été diffusé dans le flux de logs"
pass "diagnostic présent aussi dans le flux (donc dans le SSE)"

V2_BODY="$(curl -s --max-time 15 "http://127.0.0.1:$PORT_C" || true)"
printf '%s' "$V2_BODY" | grep -qi 'nginx' \
  || fail "après rollback, l'URL ne sert pas la v1 : $(printf '%s' "$V2_BODY" | head -c 120)"
printf '%s' "$V2_BODY" | grep -qi 'it works' \
  && fail "après rollback, c'est encore la v2 (httpd) qui répond"
pass "http://127.0.0.1:$PORT_C sert de nouveau la v1 (nginx)"

req GET "/api/targets/$TARGET_ID/ports" >/dev/null
jq -e --argjson c "$PORT_C" '([.allocations[].port] | index($c)) != null' "$BODY" >/dev/null \
  || fail "le rollback a relâché le port $PORT_C, alors que la v1 tourne dessus"
pass "port $PORT_C conservé : une version tourne toujours dessus"

step "7. Traçabilité du rollback"
code=$(req GET "/api/audit-logs?resourceType=deployment&pageSize=50")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
jq -e --arg id "$DEPLOY_V2" \
  '[.items[] | select(.action == "deployment.rolled_back.automatic" and .resourceId == $id)] | length > 0' \
  "$BODY" >/dev/null || fail "aucun « deployment.rolled_back.automatic » dans le journal d'audit"
AUDIT=$(jq -c --arg id "$DEPLOY_V2" \
  'first(.items[] | select(.action == "deployment.rolled_back.automatic" and .resourceId == $id))
   | {from: .before.version, to: .after.restoredVersion, reason: (.after.reason | tostring | .[0:60])}' \
  "$BODY")
pass "audit : deployment.rolled_back.automatic"
info "$AUDIT"
printf '%s' "$AUDIT" | grep -q '"from":"2.0.0"' || fail "l'audit ne dit pas de quelle version on vient"
printf '%s' "$AUDIT" | grep -q '"to":"1.0.0"' || fail "l'audit ne dit pas vers quelle version on va"
pass "l'audit nomme la version quittée, la version restaurée et la raison"

step "8. Historique des versions et redéploiement"
code=$(req GET "/api/applications/$APP_C/versions")
[ "$code" = "200" ] || fail "GET /api/applications/$APP_C/versions → HTTP $code"
jq -e '.items | length >= 2' "$BODY" >/dev/null || fail "l'historique devrait porter au moins deux versions"
jq -e '[.items[] | select(.status == "rolled_back")] | length >= 1' "$BODY" >/dev/null \
  || fail "l'historique ne montre pas la version rollbackée"
jq -e '[.items[] | select(.appVersion == "1.0.0" and .redeployable)] | length >= 1' "$BODY" >/dev/null \
  || fail "la v1 devrait être redéployable (AppSpec figée)"
pass "GET /api/applications/:id/versions — $(jq -r '.items | length' "$BODY") version(s), cible, statut, auteur"
info "$(jq -rc '[.items[] | "#\(.version) \(.appVersion) \(.status)"] | join("  ")' "$BODY")"

V1_ID=$(jq -r 'first(.items[] | select(.appVersion == "1.0.0" and .redeployable) | .deploymentId)' "$BODY")
code=$(req POST "/api/applications/$APP_C/redeploy" \
  "{\"versionId\":\"$V1_ID\",\"targetId\":\"$TARGET_ID\"}")
[ "$code" = "202" ] || fail "POST /api/applications/:id/redeploy → HTTP $code : $(cat "$BODY")"
REDEPLOY_ID=$(jq -r .id "$BODY")
jq -e '.appVersion == "1.0.0"' "$BODY" >/dev/null \
  || fail "le redéploiement ne rejoue pas l'AppSpec de la version demandée"
pass "POST /api/applications/:id/redeploy — rejoue l'AppSpec 1.0.0 figée"

for _ in $(seq 1 150); do
  sleep 2
  req GET "/api/deployments/$REDEPLOY_ID" >/dev/null
  REDEPLOY_STATUS=$(jq -r .status "$BODY")
  case "$REDEPLOY_STATUS" in success|failed|rolled_back) break ;; esac
done
[ "$REDEPLOY_STATUS" = "success" ] \
  || fail "le redéploiement a fini en « $REDEPLOY_STATUS » — $(deployment_log "$REDEPLOY_ID" | tail -c 500)"
pass "le redéploiement de la v1 a réussi"

# Rétention : les cinq versions les plus récentes, plus celle vers laquelle
# pointe `current` si elle n'en fait pas partie — ce qui est le cas après un
# rollback. D'où six au pire, et jamais davantage.
RELEASES=$(docker compose exec -T "$TARGET_CONTAINER" \
  sh -lc 'ls -1d /opt/bootstrap/apps/jalon7-rollback/*/ 2>/dev/null | grep -v /current/ | wc -l' \
  2>/dev/null | tr -d ' \r' || echo '')
if [ -n "$RELEASES" ] && [ "$RELEASES" -gt 0 ] 2>/dev/null; then
  [ "$RELEASES" -le 6 ] || fail "$RELEASES répertoires de version sur la cible, la rétention en garde 5 (+ current)"
  pass "rétention : $RELEASES répertoire(s) de version conservé(s) sur la cible (5 + current)"
else
  warn "répertoires de version illisibles depuis ce poste — rétention non vérifiée"
fi

# ─── 9. Parité ────────────────────────────────────────────────────────────────

step "9. Parité Docker / K3s"
if pnpm typecheck >"$WORK/typecheck.log" 2>&1; then
  pass "pnpm typecheck passe — scripts/test-parity.ts compile toujours"
else
  tail -20 "$WORK/typecheck.log"
  fail "pnpm typecheck échoue"
fi
warn "test-parity.ts n'est PAS exécuté : aucune cible K3s n'est enregistrée (voir README)"

# ─── ménage ───────────────────────────────────────────────────────────────────

step "10. Ménage"
destroy_and_wait "$REDEPLOY_ID"
destroy_and_wait "$DEPLOY_B"
pass "déploiements de test détruits"

printf '\n\033[32m✓ Critère de sortie du jalon 7 vérifié.\033[0m\n'
printf '\033[2m  ufw : %s · ports %s et %s alloués puis rendus · rollback %s → %s\033[0m\n' \
  "$UFW_MODE" "$PORT_A" "$PORT_B" "2.0.0" "1.0.0"
printf '\n'
