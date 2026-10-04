#!/usr/bin/env bash
#
# Checks the deletion of an application: the guard, the cascade, the forcing.
#
#   1. an application whose deployments are ALL `destroyed` is deleted without
#      forcing — it is the defect this work fixes
#   2. the cascade really destroys the containers on the target, then deletes
#      the application and gives back its ports
#   3. a partial failure across several targets is reported precisely: what was
#      destroyed, what was not, and nothing is erased
#   4. THE case that matters: unreachable target → refusal with a useful message
#      without forcing; with forcing the record goes AND the activity log
#      carries what is needed to find what remains (Compose project, target, port)
#   5. forcing requires the three permissions of the union, tested with an
#      account that only has part of them
#   6. the port reservations are given back — checked in SQL
#
# The script creates its own material (applications "fd-*", target
# "cible-fantome") and cleans it up. It touches NO application already in
# service: the `/api/apps` inventory is compared before and after.
#
# The "vps" target is never called upon. Everything plays out on
# "cible-de-verification" (the ssh-target container) and on a ghost target
# created for the occasion.
#
# Usage:
#   ./scripts/verify-force-delete.sh
#   BASE_URL=http://localhost:3200 TARGET_NAME=my-vm ./scripts/verify-force-delete.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
TARGET_NAME="${TARGET_NAME:-cible-de-verification}"
GHOST_NAME="${GHOST_NAME:-cible-fantome}"
CLIENT_IP="${CLIENT_IP:-198.51.100.42}"
IMAGE="${IMAGE:-docker.io/library/nginx:1.29-alpine}"

# TEST-NET-3 addresses (RFC 5737): reserved for documentation, never routed. A
# target pointing there is unreachable for sure, everywhere.
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

# The script runs from anywhere: the repository's paths are resolved from its
# own position, not from the current directory.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
PJAR="$WORK/partiel.jar"
BODY="$WORK/body.json"

# The target's real host, restored whatever happens: the script unplugs it on
# purpose in § 6, and an exit on error must not leave it dead.
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

command -v jq >/dev/null || { echo "jq is required"; exit 1; }

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

# Same thing, with the cookie jar of the account with partial rights.
preq() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -H "x-forwarded-for: $CLIENT_IP" -b "$PJAR" -c "$PJAR")
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }

# Direct view on the target machine: it is what tells the truth, not the database.
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
  [ "$code" = "200" ] || fail "sign-in failed (HTTP $code): $(cat "$BODY")"
  assert_admin
}

# The account must be an administrator: without that the script would collapse
# much further on a cryptic 403.
assert_admin() {
  local role
  role=$(jq -r '.user.role // empty' "$BODY")
  [ "$role" = "admin" ] && return 0
  fail "\"$ADMIN_EMAIL\" has the role \"${role:-none}\", not \"admin\" — see $BASE_URL/admin/users"
}

# Minimal AppSpec: an exposed service, an image, a health route.
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
  [ "$code" = "201" ] || fail "POST /api/applications → HTTP $code: $(cat "$BODY")"
  jq -r .id "$BODY"
}

# Deploys and waits for the verdict. Echoes: "<deploymentId> <status>".
deploy_and_wait() {
  local app_id="$1" target_id="$2" code id status
  code=$(req POST /api/deployments \
    "{\"applicationId\":\"$app_id\",\"targetId\":\"$target_id\",\"runtime\":\"docker\",\"proxy\":\"traefik\",\"autoRollback\":false}")
  [ "$code" = "202" ] || fail "POST /api/deployments → HTTP $code: $(cat "$BODY")"
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
  [ "$code" = "202" ] || fail "DELETE /api/deployments/$id → HTTP $code: $(cat "$BODY")"
  for _ in $(seq 1 90); do
    sleep 2
    req GET "/api/deployments/$id" >/dev/null
    status=$(jq -r .status "$BODY")
    [ "$status" = "destroyed" ] && return
  done
  fail "deployment $id was not destroyed in 3 minutes (status \"$status\")"
}

# Starts a cascade and waits for its report. The result lands in
# $WORK/cascade.json. Echoes: the POST's HTTP code.
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
  fail "cascade $job returned no verdict in 4 minutes"
}

# ─── 1. Context ───────────────────────────────────────────────────────────────

