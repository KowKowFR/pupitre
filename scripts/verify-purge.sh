#!/usr/bin/env bash
#
# Vérifie la purge de l'historique des déploiements.
#
# Purger n'est PAS détruire : `DELETE /api/deployments/:id` démonte l'application
# sur la machine cible, la purge n'efface que la trace en base. Ce script prouve
# que les deux gestes restent distincts et que le garde-fou tient :
#
#   1. la prévisualisation (dryRun) annonce un décompte exact
#   2. un run historique se purge — steps et logs partent avec lui
#   3. une application EN MARCHE refuse d'être purgée → 409
#   4. les entrées d'audit du run purgé sont toujours là
#   5. une réservation de port orpheline est rendue à la cible
#   6. `deployment:purge` est requis — un viewer se prend un 403
#   7. une version en service dont la DERNIÈRE MISE À JOUR A ÉCHOUÉ refuse
#      toujours la purge → 409, tandis que le déploiement raté se purge, lui
#
# Le script crée sa propre matière (application « purge-verif ») : il ne touche
# à aucune application déjà en marche. Les applications vivantes ne sont
# sollicitées qu'en prévisualisation, qui n'écrit rien.
#
# Usage :
#   ./scripts/verify-purge.sh
#   BASE_URL=http://localhost:3200 TARGET_NAME=ma-vm ./scripts/verify-purge.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
TARGET_NAME="${TARGET_NAME:-cible-de-verification}"
APP_SLUG="${APP_SLUG:-purge-verif}"
VIEWER_EMAIL="${VIEWER_EMAIL:-purge-viewer@example.test}"
VIEWER_PASSWORD="${VIEWER_PASSWORD:-motdepasse-tres-long}"
CLIENT_IP="${CLIENT_IP:-198.51.100.42}"
IMAGE="${IMAGE:-docker.io/library/nginx:1.29-alpine}"
# Deuxième jeu de matière, pour le scénario « mise à jour ratée » (§ 9).
MAJ_SLUG="${MAJ_SLUG:-purge-maj-ratee}"
IMAGE_KO="${IMAGE_KO:-docker.io/library/httpd:2.4-alpine}"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
VJAR="$WORK/viewer.jar"
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

# Même chose, avec le bocal à cookies du viewer.
vreq() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -H "x-forwarded-for: $CLIENT_IP" -b "$VJAR" -c "$VJAR")
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}

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

# Le compte doit être administrateur : sans cela le script s'écroulerait bien
# plus loin sur un 403 énigmatique.
assert_admin() {
  local role
  role=$(jq -r '.user.role // empty' "$BODY")
  [ "$role" = "admin" ] && return 0
  fail "« $ADMIN_EMAIL » a le rôle « ${role:-aucun} », pas « admin » — voir $BASE_URL/admin/users"
}

# AppSpec minimale : un service exposé, une image, une route de santé.
spec_json() {
  local name="$1" version="$2"
  jq -n --arg n "$name" --arg v "$version" --arg i "$IMAGE" \
    '{name:$n, version:$v, services:[{
        name:"web",
        source:{type:"image", ref:$i},
        port:80,
        exposed:true,
        healthcheck:{path:"/", intervalSec:2, timeoutSec:3, retries:4}
      }]}'
}

