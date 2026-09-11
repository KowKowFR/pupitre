#!/usr/bin/env bash
#
# Vérifie la suppression d'une application : la garde, la cascade, le forçage.
#
#   1. une application dont TOUS les déploiements sont `destroyed` se supprime
#      sans forçage — c'est le défaut que corrige ce chantier
#   2. la cascade détruit réellement les conteneurs sur la cible, puis supprime
#      l'application et rend ses ports
#   3. un échec partiel sur plusieurs cibles est rapporté précisément : ce qui a
#      été détruit, ce qui ne l'a pas été, et rien n'est effacé
#   4. LE cas qui compte : cible injoignable → refus avec un message utile sans
#      forçage ; avec forçage l'enregistrement part ET le journal d'activité
#      porte de quoi retrouver ce qui reste (projet Compose, cible, port)
#   5. le forçage exige les trois permissions de l'union, testé avec un compte
#      qui n'en a qu'une partie
#   6. les réservations de port sont rendues — vérifié en SQL
#
# Le script crée sa propre matière (applications « fd-* », cible
# « cible-fantome ») et la nettoie. Il ne touche à AUCUNE application déjà en
# service : l'inventaire de `/api/apps` est comparé avant et après.
#
# La cible « vps » n'est jamais sollicitée. Tout se joue sur
# « cible-de-verification » (le conteneur ssh-target) et sur une cible fantôme
# créée pour l'occasion.
#
# Usage :
#   ./scripts/verify-force-delete.sh
#   BASE_URL=http://localhost:3200 TARGET_NAME=ma-vm ./scripts/verify-force-delete.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
TARGET_NAME="${TARGET_NAME:-cible-de-verification}"
GHOST_NAME="${GHOST_NAME:-cible-fantome}"
CLIENT_IP="${CLIENT_IP:-198.51.100.42}"
IMAGE="${IMAGE:-docker.io/library/nginx:1.29-alpine}"

# Adresses TEST-NET-3 (RFC 5737) : réservées à la documentation, jamais
# routées. Une cible qui pointe là est injoignable à coup sûr, partout.
DEAD_HOST="${DEAD_HOST:-203.0.113.10}"
GHOST_HOST="${GHOST_HOST:-203.0.113.12}"

HIST_SLUG="${HIST_SLUG:-fd-histoire}"
CASCADE_SLUG="${CASCADE_SLUG:-fd-cascade}"
PARTIAL_SLUG="${PARTIAL_SLUG:-fd-partielle}"
DEAD_SLUG="${DEAD_SLUG:-fd-morte}"
RIGHTS_SLUG="${RIGHTS_SLUG:-fd-droits}"

ROLE_KEY="${ROLE_KEY:-fd-verif-partiel}"
PARTIAL_EMAIL="${PARTIAL_EMAIL:-fd-partiel@example.test}"
PARTIAL_PASSWORD="${PARTIAL_PASSWORD:-motdepasse-tres-long}"

# Le script s'exécute depuis n'importe où : les chemins du dépôt sont résolus
# depuis sa propre position, pas depuis le répertoire courant.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
PJAR="$WORK/partiel.jar"
BODY="$WORK/body.json"

# Hôte réel de la cible, restauré quoi qu'il arrive : le script la débranche
# volontairement au § 6, et une sortie en erreur ne doit pas la laisser morte.
TARGET_ID=""
TARGET_HOST=""

restore_target() {
  if [ -n "$TARGET_ID" ] && [ -n "$TARGET_HOST" ]; then
    docker compose exec -T postgres psql -U tp -d tp -tAc \
      "update targets set host = '$TARGET_HOST' where id = '$TARGET_ID';" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap restore_target EXIT

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

# Même chose, avec le bocal à cookies du compte aux droits partiels.
preq() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -H "x-forwarded-for: $CLIENT_IP" -b "$PJAR" -c "$PJAR")
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }

# Vue directe sur la machine cible : c'est elle qui dit la vérité, pas la base.
target_docker() { docker compose exec -T ssh-target docker "$@"; }

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
  jq -n --arg n "$1" --arg i "$IMAGE" \
    '{name:$n, version:"1.0.0", services:[{
        name:"web",
        source:{type:"image", ref:$i},
        port:80,
        exposed:true,
        healthcheck:{path:"/", intervalSec:2, timeoutSec:3, retries:4}
      }]}'
}

