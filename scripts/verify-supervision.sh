#!/usr/bin/env bash
#
# Vérifie la supervision des applications déployées :
#
#   1. la liste ne montre que ce qui tourne réellement
#   2. le flux SSE remonte un état de services
#   3. il remonte des lignes de logs, attribuées au bon service
#   4. il TIENT dans la durée (le piège des gardes de timeout)
#   5. le redémarrage passe par la file et publie son cycle de vie
#   6. un déploiement échoué n'est pas supervisable
#   7. l'action est tracée dans le journal d'audit
#   8. une application dont la DERNIÈRE MISE À JOUR A ÉCHOUÉ reste listée,
#      avec un état qui le dit — elle tourne toujours, dans sa version d'avant
#
# Usage :
#   ./scripts/verify-supervision.sh
#   BASE_URL=http://localhost:3200 ./scripts/verify-supervision.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
CLIENT_IP="${CLIENT_IP:-198.51.100.42}"
TARGET_NAME="${TARGET_NAME:-cible-de-verification}"
# Matière propre au script : il ne touche à aucune application déjà en marche.
FAILED_UPDATE_SLUG="${FAILED_UPDATE_SLUG:-supervision-maj-ratee}"
IMAGE_OK="${IMAGE_OK:-docker.io/library/nginx:1.29-alpine}"
IMAGE_KO="${IMAGE_KO:-docker.io/library/httpd:2.4-alpine}"

# Au-delà du défaut de garde SSH (30 s) : c'est précisément la durée qui a
# révélé que le suivi de logs était coupé par un timeout qu'il ne devrait pas
# subir. Ne pas descendre en dessous.
STREAM_SECONDS="${STREAM_SECONDS:-45}"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
BODY="$WORK/body.json"
SSE="$WORK/stream.sse"
trap 'rm -rf "$WORK"' EXIT

command -v jq >/dev/null || { echo "jq is required"; exit 1; }

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

assert_admin() {
  local role
  role=$(jq -r '.user.role // empty' "$BODY")
  [ "$role" = "admin" ] && return 0
  fail "\"$ADMIN_EMAIL\" has the role \"${role:-none}\", not \"admin\" — see /admin/users"
}

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
  [ "$code" = "200" ] || fail "sign-in failed (HTTP $code): $(cat "$BODY")"
  assert_admin
}

# Extrait les données d'un type d'événement SSE donné.
events() { grep -A1 "^event: $1\$" "$SSE" | grep '^data:' | sed 's/^data: //'; }

# ─── helpers du scénario « dernière mise à jour échouée » ─────────────────────

# AppSpec saine : un service exposé, une image, une route de santé.
spec_ok() {
  jq -n --arg n "$1" --arg v "$2" --arg i "$IMAGE_OK" \
    '{name:$n, version:$v, services:[{
        name:"web", source:{type:"image", ref:$i}, port:80, exposed:true,
        healthcheck:{path:"/", intervalSec:2, timeoutSec:3, retries:4}
      }]}'
}

# AppSpec dont la sonde du PIPELINE échoue alors que le conteneur se porte bien.
# Même recette que verify-ports-rollback.sh : le service écoute sur 80, le driver publie
# 8080, et personne n'écoute derrière. L'étape en défaut est donc `healthcheck`,
# après que `deploy` a remplacé les conteneurs — le cas exact qui faisait
# disparaître l'application de cet écran.
spec_ko() {
  jq -n --arg n "$1" --arg v "$2" --arg i "$IMAGE_KO" \
    '{name:$n, version:$v, services:[{
        name:"web", source:{type:"image", ref:$i}, port:8080, exposed:true,
        healthcheck:{path:"/", port:80, intervalSec:2, timeoutSec:3, retries:3}
      }]}'
}

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
# `autoRollback:false` : on veut un `failed` franc, pas un `rolled_back`.
deploy_and_wait() {
  local app_id="$1" target_id="$2" code id status
  code=$(req POST /api/deployments \
    "{\"applicationId\":\"$app_id\",\"targetId\":\"$target_id\",\"runtime\":\"docker\",\"proxy\":\"traefik\",\"autoRollback\":false}")
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
  fail "deployment $id did not complete in 5 minutes (status \"$status\")"
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
  fail "deployment $id was not destroyed in 3 minutes (status \"$status\")"
}