# AppSpec dont la sonde du PIPELINE échoue alors que le conteneur se porte bien.
# Même recette que verify-jalon7.sh : le service écoute sur 80, le driver publie
# 8080, personne n'écoute derrière. L'étape en défaut est donc `healthcheck`,
# après que `deploy` a remplacé les conteneurs.
spec_json_broken() {
  local name="$1" version="$2"
  jq -n --arg n "$name" --arg v "$version" --arg i "$IMAGE_KO" \
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

# ─── 1. Contexte ──────────────────────────────────────────────────────────────

step "1. Connexion et cible"
login
pass "connecté en tant que $ADMIN_EMAIL"

req GET /api/targets >/dev/null
TARGET_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY")
[ -n "$TARGET_ID" ] || fail "cible « $TARGET_NAME » introuvable — lancez ./scripts/setup-test-target.sh"
pass "cible $TARGET_NAME — $TARGET_ID"

# Applications en marche AVANT le passage du script : elles doivent être
# strictement identiques à la fin.
req GET /api/apps >/dev/null
LIVE_BEFORE=$(jq -r '[.items[].applicationSlug] | sort | join(",")' "$BODY")
[ -n "$LIVE_BEFORE" ] || warn "aucune application en marche : le test du 409 reposera sur celle du script"
pass "applications en marche avant purge : ${LIVE_BEFORE:-aucune}"

# ─── 2. Matière de test ───────────────────────────────────────────────────────

step "2. Deux runs de « $APP_SLUG » — une v1 historique, une v2 en service"
APP_ID=$(upsert_app "$APP_SLUG" "$(spec_json "$APP_SLUG" 1.0.0)")
pass "application $APP_SLUG — $APP_ID"

read -r DEPLOY_V1 STATUS_V1 <<< "$(deploy_and_wait "$APP_ID" "$TARGET_ID")"
[ "$STATUS_V1" = "success" ] || fail "la v1 devait réussir, statut « $STATUS_V1 »"
req GET "/api/deployments/$DEPLOY_V1" >/dev/null
PORT_V1=$(jq -r '.publishedPort // empty' "$BODY")
pass "v1 déployée — $DEPLOY_V1, port $PORT_V1"

read -r DEPLOY_V2 STATUS_V2 <<< "$(deploy_and_wait "$APP_ID" "$TARGET_ID")"
[ "$STATUS_V2" = "success" ] || fail "la v2 devait réussir, statut « $STATUS_V2 »"
pass "v2 déployée — $DEPLOY_V2 : c'est elle qui est en service"

STEPS_V1=$(psql_q "select count(*) from deployment_steps where deployment_id = '$DEPLOY_V1';")
[ "$STEPS_V1" -gt 0 ] || fail "la v1 n'a aucune step en base"
pass "la v1 porte $STEPS_V1 steps en base"

# ─── 3. Prévisualisation ──────────────────────────────────────────────────────

step "3. La prévisualisation annonce un décompte exact"

code=$(req POST /api/deployments/purge "{\"ids\":[\"$DEPLOY_V1\"],\"dryRun\":true}")
[ "$code" = "200" ] || fail "POST /api/deployments/purge (dryRun) → HTTP $code : $(cat "$BODY")"
jq -e '.matched == 1 and .purgedCount == 1 and .refusedCount == 0 and .dryRun == true' "$BODY" \
  >/dev/null || fail "prévisualisation inattendue : $(jq -c '{matched,purgedCount,refusedCount}' "$BODY")"
pass "1 run visé, 1 purgeable, 0 refusé — $(jq -c '.purgedByStatus' "$BODY")"

# Rien n'a bougé : une prévisualisation ne purge pas.
still=$(psql_q "select count(*) from deployments where id = '$DEPLOY_V1';")
[ "$still" = "1" ] || fail "la prévisualisation a effacé le déploiement"
pass "après prévisualisation, la v1 est toujours en base"

# Décompte par filtre, confronté au SQL : c'est le test du « décompte exact ».
SQL_FAILED=$(psql_q "select count(*) from deployments where status = 'failed';")
code=$(req POST /api/deployments/purge '{"statuses":["failed"],"dryRun":true}')
[ "$code" = "200" ] || fail "POST purge statuses=failed → HTTP $code : $(cat "$BODY")"
API_FAILED=$(jq -r '.matched' "$BODY")
[ "$API_FAILED" = "$SQL_FAILED" ] \
  || fail "décompte faux : l'API annonce $API_FAILED runs échoués, SQL en compte $SQL_FAILED"
pass "filtre par statut « failed » : $API_FAILED annoncés, $SQL_FAILED en base — identiques"

# Ancienneté : rien n'a dix ans.
code=$(req POST /api/deployments/purge '{"olderThanDays":3650,"dryRun":true}')
[ "$code" = "200" ] || fail "POST purge olderThanDays → HTTP $code : $(cat "$BODY")"
jq -e '.matched == 0 and .purgedCount == 0' "$BODY" >/dev/null \
  || fail "« plus vieux que 3650 jours » ne devrait rien viser : $(jq -c '{matched}' "$BODY")"
pass "filtre « plus vieux que 3650 jours » → 0 run"

# Un filtre vide viserait tout l'historique : c'est refusé.
code=$(req POST /api/deployments/purge '{"dryRun":true}')
[ "$code" = "422" ] || fail "un filtre vide devrait être refusé (HTTP $code)"
pass "filtre vide refusé → 422"

# ─── 4. LE test : une application en marche ne se purge pas ───────────────────

step "4. Une application EN MARCHE refuse d'être purgée → 409"

code=$(req DELETE "/api/deployments/$DEPLOY_V2/purge")
[ "$code" = "409" ] || fail "purge de la v2 en service : attendu 409, reçu $code — $(cat "$BODY")"
jq -e '.error.message | test("Détruisez-la d.abord")' "$BODY" >/dev/null \
  || fail "le message ne dit pas quoi faire : $(jq -r '.error.message' "$BODY")"
pass "409 — $(jq -r '.error.message' "$BODY")"

# Elle est toujours là, et toujours en marche.
psql_q "select count(*) from deployments where id = '$DEPLOY_V2';" | grep -q '^1$' \
  || fail "la v2 a disparu malgré le refus"
pass "la v2 est intacte en base"

# En masse : le mélange purgeable + en service doit être rapporté honnêtement.
code=$(req POST /api/deployments/purge \
  "{\"ids\":[\"$DEPLOY_V1\",\"$DEPLOY_V2\"],\"dryRun\":true}")
[ "$code" = "200" ] || fail "POST purge (mixte) → HTTP $code"
jq -e '.matched == 2 and .purgedCount == 1 and .refusedCount == 1' "$BODY" >/dev/null \
  || fail "décompte mixte faux : $(jq -c '{matched,purgedCount,refusedCount}' "$BODY")"
jq -e '.refused[0].reason == "live"' "$BODY" >/dev/null \
  || fail "raison de refus inattendue : $(jq -c '.refused' "$BODY")"
pass "2 visés → 1 purgeable, 1 refusé (raison « live ») : le compteur ne ment pas"

# Les applications déjà en marche avant le script : mêmes règles, en
# prévisualisation seulement — rien n'est écrit.
req GET /api/apps >/dev/null
jq -r '.items[].id' "$BODY" > "$WORK/live-ids.txt"
LIVE_IDS=$(jq -c '[.items[].id]' "$BODY")
LIVE_N=$(jq -r 'length' <<< "$LIVE_IDS")
if [ "$LIVE_N" -gt 0 ]; then
  code=$(req POST /api/deployments/purge "{\"ids\":$LIVE_IDS,\"dryRun\":true}")
  [ "$code" = "200" ] || fail "POST purge (apps en marche, dryRun) → HTTP $code"
  jq -e --argjson n "$LIVE_N" '.purgedCount == 0 and .refusedCount == $n' "$BODY" >/dev/null \
    || fail "des applications en marche seraient purgées : $(jq -c '{purgedCount,refusedCount}' "$BODY")"
  pass "les $LIVE_N applications en marche sont toutes refusées"
  info "$(jq -r '[.refused[] | "\(.applicationSlug) v\(.version) → \(.reason)"] | join("  ")' "$BODY")"
fi

# ─── 5. Purge d'un run historique ─────────────────────────────────────────────

step "5. Un run historique se purge — steps et logs partent avec lui"

AUDIT_BEFORE=$(psql_q "select count(*) from audit_logs where resource_id = '$DEPLOY_V1';")
[ "$AUDIT_BEFORE" -gt 0 ] || fail "aucune entrée d'audit pour la v1 : le test d'audit serait vide"
info "$AUDIT_BEFORE entrée(s) d'audit pour la v1 avant purge"

code=$(req DELETE "/api/deployments/$DEPLOY_V1/purge")
[ "$code" = "200" ] || fail "DELETE /api/deployments/$DEPLOY_V1/purge → HTTP $code : $(cat "$BODY")"
pass "v1 purgée — $(jq -c '{purged, releasedPorts, rollbackTargetsLost}' "$BODY")"

[ "$(psql_q "select count(*) from deployments where id = '$DEPLOY_V1';")" = "0" ] \
  || fail "la v1 est encore en base"
pass "la ligne de déploiement a disparu"

[ "$(psql_q "select count(*) from deployment_steps where deployment_id = '$DEPLOY_V1';")" = "0" ] \
  || fail "les steps de la v1 ont survécu à la purge"
pass "les $STEPS_V1 steps (et leurs logs) sont parties en cascade"

[ "$(psql_q "select count(*) from scan_runs where deployment_id = '$DEPLOY_V1';")" = "0" ] \
  || fail "des scan_runs de la v1 ont survécu"
pass "aucun scan_run orphelin"

# La v2 tourne toujours : sa réservation de port ne doit surtout pas bouger.
ALLOC=$(psql_q "select count(*) from port_allocations where target_id = '$TARGET_ID' and application_id = '$APP_ID';")
[ "$ALLOC" = "1" ] || fail "la purge de la v1 a emporté la réservation de port de la v2 en service"
pass "la réservation de port de $APP_SLUG est intacte — la v2 tourne encore"

http=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://127.0.0.1:$PORT_V1" || echo 000)
[ "$http" = "200" ] || warn "http://127.0.0.1:$PORT_V1 → HTTP $http (port non publié hors de la cible ?)"
[ "$http" = "200" ] && pass "l'application répond toujours sur $PORT_V1"

# ─── 6. L'audit survit à ce qu'il décrit ──────────────────────────────────────

step "6. Les entrées d'audit du run purgé sont toujours là"

AUDIT_AFTER=$(psql_q "select count(*) from audit_logs where resource_id = '$DEPLOY_V1';")
[ "$AUDIT_AFTER" -ge "$AUDIT_BEFORE" ] \
  || fail "des entrées d'audit ont disparu avec le déploiement ($AUDIT_BEFORE → $AUDIT_AFTER)"
pass "$AUDIT_AFTER entrée(s) d'audit pour un déploiement qui n'existe plus"
info "$(psql_q "select string_agg(distinct action, ', ') from audit_logs where resource_id = '$DEPLOY_V1';")"

psql_q "select count(*) from audit_logs where action = 'deployment.purged' and resource_id = '$DEPLOY_V1';" \
  | grep -q '^1$' || fail "la purge elle-même n'est pas journalisée"
pass "la purge a laissé sa propre entrée « deployment.purged »"
info "$(psql_q "select after::text from audit_logs where action = 'deployment.purged' and resource_id = '$DEPLOY_V1';" | head -c 300)"

# ─── 7. Réservation de port orpheline ─────────────────────────────────────────

step "7. La purge rend une réservation de port orpheline"

destroy_and_wait "$DEPLOY_V2"
pass "v2 détruite sur la cible — l'application ne tourne plus"

# Le destroy relâche déjà la réservation. On en repose une à la main pour
# prouver le seul point que la purge doit garantir : si une réservation survit
# au dernier déploiement d'un couple (crash du worker, destroy jamais joué),
# c'est la purge qui la rend. Sans cette ligne, le test passerait sans rien
# démontrer.
psql_q "insert into port_allocations (target_id, port, application_id)
        values ('$TARGET_ID', $PORT_V1, '$APP_ID')
        on conflict do nothing;" >/dev/null
ORPHAN=$(psql_q "select count(*) from port_allocations where target_id = '$TARGET_ID' and application_id = '$APP_ID';")
[ "$ORPHAN" = "1" ] || fail "impossible de reposer la réservation orpheline (port $PORT_V1 déjà pris ?)"
pass "réservation orpheline reposée : port $PORT_V1 pour $APP_SLUG"

code=$(req DELETE "/api/deployments/$DEPLOY_V2/purge")
[ "$code" = "200" ] || fail "purge de la v2 détruite → HTTP $code : $(cat "$BODY")"
jq -e --argjson p "$PORT_V1" '[.releasedPorts[].port] | index($p) != null' "$BODY" >/dev/null \
  || fail "la purge n'annonce pas la libération du port $PORT_V1 : $(jq -c '.releasedPorts' "$BODY")"
pass "la purge annonce le port rendu — $(jq -c '.releasedPorts' "$BODY")"

[ "$(psql_q "select count(*) from port_allocations where target_id = '$TARGET_ID' and application_id = '$APP_ID';")" = "0" ] \
  || fail "le port $PORT_V1 reste réservé après la purge du dernier déploiement"
pass "plus aucune réservation en base pour $APP_SLUG — le port est de nouveau allouable"

req GET "/api/targets/$TARGET_ID/ports" >/dev/null
jq -e --arg s "$APP_SLUG" '[.allocations[] | select(.applicationSlug == $s)] | length == 0' "$BODY" \
  >/dev/null || fail "GET /ports montre encore une réservation pour $APP_SLUG"
pass "GET /api/targets/:id/ports le confirme"

# ─── 8. Permission ────────────────────────────────────────────────────────────

step "8. « deployment:purge » est requis"

code=$(req POST /api/admin/users \
  "{\"name\":\"Viewer purge\",\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\",\"role\":\"viewer\"}")
case "$code" in
  201) pass "utilisateur viewer créé" ;;
  409) pass "utilisateur viewer déjà présent" ;;
  *)   fail "POST /api/admin/users → HTTP $code : $(cat "$BODY")" ;;