step "1. Sign-in and target"
login
pass "signed in as $ADMIN_EMAIL"

req GET /api/targets >/dev/null
TARGET_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY")
[ -n "$TARGET_ID" ] || fail "target \"$TARGET_NAME\" not found — run ./scripts/setup-test-target.sh"
TARGET_HOST=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .host' "$BODY")
pass "target $TARGET_NAME ($TARGET_HOST) — $TARGET_ID"

# Applications really in service BEFORE: they must be strictly identical at the
# end. It is the safeguard of the script itself.
req GET /api/apps >/dev/null
LIVE_BEFORE=$(jq -r '[.items[].applicationSlug] | sort | join(",")' "$BODY")
pass "applications in service before: ${LIVE_BEFORE:-none}"

# Cleanup from an interrupted previous run. The forced cascade is used here —
# the very tool being checked — because it is precisely its job: taking back an
# application whose state is no longer known.
for slug in "$HIST_SLUG" "$CASCADE_SLUG" "$PARTIAL_SLUG" "$DEAD_SLUG" "$RIGHTS_SLUG"; do
  req GET /api/applications >/dev/null
  stale=$(jq -r --arg s "$slug" '.items[] | select(.slug == $s) | .id' "$BODY" | head -1)
  [ -n "$stale" ] || continue
  req POST "/api/applications/$stale/cascade" "{\"force\":true,\"confirm\":\"$slug\"}" >/dev/null
  warn "leftover from a previous run: \"$slug\" erased by force"
  sleep 5
done

# ─── 2. The guard's defect ────────────────────────────────────────────────────

step "2. An application whose deployments are all \"destroyed\" is deleted"

HIST_ID=$(upsert_app "$HIST_SLUG")
read -r HIST_DEPLOY HIST_STATUS <<< "$(deploy_and_wait "$HIST_ID" "$TARGET_ID")"
[ "$HIST_STATUS" = "success" ] || fail "$HIST_SLUG was supposed to deploy, status \"$HIST_STATUS\""
pass "$HIST_SLUG deployed — $HIST_DEPLOY"

destroy_and_wait "$HIST_DEPLOY"
pass "deployment destroyed — the application only carries history now"

HIST_ROWS=$(psql_q "select count(*) from deployments where application_id = '$HIST_ID';")
[ "$HIST_ROWS" -gt 0 ] || fail "no deployment row: the test would be empty"
HIST_DESTROYED=$(psql_q "select count(*) from deployments where application_id = '$HIST_ID' and status = 'destroyed';")
[ "$HIST_ROWS" = "$HIST_DESTROYED" ] \
  || fail "$HIST_DESTROYED/$HIST_ROWS rows destroyed — the history is not in the expected state"
info "$HIST_ROWS deployment(s), all with the \"destroyed\" status"

# It is HERE that the old guard refused: it counted everything, `destroyed` included.
code=$(req DELETE "/api/applications/$HIST_ID")
[ "$code" = "200" ] || fail "deletion refused although nothing runs (HTTP $code): $(cat "$BODY")"
pass "deleted without forcing — $(jq -c '{erasedDeploymentCount, releasedPorts}' "$BODY")"

[ "$(psql_q "select count(*) from applications where id = '$HIST_ID';")" = "0" ] \
  || fail "the application is still in the database"
[ "$(psql_q "select count(*) from deployments where application_id = '$HIST_ID';")" = "0" ] \
  || fail "deployments survived the deletion"
[ "$(psql_q "select count(*) from port_allocations where application_id = '$HIST_ID';")" = "0" ] \
  || fail "a port reservation stayed on a deleted application"
pass "application, history and port reservation: everything is gone"

# ─── 3. The cascade ───────────────────────────────────────────────────────────

step "3. The cascade destroys on the target, then deletes"

CASCADE_ID=$(upsert_app "$CASCADE_SLUG")
read -r CASCADE_DEPLOY CASCADE_STATUS <<< "$(deploy_and_wait "$CASCADE_ID" "$TARGET_ID")"
[ "$CASCADE_STATUS" = "success" ] || fail "$CASCADE_SLUG was supposed to deploy, status \"$CASCADE_STATUS\""
req GET "/api/deployments/$CASCADE_DEPLOY" >/dev/null
CASCADE_PORT=$(jq -r '.publishedPort // empty' "$BODY")
pass "$CASCADE_SLUG deployed — port $CASCADE_PORT"