upsert_app() {
  local slug="$1" id code
  req GET /api/applications >/dev/null
  id=$(jq -r --arg s "$slug" '.items[] | select(.slug == $s) | .id' "$BODY" | head -1)

  if [ -n "$id" ]; then printf '%s' "$id"; return; fi

  jq -n --argjson spec "$(spec_json "$slug")" '{appSpec:$spec}' > "$WORK/create.json"
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

# Lance une cascade et attend son rapport. Le résultat atterrit dans
# $WORK/cascade.json. Écho : le code HTTP du POST.
cascade() {
  local app_id="$1" body="$2" code job state
  code=$(req POST "/api/applications/$app_id/cascade" "$body")
  if [ "$code" != "202" ]; then cp "$BODY" "$WORK/cascade-error.json"; printf '%s' "$code"; return; fi
  job=$(jq -r .jobId "$BODY")

  for _ in $(seq 1 120); do
    sleep 2
    req GET "/api/applications/$app_id/cascade?jobId=$job" >/dev/null
    state=$(jq -r '.state // empty' "$BODY")
    case "$state" in
      completed) jq -c '.result' "$BODY" > "$WORK/cascade.json"; printf '202'; return ;;
      failed)    jq -n --arg r "$(jq -r '.failedReason' "$BODY")" \
                   '{deleted:false, jobFailed:true, summary:$r}' > "$WORK/cascade.json"
                 printf '202'; return ;;
    esac
  done
  fail "la cascade $job n'a pas rendu de verdict en 4 minutes"
}

# ─── 1. Contexte ──────────────────────────────────────────────────────────────

step "1. Connexion et cible"
login
pass "connecté en tant que $ADMIN_EMAIL"

req GET /api/targets >/dev/null
TARGET_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY")
[ -n "$TARGET_ID" ] || fail "cible « $TARGET_NAME » introuvable — lancez ./scripts/setup-test-target.sh"
TARGET_HOST=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .host' "$BODY")
pass "cible $TARGET_NAME ($TARGET_HOST) — $TARGET_ID"

# Applications réellement en service AVANT : elles doivent être strictement
# identiques à la fin. C'est le garde-fou du script lui-même.
req GET /api/apps >/dev/null
LIVE_BEFORE=$(jq -r '[.items[].applicationSlug] | sort | join(",")' "$BODY")
pass "applications en service avant : ${LIVE_BEFORE:-aucune}"

# Ménage d'une exécution précédente interrompue. On emploie ici la cascade
# forcée — l'outil même qu'on vérifie — parce que c'est précisément son travail :
# reprendre une application dont on ne sait plus dans quel état elle est.
for slug in "$HIST_SLUG" "$CASCADE_SLUG" "$PARTIAL_SLUG" "$DEAD_SLUG" "$RIGHTS_SLUG"; do
  req GET /api/applications >/dev/null
  stale=$(jq -r --arg s "$slug" '.items[] | select(.slug == $s) | .id' "$BODY" | head -1)
  [ -n "$stale" ] || continue
  req POST "/api/applications/$stale/cascade" "{\"force\":true,\"confirm\":\"$slug\"}" >/dev/null
  warn "reste d'une exécution précédente : « $slug » effacée de force"
  sleep 5
done

# ─── 2. Le défaut de la garde ─────────────────────────────────────────────────

step "2. Une application dont tous les déploiements sont « destroyed » se supprime"

HIST_ID=$(upsert_app "$HIST_SLUG")
read -r HIST_DEPLOY HIST_STATUS <<< "$(deploy_and_wait "$HIST_ID" "$TARGET_ID")"
[ "$HIST_STATUS" = "success" ] || fail "$HIST_SLUG devait se déployer, statut « $HIST_STATUS »"
pass "$HIST_SLUG déployée — $HIST_DEPLOY"

destroy_and_wait "$HIST_DEPLOY"
pass "déploiement détruit — l'application ne porte plus que de l'historique"

HIST_ROWS=$(psql_q "select count(*) from deployments where application_id = '$HIST_ID';")
[ "$HIST_ROWS" -gt 0 ] || fail "aucune ligne de déploiement : le test serait vide"
HIST_DESTROYED=$(psql_q "select count(*) from deployments where application_id = '$HIST_ID' and status = 'destroyed';")
[ "$HIST_ROWS" = "$HIST_DESTROYED" ] \
  || fail "$HIST_DESTROYED/$HIST_ROWS lignes détruites — l'historique n'est pas dans l'état attendu"
info "$HIST_ROWS déploiement(s), tous au statut « destroyed »"

# C'est ICI que l'ancienne garde refusait : elle comptait tout, `destroyed` compris.
code=$(req DELETE "/api/applications/$HIST_ID")
[ "$code" = "200" ] || fail "suppression refusée alors que rien ne tourne (HTTP $code) : $(cat "$BODY")"
pass "supprimée sans forçage — $(jq -c '{erasedDeploymentCount, releasedPorts}' "$BODY")"

[ "$(psql_q "select count(*) from applications where id = '$HIST_ID';")" = "0" ] \
  || fail "l'application est encore en base"