esac
VIEWER_ID=$(psql_q "select id from users where email = '$VIEWER_EMAIL';")

for _ in 1 2 3 4 5; do
  code=$(vreq POST /api/auth/sign-in/email \
    "{\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\"}")
  [ "$code" = "429" ] || break
  sleep 6
done
[ "$code" = "200" ] || fail "connexion viewer impossible (HTTP $code) : $(cat "$BODY")"
pass "connecté en tant que $VIEWER_EMAIL"

# Il lit l'historique — c'est bien un viewer, pas un compte cassé.
code=$(vreq GET /api/deployments)
[ "$code" = "200" ] || fail "le viewer ne peut même pas lire les déploiements (HTTP $code)"
ANY_ID=$(jq -r '.items[0].id // empty' "$BODY")
pass "le viewer lit bien l'historique"

code=$(vreq POST /api/deployments/purge '{"statuses":["failed"],"dryRun":true}')
[ "$code" = "403" ] || fail "purge en masse par un viewer : attendu 403, reçu $code"
jq -e '.error.details.permission == "deployment:purge"' "$BODY" >/dev/null \
  || fail "le 403 ne nomme pas la permission : $(cat "$BODY")"
pass "purge en masse refusée au viewer → 403 deployment:purge"

if [ -n "$ANY_ID" ]; then
  code=$(vreq DELETE "/api/deployments/$ANY_ID/purge")
  [ "$code" = "403" ] || fail "purge unitaire par un viewer : attendu 403, reçu $code"
  pass "purge unitaire refusée au viewer → 403"