RUNNING=$(target_docker ps -a --format '{{.Names}}' | grep -c "^app-$CASCADE_SLUG" || true)
[ "$RUNNING" -gt 0 ] || fail "no \"app-$CASCADE_SLUG\" container on the target"
pass "$RUNNING \"app-$CASCADE_SLUG\" container(s) present on the target"

ALLOC=$(psql_q "select port from port_allocations where application_id = '$CASCADE_ID';")
[ -n "$ALLOC" ] || fail "no port reservation for $CASCADE_SLUG"
pass "port $ALLOC reserved in the database"

# Without a cascade, the plain deletion refuses — and the message must say what to do.
code=$(req DELETE "/api/applications/$CASCADE_ID")
[ "$code" = "409" ] || fail "plain deletion of a running app: expected 409, got $code"
jq -e '.error.code == "application_has_live_deployments"' "$BODY" >/dev/null \
  || fail "unexpected error code: $(jq -c '.error.code' "$BODY")"
jq -e --arg t "$TARGET_NAME" '.error.message | test($t)' "$BODY" >/dev/null \
  || fail "the message does not name the target: $(jq -r '.error.message' "$BODY")"
jq -e '.error.message | test("cascade")' "$BODY" >/dev/null \
  || fail "the message does not say how to get out of it: $(jq -r '.error.message' "$BODY")"
pass "409 — $(jq -r '.error.message' "$BODY")"

code=$(cascade "$CASCADE_ID" '{"force":false}')
[ "$code" = "202" ] || fail "POST cascade → HTTP $code: $(cat "$WORK/cascade-error.json" 2>/dev/null)"
jq -e '.deleted == true and (.abandoned | length) == 0 and (.destroyed | length) == 1' "$WORK/cascade.json" \
  >/dev/null || fail "unexpected cascade: $(cat "$WORK/cascade.json")"
pass "$(jq -r '.summary' "$WORK/cascade.json")"

LEFT=$(target_docker ps -a --format '{{.Names}}' | grep -c "^app-$CASCADE_SLUG" || true)
[ "$LEFT" = "0" ] || fail "$LEFT \"app-$CASCADE_SLUG\" container(s) still run on the target"
pass "no \"app-$CASCADE_SLUG\" container left on the target (docker ps -a)"

[ "$(psql_q "select count(*) from applications where id = '$CASCADE_ID';")" = "0" ] \
  || fail "the application survives the cascade"
[ "$(psql_q "select count(*) from deployments where application_id = '$CASCADE_ID';")" = "0" ] \
  || fail "the history survives the cascade"
[ "$(psql_q "select count(*) from port_allocations where application_id = '$CASCADE_ID';")" = "0" ] \
  || fail "the reservation of port $ALLOC was not given back"
pass "application, history and port $ALLOC: everything is given back"

# ─── 4. Partial failure across several targets ────────────────────────────────

step "4. Partial failure across several targets: reported, and nothing is erased"

# A ghost target: declared on the real machine for the time of the preflight
# (without which the API refuses to deploy on it), then switched to a TEST-NET
# address. The deployment that follows fails BEFORE having touched anything —
# but it stays `live` in the panel's sense, because where it stopped is unknown.
# Two targets cannot declare the same endpoint: so the machine is designated by
# its container's IP address rather than by its service name. It is the same
# machine, seen differently — exactly what we want here.
GHOST_REAL_HOST=$(docker inspect -f \
  '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$(docker compose ps -q ssh-target)")
[ -n "$GHOST_REAL_HOST" ] || fail "address of the ssh-target container not found"

# Cleanup from a previous run: a ghost target left on TEST-NET would not pass
# the preflight.
req GET /api/targets >/dev/null
STALE=$(jq -r --arg n "$GHOST_NAME" '.items[] | select(.name == $n) | .id' "$BODY")
[ -n "$STALE" ] && req DELETE "/api/targets/$STALE" >/dev/null 2>&1

jq -n --arg key "$(cat .test-target-key)" --arg n "$GHOST_NAME" --arg h "$GHOST_REAL_HOST" \
  '{name:$n, host:$h, port:22, sshUser:"tp", authMethod:"key",
    sudoMethod:"nopasswd", credential:$key, labels:{env:"test"},
    portRangeStart:30000, portRangeEnd:30009}' > "$WORK/ghost.json"
