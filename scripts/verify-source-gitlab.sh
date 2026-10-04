#!/usr/bin/env bash
#
# Le troisième fournisseur de code, de bout en bout contre une vraie instance
# GitLab CE :
#
#   1. connecter GitLab : « Tester » refuse un mauvais jeton et un jeton sans
#      la portée `api`, nomme le robot du bon jeton et son échéance ; le jeton
#      est chiffré, et ne ressort jamais
#   2. le projet — dans un sous-groupe, `atelier/web/bonjour` — se liste à côté
#      de ceux des autres fournisseurs, et le pupitre.json d'une branche se trouve
#   3. créer l'application depuis le projet, la déployer sur une cible Docker :
#      le code téléchargé chez GitLab se construit, la page répond, l'état du
#      déploiement est écrit sur le commit
#   4. un commit sur la branche : le polling le voit, l'application est
#      redéployée là où elle tourne, la nouvelle page répond
#   5. un commit qui touche l'infrastructure attend une validation, et le dit
#      sur le commit ; l'automate de GitLab refuse un second « pending » avec
#      le message que le client reconnaît
#   6. le journal, sans jeton ; ménage : application détruite, GitLab déconnecté
#
# Prérequis — l'instance de test, et le panel qui la joint à la même adresse :
#   docker compose --profile test up -d gitlab     # plusieurs minutes au premier démarrage
#
# Usage :
#   ./scripts/verify-source-gitlab.sh
#   BASE_URL=http://localhost:3200 DOCKER_TARGET=… DB_NAME=… ./scripts/verify-source-gitlab.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
DOCKER_TARGET="${DOCKER_TARGET:-cible-de-verification}"
DB_NAME="${DB_NAME:-tp}"
GITLAB_URL="${GITLAB_URL:-http://localhost:3040}"
REPO="atelier/web/bonjour"
ENCODED="atelier%2Fweb%2Fbonjour"
SLUG="bonjour-gitlab"
CLIENT_IP="${CLIENT_IP:-198.51.100.95}"

WORK="$(mktemp -d)"
BODY="$WORK/body.json"
JAR="$WORK/admin.jar"
APP_ID=""
WEAK_TOKEN_ID=""

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

# GitLab, directement, avec le jeton d'administration de `scripts/test-gitlab/setup.sh`.
forge() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$WORK/forge.json" -w '%{http_code}' -X "$method" "$GITLAB_URL/api/v4$path"
              -H "private-token: $ADMIN_TOKEN" -H 'content-type: application/json')
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}

psql_q() { docker compose exec -T postgres psql -U tp -d "$DB_NAME" -tAc "$1"; }

head_sha() { forge GET "/projects/$ENCODED/repository/branches/main" >/dev/null; jq -r .commit.id "$WORK/forge.json"; }

# Remplace un fichier du projet par un commit. Écho : rien.
commit_file() {
  local path="$1" content="$2" message="$3" body code
  body=$(jq -n --arg p "$path" --arg c "$content" --arg m "$message" \
    '{branch:"main", commit_message:$m, actions:[{action:"update", file_path:$p, content:$c}]}')
  code=$(forge POST "/projects/$ENCODED/repository/commits" "$body")
  [ "$code" = "201" ] || fail "commit de $path → HTTP $code : $(cat "$WORK/forge.json")"
}