fi

# ─── 9. Le trou : une mise à jour ratée derrière une version en service ───────
#
# Le défaut corrigé : « en service » se calculait sur le DERNIER déploiement du
# couple (application, cible). Un déploiement raté prenait la tête, la version
# `success` en dessous cessait d'être considérée comme vivante — et devenait
# purgeable, alors que ses conteneurs tournaient toujours. Purger cette
# trace-là, c'était perdre le port réservé, le rollback et la destruction.

step "9. Une mise à jour ratée ne rend pas purgeable la version en service"

MAJ_APP=$(upsert_app "$MAJ_SLUG" "$(spec_json "$MAJ_SLUG" 1.0.0)")
read -r MAJ_V1 MAJ_S1 <<< "$(deploy_and_wait "$MAJ_APP" "$TARGET_ID")"
[ "$MAJ_S1" = "success" ] || fail "la v1 de $MAJ_SLUG devait réussir, statut « $MAJ_S1 »"
req GET "/api/deployments/$MAJ_V1" >/dev/null
MAJ_PORT=$(jq -r '.publishedPort // empty' "$BODY")
pass "v1 en service — $MAJ_V1, port $MAJ_PORT"

upsert_app "$MAJ_SLUG" "$(spec_json_broken "$MAJ_SLUG" 2.0.0)" >/dev/null
read -r MAJ_V2 MAJ_S2 <<< "$(deploy_and_wait "$MAJ_APP" "$TARGET_ID")"
[ "$MAJ_S2" = "failed" ] || fail "la v2 devait échouer franchement, statut « $MAJ_S2 »"
req GET "/api/deployments/$MAJ_V2" >/dev/null
jq -e '.failedStep == "healthcheck"' "$BODY" >/dev/null \
  || fail "l'échec devait porter sur « healthcheck », pas « $(jq -r .failedStep "$BODY") »"