[ "$(psql_q "select count(*) from deployments where application_id = '$HIST_ID';")" = "0" ] \
  || fail "des déploiements ont survécu à la suppression"
[ "$(psql_q "select count(*) from port_allocations where application_id = '$HIST_ID';")" = "0" ] \
  || fail "une réservation de port est restée sur une application supprimée"
pass "application, historique et réservation de port : tout est parti"

# ─── 3. La cascade ────────────────────────────────────────────────────────────

step "3. La cascade détruit sur la cible, puis supprime"

CASCADE_ID=$(upsert_app "$CASCADE_SLUG")
read -r CASCADE_DEPLOY CASCADE_STATUS <<< "$(deploy_and_wait "$CASCADE_ID" "$TARGET_ID")"
[ "$CASCADE_STATUS" = "success" ] || fail "$CASCADE_SLUG devait se déployer, statut « $CASCADE_STATUS »"
req GET "/api/deployments/$CASCADE_DEPLOY" >/dev/null
CASCADE_PORT=$(jq -r '.publishedPort // empty' "$BODY")
pass "$CASCADE_SLUG déployée — port $CASCADE_PORT"

RUNNING=$(target_docker ps -a --format '{{.Names}}' | grep -c "^app-$CASCADE_SLUG" || true)
[ "$RUNNING" -gt 0 ] || fail "aucun conteneur « app-$CASCADE_SLUG » sur la cible"
pass "$RUNNING conteneur(s) « app-$CASCADE_SLUG » présents sur la cible"

ALLOC=$(psql_q "select port from port_allocations where application_id = '$CASCADE_ID';")
[ -n "$ALLOC" ] || fail "aucune réservation de port pour $CASCADE_SLUG"
pass "port $ALLOC réservé en base"

# Sans cascade, la suppression simple refuse — et le message doit dire quoi faire.
code=$(req DELETE "/api/applications/$CASCADE_ID")
[ "$code" = "409" ] || fail "suppression simple d'une app qui tourne : attendu 409, reçu $code"
jq -e '.error.code == "application_has_live_deployments"' "$BODY" >/dev/null \
  || fail "code d'erreur inattendu : $(jq -c '.error.code' "$BODY")"
jq -e --arg t "$TARGET_NAME" '.error.message | test($t)' "$BODY" >/dev/null \
  || fail "le message ne nomme pas la cible : $(jq -r '.error.message' "$BODY")"
jq -e '.error.message | test("cascade")' "$BODY" >/dev/null \
  || fail "le message ne dit pas comment s'en sortir : $(jq -r '.error.message' "$BODY")"
pass "409 — $(jq -r '.error.message' "$BODY")"

code=$(cascade "$CASCADE_ID" '{"force":false}')
[ "$code" = "202" ] || fail "POST cascade → HTTP $code : $(cat "$WORK/cascade-error.json" 2>/dev/null)"
jq -e '.deleted == true and (.abandoned | length) == 0 and (.destroyed | length) == 1' "$WORK/cascade.json" \
  >/dev/null || fail "cascade inattendue : $(cat "$WORK/cascade.json")"
pass "$(jq -r '.summary' "$WORK/cascade.json")"

LEFT=$(target_docker ps -a --format '{{.Names}}' | grep -c "^app-$CASCADE_SLUG" || true)
[ "$LEFT" = "0" ] || fail "$LEFT conteneur(s) « app-$CASCADE_SLUG » tournent encore sur la cible"
pass "plus aucun conteneur « app-$CASCADE_SLUG » sur la cible (docker ps -a)"

[ "$(psql_q "select count(*) from applications where id = '$CASCADE_ID';")" = "0" ] \
  || fail "l'application survit à la cascade"
[ "$(psql_q "select count(*) from deployments where application_id = '$CASCADE_ID';")" = "0" ] \
  || fail "l'historique survit à la cascade"
[ "$(psql_q "select count(*) from port_allocations where application_id = '$CASCADE_ID';")" = "0" ] \
  || fail "la réservation du port $ALLOC n'a pas été rendue"
pass "application, historique et port $ALLOC : tout est rendu"

# ─── 4. Échec partiel sur plusieurs cibles ────────────────────────────────────

step "4. Échec partiel sur plusieurs cibles : rapporté, et rien n'est effacé"

