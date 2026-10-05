#!/usr/bin/env bash
#
# A second code provider, end to end against a real Gitea forge:
#
#   1. connecting the forge: "Test" refuses a wrong token and names the right
#      account; the token is encrypted, and never comes out
#   2. its repositories are listed next to the other providers' ones, and a
#      branch's pupitre.json is found
#   3. creating the application from the repository, deploying it on a Docker
#      target: the code downloaded from Gitea builds, the page answers, the
#      deployment's state is written on the commit
#   4. a commit on the branch: the polling sees it, the application is
#      redeployed where it runs, the new page answers
#   5. a commit that touches the infrastructure waits for an approval, and says
#      so on the commit
#   6. the log, without a token; cleanup: application destroyed, forge
#      disconnected
#
# Prerequisite — the test forge, and the panel reaching it at the same address:
#   docker compose --profile test up -d gitea
#
# Usage:
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

# The forge, directly, with the test account.
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

# Replaces a repository file through a commit. Echoes: nothing.
commit_file() {
  local path="$1" content="$2" message="$3" sha body code
  forge GET "/repos/$REPO/contents/$path?ref=main" >/dev/null
  sha=$(jq -r .sha "$WORK/forge.json")
  body=$(jq -n --arg c "$(printf '%s' "$content" | base64 | tr -d '\n')" --arg m "$message" --arg s "$sha" \
    '{content:$c, message:$m, branch:"main", sha:$s}')
  code=$(forge PUT "/repos/$REPO/contents/$path" "$body")
  [ "$code" = "200" ] || fail "commit of $path → HTTP $code: $(cat "$WORK/forge.json")"
}

# The state Pupitre wrote on a commit, for a context. Waits for it to be `want`.
wait_status() {
  local sha="$1" context="$2" want="$3" state=""
  for _ in $(seq 1 100); do
    forge GET "/repos/$REPO/commits/$sha/statuses" >/dev/null
    state=$(jq -r --arg c "$context" '[.[] | select(.context == $c)][0].status // empty' "$WORK/forge.json")
    [ "$state" = "$want" ] && return 0
    sleep 3
  done
  fail "status \"$context\" on ${sha:0:7}: \"${state:-none}\" instead of \"$want\""
}

wait_deployment() {
  local id="$1" status=""
  for _ in $(seq 1 200); do
    sleep 3
    req GET "/api/deployments/$id" >/dev/null
    status=$(jq -r .status "$BODY")
    case "$status" in success|failed|rolled_back|destroyed) printf '%s' "$status"; return ;; esac
  done
  fail "deployment $id did not complete in 10 minutes (status \"$status\")"
}

page() {
  docker compose exec -T ssh-target sh -c \
    "wget -qO- http://127.0.0.1:$1/ 2>/dev/null || curl -s http://127.0.0.1:$1/"
}