pass "v2 échouée à l'étape healthcheck — $MAJ_V2"

# L'application n'a pas disparu de la supervision : c'est l'autre moitié du même
# défaut, vérifiée en détail par verify-supervision.sh.
req GET /api/apps >/dev/null
jq -e --arg s "$MAJ_SLUG" '[.items[] | select(.applicationSlug == $s)] | length == 1' "$BODY" \
  >/dev/null || fail "« $MAJ_SLUG » a disparu de /api/apps après le déploiement raté"
jq -e --arg s "$MAJ_SLUG" '[.items[] | select(.applicationSlug == $s)][0].lastFailedUpdate != null' \
  "$BODY" >/dev/null || fail "l'état ne signale pas la mise à jour échouée"
pass "toujours listée dans /api/apps, avec « dernière mise à jour échouée »"

# LE test : la v1 `success` sous-jacente refuse toujours la purge.
code=$(req DELETE "/api/deployments/$MAJ_V1/purge")
[ "$code" = "409" ] || fail "purge de la v1 en service : attendu 409, reçu $code — $(cat "$BODY")"
jq -e '.error.message | test("Détruisez-la d.abord")' "$BODY" >/dev/null \
  || fail "le message ne dit pas quoi faire : $(jq -r '.error.message' "$BODY")"