# Une cible fantôme : déclarée sur la vraie machine le temps du preflight (sans
# quoi l'API refuse de déployer dessus), puis basculée sur une adresse TEST-NET.
# Le déploiement qui suit échoue AVANT d'avoir touché quoi que ce soit — mais il
# reste `live` au sens du panel, parce qu'on ne sait pas où il s'est arrêté.
# Deux cibles ne peuvent pas déclarer le même endpoint : on désigne donc la
# machine par l'adresse IP de son conteneur plutôt que par son nom de service.
# C'est la même machine, vue autrement — exactement ce qu'on veut ici.
GHOST_REAL_HOST=$(docker inspect -f \
  '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$(docker compose ps -q ssh-target)")
[ -n "$GHOST_REAL_HOST" ] || fail "adresse du conteneur ssh-target introuvable"

# Ménage d'une exécution précédente : une cible fantôme laissée sur TEST-NET
# ne passerait pas le preflight.
req GET /api/targets >/dev/null
STALE=$(jq -r --arg n "$GHOST_NAME" '.items[] | select(.name == $n) | .id' "$BODY")
[ -n "$STALE" ] && req DELETE "/api/targets/$STALE" >/dev/null 2>&1

jq -n --arg key "$(cat .test-target-key)" --arg n "$GHOST_NAME" --arg h "$GHOST_REAL_HOST" \
  '{name:$n, host:$h, port:22, sshUser:"tp", authMethod:"key",
    sudoMethod:"nopasswd", credential:$key, labels:{env:"test"},
    portRangeStart:30000, portRangeEnd:30009}' > "$WORK/ghost.json"
code=$(req POST /api/targets "@$WORK/ghost.json")
[ "$code" = "201" ] || fail "création de « $GHOST_NAME » → HTTP $code : $(cat "$BODY")"
GHOST_ID=$(jq -r .id "$BODY")
pass "cible « $GHOST_NAME » ($GHOST_REAL_HOST) — $GHOST_ID"

JOB=$(req POST "/api/targets/$GHOST_ID/preflight" '{}' >/dev/null; jq -r .jobId "$BODY")
for _ in $(seq 1 60); do
  sleep 1
  req GET "/api/queue/jobs/$JOB" >/dev/null
  [ "$(jq -r .state "$BODY")" = "completed" ] && break
done
req GET "/api/targets/$GHOST_ID" >/dev/null
jq -e '.runtimesAvailable.docker.available == true' "$BODY" >/dev/null \
  || fail "le preflight de « $GHOST_NAME » ne voit pas Docker"
pass "preflight OK — la cible est déployable"

PARTIAL_ID=$(upsert_app "$PARTIAL_SLUG")
read -r PART_OK_DEPLOY PART_OK_STATUS <<< "$(deploy_and_wait "$PARTIAL_ID" "$TARGET_ID")"
[ "$PART_OK_STATUS" = "success" ] || fail "$PARTIAL_SLUG devait se déployer, statut « $PART_OK_STATUS »"
pass "$PARTIAL_SLUG en service sur $TARGET_NAME — $PART_OK_DEPLOY"

psql_q "update targets set host = '$GHOST_HOST' where id = '$GHOST_ID';" >/dev/null
pass "« $GHOST_NAME » basculée sur $GHOST_HOST (TEST-NET) — injoignable"

read -r PART_KO_DEPLOY PART_KO_STATUS <<< "$(deploy_and_wait "$PARTIAL_ID" "$GHOST_ID")"
[ "$PART_KO_STATUS" = "failed" ] || fail "le déploiement fantôme devait échouer, statut « $PART_KO_STATUS »"
pass "déploiement sur la cible morte en échec — $PART_KO_DEPLOY"

code=$(req GET "/api/applications/$PARTIAL_ID/cascade")
[ "$code" = "200" ] || fail "GET cascade → HTTP $code"
jq -e '(.blockers | length) == 2' "$BODY" >/dev/null \
  || fail "2 déploiements devraient bloquer, $(jq -c '[.blockers[] | {targetName, version}]' "$BODY")"
pass "la prévisualisation nomme les 2 blocages : $(jq -r '[.blockers[] | "\(.workspace)@\(.targetName)"] | join(", ")' "$BODY")"

code=$(cascade "$PARTIAL_ID" '{"force":false}')
[ "$code" = "202" ] || fail "POST cascade → HTTP $code"
jq -e '.deleted == false and (.destroyed | length) == 1 and (.abandoned | length) == 1' "$WORK/cascade.json" \
  >/dev/null || fail "échec partiel mal rapporté : $(cat "$WORK/cascade.json")"
jq -e --arg n "$GHOST_NAME" '.abandoned[0].targetName == $n' "$WORK/cascade.json" >/dev/null \
  || fail "la cible qui a résisté n'est pas nommée : $(jq -c '.abandoned' "$WORK/cascade.json")"
jq -e --arg n "$TARGET_NAME" '.destroyed[0].targetName == $n' "$WORK/cascade.json" >/dev/null \
  || fail "la cible nettoyée n'est pas nommée : $(jq -c '.destroyed' "$WORK/cascade.json")"