cascade_delete() {
  local app="$1" code
  [ -n "$app" ] || return 0
  code=$(req POST "/api/applications/$app/cascade" '{"force":false}')
  [ "$code" = "202" ] || { info "cascade → HTTP $code: $(cat "$BODY")"; return 0; }
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

# ─── 1. The forge ─────────────────────────────────────────────────────────────
step "1. Connecting the forge"
for _ in 1 2 3 4 5; do
  code=$(req POST /api/auth/sign-in/email "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
  [ "$code" = "429" ] || break
  sleep 6
done
[ "$code" = "200" ] || fail "sign-in → HTTP $code"
[ "$(jq -r '.user.role // empty' "$BODY")" = "admin" ] || fail "\"$ADMIN_EMAIL\" is not an administrator"
pass "signed in as $ADMIN_EMAIL"

req GET /api/targets >/dev/null
TARGET_ID=$(jq -r --arg n "$DOCKER_TARGET" '.items[] | select(.name == $n) | .id' "$BODY")
[ -n "$TARGET_ID" ] || fail "target \"$DOCKER_TARGET\" not found"

# Leftovers from a previous pass.
req GET /api/applications >/dev/null
old=$(jq -r --arg s "$SLUG" '.items[] | select(.slug == $s) | .id' "$BODY" | head -1)
[ -n "$old" ] && { info "leftover from a previous pass: $SLUG"; cascade_delete "$old"; }
req DELETE /api/integrations/gitea >/dev/null || true

TOKEN=$(GITEA_URL="$GITEA_URL" ./scripts/test-gitea/setup.sh)
[ -n "$TOKEN" ] || fail "the test forge's token could not be created"
pass "test forge ready: $REPO, new token"

code=$(req POST /api/integrations/gitea/check "{\"url\":\"$GITEA_URL\",\"token\":\"mauvais-jeton-de-test\"}")
[ "$code" = "200" ] && jq -e '.ok == false' "$BODY" >/dev/null || fail "wrong token: $(cat "$BODY")"
info "refusal: $(jq -r .error "$BODY")"
code=$(req POST /api/integrations/gitea/check "{\"url\":\"$GITEA_URL\",\"token\":\"$TOKEN\"}")
jq -e --arg u "$GITEA_USER" '.ok == true and .login == $u' "$BODY" >/dev/null || fail "right token: $(cat "$BODY")"
pass "\"Test\" refuses a wrong token, and names the right one's account (Gitea $(jq -r .version "$BODY"))"

code=$(req PUT /api/integrations/gitea "{\"url\":\"$GITEA_URL/\",\"token\":\"$TOKEN\"}")
[ "$code" = "201" ] || fail "connecting the forge → HTTP $code: $(cat "$BODY")"
grep -q "$TOKEN" "$BODY" && fail "the response contains the token"
req GET /api/integrations/gitea >/dev/null
grep -q "$TOKEN" "$BODY" && fail "GET /api/integrations/gitea returns the token"
stored=$(psql_q "select token_encrypted from source_connections where provider = 'gitea';")
[ -n "$stored" ] && [[ "$stored" != *"$TOKEN"* ]] || fail "the token is not encrypted in the database"
pass "forge connected ($(jq -r .connection.url "$BODY")) — token encrypted, never returned"

# ─── 2. Its repositories ──────────────────────────────────────────────────────
step "2. The forge's repositories"
code=$(req GET /api/integrations/repositories)
[ "$code" = "200" ] || fail "repositories → HTTP $code: $(cat "$BODY")"
jq -e --arg r "$REPO" '.items | any(.provider == "gitea" and .fullName == $r and .installationId == null)' "$BODY" >/dev/null \
  || fail "$REPO missing from the list: $(jq -c '.items | map(.fullName)' "$BODY")"
providers=$(jq -r '[.items[].provider] | unique | join(", ")' "$BODY")
errors=$(jq -r '.errors | map(.provider + " : " + .message) | join(" · ")' "$BODY")
[ -n "$errors" ] && info "silent providers: $errors"
pass "$REPO listed, providers present: $providers"

code=$(req GET "/api/integrations/specs?provider=gitea&repository=$REPO&branch=main")
[ "$code" = "200" ] && jq -e '.specs == ["pupitre.json"]' "$BODY" >/dev/null || fail "specs → HTTP $code: $(cat "$BODY")"
pass "main's pupitre.json is found, at commit $(jq -r '.sha[0:7]' "$BODY")"

# ─── 3. Creating from the repository, deploying ───────────────────────────────
step "3. Creating the application from Gitea, deploying it on Docker"
code=$(req POST /api/applications/from-source \
  "{\"provider\":\"gitea\",\"repository\":\"$REPO\",\"branch\":\"main\",\"specPath\":\"pupitre.json\",\"deployTo\":\"running\",\"mode\":\"auto_unless_infra\"}")
[ "$code" = "201" ] || fail "creation → HTTP $code: $(cat "$BODY")"
APP_ID=$(jq -r .application.id "$BODY")
SOURCE_ID=$(jq -r .source.id "$BODY")
[ "$(psql_q "select c.provider from application_sources s join source_connections c on c.id = s.connection_id where s.id = '$SOURCE_ID';")" = "gitea" ] \
  || fail "the link does not go through the Gitea connection"
pass "\"$SLUG\" created and linked to $REPO@main"

SHA1=$(head_sha)
code=$(req POST /api/deployments \
  "{\"applicationId\":\"$APP_ID\",\"targetId\":\"$TARGET_ID\",\"runtime\":\"docker\",\"autoRollback\":false,\"scanConfig\":{\"scanners\":[],\"failOn\":\"NONE\"}}")
[ "$code" = "202" ] || fail "deployment → HTTP $code: $(cat "$BODY")"
DEP1=$(jq -r .id "$BODY")
[ "$(wait_deployment "$DEP1")" = "success" ] || fail "deployment: $(jq -r .error "$BODY")"
jq -e --arg u "$GITEA_URL/$REPO" --arg s "$SHA1" '.sourceUrl == $u and .sourceSha == $s' "$BODY" >/dev/null \
  || fail "the deployment does not keep its Gitea repository: $(jq -c '{sourceUrl, sourceSha}' "$BODY")"
PORT=$(jq -r .publishedPort "$BODY")
[[ "$(page "$PORT")" == *"bonjour depuis gitea"* ]] || fail "the page does not serve the repository's code"
pass "built from the Gitea archive of commit ${SHA1:0:7}, it serves its page (port $PORT)"
wait_status "$SHA1" "pupitre/$DOCKER_TARGET" success
pass "\"success\" written on the commit, context pupitre/$DOCKER_TARGET"

# ─── 4. A commit ──────────────────────────────────────────────────────────────
step "4. A commit on main: redeployed where the application runs"
commit_file "app/index.html" $'<h1>v2 depuis gitea</h1>\n' "v2"
SHA2=$(head_sha)
code=$(req POST "/api/applications/$APP_ID/sources/$SOURCE_ID/check")
[ "$code" = "202" ] || fail "check → HTTP $code: $(cat "$BODY")"
DEP2=""
for _ in $(seq 1 60); do
  DEP2=$(psql_q "select id from deployments where application_id = '$APP_ID' and source_sha = '$SHA2' limit 1;")
  [ -n "$DEP2" ] && break
  sleep 2
done
[ -n "$DEP2" ] || fail "no deployment for ${SHA2:0:7} — link: $(psql_q "select last_error from application_sources where id = '$SOURCE_ID';")"
[ "$(wait_deployment "$DEP2")" = "success" ] || fail "redeployment: $(jq -r .error "$BODY")"
PORT=$(jq -r .publishedPort "$BODY")
[[ "$(page "$PORT")" == *"v2 depuis gitea"* ]] || fail "the new page is not served"
pass "the polling saw ${SHA2:0:7}, the application was redeployed and serves \"v2\""
# The link goes through its connection's client: a GitHub client that took it
# for a GitHub repository would leave its error there.
last_error=$(psql_q "select coalesce(last_error, '') from application_sources where id = '$SOURCE_ID';")
[ -z "$last_error" ] || fail "the link carries an error: $last_error"
pass "the link is checked by the Gitea client, without an error"
wait_status "$SHA2" "pupitre/$DOCKER_TARGET" success
pass "\"success\" written on the new commit"

# ─── 5. An infrastructure change ──────────────────────────────────────────────
step "5. A commit that touches the infrastructure waits for an approval"
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
[ "$proposal" = "infra" ] || fail "no commit waiting for ${SHA3:0:7}: $(jq -c .proposals "$BODY")"
[ -z "$(psql_q "select id from deployments where application_id = '$APP_ID' and source_sha = '$SHA3';")" ] \
  || fail "the infrastructure commit went out without an approval"
wait_status "$SHA3" "pupitre" pending
pass "waiting (infra), nothing deployed, \"pending\" written on the commit"

# ─── 6. Log and cleanup ───────────────────────────────────────────────────────
step "6. The log"
[ "$(psql_q "select count(*) from audit_logs where action = 'integration.gitea.connected' and created_at > now() - interval '1 hour';")" -ge 1 ] \
  || fail "the forge's connection is not in the log"
[ "$(psql_q "select count(*) from audit_logs where action = 'source.linked' and after->>'provider' = 'gitea' and created_at > now() - interval '1 hour';")" -ge 1 ] \
  || fail "the link to the Gitea repository is not in the log"
leak=$(psql_q "select count(*) from audit_logs where created_at > now() - interval '1 hour' and strpos(coalesce(after::text,'') || coalesce(before::text,''), '$TOKEN') > 0;")
[ "$leak" = "0" ] || fail "the forge's token appears in the log"
pass "connection and link in the log, without the token"

step "7. Cleanup"
cascade_delete "$APP_ID"
APP_ID=""
code=$(req DELETE /api/integrations/gitea)
[ "$code" = "200" ] || fail "disconnecting → HTTP $code: $(cat "$BODY")"
[ "$(psql_q "select count(*) from source_connections where provider = 'gitea';")" = "0" ] || fail "the connection stayed"
pass "application destroyed, forge disconnected"

printf '\n\033[32mGitea provider: everything complies.\033[0m\n'