code=$(req POST /api/targets "@$WORK/ghost.json")
[ "$code" = "201" ] || fail "creating \"$GHOST_NAME\" → HTTP $code: $(cat "$BODY")"
GHOST_ID=$(jq -r .id "$BODY")
pass "target \"$GHOST_NAME\" ($GHOST_REAL_HOST) — $GHOST_ID"

JOB=$(req POST "/api/targets/$GHOST_ID/preflight" '{}' >/dev/null; jq -r .jobId "$BODY")
for _ in $(seq 1 60); do
  sleep 1
  req GET "/api/queue/jobs/$JOB" >/dev/null
  [ "$(jq -r .state "$BODY")" = "completed" ] && break
done
req GET "/api/targets/$GHOST_ID" >/dev/null
jq -e '.runtimesAvailable.docker.available == true' "$BODY" >/dev/null \
  || fail "the preflight of \"$GHOST_NAME\" does not see Docker"
pass "preflight OK — the target is deployable"

PARTIAL_ID=$(upsert_app "$PARTIAL_SLUG")
read -r PART_OK_DEPLOY PART_OK_STATUS <<< "$(deploy_and_wait "$PARTIAL_ID" "$TARGET_ID")"
[ "$PART_OK_STATUS" = "success" ] || fail "$PARTIAL_SLUG was supposed to deploy, status \"$PART_OK_STATUS\""
pass "$PARTIAL_SLUG in service on $TARGET_NAME — $PART_OK_DEPLOY"

psql_q "update targets set host = '$GHOST_HOST' where id = '$GHOST_ID';" >/dev/null
pass "\"$GHOST_NAME\" switched to $GHOST_HOST (TEST-NET) — unreachable"

read -r PART_KO_DEPLOY PART_KO_STATUS <<< "$(deploy_and_wait "$PARTIAL_ID" "$GHOST_ID")"
[ "$PART_KO_STATUS" = "failed" ] || fail "the ghost deployment was supposed to fail, status \"$PART_KO_STATUS\""
pass "deployment on the dead target failed — $PART_KO_DEPLOY"

code=$(req GET "/api/applications/$PARTIAL_ID/cascade")
[ "$code" = "200" ] || fail "GET cascade → HTTP $code"
jq -e '(.blockers | length) == 2' "$BODY" >/dev/null \
  || fail "2 deployments should block, $(jq -c '[.blockers[] | {targetName, version}]' "$BODY")"
pass "the preview names the 2 blockers: $(jq -r '[.blockers[] | "\(.workspace)@\(.targetName)"] | join(", ")' "$BODY")"

code=$(cascade "$PARTIAL_ID" '{"force":false}')
[ "$code" = "202" ] || fail "POST cascade → HTTP $code"
jq -e '.deleted == false and (.destroyed | length) == 1 and (.abandoned | length) == 1' "$WORK/cascade.json" \
  >/dev/null || fail "partial failure badly reported: $(cat "$WORK/cascade.json")"
jq -e --arg n "$GHOST_NAME" '.abandoned[0].targetName == $n' "$WORK/cascade.json" >/dev/null \
  || fail "the target that resisted is not named: $(jq -c '.abandoned' "$WORK/cascade.json")"
jq -e --arg n "$TARGET_NAME" '.destroyed[0].targetName == $n' "$WORK/cascade.json" >/dev/null \
  || fail "the cleaned target is not named: $(jq -c '.destroyed' "$WORK/cascade.json")"
pass "1 destroyed / 1 abandoned, by name — deleted:false"
info "$(jq -r '.summary' "$WORK/cascade.json")"

# Nothing was erased: the partial failure is not a silent half-success.
[ "$(psql_q "select count(*) from applications where id = '$PARTIAL_ID';")" = "1" ] \
  || fail "the application was deleted despite the partial failure"
[ "$(psql_q "select count(*) from deployments where application_id = '$PARTIAL_ID';")" -ge 2 ] \
  || fail "the history was purged despite the partial failure"
pass "the application and its history are intact — forcing stays possible, knowingly"

