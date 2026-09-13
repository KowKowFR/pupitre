#!/usr/bin/env bash
#
# Déploiement de bout en bout et logs en direct, par les routes de l'UI.
#
#   1. Créer une application depuis simple.json
#   2. La déployer sur une cible Docker
#   3. Voir les steps s'enchaîner et les logs défiler en direct
#   4. Obtenir une URL qui répond
#   5. Se rebrancher en cours de déploiement et retrouver les logs déjà passés
#
# Le script emprunte exactement les mêmes routes que l'UI. Prérequis :
# une cible Docker déployable — `./scripts/setup-test-target.sh` en provisionne une.
#
# Usage :
#   ./scripts/verify-deploy-logs.sh
#   BASE_URL=http://localhost:3100 TARGET_NAME=ma-vm ./scripts/verify-deploy-logs.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
TARGET_NAME="${TARGET_NAME:-cible-de-verification}"
SPEC="${SPEC:-packages/core/src/spec/__fixtures__/simple.json}"
CLIENT_IP="${CLIENT_IP:-198.51.100.42}"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
BODY="$WORK/body.json"
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


# Better Auth limite les connexions répétées depuis une même IP. Les scripts de
# vérification s'enchaînent : on patiente plutôt que de retomber par erreur sur
# l'inscription, qui donnerait un message trompeur.
login() {
  local code
  for _ in 1 2 3 4 5; do
    code=$(req POST /api/auth/sign-in/email "$@" \
      "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
    case "$code" in
      200) assert_admin; return 0 ;;
      429) sleep 6 ;;
      *)   break ;;
    esac
  done

  # Pas de compte : amorçage du premier administrateur.
  code=$(req POST /api/auth/sign-up/email "$@" \
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
  printf '      2. ou promouvez « %s » depuis %s/admin/users\n' "$ADMIN_EMAIL" "$BASE_URL"
  exit 1
}


step "1. Connexion"
login
pass "connecté en tant que $ADMIN_EMAIL"

step "2. Créer l'application depuis $SPEC"
SLUG=$(jq -r .name "$SPEC")
req GET /api/applications >/dev/null
EXISTING=$(jq -r --arg s "$SLUG" '.items[] | select(.slug == $s) | .id' "$BODY")

if [ -n "$EXISTING" ]; then
  pass "application « $SLUG » déjà présente"
  APP_ID="$EXISTING"
else
  jq '{appSpec: .}' "$SPEC" > "$WORK/app.json"
  code=$(req POST /api/applications "@$WORK/app.json")
  [ "$code" = "201" ] || fail "POST /api/applications → HTTP $code : $(cat "$BODY")"
  APP_ID=$(jq -r .id "$BODY")
  pass "application créée : $SLUG"
fi
info "$(jq -c '{services: [.services[].name], exposed: [.services[] | select(.exposed) | .name][0]}' "$SPEC")"

step "3. Cible Docker"
req GET /api/targets >/dev/null
TARGET_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY")
[ -n "$TARGET_ID" ] || fail "cible « $TARGET_NAME » introuvable — lancez ./scripts/setup-test-target.sh"

DOCKER_OK=$(jq -r --arg n "$TARGET_NAME" \
  '.items[] | select(.name == $n) | .runtimesAvailable.docker.available' "$BODY")
[ "$DOCKER_OK" = "true" ] || fail "la cible « $TARGET_NAME » n'a pas de runtime Docker — lancez un preflight"
pass "$TARGET_NAME — Docker $(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .runtimesAvailable.docker.version' "$BODY")"

step "4. POST /api/deployments — la route ne doit pas attendre"
BEFORE=$(date +%s)
code=$(req POST /api/deployments \
  "{\"applicationId\":\"$APP_ID\",\"targetId\":\"$TARGET_ID\",\"scanConfig\":{\"scanners\":[],\"failOn\":\"NONE\"},\"runtime\":\"docker\",\"proxy\":\"traefik\"}")
ELAPSED=$(( $(date +%s) - BEFORE ))
[ "$code" = "202" ] || fail "attendu 202, reçu HTTP $code : $(cat "$BODY")"

DEPLOY_ID=$(jq -r .id "$BODY")
STEP_COUNT=$(jq -r '.steps | length' "$BODY")
# Le pipeline a gagné l'étape « scan » après coup : la liste fait foi, pas un
# nombre écrit en dur ici.
EXPECTED_STEPS=$(grep -c "^  { key: '" packages/core/src/pipeline.ts)
[ "$STEP_COUNT" = "$EXPECTED_STEPS" ] \
  || fail "attendu $EXPECTED_STEPS étapes créées d'emblée, reçu $STEP_COUNT"
jq -e '[.steps[] | select(.status != "pending")] | length == 0' "$BODY" >/dev/null \
  || fail "toutes les étapes doivent naître en « pending »"

pass "202 en ${ELAPSED}s — $DEPLOY_ID"
pass "les $EXPECTED_STEPS étapes existent déjà, toutes en « pending »"
info "$(jq -rc '[.steps[].key] | join(" → ")' "$BODY")"

step "5. Flux SSE en direct"
curl -sN --max-time 300 -b "$JAR" "$BASE_URL/api/deployments/$DEPLOY_ID/logs" > "$WORK/live.sse" &
LIVE_PID=$!

# Un second client se branche en cours de route : c'est le rafraîchissement de page.
sleep 5
curl -sN --max-time 300 -b "$JAR" "$BASE_URL/api/deployments/$DEPLOY_ID/logs" > "$WORK/refresh.sse" &
REFRESH_PID=$!

wait "$LIVE_PID" || true
wait "$REFRESH_PID" || true