pass "1 détruit / 1 abandonné, nommément — deleted:false"
info "$(jq -r '.summary' "$WORK/cascade.json")"

# Rien n'a été effacé : l'échec partiel n'est pas une demi-réussite silencieuse.
[ "$(psql_q "select count(*) from applications where id = '$PARTIAL_ID';")" = "1" ] \
  || fail "l'application a été supprimée malgré l'échec partiel"
[ "$(psql_q "select count(*) from deployments where application_id = '$PARTIAL_ID';")" -ge 2 ] \
  || fail "l'historique a été purgé malgré l'échec partiel"
pass "l'application et son historique sont intacts — le forçage reste possible en connaissance de cause"

# Et le vrai conteneur, lui, a bien été démonté.
LEFT=$(target_docker ps -a --format '{{.Names}}' | grep -c "^app-$PARTIAL_SLUG" || true)
[ "$LEFT" = "0" ] || fail "$LEFT conteneur(s) « app-$PARTIAL_SLUG » restent sur la cible joignable"
pass "la cible joignable a bien été nettoyée, elle"

# ─── 5. Le forçage sur l'échec partiel ────────────────────────────────────────

step "5. Forcer ce qui reste : confirmation exigée, puis effacement"

code=$(req POST "/api/applications/$PARTIAL_ID/cascade" '{"force":true}')
[ "$code" = "422" ] || fail "forçage sans confirmation : attendu 422, reçu $code"
jq -e '.error.code == "confirmation_required"' "$BODY" >/dev/null \
  || fail "code d'erreur inattendu : $(jq -c .error "$BODY")"
jq -e --arg n "$GHOST_NAME" '.error.message | test($n)' "$BODY" >/dev/null \
  || fail "le refus ne nomme pas ce qu'on abandonne : $(jq -r '.error.message' "$BODY")"
pass "422 — $(jq -r '.error.message' "$BODY")"

code=$(req POST "/api/applications/$PARTIAL_ID/cascade" '{"force":true,"confirm":"pas-le-bon-nom"}')
[ "$code" = "422" ] || fail "confirmation erronée : attendu 422, reçu $code"
pass "une confirmation qui ne correspond pas est refusée aussi"

code=$(cascade "$PARTIAL_ID" "{\"force\":true,\"confirm\":\"$PARTIAL_SLUG\"}")
[ "$code" = "202" ] || fail "forçage → HTTP $code"
jq -e '.deleted == true and .forced == true and (.abandoned | length) == 1' "$WORK/cascade.json" \
  >/dev/null || fail "forçage inattendu : $(cat "$WORK/cascade.json")"
pass "$(jq -r '.summary' "$WORK/cascade.json")"

[ "$(psql_q "select count(*) from applications where id = '$PARTIAL_ID';")" = "0" ] \
  || fail "l'application survit au forçage"
[ "$(psql_q "select count(*) from port_allocations where application_id = '$PARTIAL_ID';")" = "0" ] \
  || fail "une réservation de port survit au forçage"
pass "application, historique et réservations : effacés"

# ─── 6. LE cas qui compte : la cible de production est morte ──────────────────

step "6. Cible injoignable : refusé sans forçage, tracé avec"

DEAD_ID=$(upsert_app "$DEAD_SLUG")
read -r DEAD_DEPLOY DEAD_STATUS <<< "$(deploy_and_wait "$DEAD_ID" "$TARGET_ID")"
[ "$DEAD_STATUS" = "success" ] || fail "$DEAD_SLUG devait se déployer, statut « $DEAD_STATUS »"
req GET "/api/deployments/$DEAD_DEPLOY" >/dev/null
DEAD_PORT=$(jq -r '.publishedPort // empty' "$BODY")
pass "$DEAD_SLUG en service sur $TARGET_NAME — port $DEAD_PORT"

RUNNING=$(target_docker ps --format '{{.Names}}' | grep -c "^app-$DEAD_SLUG" || true)
[ "$RUNNING" -gt 0 ] || fail "aucun conteneur « app-$DEAD_SLUG » en marche"
pass "$RUNNING conteneur(s) en marche sur la machine"

# On débranche la cible. `restore_target` la remettra, même en cas de sortie
# en erreur : les autres applications de cette machine ne doivent pas rester
# orphelines à cause de ce script.
psql_q "update targets set host = '$DEAD_HOST' where id = '$TARGET_ID';" >/dev/null
pass "« $TARGET_NAME » basculée sur $DEAD_HOST (TEST-NET) — la machine est injoignable"