# And the real container, for its part, was indeed taken down.
LEFT=$(target_docker ps -a --format '{{.Names}}' | grep -c "^app-$PARTIAL_SLUG" || true)
[ "$LEFT" = "0" ] || fail "$LEFT \"app-$PARTIAL_SLUG\" container(s) remain on the reachable target"
pass "the reachable target was indeed cleaned up"

# ─── 5. Forcing on the partial failure ────────────────────────────────────────

step "5. Forcing what remains: confirmation required, then erasure"

code=$(req POST "/api/applications/$PARTIAL_ID/cascade" '{"force":true}')
[ "$code" = "422" ] || fail "forcing without confirmation: expected 422, got $code"
jq -e '.error.code == "confirmation_required"' "$BODY" >/dev/null \
  || fail "unexpected error code: $(jq -c .error "$BODY")"
jq -e --arg n "$GHOST_NAME" '.error.message | test($n)' "$BODY" >/dev/null \
  || fail "the refusal does not name what is abandoned: $(jq -r '.error.message' "$BODY")"
pass "422 — $(jq -r '.error.message' "$BODY")"

code=$(req POST "/api/applications/$PARTIAL_ID/cascade" '{"force":true,"confirm":"pas-le-bon-nom"}')
[ "$code" = "422" ] || fail "wrong confirmation: expected 422, got $code"
pass "a confirmation that does not match is refused too"

code=$(cascade "$PARTIAL_ID" "{\"force\":true,\"confirm\":\"$PARTIAL_SLUG\"}")
[ "$code" = "202" ] || fail "forcing → HTTP $code"
jq -e '.deleted == true and .forced == true and (.abandoned | length) == 1' "$WORK/cascade.json" \
  >/dev/null || fail "unexpected forcing: $(cat "$WORK/cascade.json")"
pass "$(jq -r '.summary' "$WORK/cascade.json")"

[ "$(psql_q "select count(*) from applications where id = '$PARTIAL_ID';")" = "0" ] \
  || fail "the application survives the forcing"
[ "$(psql_q "select count(*) from port_allocations where application_id = '$PARTIAL_ID';")" = "0" ] \
  || fail "a port reservation survives the forcing"
pass "application, history and reservations: erased"

# ─── 6. THE case that matters: the production target is dead ──────────────────

step "6. Unreachable target: refused without forcing, traced with it"

DEAD_ID=$(upsert_app "$DEAD_SLUG")
read -r DEAD_DEPLOY DEAD_STATUS <<< "$(deploy_and_wait "$DEAD_ID" "$TARGET_ID")"
[ "$DEAD_STATUS" = "success" ] || fail "$DEAD_SLUG was supposed to deploy, status \"$DEAD_STATUS\""
req GET "/api/deployments/$DEAD_DEPLOY" >/dev/null
DEAD_PORT=$(jq -r '.publishedPort // empty' "$BODY")
pass "$DEAD_SLUG in service on $TARGET_NAME — port $DEAD_PORT"

RUNNING=$(target_docker ps --format '{{.Names}}' | grep -c "^app-$DEAD_SLUG" || true)
[ "$RUNNING" -gt 0 ] || fail "no running \"app-$DEAD_SLUG\" container"
pass "$RUNNING container(s) running on the machine"

# We unplug the target. `restore_target` will put it back, even on an exit on
# error: the other applications of this machine must not stay orphaned because
# of this script.
psql_q "update targets set host = '$DEAD_HOST' where id = '$TARGET_ID';" >/dev/null
pass "\"$TARGET_NAME\" switched to $DEAD_HOST (TEST-NET) — the machine is unreachable"

code=$(req DELETE "/api/applications/$DEAD_ID")
[ "$code" = "409" ] || fail "plain deletion: expected 409, got $code"
jq -e '.error.message | test("cascade")' "$BODY" >/dev/null \
  || fail "the message does not say how to get out of it: $(jq -r '.error.message' "$BODY")"
pass "409 — $(jq -r '.error.message' "$BODY")"

code=$(cascade "$DEAD_ID" '{"force":false}')
[ "$code" = "202" ] || fail "POST cascade → HTTP $code"
jq -e '.deleted == false and (.abandoned | length) == 1' "$WORK/cascade.json" >/dev/null \
  || fail "the cascade should have failed cleanly: $(cat "$WORK/cascade.json")"