events() { grep -A1 '^event: event' "$1" | grep '^data:' | sed 's/^data: //'; }
logs()   { grep -A1 '^event: log'   "$1" | grep '^data:' | sed 's/^data: //'; }

LIVE_LOGS=$(logs "$WORK/live.sse" | wc -l | tr -d ' ')
[ "$LIVE_LOGS" -gt 0 ] || fail "aucune ligne de log reçue en direct"
pass "$LIVE_LOGS ligne(s) reçue(s) en direct"

for key in preflight allocate_port render upload build scan deploy healthcheck proxy rollback; do
  status=$(events "$WORK/live.sse" | jq -rc --arg k "$key" \
    'select(.type == "step" and .key == $k) | .status' | tail -1)
  [ -n "$status" ] || fail "aucun événement pour l'étape « $key »"
  printf '    \033[2m%-14s → %s\033[0m\n' "$key" "$status"
done
pass "les $EXPECTED_STEPS étapes ont émis leur changement d'état"

# `allocate_port` et `proxy` ne dépendent pas du worker : c'est le driver qui tranche.
jq -e 'select(.type == "step" and .key == "build") | .status == "skipped"' \
  <<< "$(events "$WORK/live.sse" | jq -c 'select(.type=="step" and .key=="build")' | tail -1)" >/dev/null \
  || info "build : pas skipped (l'AppSpec contient un service à construire)"

FINAL=$(events "$WORK/live.sse" | jq -rc 'select(.type == "deployment") | .status' | tail -1)
[ "$FINAL" = "success" ] || fail "déploiement terminé en « $FINAL » : $(logs "$WORK/live.sse" | jq -rc '.line' | tail -5)"
pass "déploiement terminé en « success »"

step "6. Rafraîchissement en cours : les logs passés sont retrouvés"
REFRESH_LOGS=$(logs "$WORK/refresh.sse" | wc -l | tr -d ' ')
[ "$REFRESH_LOGS" -gt 0 ] || fail "le client rebranché n'a rien reçu"

# Le preflight a eu lieu avant que ce client ne se connecte : il doit quand même
# le voir, rejoué depuis deployment_steps.log.
logs "$WORK/refresh.sse" | jq -rc 'select(.step == "preflight") | .line' | grep -q . \
  || fail "les logs antérieurs à la connexion sont absents — il y a un trou"
pass "$REFRESH_LOGS ligne(s), dont celles d'avant la connexion"
info "première ligne rejouée : $(logs "$WORK/refresh.sse" | jq -rc '.line' | head -1)"

# La couture entre relecture et direct ne doit ni perdre ni dupliquer :
# le client rebranché doit recevoir exactement ce que le premier a vu.
LIVE_SET=$(logs "$WORK/live.sse" | jq -rc '"\(.ts)|\(.step)|\(.line)"' | sort)
REFRESH_SET=$(logs "$WORK/refresh.sse" | jq -rc '"\(.ts)|\(.step)|\(.line)"' | sort)
if [ "$LIVE_SET" != "$REFRESH_SET" ]; then
  printf '    \033[2mmanquant chez le client rebranché :\033[0m\n'
  comm -23 <(printf '%s\n' "$LIVE_SET") <(printf '%s\n' "$REFRESH_SET") | head -5
  printf '    \033[2men trop chez le client rebranché :\033[0m\n'
  comm -13 <(printf '%s\n' "$LIVE_SET") <(printf '%s\n' "$REFRESH_SET") | head -5
  fail "la couture historique/direct perd ou duplique des lignes"
fi
pass "le client rebranché a reçu exactement les mêmes lignes, ni perte ni doublon"

step "7. L'URL répond"
code=$(req GET "/api/deployments/$DEPLOY_ID")
[ "$code" = "200" ] || fail "GET /api/deployments/$DEPLOY_ID → HTTP $code"

URL=$(jq -r '.url // empty' "$BODY")
PORT=$(jq -r '.publishedPort // empty' "$BODY")
[ -n "$URL" ] || fail "le déploiement n'a produit aucune URL"
pass "URL : $URL (port $PORT)"

jq -e '[.steps[] | select(.status == "success")] | length >= 6' "$BODY" >/dev/null \
  || fail "trop peu d'étapes réussies : $(jq -c '[.steps[] | {key, status}]' "$BODY")"
jq -e '[.steps[] | select(.log | length > 0)] | length >= 5' "$BODY" >/dev/null \
  || fail "les logs ne sont pas persistés dans deployment_steps.log"
pass "logs persistés dans deployment_steps.log"

# L'URL porte le nom d'hôte vu par le worker. Depuis ce script, on passe par le
# port publié sur la machine locale — c'est le même conteneur au bout.
PROBE="${PROBE_URL:-http://127.0.0.1:$PORT}"
http=$(curl -s -o "$WORK/page.html" -w '%{http_code}' --max-time 15 "$PROBE" || echo 000)
[ "$http" = "200" ] || fail "$PROBE → HTTP $http"
pass "$PROBE → HTTP 200"
info "$(head -c 60 "$WORK/page.html" | tr -d '\n')"

step "8. Traçabilité"
code=$(req GET "/api/audit-logs?resourceType=deployment&pageSize=20")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
for action in deployment.created deployment.succeeded; do
  jq -e --arg a "$action" --arg id "$DEPLOY_ID" \
    '[.items[] | select(.action == $a and .resourceId == $id)] | length > 0' "$BODY" >/dev/null \
    || fail "action « $action » absente du journal d'audit"
  pass "audit : $action"
done

printf '\n\033[32m✓ Déploiement et logs en direct vérifiés.\033[0m\n'
printf '\033[2m  Suivi : %s/deployments/%s\033[0m\n' "$BASE_URL" "$DEPLOY_ID"
printf '\n'