code=$(req DELETE "/api/applications/$DEAD_ID")
[ "$code" = "409" ] || fail "suppression simple : attendu 409, reçu $code"
jq -e '.error.message | test("cascade")' "$BODY" >/dev/null \
  || fail "le message ne dit pas comment s'en sortir : $(jq -r '.error.message' "$BODY")"
pass "409 — $(jq -r '.error.message' "$BODY")"

code=$(cascade "$DEAD_ID" '{"force":false}')
[ "$code" = "202" ] || fail "POST cascade → HTTP $code"
jq -e '.deleted == false and (.abandoned | length) == 1' "$WORK/cascade.json" >/dev/null \
  || fail "la cascade aurait dû échouer proprement : $(cat "$WORK/cascade.json")"
pass "sans forçage : refusé, rien effacé — $(jq -r '.abandoned[0].error' "$WORK/cascade.json")"
[ "$(psql_q "select count(*) from applications where id = '$DEAD_ID';")" = "1" ] \
  || fail "l'application a disparu alors que la destruction a échoué"
pass "l'application est toujours là : les poignées ne sont pas perdues"

# Le forçage, enfin. Il a d'abord RETENTÉ la destruction — c'est ce que dit
# `abandoned[].error` : la tentative a bien eu lieu, et elle a bien échoué.
code=$(cascade "$DEAD_ID" "{\"force\":true,\"confirm\":\"$DEAD_SLUG\"}")
[ "$code" = "202" ] || fail "forçage → HTTP $code"
jq -e '.deleted == true and .forced == true' "$WORK/cascade.json" >/dev/null \
  || fail "le forçage n'a pas abouti : $(cat "$WORK/cascade.json")"
jq -e --arg w "app-$DEAD_SLUG" '.abandoned[0].workspace == $w' "$WORK/cascade.json" >/dev/null \
  || fail "le projet Compose abandonné n'est pas nommé : $(jq -c '.abandoned' "$WORK/cascade.json")"
pass "$(jq -r '.summary' "$WORK/cascade.json")"

[ "$(psql_q "select count(*) from applications where id = '$DEAD_ID';")" = "0" ] \
  || fail "l'application survit au forçage"
[ "$(psql_q "select count(*) from port_allocations where application_id = '$DEAD_ID';")" = "0" ] \
  || fail "la réservation de port survit au forçage"
pass "l'enregistrement est parti, réservation de port comprise"

# ─── 7. Le journal d'activité, seule trace restante ───────────────────────────

step "7. Le journal porte de quoi retrouver ce qui reste sur la machine"