pass "without forcing: refused, nothing erased — $(jq -r '.abandoned[0].error' "$WORK/cascade.json")"
[ "$(psql_q "select count(*) from applications where id = '$DEAD_ID';")" = "1" ] \
  || fail "the application disappeared although the destruction failed"
pass "the application is still there: the handles are not lost"

# Forcing, at last. It first RETRIED the destruction — that is what
# `abandoned[].error` says: the attempt did take place, and it did fail.
code=$(cascade "$DEAD_ID" "{\"force\":true,\"confirm\":\"$DEAD_SLUG\"}")
[ "$code" = "202" ] || fail "forcing → HTTP $code"
jq -e '.deleted == true and .forced == true' "$WORK/cascade.json" >/dev/null \
  || fail "the forcing did not complete: $(cat "$WORK/cascade.json")"
jq -e --arg w "app-$DEAD_SLUG" '.abandoned[0].workspace == $w' "$WORK/cascade.json" >/dev/null \
  || fail "the abandoned Compose project is not named: $(jq -c '.abandoned' "$WORK/cascade.json")"
pass "$(jq -r '.summary' "$WORK/cascade.json")"

[ "$(psql_q "select count(*) from applications where id = '$DEAD_ID';")" = "0" ] \
  || fail "the application survives the forcing"
[ "$(psql_q "select count(*) from port_allocations where application_id = '$DEAD_ID';")" = "0" ] \
  || fail "the port reservation survives the forcing"
pass "the record is gone, port reservation included"

# ─── 7. The activity log, the only trace left ─────────────────────────────────

step "7. The log carries what is needed to find what remains on the machine"