# L'état que Pupitre a écrit sur un commit, pour un contexte. Attend qu'il soit `want`.
wait_status() {
  local sha="$1" context="$2" want="$3" state=""
  for _ in $(seq 1 100); do
    forge GET "/projects/$ENCODED/repository/commits/$sha/statuses" >/dev/null || true
    # Une instance chargée répond parfois 502 : on réessaie au tour suivant.
    state=$(jq -r --arg c "$context" '[.[] | select(.name == $c)][0].status // empty' "$WORK/forge.json" 2>/dev/null || true)
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
  req DELETE /api/integrations/gitlab >/dev/null
  [ -n "$WEAK_TOKEN_ID" ] && forge DELETE "/projects/$ENCODED/access_tokens/$WEAK_TOKEN_ID" >/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

# ─── 1. GitLab ────────────────────────────────────────────────────────────────
step "1. Connecter GitLab"
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
req DELETE /api/integrations/gitlab >/dev/null || true

TOKEN=$(GITLAB_URL="$GITLAB_URL" ./scripts/test-gitlab/setup.sh)
[ -n "$TOKEN" ] || fail "le jeton du projet de test n'a pas pu être créé"
ADMIN_TOKEN=$(docker compose exec -T gitlab cat /etc/gitlab/pupitre-admin-token)
pass "instance de test prête : $REPO, jeton de projet neuf (Maintainer, api)"

code=$(req POST /api/integrations/gitlab/check "{\"url\":\"$GITLAB_URL\",\"token\":\"mauvais-jeton-de-test\"}")
[ "$code" = "200" ] && jq -e '.ok == false' "$BODY" >/dev/null || fail "mauvais jeton : $(cat "$BODY")"
info "refus : $(jq -r .error "$BODY")"

# Un jeton qui lit tout mais n'écrit rien : refusé, la portée manquante nommée.
code=$(forge POST "/projects/$ENCODED/access_tokens" "$(jq -n --arg e "$(date -u -v+7d +%F 2>/dev/null || date -u -d '+7 days' +%F)" \
  '{name:"pupitre-lecture", scopes:["read_api","read_repository"], access_level:30, expires_at:$e}')")
[ "$code" = "201" ] || fail "jeton en lecture → HTTP $code : $(cat "$WORK/forge.json")"
WEAK_TOKEN_ID=$(jq -r .id "$WORK/forge.json")
weak=$(jq -r .token "$WORK/forge.json")
code=$(req POST /api/integrations/gitlab/check "{\"url\":\"$GITLAB_URL\",\"token\":\"$weak\"}")
jq -e '.ok == false and (.error | contains("api"))' "$BODY" >/dev/null || fail "jeton sans api : $(cat "$BODY")"
info "refus : $(jq -r .error "$BODY")"
code=$(req PUT /api/integrations/gitlab "{\"url\":\"$GITLAB_URL\",\"token\":\"$weak\"}")
[ "$code" = "502" ] || fail "un jeton sans api s'enregistre → HTTP $code"
forge DELETE "/projects/$ENCODED/access_tokens/$WEAK_TOKEN_ID" >/dev/null
WEAK_TOKEN_ID=""

code=$(req POST /api/integrations/gitlab/check "{\"url\":\"$GITLAB_URL\",\"token\":\"$TOKEN\"}")
jq -e '.ok == true and (.login | startswith("project_")) and (.expiresAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$"))' "$BODY" >/dev/null \
  || fail "bon jeton : $(cat "$BODY")"
pass "« Tester » refuse un mauvais jeton et un jeton sans api, nomme le robot du bon ($(jq -r .login "$BODY"), GitLab $(jq -r .version "$BODY"), échéance $(jq -r .expiresAt "$BODY"))"

code=$(req PUT /api/integrations/gitlab "{\"url\":\"$GITLAB_URL/\",\"token\":\"$TOKEN\"}")
[ "$code" = "201" ] || fail "connexion de GitLab → HTTP $code : $(cat "$BODY")"
grep -q "$TOKEN" "$BODY" && fail "la réponse contient le jeton"
req GET /api/integrations/gitlab >/dev/null
grep -q "$TOKEN" "$BODY" && fail "GET /api/integrations/gitlab rend le jeton"
stored=$(psql_q "select token_encrypted from source_connections where provider = 'gitlab';")
[ -n "$stored" ] && [[ "$stored" != *"$TOKEN"* ]] || fail "le jeton n'est pas chiffré en base"
pass "GitLab connecté ($(jq -r .connection.url "$BODY")) — jeton chiffré, jamais rendu"

# ─── 2. Ses projets ───────────────────────────────────────────────────────────
step "2. Les projets du jeton"
code=$(req GET /api/integrations/repositories)
[ "$code" = "200" ] || fail "dépôts → HTTP $code : $(cat "$BODY")"
jq -e --arg r "$REPO" '.items | any(.provider == "gitlab" and .fullName == $r and .installationId == null and .defaultBranch == "main")' "$BODY" >/dev/null \
  || fail "$REPO absent de la liste : $(jq -c '.items | map(.fullName)' "$BODY")"
providers=$(jq -r '[.items[].provider] | unique | join(", ")' "$BODY")
errors=$(jq -r '.errors | map(.provider + " : " + .message) | join(" · ")' "$BODY")
[ -n "$errors" ] && info "fournisseurs muets : $errors"
pass "$REPO — un projet de sous-groupe — listé, fournisseurs présents : $providers"

code=$(req GET "/api/integrations/specs?provider=gitlab&repository=$REPO&branch=main")
[ "$code" = "200" ] && jq -e '.specs == ["pupitre.json"]' "$BODY" >/dev/null || fail "specs → HTTP $code : $(cat "$BODY")"
pass "le pupitre.json de main se trouve, au commit $(jq -r '.sha[0:7]' "$BODY")"

# ─── 3. Créer depuis le projet, déployer ──────────────────────────────────────
step "3. Créer l'application depuis GitLab, la déployer sur Docker"
code=$(req POST /api/applications/from-source \
  "{\"provider\":\"gitlab\",\"repository\":\"$REPO\",\"branch\":\"main\",\"specPath\":\"pupitre.json\",\"deployTo\":\"running\",\"mode\":\"auto_unless_infra\"}")
[ "$code" = "201" ] || fail "création → HTTP $code : $(cat "$BODY")"
APP_ID=$(jq -r .application.id "$BODY")
SOURCE_ID=$(jq -r .source.id "$BODY")
[ "$(psql_q "select c.provider from application_sources s join source_connections c on c.id = s.connection_id where s.id = '$SOURCE_ID';")" = "gitlab" ] \
  || fail "la liaison ne passe pas par la connexion GitLab"
pass "« $SLUG » créée et liée à $REPO@main"

SHA1=$(head_sha)
code=$(req POST /api/deployments \
  "{\"applicationId\":\"$APP_ID\",\"targetId\":\"$TARGET_ID\",\"runtime\":\"docker\",\"autoRollback\":false,\"scanConfig\":{\"scanners\":[],\"failOn\":\"NONE\"}}")
[ "$code" = "202" ] || fail "déploiement → HTTP $code : $(cat "$BODY")"
DEP1=$(jq -r .id "$BODY")
[ "$(wait_deployment "$DEP1")" = "success" ] || fail "déploiement : $(jq -r .error "$BODY")"
jq -e --arg u "$GITLAB_URL/$REPO" --arg s "$SHA1" '.sourceUrl == $u and .sourceSha == $s' "$BODY" >/dev/null \
  || fail "le déploiement ne garde pas son projet GitLab : $(jq -c '{sourceUrl, sourceSha}' "$BODY")"
PORT=$(jq -r .publishedPort "$BODY")
[[ "$(page "$PORT")" == *"bonjour depuis gitlab"* ]] || fail "la page ne sert pas le code du projet"
pass "construite depuis l'archive GitLab du commit ${SHA1:0:7}, elle sert sa page (port $PORT)"
wait_status "$SHA1" "pupitre/$DOCKER_TARGET" success
pass "« success » écrit sur le commit, statut pupitre/$DOCKER_TARGET"

# ─── 4. Un commit ─────────────────────────────────────────────────────────────
step "4. Un commit sur main : redéployé là où l'application tourne"
commit_file "app/index.html" $'<h1>v2 depuis gitlab</h1>\n' "v2"
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
[[ "$(page "$PORT")" == *"v2 depuis gitlab"* ]] || fail "la nouvelle page n'est pas servie"
pass "le polling a vu ${SHA2:0:7}, l'application a été redéployée et sert « v2 »"
last_error=$(psql_q "select coalesce(last_error, '') from application_sources where id = '$SOURCE_ID';")
[ -z "$last_error" ] || fail "la liaison porte une erreur : $last_error"
pass "la liaison est vérifiée par le client GitLab, sans erreur (comparaison comprise)"
wait_status "$SHA2" "pupitre/$DOCKER_TARGET" success
pass "« success » écrit sur le nouveau commit"

# ─── 5. Un changement d'infrastructure ────────────────────────────────────────
step "5. Un commit qui touche l'infrastructure attend une validation"
forge GET "/projects/$ENCODED/repository/files/pupitre.json/raw?ref=main" >/dev/null
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

# Le client tient pour acquis qu'un second « pending » est refusé par ce
# message-là : on le vérifie auprès de la vraie instance, avec le jeton de
# Pupitre — GitLab rattache un statut à son auteur, un autre compte en
# créerait un second.
code=$(curl -s -o "$WORK/forge.json" -w '%{http_code}' -X POST "$GITLAB_URL/api/v4/projects/$ENCODED/statuses/$SHA3" \
  -H "private-token: $TOKEN" -H 'content-type: application/json' --data-binary '{"state":"pending","name":"pupitre"}')
[ "$code" = "400" ] && jq -e '.message | tostring | contains("Cannot transition status")' "$WORK/forge.json" >/dev/null \
  || fail "second « pending » → HTTP $code : $(cat "$WORK/forge.json")"
pass "un second « pending » est refusé par l'automate de GitLab, avec le message que le client reconnaît"

# ─── 6. Journal et ménage ─────────────────────────────────────────────────────
step "6. Le journal"
[ "$(psql_q "select count(*) from audit_logs where action = 'integration.gitlab.connected' and created_at > now() - interval '1 hour';")" -ge 1 ] \
  || fail "la connexion de GitLab n'est pas au journal"
[ "$(psql_q "select count(*) from audit_logs where action = 'source.linked' and after->>'provider' = 'gitlab' and created_at > now() - interval '1 hour';")" -ge 1 ] \
  || fail "la liaison au projet GitLab n'est pas au journal"
leak=$(psql_q "select count(*) from audit_logs where created_at > now() - interval '1 hour' and strpos(coalesce(after::text,'') || coalesce(before::text,''), '$TOKEN') > 0;")
[ "$leak" = "0" ] || fail "le jeton de GitLab apparaît au journal"
pass "connexion et liaison au journal, sans le jeton"

step "7. Ménage"
cascade_delete "$APP_ID"
APP_ID=""
code=$(req DELETE /api/integrations/gitlab)
[ "$code" = "200" ] || fail "déconnexion → HTTP $code : $(cat "$BODY")"
[ "$(psql_q "select count(*) from source_connections where provider = 'gitlab';")" = "0" ] || fail "la connexion est restée"
pass "application détruite, GitLab déconnecté"

printf '\n\033[32mFournisseur GitLab : tout est conforme.\033[0m\n'