pass "409 — $(jq -r '.error.message' "$BODY")"

psql_q "select count(*) from deployments where id = '$MAJ_V1';" | grep -q '^1$' \
  || fail "la v1 a disparu malgré le refus"
[ "$(psql_q "select count(*) from port_allocations where target_id = '$TARGET_ID' and application_id = '$MAJ_APP';")" = "1" ] \
  || fail "la réservation de port de $MAJ_SLUG a été perdue"
pass "la v1 et sa réservation de port sont intactes"

# Le déploiement raté, lui, se purge normalement : il n'est la poignée de rien.
code=$(req DELETE "/api/deployments/$MAJ_V2/purge")
[ "$code" = "200" ] || fail "purge de la v2 échouée : attendu 200, reçu $code — $(cat "$BODY")"
pass "la v2 échouée se purge — $(jq -c '{purged, releasedPorts}' "$BODY")"

[ "$(psql_q "select count(*) from deployments where id = '$MAJ_V2';")" = "0" ] \
  || fail "la v2 est encore en base"
[ "$(psql_q "select count(*) from port_allocations where target_id = '$TARGET_ID' and application_id = '$MAJ_APP';")" = "1" ] \
  || fail "purger la v2 a emporté la réservation de port de la v1 en service"
pass "la v2 a disparu, la réservation de la v1 est restée"

# Ménage de la matière du § 9.
destroy_and_wait "$MAJ_V1"
code=$(req DELETE "/api/deployments/$MAJ_V1/purge")
[ "$code" = "200" ] || warn "purge de la v1 détruite → HTTP $code : $(cat "$BODY")"
code=$(req DELETE "/api/applications/$MAJ_APP")
[ "$code" = "200" ] || warn "suppression de $MAJ_SLUG → HTTP $code : $(cat "$BODY")"
pass "matière du § 9 nettoyée"

# ─── 10. Rien de vivant n'a été touché ────────────────────────────────────────

step "10. Les applications en marche sont intactes"

req GET /api/apps >/dev/null
LIVE_AFTER=$(jq -r '[.items[].applicationSlug] | sort | join(",")' "$BODY")
[ "$LIVE_AFTER" = "$LIVE_BEFORE" ] \
  || fail "les applications en marche ont changé : « $LIVE_BEFORE » → « $LIVE_AFTER »"
pass "toujours en marche : ${LIVE_AFTER:-aucune}"

step "11. Ménage"
code=$(req DELETE "/api/applications/$APP_ID")
[ "$code" = "200" ] || warn "suppression de $APP_SLUG → HTTP $code : $(cat "$BODY")"
[ "$code" = "200" ] && pass "application de test supprimée"
req DELETE "/api/admin/users/$VIEWER_ID" >/dev/null
pass "utilisateur viewer supprimé"

printf '\n\033[32m✓ Purge de l’historique vérifiée.\033[0m\n'
printf '\033[2m  Écran : %s/deployments\033[0m\n\n' "$BASE_URL"