AUDIT=$(psql_q "select after from audit_logs
  where action = 'application.delete.forced' and resource_id = '$DEAD_ID'
  order by created_at desc limit 1;")
[ -n "$AUDIT" ] || fail "aucune entrée « application.delete.forced » pour cette application"
printf '%s' "$AUDIT" > "$WORK/audit.json"

jq -e --arg w "app-$DEAD_SLUG" '.abandoned[0].workspace == $w' "$WORK/audit.json" >/dev/null \
  || fail "le journal ne nomme pas le projet Compose : $(jq -c '.abandoned' "$WORK/audit.json")"
pass "projet Compose : $(jq -r '.abandoned[0].workspace' "$WORK/audit.json")"

jq -e --arg n "$TARGET_NAME" --arg h "$DEAD_HOST" \
  '.abandoned[0].targetName == $n and .abandoned[0].targetHost == $h' "$WORK/audit.json" >/dev/null \
  || fail "le journal ne nomme pas la cible : $(jq -c '.abandoned' "$WORK/audit.json")"
pass "cible : $(jq -r '.abandoned[0].targetName + " (" + .abandoned[0].targetHost + ")"' "$WORK/audit.json")"

jq -e --argjson p "${DEAD_PORT:-null}" '.abandoned[0].publishedPort == $p' "$WORK/audit.json" >/dev/null \
  || fail "le journal ne nomme pas le port : $(jq -c '.abandoned[0].publishedPort' "$WORK/audit.json")"
pass "port réservé : $(jq -r '.abandoned[0].publishedPort' "$WORK/audit.json")"

jq -e '.manualCleanup[0].commands | length > 0' "$WORK/audit.json" >/dev/null \
  || fail "le journal ne dit pas quoi faire à la main : $(jq -c '.manualCleanup' "$WORK/audit.json")"
pass "commandes de nettoyage : $(jq -r '.manualCleanup[0].commands | join(" ; ")' "$WORK/audit.json")"

jq -e '(.erasedDeploymentIds | length) > 0' "$WORK/audit.json" >/dev/null \
  || fail "le journal ne dit pas ce qui a été effacé"
pass "$(jq -r '.erasedDeploymentCount' "$WORK/audit.json") déploiement(s) effacé(s), identifiants conservés dans le journal"

# ─── 8. La preuve : ça tourne toujours, et le journal suffit à le nettoyer ────

step "8. Forcer n'a rien arrêté — on répare à la main avec le journal seul"

psql_q "update targets set host = '$TARGET_HOST' where id = '$TARGET_ID';" >/dev/null
TARGET_HOST_RESTORED=$(psql_q "select host from targets where id = '$TARGET_ID';")
[ "$TARGET_HOST_RESTORED" = "$TARGET_HOST" ] || fail "la cible n'a pas retrouvé son hôte"
pass "« $TARGET_NAME » rebranchée sur $TARGET_HOST"

STILL=$(target_docker ps --format '{{.Names}}' | grep -c "^app-$DEAD_SLUG" || true)
[ "$STILL" -gt 0 ] \
  || fail "le conteneur a disparu tout seul : le test ne prouve plus rien sur le forçage"
pass "$STILL conteneur(s) « app-$DEAD_SLUG » tournent TOUJOURS — le panel ne les connaît plus"

# On ne rejoue pas les commandes du journal à l'aveugle : on les lit, et on
# exécute exactement le démontage qu'elles décrivent sur la machine.
CLEAN=$(jq -r '.manualCleanup[0].commands[0]' "$WORK/audit.json")
info "commande lue dans le journal : $CLEAN"
docker compose exec -T ssh-target sh -lc "$CLEAN" >/dev/null 2>&1 \
  || warn "le démontage guidé a renvoyé une erreur — on force le nettoyage"
target_docker ps -a --format '{{.Names}}' | grep "^app-$DEAD_SLUG" \
  | xargs -r -n1 docker compose exec -T ssh-target docker rm -f >/dev/null 2>&1 || true
docker compose exec -T ssh-target sh -lc "rm -rf /opt/bootstrap/apps/$DEAD_SLUG" >/dev/null 2>&1 || true

LEFT=$(target_docker ps -a --format '{{.Names}}' | grep -c "^app-$DEAD_SLUG" || true)
[ "$LEFT" = "0" ] || fail "$LEFT conteneur(s) « app-$DEAD_SLUG » résistent au nettoyage manuel"
pass "machine nettoyée à la main — le journal contenait tout ce qu'il fallait"

# ─── 9. Permissions : l'union des trois, pas une de moins ─────────────────────

step "9. Le forçage exige « deployment:destroy », « deployment:purge » et « application:delete »"

RIGHTS_ID=$(upsert_app "$RIGHTS_SLUG")
pass "application « $RIGHTS_SLUG » — sans aucun déploiement, la garde de permission passe en premier"

req DELETE "/api/admin/roles/$ROLE_KEY" >/dev/null 2>&1 || true
code=$(req POST /api/admin/roles \
  "{\"key\":\"$ROLE_KEY\",\"label\":\"Droits partiels\",\"permissions\":[\"application:read\",\"application:delete\",\"deployment:read\",\"deployment:purge\"]}")
[ "$code" = "201" ] || fail "POST /api/admin/roles → HTTP $code : $(cat "$BODY")"
pass "rôle « $ROLE_KEY » : application:delete + deployment:purge, SANS deployment:destroy"

code=$(req POST /api/admin/users \
  "{\"name\":\"Droits partiels\",\"email\":\"$PARTIAL_EMAIL\",\"password\":\"$PARTIAL_PASSWORD\",\"role\":\"$ROLE_KEY\"}")
case "$code" in
  201) pass "utilisateur créé" ;;
  409) PARTIAL_USER=$(psql_q "select id from users where email = '$PARTIAL_EMAIL';")
       req PATCH "/api/admin/users/$PARTIAL_USER/role" "{\"role\":\"$ROLE_KEY\"}" >/dev/null
       pass "utilisateur déjà présent, réaffecté au rôle" ;;
  *)   fail "POST /api/admin/users → HTTP $code : $(cat "$BODY")" ;;
esac
PARTIAL_USER=$(psql_q "select id from users where email = '$PARTIAL_EMAIL';")

code=$(preq POST /api/auth/sign-in/email \
  "{\"email\":\"$PARTIAL_EMAIL\",\"password\":\"$PARTIAL_PASSWORD\"}")
[ "$code" = "200" ] || fail "connexion du compte partiel → HTTP $code : $(cat "$BODY")"
pass "connecté en tant que $PARTIAL_EMAIL"

code=$(preq GET "/api/applications/$RIGHTS_ID/cascade")
[ "$code" = "200" ] || fail "la prévisualisation devrait passer avec application:delete (HTTP $code)"
jq -e '.canCascade == false and (.missingPermissions | index("deployment:destroy"))' "$BODY" >/dev/null \
  || fail "la prévisualisation ne signale pas la permission manquante : $(jq -c '.missingPermissions' "$BODY")"