step "1. Sign-in"
login
pass "signed in as $ADMIN_EMAIL"

step "2. Les applications supervisées"
code=$(req GET /api/apps)
[ "$code" = "200" ] || fail "GET /api/apps → HTTP $code : $(cat "$BODY")"

COUNT=$(jq -r '.items | length' "$BODY")
[ "$COUNT" -ge 1 ] || fail "aucune application en marche — déployez-en une d'abord"
pass "$COUNT application(s) supervisée(s)"

# Seuls « success » et « rolled_back » représentent quelque chose qui tourne.
jq -e '[.items[] | select(.status != "success" and .status != "rolled_back")] | length == 0' \
  "$BODY" >/dev/null || fail "la liste contient un déploiement qui ne tourne pas"
pass "la liste ne contient que des déploiements en marche"

# Photo de départ : à la fin du script, elle doit être identique.
# L'identité d'une ligne supervisée est le COUPLE application+cible, pas le
# seul nom : la même application peut tourner sur deux machines, et deux lignes
# « demo-api » ne sont alors pas un doublon mais deux déploiements distincts.
# Comparer les seuls noms ferait passer ce cas normal pour une fuite.
live_pairs() { jq -r '[.items[] | "\(.applicationSlug)@\(.targetName)"] | sort | join(", ")' "$BODY"; }

LIVE_BEFORE=$(live_pairs)

APP_ID=$(jq -r '.items[0].id' "$BODY")
APP_SLUG=$(jq -r '.items[0].applicationSlug' "$BODY")
APP_URL=$(jq -r '.items[0].url // empty' "$BODY")
info "sujet : « $APP_SLUG » ($APP_ID)"

step "3. Flux de logs en direct (${STREAM_SECONDS} s)"
# Du trafic, pour que l'application ait quelque chose à dire.
if [ -n "$APP_URL" ]; then
  ( sleep 4; for _ in $(seq 1 30); do curl -s -o /dev/null --max-time 2 "$APP_URL/" || true; done ) &
fi

curl -sN --max-time "$STREAM_SECONDS" -b "$JAR" "$BASE_URL/api/apps/$APP_ID/logs" > "$SSE" || true
wait 2>/dev/null || true

grep -q '^event: ready' "$SSE" || fail "le flux ne s'est pas ouvert : $(head -c 300 "$SSE")"
pass "flux ouvert"

if grep -q '^event: error' "$SSE"; then
  fail "le flux a signalé une erreur : $(events error | head -1)"
fi

events status | tail -1 > "$WORK/status.json"
[ -s "$WORK/status.json" ] || fail "aucun état de services remonté"
SERVICES=$(jq -r '[.services[].name] | join(", ")' "$WORK/status.json")
[ -n "$SERVICES" ] || fail "l'état ne contient aucun service"
pass "état des services : $SERVICES"

LINES=$(grep -c '^event: log' "$SSE" || true)
[ "$LINES" -ge 1 ] || fail "aucune ligne de log reçue"
pass "$LINES ligne(s) de log reçue(s)"

step "4. Le flux tient dans la durée"
# Le piège : une garde de timeout côté SSH coupait « logs -f » au bout de 30 s.
# Un « stream.stopped » avant la fin du test signifie que la coupure est revenue.
if events lifecycle | jq -e 'select(.action == "stream.stopped")' >/dev/null 2>&1; then
  DETAIL=$(events lifecycle | jq -r 'select(.action == "stream.stopped") | .detail')
  fail "le flux s'est coupé tout seul avant ${STREAM_SECONDS} s ($DETAIL)"
fi
pass "aucune coupure prématurée sur ${STREAM_SECONDS} s"

step "5. Les noms de service concordent"
# Compose préfixe avec le nom du CONTENEUR (« api-1 »), l'état rapporte le nom
# du SERVICE (« api »). S'ils divergent, le filtre par service de l'interface
# ne trouve jamais rien — panne silencieuse.
events log | jq -r '.service // empty' | sort -u > "$WORK/vus.txt"
jq -r '.services[].name' "$WORK/status.json" | sort -u > "$WORK/connus.txt"