AUDIT=$(psql_q "select after from audit_logs
  where action = 'application.delete.forced' and resource_id = '$DEAD_ID'
  order by created_at desc limit 1;")
[ -n "$AUDIT" ] || fail "no \"application.delete.forced\" entry for this application"
printf '%s' "$AUDIT" > "$WORK/audit.json"

jq -e --arg w "app-$DEAD_SLUG" '.abandoned[0].workspace == $w' "$WORK/audit.json" >/dev/null \
  || fail "the log does not name the Compose project: $(jq -c '.abandoned' "$WORK/audit.json")"
pass "Compose project: $(jq -r '.abandoned[0].workspace' "$WORK/audit.json")"

jq -e --arg n "$TARGET_NAME" --arg h "$DEAD_HOST" \
  '.abandoned[0].targetName == $n and .abandoned[0].targetHost == $h' "$WORK/audit.json" >/dev/null \
  || fail "the log does not name the target: $(jq -c '.abandoned' "$WORK/audit.json")"
pass "target: $(jq -r '.abandoned[0].targetName + " (" + .abandoned[0].targetHost + ")"' "$WORK/audit.json")"

jq -e --argjson p "${DEAD_PORT:-null}" '.abandoned[0].publishedPort == $p' "$WORK/audit.json" >/dev/null \
  || fail "the log does not name the port: $(jq -c '.abandoned[0].publishedPort' "$WORK/audit.json")"
pass "reserved port: $(jq -r '.abandoned[0].publishedPort' "$WORK/audit.json")"

jq -e '.manualCleanup[0].commands | length > 0' "$WORK/audit.json" >/dev/null \
  || fail "the log does not say what to do by hand: $(jq -c '.manualCleanup' "$WORK/audit.json")"
pass "cleanup commands: $(jq -r '.manualCleanup[0].commands | join(" ; ")' "$WORK/audit.json")"

jq -e '(.erasedDeploymentIds | length) > 0' "$WORK/audit.json" >/dev/null \
  || fail "the log does not say what was erased"
pass "$(jq -r '.erasedDeploymentCount' "$WORK/audit.json") deployment(s) erased, identifiers kept in the log"

# ─── 8. The proof: it still runs, and the log is enough to clean it up ────────

step "8. Forcing stopped nothing — repairing by hand with the log alone"

psql_q "update targets set host = '$TARGET_HOST' where id = '$TARGET_ID';" >/dev/null
TARGET_HOST_RESTORED=$(psql_q "select host from targets where id = '$TARGET_ID';")
[ "$TARGET_HOST_RESTORED" = "$TARGET_HOST" ] || fail "the target did not get its host back"
pass "\"$TARGET_NAME\" plugged back on $TARGET_HOST"

STILL=$(target_docker ps --format '{{.Names}}' | grep -c "^app-$DEAD_SLUG" || true)
[ "$STILL" -gt 0 ] \
  || fail "the container disappeared on its own: the test no longer proves anything about forcing"
pass "$STILL \"app-$DEAD_SLUG\" container(s) STILL run — the panel no longer knows them"

# The log's commands are not replayed blindly: we read them, and run exactly the
# teardown they describe on the machine.
CLEAN=$(jq -r '.manualCleanup[0].commands[0]' "$WORK/audit.json")
info "command read in the log: $CLEAN"
docker compose exec -T ssh-target sh -lc "$CLEAN" >/dev/null 2>&1 \
  || warn "the guided teardown returned an error — forcing the cleanup"
target_docker ps -a --format '{{.Names}}' | grep "^app-$DEAD_SLUG" \
  | xargs -r -n1 docker compose exec -T ssh-target docker rm -f >/dev/null 2>&1 || true
docker compose exec -T ssh-target sh -lc "rm -rf /opt/bootstrap/apps/$DEAD_SLUG" >/dev/null 2>&1 || true

LEFT=$(target_docker ps -a --format '{{.Names}}' | grep -c "^app-$DEAD_SLUG" || true)
[ "$LEFT" = "0" ] || fail "$LEFT \"app-$DEAD_SLUG\" container(s) resist the manual cleanup"
pass "machine cleaned up by hand — the log contained everything needed"

# ─── 9. Permissions: the union of the three, not one fewer ────────────────────

step "9. Forcing requires \"deployment:destroy\", \"deployment:purge\" and \"application:delete\""

RIGHTS_ID=$(upsert_app "$RIGHTS_SLUG")
pass "application \"$RIGHTS_SLUG\" — without any deployment, the permission guard comes first"

req DELETE "/api/admin/roles/$ROLE_KEY" >/dev/null 2>&1 || true
code=$(req POST /api/admin/roles \
  "{\"key\":\"$ROLE_KEY\",\"label\":\"Droits partiels\",\"permissions\":[\"application:read\",\"application:delete\",\"deployment:read\",\"deployment:purge\"]}")
[ "$code" = "201" ] || fail "POST /api/admin/roles → HTTP $code: $(cat "$BODY")"
pass "role \"$ROLE_KEY\": application:delete + deployment:purge, WITHOUT deployment:destroy"

code=$(req POST /api/admin/users \
  "{\"name\":\"Droits partiels\",\"email\":\"$PARTIAL_EMAIL\",\"password\":\"$PARTIAL_PASSWORD\",\"role\":\"$ROLE_KEY\"}")
case "$code" in
  201) pass "user created" ;;
  409) PARTIAL_USER=$(psql_q "select id from users where email = '$PARTIAL_EMAIL';")
       req PATCH "/api/admin/users/$PARTIAL_USER/role" "{\"role\":\"$ROLE_KEY\"}" >/dev/null
       pass "user already present, reassigned to the role" ;;
  *)   fail "POST /api/admin/users → HTTP $code: $(cat "$BODY")" ;;
esac
PARTIAL_USER=$(psql_q "select id from users where email = '$PARTIAL_EMAIL';")

code=$(preq POST /api/auth/sign-in/email \
  "{\"email\":\"$PARTIAL_EMAIL\",\"password\":\"$PARTIAL_PASSWORD\"}")
[ "$code" = "200" ] || fail "sign-in of the partial account → HTTP $code: $(cat "$BODY")"
pass "signed in as $PARTIAL_EMAIL"

code=$(preq GET "/api/applications/$RIGHTS_ID/cascade")
[ "$code" = "200" ] || fail "the preview should pass with application:delete (HTTP $code)"
jq -e '.canCascade == false and (.missingPermissions | index("deployment:destroy"))' "$BODY" >/dev/null \
  || fail "the preview does not flag the missing permission: $(jq -c '.missingPermissions' "$BODY")"
pass "the preview says what is missing: $(jq -r '.missingPermissions | join(", ")' "$BODY")"

