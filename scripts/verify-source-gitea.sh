#!/usr/bin/env bash
#
# Un second fournisseur de code, de bout en bout contre une vraie forge Gitea :
#
#   1. connecter la forge : « Tester » refuse un mauvais jeton et nomme le bon
#      compte ; le jeton est chiffré, et ne ressort jamais
#   2. ses dépôts se listent à côté de ceux des autres fournisseurs, et le
#      pupitre.json d'une branche se trouve
#   3. créer l'application depuis le dépôt, la déployer sur une cible Docker :
#      le code téléchargé chez Gitea se construit, la page répond, l'état du
#      déploiement est écrit sur le commit
#   4. un commit sur la branche : le polling le voit, l'application est
#      redéployée là où elle tourne, la nouvelle page répond
#   5. un commit qui touche l'infrastructure attend une validation, et le dit
#      sur le commit
#   6. le journal, sans jeton ; ménage : application détruite, forge déconnectée
#
# Prérequis — la forge de test, et le panel qui la joint à la même adresse :
#   docker compose --profile test up -d gitea
#
# Usage :
#   ./scripts/verify-source-gitea.sh
#   BASE_URL=http://localhost:3200 DOCKER_TARGET=… ./scripts/verify-source-gitea.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
DOCKER_TARGET="${DOCKER_TARGET:-cible-de-verification}"
GITEA_URL="${GITEA_URL:-http://localhost:3030}"
GITEA_USER="${GITEA_USER:-pupitre}"
GITEA_PASSWORD="${GITEA_PASSWORD:-motdepasse-forge-test}"
REPO="${GITEA_USER}/bonjour"
SLUG="bonjour-gitea"
CLIENT_IP="${CLIENT_IP:-198.51.100.94}"

WORK="$(mktemp -d)"
BODY="$WORK/body.json"
JAR="$WORK/admin.jar"
APP_ID=""

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

# La forge, directement, avec le compte de test.
forge() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$WORK/forge.json" -w '%{http_code}' -X "$method" "$GITEA_URL/api/v1$path"
              -u "$GITEA_USER:$GITEA_PASSWORD" -H 'content-type: application/json')
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }
error_code() { jq -r '.error.code // empty' "$BODY"; }

head_sha() { forge GET "/repos/$REPO/branches/main" >/dev/null; jq -r .commit.id "$WORK/forge.json"; }

# Remplace un fichier du dépôt par un commit. Écho : rien.
commit_file() {
  local path="$1" content="$2" message="$3" sha body code
  forge GET "/repos/$REPO/contents/$path?ref=main" >/dev/null
  sha=$(jq -r .sha "$WORK/forge.json")
  body=$(jq -n --arg c "$(printf '%s' "$content" | base64 | tr -d '\n')" --arg m "$message" --arg s "$sha" \
    '{content:$c, message:$m, branch:"main", sha:$s}')
  code=$(forge PUT "/repos/$REPO/contents/$path" "$body")
  [ "$code" = "200" ] || fail "commit de $path → HTTP $code : $(cat "$WORK/forge.json")"
}

# L'état que Pupitre a écrit sur un commit, pour un contexte. Attend qu'il soit `want`.
wait_status() {
  local sha="$1" context="$2" want="$3" state=""
  for _ in $(seq 1 100); do
    forge GET "/repos/$REPO/commits/$sha/statuses" >/dev/null
    state=$(jq -r --arg c "$context" '[.[] | select(.context == $c)][0].status // empty' "$WORK/forge.json")
    [ "$state" = "$want" ] && return 0
    sleep 3
  done
  fail "statut « $context » sur ${sha:0:7} : « ${state:-aucun} » au lieu de « $want »"
}

wait_deployment() {
  local id="$1" status=""
  for _ in $(seq 1 200); do
    sleep 3
    req GET "/api/deployments/$id" >/dev/null
    status=$(jq -r .status "$BODY")
    case "$status" in success|failed|rolled_back|destroyed) printf '%s' "$status"; return ;; esac
  done
  fail "le déploiement $id n'a pas abouti en 10 minutes (statut « $status »)"
}