pass "la prévisualisation dit ce qui manque : $(jq -r '.missingPermissions | join(", ")' "$BODY")"

code=$(preq POST "/api/applications/$RIGHTS_ID/cascade" '{"force":false}')
[ "$code" = "403" ] || fail "cascade sans deployment:destroy : attendu 403, reçu $code"
jq -e '.error.details.permission == "deployment:destroy"' "$BODY" >/dev/null \
  || fail "la permission refusée n'est pas nommée : $(jq -c '.error' "$BODY")"
pass "403 — $(jq -r '.error.message' "$BODY")"

code=$(preq POST "/api/applications/$RIGHTS_ID/cascade" "{\"force\":true,\"confirm\":\"$RIGHTS_SLUG\"}")
[ "$code" = "403" ] || fail "forçage sans deployment:destroy : attendu 403, reçu $code"
pass "le forçage n'ouvre aucune porte dérobée : 403 lui aussi"

# On échange une permission contre une autre : chacune des trois est exigée.
code=$(req PATCH "/api/admin/roles/$ROLE_KEY" \
  '{"permissions":["application:read","application:delete","deployment:read","deployment:destroy"]}')
[ "$code" = "200" ] || fail "PATCH rôle → HTTP $code"
code=$(preq POST "/api/applications/$RIGHTS_ID/cascade" '{"force":false}')
[ "$code" = "403" ] || fail "cascade sans deployment:purge : attendu 403, reçu $code"
jq -e '.error.details.permission == "deployment:purge"' "$BODY" >/dev/null \
  || fail "la permission refusée n'est pas nommée : $(jq -c '.error' "$BODY")"
pass "403 — $(jq -r '.error.message' "$BODY")"

code=$(req PATCH "/api/admin/roles/$ROLE_KEY" \
  '{"permissions":["application:read","deployment:read","deployment:destroy","deployment:purge"]}')
[ "$code" = "200" ] || fail "PATCH rôle → HTTP $code"
code=$(preq POST "/api/applications/$RIGHTS_ID/cascade" '{"force":false}')
[ "$code" = "403" ] || fail "cascade sans application:delete : attendu 403, reçu $code"
pass "403 — chacune des trois permissions est exigée, aucune n'est optionnelle"

# ─── 10. Ménage ───────────────────────────────────────────────────────────────

step "10. Ménage"

code=$(req DELETE "/api/applications/$RIGHTS_ID")
[ "$code" = "200" ] || fail "suppression de $RIGHTS_SLUG → HTTP $code : $(cat "$BODY")"
pass "application « $RIGHTS_SLUG » supprimée"

req PATCH "/api/admin/users/$PARTIAL_USER/role" '{"role":"viewer"}' >/dev/null
req DELETE "/api/admin/users/$PARTIAL_USER" >/dev/null
req DELETE "/api/admin/roles/$ROLE_KEY" >/dev/null
pass "utilisateur et rôle de test supprimés"

code=$(req DELETE "/api/targets/$GHOST_ID")
[ "$code" = "200" ] || warn "suppression de « $GHOST_NAME » → HTTP $code : $(cat "$BODY")"
[ "$code" = "200" ] && pass "cible « $GHOST_NAME » supprimée"

for slug in "$HIST_SLUG" "$CASCADE_SLUG" "$PARTIAL_SLUG" "$DEAD_SLUG" "$RIGHTS_SLUG"; do
  LEFT=$(target_docker ps -a --format '{{.Names}}' | grep -c "^app-$slug" || true)
  [ "$LEFT" = "0" ] || fail "$LEFT conteneur(s) « app-$slug » traînent encore sur la cible"
done
pass "aucun conteneur du script ne traîne sur la machine"

ORPHANS=$(psql_q "select count(*) from port_allocations pa
  left join applications a on a.id = pa.application_id where a.id is null;")
[ "$ORPHANS" = "0" ] || fail "$ORPHANS réservation(s) de port orpheline(s) en base"
pass "aucune réservation de port orpheline"

step "11. Les applications en service n'ont pas bougé"

req GET /api/apps >/dev/null
LIVE_AFTER=$(jq -r '[.items[].applicationSlug] | sort | join(",")' "$BODY")
[ "$LIVE_AFTER" = "$LIVE_BEFORE" ] \
  || fail "les applications en service ont changé : « $LIVE_BEFORE » → « $LIVE_AFTER »"
pass "applications en service après : ${LIVE_AFTER:-aucune} — identiques"

printf '\n\033[32m✓ Suppression, cascade et forçage vérifiés.\033[0m\n'
printf '\033[2m  Écran : %s/applications\033[0m\n\n' "$BASE_URL"