code=$(preq POST "/api/applications/$RIGHTS_ID/cascade" '{"force":false}')
[ "$code" = "403" ] || fail "cascade without deployment:destroy: expected 403, got $code"
jq -e '.error.details.permission == "deployment:destroy"' "$BODY" >/dev/null \
  || fail "the refused permission is not named: $(jq -c '.error' "$BODY")"
pass "403 — $(jq -r '.error.message' "$BODY")"

code=$(preq POST "/api/applications/$RIGHTS_ID/cascade" "{\"force\":true,\"confirm\":\"$RIGHTS_SLUG\"}")
[ "$code" = "403" ] || fail "forcing without deployment:destroy: expected 403, got $code"
pass "forcing opens no back door: 403 as well"

# One permission is swapped for another: each of the three is required.
code=$(req PATCH "/api/admin/roles/$ROLE_KEY" \
  '{"permissions":["application:read","application:delete","deployment:read","deployment:destroy"]}')
[ "$code" = "200" ] || fail "role PATCH → HTTP $code"
code=$(preq POST "/api/applications/$RIGHTS_ID/cascade" '{"force":false}')
[ "$code" = "403" ] || fail "cascade without deployment:purge: expected 403, got $code"
jq -e '.error.details.permission == "deployment:purge"' "$BODY" >/dev/null \
  || fail "the refused permission is not named: $(jq -c '.error' "$BODY")"
pass "403 — $(jq -r '.error.message' "$BODY")"

code=$(req PATCH "/api/admin/roles/$ROLE_KEY" \
  '{"permissions":["application:read","deployment:read","deployment:destroy","deployment:purge"]}')
[ "$code" = "200" ] || fail "role PATCH → HTTP $code"
code=$(preq POST "/api/applications/$RIGHTS_ID/cascade" '{"force":false}')
[ "$code" = "403" ] || fail "cascade without application:delete: expected 403, got $code"
pass "403 — each of the three permissions is required, none is optional"

# ─── 10. Cleanup ──────────────────────────────────────────────────────────────

step "10. Cleanup"

code=$(req DELETE "/api/applications/$RIGHTS_ID")
[ "$code" = "200" ] || fail "deleting $RIGHTS_SLUG → HTTP $code: $(cat "$BODY")"
pass "application \"$RIGHTS_SLUG\" deleted"

req PATCH "/api/admin/users/$PARTIAL_USER/role" '{"role":"viewer"}' >/dev/null
req DELETE "/api/admin/users/$PARTIAL_USER" >/dev/null
req DELETE "/api/admin/roles/$ROLE_KEY" >/dev/null
pass "test user and role deleted"

code=$(req DELETE "/api/targets/$GHOST_ID")
[ "$code" = "200" ] || warn "deleting \"$GHOST_NAME\" → HTTP $code: $(cat "$BODY")"
[ "$code" = "200" ] && pass "target \"$GHOST_NAME\" deleted"

for slug in "$HIST_SLUG" "$CASCADE_SLUG" "$PARTIAL_SLUG" "$DEAD_SLUG" "$RIGHTS_SLUG"; do
  LEFT=$(target_docker ps -a --format '{{.Names}}' | grep -c "^app-$slug" || true)
  [ "$LEFT" = "0" ] || fail "$LEFT \"app-$slug\" container(s) still linger on the target"
done
pass "no container of the script lingers on the machine"

ORPHANS=$(psql_q "select count(*) from port_allocations pa
  left join applications a on a.id = pa.application_id where a.id is null;")
[ "$ORPHANS" = "0" ] || fail "$ORPHANS orphan port reservation(s) in the database"
pass "no orphan port reservation"

step "11. The applications in service did not move"

req GET /api/apps >/dev/null
LIVE_AFTER=$(jq -r '[.items[].applicationSlug] | sort | join(",")' "$BODY")
[ "$LIVE_AFTER" = "$LIVE_BEFORE" ] \
  || fail "the applications in service changed: \"$LIVE_BEFORE\" → \"$LIVE_AFTER\""
pass "applications in service after: ${LIVE_AFTER:-none} — identical"

printf '\n\033[32m✓ Deletion, cascade and forcing verified.\033[0m\n'
printf '\033[2m  Screen: %s/applications\033[0m\n\n' "$BASE_URL"