page() {
  docker compose exec -T ssh-target sh -c \
    "wget -qO- http://127.0.0.1:$1/ 2>/dev/null || curl -s http://127.0.0.1:$1/"
}

cascade_delete() {
  local app="$1" code
  [ -n "$app" ] || return 0
  code=$(req POST "/api/applications/$app/cascade" '{"force":false}')
  [ "$code" = "202" ] || { info "cascade → HTTP $code : $(cat "$BODY")"; return 0; }
  for _ in $(seq 1 120); do
    sleep 2
    [ "$(req GET "/api/applications/$app")" = "404" ] && return 0
  done
}

cleanup() {
  set +e
  cascade_delete "$APP_ID"
  req DELETE /api/integrations/gitea >/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

# ─── 1. La forge ──────────────────────────────────────────────────────────────
step "1. Connecter la forge"
for _ in 1 2 3 4 5; do
  code=$(req POST /api/auth/sign-in/email "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
  [ "$code" = "429" ] || break
  sleep 6
done
[ "$code" = "200" ] || fail "connexion → HTTP $code"
[ "$(jq -r '.user.role // empty' "$BODY")" = "admin" ] || fail "« $ADMIN_EMAIL » n'est pas administrateur"
pass "connecté en tant que $ADMIN_EMAIL"

req GET /api/targets >/dev/null
TARGET_ID=$(jq -r --arg n "$DOCKER_TARGET" '.items[] | select(.name == $n) | .id' "$BODY")
[ -n "$TARGET_ID" ] || fail "cible « $DOCKER_TARGET » introuvable"

# Restes d'un passage précédent.
req GET /api/applications >/dev/null
old=$(jq -r --arg s "$SLUG" '.items[] | select(.slug == $s) | .id' "$BODY" | head -1)
[ -n "$old" ] && { info "reste d'un passage précédent : $SLUG"; cascade_delete "$old"; }
req DELETE /api/integrations/gitea >/dev/null || true

TOKEN=$(GITEA_URL="$GITEA_URL" ./scripts/test-gitea/setup.sh)
[ -n "$TOKEN" ] || fail "le jeton de la forge de test n'a pas pu être créé"
pass "forge de test prête : $REPO, jeton neuf"

code=$(req POST /api/integrations/gitea/check "{\"url\":\"$GITEA_URL\",\"token\":\"mauvais-jeton-de-test\"}")
[ "$code" = "200" ] && jq -e '.ok == false' "$BODY" >/dev/null || fail "mauvais jeton : $(cat "$BODY")"
info "refus : $(jq -r .error "$BODY")"
code=$(req POST /api/integrations/gitea/check "{\"url\":\"$GITEA_URL\",\"token\":\"$TOKEN\"}")
jq -e --arg u "$GITEA_USER" '.ok == true and .login == $u' "$BODY" >/dev/null || fail "bon jeton : $(cat "$BODY")"
pass "« Tester » refuse un mauvais jeton, et nomme le compte du bon (Gitea $(jq -r .version "$BODY"))"

code=$(req PUT /api/integrations/gitea "{\"url\":\"$GITEA_URL/\",\"token\":\"$TOKEN\"}")
[ "$code" = "201" ] || fail "connexion de la forge → HTTP $code : $(cat "$BODY")"
grep -q "$TOKEN" "$BODY" && fail "la réponse contient le jeton"
req GET /api/integrations/gitea >/dev/null
grep -q "$TOKEN" "$BODY" && fail "GET /api/integrations/gitea rend le jeton"
stored=$(psql_q "select token_encrypted from source_connections where provider = 'gitea';")
[ -n "$stored" ] && [[ "$stored" != *"$TOKEN"* ]] || fail "le jeton n'est pas chiffré en base"
pass "forge connectée ($(jq -r .connection.url "$BODY")) — jeton chiffré, jamais rendu"

# ─── 2. Ses dépôts ────────────────────────────────────────────────────────────
step "2. Les dépôts de la forge"
code=$(req GET /api/integrations/repositories)
[ "$code" = "200" ] || fail "dépôts → HTTP $code : $(cat "$BODY")"
jq -e --arg r "$REPO" '.items | any(.provider == "gitea" and .fullName == $r and .installationId == null)' "$BODY" >/dev/null \
  || fail "$REPO absent de la liste : $(jq -c '.items | map(.fullName)' "$BODY")"
providers=$(jq -r '[.items[].provider] | unique | join(", ")' "$BODY")
errors=$(jq -r '.errors | map(.provider + " : " + .message) | join(" · ")' "$BODY")
[ -n "$errors" ] && info "fournisseurs muets : $errors"
pass "$REPO listé, fournisseurs présents : $providers"

code=$(req GET "/api/integrations/specs?provider=gitea&repository=$REPO&branch=main")
[ "$code" = "200" ] && jq -e '.specs == ["pupitre.json"]' "$BODY" >/dev/null || fail "specs → HTTP $code : $(cat "$BODY")"
pass "le pupitre.json de main se trouve, au commit $(jq -r '.sha[0:7]' "$BODY")"

# ─── 3. Créer depuis le dépôt, déployer ───────────────────────────────────────
step "3. Créer l'application depuis Gitea, la déployer sur Docker"
code=$(req POST /api/applications/from-source \
  "{\"provider\":\"gitea\",\"repository\":\"$REPO\",\"branch\":\"main\",\"specPath\":\"pupitre.json\",\"deployTo\":\"running\",\"mode\":\"auto_unless_infra\"}")
[ "$code" = "201" ] || fail "création → HTTP $code : $(cat "$BODY")"
APP_ID=$(jq -r .application.id "$BODY")
SOURCE_ID=$(jq -r .source.id "$BODY")
[ "$(psql_q "select c.provider from application_sources s join source_connections c on c.id = s.connection_id where s.id = '$SOURCE_ID';")" = "gitea" ] \
  || fail "la liaison ne passe pas par la connexion Gitea"
pass "« $SLUG » créée et liée à $REPO@main"

SHA1=$(head_sha)
code=$(req POST /api/deployments \
  "{\"applicationId\":\"$APP_ID\",\"targetId\":\"$TARGET_ID\",\"runtime\":\"docker\",\"autoRollback\":false,\"scanConfig\":{\"scanners\":[],\"failOn\":\"NONE\"}}")
[ "$code" = "202" ] || fail "déploiement → HTTP $code : $(cat "$BODY")"
DEP1=$(jq -r .id "$BODY")
[ "$(wait_deployment "$DEP1")" = "success" ] || fail "déploiement : $(jq -r .error "$BODY")"
jq -e --arg u "$GITEA_URL/$REPO" --arg s "$SHA1" '.sourceUrl == $u and .sourceSha == $s' "$BODY" >/dev/null \
  || fail "le déploiement ne garde pas son dépôt Gitea : $(jq -c '{sourceUrl, sourceSha}' "$BODY")"
PORT=$(jq -r .publishedPort "$BODY")
[[ "$(page "$PORT")" == *"bonjour depuis gitea"* ]] || fail "la page ne sert pas le code du dépôt"
pass "construite depuis l'archive Gitea du commit ${SHA1:0:7}, elle sert sa page (port $PORT)"
wait_status "$SHA1" "pupitre/$DOCKER_TARGET" success
pass "« success » écrit sur le commit, contexte pupitre/$DOCKER_TARGET"

# ─── 4. Un commit ─────────────────────────────────────────────────────────────
step "4. Un commit sur main : redéployé là où l'application tourne"
commit_file "app/index.html" $'<h1>v2 depuis gitea</h1>\n' "v2"
SHA2=$(head_sha)
code=$(req POST "/api/applications/$APP_ID/sources/$SOURCE_ID/check")
[ "$code" = "202" ] || fail "vérification → HTTP $code : $(cat "$BODY")"
DEP2=""
for _ in $(seq 1 60); do
  DEP2=$(psql_q "select id from deployments where application_id = '$APP_ID' and source_sha = '$SHA2' limit 1;")
  [ -n "$DEP2" ] && break
  sleep 2
done
[ -n "$DEP2" ] || fail "aucun déploiement pour ${SHA2:0:7} — liaison : $(psql_q "select last_error from application_sources where id = '$SOURCE_ID';")"
[ "$(wait_deployment "$DEP2")" = "success" ] || fail "redéploiement : $(jq -r .error "$BODY")"
PORT=$(jq -r .publishedPort "$BODY")
[[ "$(page "$PORT")" == *"v2 depuis gitea"* ]] || fail "la nouvelle page n'est pas servie"
pass "le polling a vu ${SHA2:0:7}, l'application a été redéployée et sert « v2 »"
# La liaison passe par le client de sa connexion : un client GitHub qui la
# prendrait pour un dépôt GitHub y laisserait son erreur.
last_error=$(psql_q "select coalesce(last_error, '') from application_sources where id = '$SOURCE_ID';")
[ -z "$last_error" ] || fail "la liaison porte une erreur : $last_error"
pass "la liaison est vérifiée par le client Gitea, sans erreur"
wait_status "$SHA2" "pupitre/$DOCKER_TARGET" success
pass "« success » écrit sur le nouveau commit"

# ─── 5. Un changement d'infrastructure ────────────────────────────────────────
step "5. Un commit qui touche l'infrastructure attend une validation"
forge GET "/repos/$REPO/raw/pupitre.json?ref=main" >/dev/null
spec=$(jq -c '.services[0].port = 8081' "$WORK/forge.json")
commit_file "pupitre.json" "$spec" "port 8081"
SHA3=$(head_sha)
req POST "/api/applications/$APP_ID/sources/$SOURCE_ID/check" >/dev/null
proposal=""
for _ in $(seq 1 40); do
  req GET "/api/applications/$APP_ID/sources" >/dev/null
  proposal=$(jq -r --arg s "$SHA3" '.proposals[] | select(.sha == $s) | .reason' "$BODY")
  [ -n "$proposal" ] && break
  sleep 2
done
[ "$proposal" = "infra" ] || fail "aucun commit en attente pour ${SHA3:0:7} : $(jq -c .proposals "$BODY")"
[ -z "$(psql_q "select id from deployments where application_id = '$APP_ID' and source_sha = '$SHA3';")" ] \
  || fail "le commit d'infrastructure est parti sans validation"
wait_status "$SHA3" "pupitre" pending
pass "en attente (infra), rien de déployé, « pending » écrit sur le commit"

# ─── 6. Journal et ménage ─────────────────────────────────────────────────────
step "6. Le journal"
[ "$(psql_q "select count(*) from audit_logs where action = 'integration.gitea.connected' and created_at > now() - interval '1 hour';")" -ge 1 ] \
  || fail "la connexion de la forge n'est pas au journal"
[ "$(psql_q "select count(*) from audit_logs where action = 'source.linked' and after->>'provider' = 'gitea' and created_at > now() - interval '1 hour';")" -ge 1 ] \
  || fail "la liaison au dépôt Gitea n'est pas au journal"
leak=$(psql_q "select count(*) from audit_logs where created_at > now() - interval '1 hour' and strpos(coalesce(after::text,'') || coalesce(before::text,''), '$TOKEN') > 0;")
[ "$leak" = "0" ] || fail "le jeton de la forge apparaît au journal"
pass "connexion et liaison au journal, sans le jeton"

step "7. Ménage"
cascade_delete "$APP_ID"
APP_ID=""
code=$(req DELETE /api/integrations/gitea)
[ "$code" = "200" ] || fail "déconnexion → HTTP $code : $(cat "$BODY")"
[ "$(psql_q "select count(*) from source_connections where provider = 'gitea';")" = "0" ] || fail "la connexion est restée"
pass "application détruite, forge déconnectée"

printf '\n\033[32mFournisseur Gitea : tout est conforme.\033[0m\n'