if [ -s "$WORK/vus.txt" ]; then
  INTRUS=$(comm -23 "$WORK/vus.txt" "$WORK/connus.txt" || true)
  [ -z "$INTRUS" ] || fail "service inconnu de l'état dans les logs : $(echo "$INTRUS" | tr '\n' ' ')"
  pass "tous les services vus dans les logs existent dans l'état"
else
  info "aucune ligne préfixée — rien à recouper"
fi

step "6. Redémarrage"
code=$(req POST "/api/apps/$APP_ID/restart")
[ "$code" = "202" ] || [ "$code" = "200" ] || fail "POST restart → HTTP $code : $(cat "$BODY")"
JOB=$(jq -r '.jobId // "?"' "$BODY")
pass "redémarrage enfilé (job $JOB) — la route ne fait pas le travail elle-même"

# Le cycle de vie est publié sur le flux : on rouvre pour l'observer.
curl -sN --max-time 40 -b "$JAR" "$BASE_URL/api/apps/$APP_ID/logs" > "$SSE" || true

if events lifecycle | jq -e 'select(.action == "restart" and .done == true)' \
     >/dev/null 2>&1; then
  pass "cycle de vie observé : $(events lifecycle | jq -r 'select(.action == "restart") | .detail' | tail -1)"
else
  info "le redémarrage s'est terminé avant la réouverture du flux — on vérifie l'état"
  events status | tail -1 | jq -e '[.services[] | select(.state == "running")] | length >= 1' \
    >/dev/null || fail "aucun service en marche après redémarrage"
  pass "les services tournent après redémarrage"
fi

step "7. Un déploiement qui ne tourne pas n'est pas supervisable"
code=$(req GET "/api/deployments?status=failed&pageSize=1")
DEAD=""
[ "$code" = "200" ] && DEAD=$(jq -r '.items[0].id // empty' "$BODY" 2>/dev/null || true)
if [ -n "$DEAD" ]; then
  code=$(curl -s -o "$BODY" -w '%{http_code}' -b "$JAR" "$BASE_URL/api/apps/$DEAD/logs")
  [ "$code" = "409" ] || fail "déploiement échoué : attendu 409, reçu $code"
  pass "flux refusé sur un déploiement échoué → 409"
else
  info "aucun déploiement échoué sous la main — cas non exercé"
fi

step "8. Traceability"
code=$(req GET "/api/audit-logs?resourceType=deployment&pageSize=30")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
jq -e '[.items[] | select(.action == "app.restart.requested")] | length > 0' "$BODY" >/dev/null \
  || fail "action « app.restart.requested » absente du journal d'audit"
pass "audit : app.restart.requested"

# ─── 9. Une mise à jour ratée ne fait pas disparaître l'application ───────────
#
# Le défaut corrigé : l'écran ne retenait que le DERNIER déploiement du couple
# (application, cible), et seulement s'il était `success` ou `rolled_back`. Dès
# qu'un déploiement échouait derrière une version en service, l'application
# sortait de la liste — alors que ses conteneurs tournaient toujours.

step "9. Une application dont la dernière mise à jour a échoué reste listée"

req GET /api/targets >/dev/null
TARGET_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY")
[ -n "$TARGET_ID" ] || fail "target \"$TARGET_NAME\" not found — run ./scripts/setup-test-target.sh"
info "cible $TARGET_NAME — $TARGET_ID"

MAJ_APP=$(upsert_app "$FAILED_UPDATE_SLUG" "$(spec_ok "$FAILED_UPDATE_SLUG" 1.0.0)")
read -r MAJ_V1 MAJ_S1 <<< "$(deploy_and_wait "$MAJ_APP" "$TARGET_ID")"
[ "$MAJ_S1" = "success" ] || fail "la v1 devait réussir, statut « $MAJ_S1 »"
pass "v1 de « $FAILED_UPDATE_SLUG » en service — $MAJ_V1"

req GET /api/apps >/dev/null
jq -e --arg s "$FAILED_UPDATE_SLUG" '[.items[] | select(.applicationSlug == $s)] | length == 1' \
  "$BODY" >/dev/null || fail "« $FAILED_UPDATE_SLUG » n'apparaît pas dans /api/apps après la v1"
pass "elle est listée dans /api/apps"

upsert_app "$FAILED_UPDATE_SLUG" "$(spec_ko "$FAILED_UPDATE_SLUG" 2.0.0)" >/dev/null
read -r MAJ_V2 MAJ_S2 <<< "$(deploy_and_wait "$MAJ_APP" "$TARGET_ID")"
[ "$MAJ_S2" = "failed" ] || fail "la v2 devait échouer franchement, statut « $MAJ_S2 »"
req GET "/api/deployments/$MAJ_V2" >/dev/null
jq -e '.failedStep == "healthcheck"' "$BODY" >/dev/null \
  || fail "l'échec devait porter sur « healthcheck », pas « $(jq -r .failedStep "$BODY") »"
pass "v2 échouée à l'étape healthcheck — $MAJ_V2"

# LE test : l'application est toujours là.
req GET /api/apps >/dev/null
jq -e --arg s "$FAILED_UPDATE_SLUG" '[.items[] | select(.applicationSlug == $s)] | length == 1' \
  "$BODY" >/dev/null \
  || fail "« $FAILED_UPDATE_SLUG » a disparu de /api/apps après un déploiement raté — c'est le défaut"
pass "elle est TOUJOURS listée après le déploiement raté"

# Et c'est bien la v1 qui est présentée comme en service : c'est elle qui tourne,
# et c'est le seul identifiant sur lequel logs et redémarrage ont un sens.
jq -e --arg s "$FAILED_UPDATE_SLUG" --arg id "$MAJ_V1" \
  '[.items[] | select(.applicationSlug == $s)][0] | .id == $id and .status == "success"' \
  "$BODY" >/dev/null || fail "la ligne ne porte pas la v1 en service : $(jq -c --arg s "$FAILED_UPDATE_SLUG" '[.items[]|select(.applicationSlug==$s)][0]|{id,status}' "$BODY")"
pass "la ligne porte la v1 en service, pas la v2 échouée"

# L'état le dit franchement plutôt que de le taire.
jq -e --arg s "$FAILED_UPDATE_SLUG" --arg id "$MAJ_V2" \
  '[.items[] | select(.applicationSlug == $s)][0].lastFailedUpdate
     | . != null and .deploymentId == $id and .failedStep == "healthcheck"
       and .mayHaveReplacedServices == true' \
  "$BODY" >/dev/null \
  || fail "l'état ne signale pas la mise à jour échouée : $(jq -c --arg s "$FAILED_UPDATE_SLUG" '[.items[]|select(.applicationSlug==$s)][0].lastFailedUpdate' "$BODY")"
pass "l'état porte « dernière mise à jour échouée » — v2, étape healthcheck"

# Les logs applicatifs restent accessibles sur la version en service.
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" --max-time 8 \
  "$BASE_URL/api/apps/$MAJ_V1/logs" || true)
[ "$code" = "200" ] || fail "le flux de logs de la v1 en service devrait s'ouvrir (HTTP $code)"
pass "le flux de logs de la version en service s'ouvre toujours"

step "10. Cleanup"
destroy_and_wait "$MAJ_V1"
pass "déploiement de test détruit sur la cible"
code=$(req DELETE "/api/deployments/$MAJ_V2/purge")
[ "$code" = "200" ] || info "purge de la v2 échouée → HTTP $code : $(jq -r '.error.message // ""' "$BODY")"
code=$(req DELETE "/api/deployments/$MAJ_V1/purge")
[ "$code" = "200" ] || info "purge de la v1 détruite → HTTP $code : $(jq -r '.error.message // ""' "$BODY")"
code=$(req DELETE "/api/applications/$MAJ_APP")
[ "$code" = "200" ] || info "suppression de $FAILED_UPDATE_SLUG → HTTP $code : $(cat "$BODY")"
pass "application de test supprimée"

req GET /api/apps >/dev/null
LIVE_AFTER=$(live_pairs)
[ "$LIVE_AFTER" = "$LIVE_BEFORE" ] \
  || fail "les applications en marche ont changé : « $LIVE_BEFORE » → « $LIVE_AFTER »"
pass "les applications réellement en marche sont intactes : ${LIVE_AFTER:-aucune}"

printf '\n\033[32m✓ Supervision vérifiée.\033[0m\n'
printf '\033[2m  Écran : %s/apps\033[0m\n\n' "$BASE_URL"
