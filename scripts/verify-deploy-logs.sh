#!/usr/bin/env bash
#
# End-to-end deployment and live logs, through the UI's routes.
#
#   1. Create an application from simple.json
#   2. Deploy it on a Docker target
#   3. See the steps follow one another and the logs scroll live
#   4. Get a URL that answers
#   5. Reconnect during the deployment and find the logs already past
#
# The script takes exactly the same routes as the UI. Prerequisite: a
# deployable Docker target — `./scripts/setup-test-target.sh` provisions one.
#
# Usage:
#   ./scripts/verify-deploy-logs.sh
#   BASE_URL=http://localhost:3100 TARGET_NAME=my-vm ./scripts/verify-deploy-logs.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
TARGET_NAME="${TARGET_NAME:-verification-target}"
SPEC="${SPEC:-packages/core/src/spec/__fixtures__/simple.json}"
CLIENT_IP="${CLIENT_IP:-198.51.100.42}"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
BODY="$WORK/body.json"
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


# Better Auth limits repeated sign-ins from the same IP. The verification
# scripts follow one another: we wait rather than fall back by mistake on the
# sign-up, which would give a misleading message.
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

  # No account: bootstrapping the first administrator.
  code=$(req POST /api/auth/sign-up/email "$@" \
    "{\"name\":\"Admin\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
  [ "$code" = "200" ] || fail "sign-in failed (HTTP $code): $(cat "$BODY")"
  assert_admin
}

# The account must be an administrator. Settling for a successful sign-in would
# let the script fail much further, on a cryptic 403: that is exactly what
# happens when someone already created THEIR account (which becomes admin), and
# the fallback sign-up makes a mere viewer.
assert_admin() {
  local role
  role=$(jq -r '.user.role // empty' "$BODY")
  [ "$role" = "admin" ] && return 0

  printf '  \033[31m✗\033[0m %s\n' "\"$ADMIN_EMAIL\" has the role \"${role:-none}\", not \"admin\"."
  printf '    The first account created on a blank database becomes administrator;\n'
  printf '    the following ones are mere viewers.\n\n'
  printf '    Two ways out:\n'
  printf '      1. rerun with YOUR admin account:\n'
  printf '         ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=... %s\n' "$0"
  printf '      2. or promote "%s" from %s/admin/users\n' "$ADMIN_EMAIL" "$BASE_URL"
  exit 1
}


step "1. Sign-in"
login
pass "signed in as $ADMIN_EMAIL"

step "2. Creating the application from $SPEC"
SLUG=$(jq -r .name "$SPEC")
req GET /api/applications >/dev/null
EXISTING=$(jq -r --arg s "$SLUG" '.items[] | select(.slug == $s) | .id' "$BODY")

if [ -n "$EXISTING" ]; then
  pass "application \"$SLUG\" already present"
  APP_ID="$EXISTING"
else
  jq '{appSpec: .}' "$SPEC" > "$WORK/app.json"
  code=$(req POST /api/applications "@$WORK/app.json")
  [ "$code" = "201" ] || fail "POST /api/applications → HTTP $code: $(cat "$BODY")"
  APP_ID=$(jq -r .id "$BODY")
  pass "application created: $SLUG"
fi
info "$(jq -c '{services: [.services[].name], exposed: [.services[] | select(.exposed) | .name][0]}' "$SPEC")"

step "3. Docker target"
req GET /api/targets >/dev/null
TARGET_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY")
[ -n "$TARGET_ID" ] || fail "target \"$TARGET_NAME\" not found — run ./scripts/setup-test-target.sh"

DOCKER_OK=$(jq -r --arg n "$TARGET_NAME" \
  '.items[] | select(.name == $n) | .runtimesAvailable.docker.available' "$BODY")
[ "$DOCKER_OK" = "true" ] || fail "the target \"$TARGET_NAME\" has no Docker runtime — run a preflight"
pass "$TARGET_NAME — Docker $(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .runtimesAvailable.docker.version' "$BODY")"

step "4. POST /api/deployments — the route must not wait"
BEFORE=$(date +%s)
code=$(req POST /api/deployments \
  "{\"applicationId\":\"$APP_ID\",\"targetId\":\"$TARGET_ID\",\"scanConfig\":{\"scanners\":[],\"failOn\":\"NONE\"},\"runtime\":\"docker\",\"proxy\":\"traefik\"}")
ELAPSED=$(( $(date +%s) - BEFORE ))
[ "$code" = "202" ] || fail "expected 202, got HTTP $code: $(cat "$BODY")"

DEPLOY_ID=$(jq -r .id "$BODY")
STEP_COUNT=$(jq -r '.steps | length' "$BODY")
# The pipeline gained the "scan" step afterwards: the list is authoritative, not
# a number hard-coded here.
EXPECTED_STEPS=$(grep -c "^  { key: '" packages/core/src/pipeline.ts)
[ "$STEP_COUNT" = "$EXPECTED_STEPS" ] \
  || fail "expected $EXPECTED_STEPS steps created right away, got $STEP_COUNT"
jq -e '[.steps[] | select(.status != "pending")] | length == 0' "$BODY" >/dev/null \
  || fail "every step must be born \"pending\""

pass "202 in ${ELAPSED}s — $DEPLOY_ID"
pass "the $EXPECTED_STEPS steps already exist, all \"pending\""
info "$(jq -rc '[.steps[].key] | join(" → ")' "$BODY")"

step "5. Live SSE stream"
curl -sN --max-time 300 -b "$JAR" "$BASE_URL/api/deployments/$DEPLOY_ID/logs" > "$WORK/live.sse" &
LIVE_PID=$!

# A second client connects along the way: it is the page refresh.
sleep 5
curl -sN --max-time 300 -b "$JAR" "$BASE_URL/api/deployments/$DEPLOY_ID/logs" > "$WORK/refresh.sse" &
REFRESH_PID=$!

wait "$LIVE_PID" || true
wait "$REFRESH_PID" || true

events() { grep -A1 '^event: event' "$1" | grep '^data:' | sed 's/^data: //'; }
logs()   { grep -A1 '^event: log'   "$1" | grep '^data:' | sed 's/^data: //'; }

LIVE_LOGS=$(logs "$WORK/live.sse" | wc -l | tr -d ' ')
[ "$LIVE_LOGS" -gt 0 ] || fail "no log line received live"
pass "$LIVE_LOGS line(s) received live"

for key in preflight allocate_port render upload build scan deploy healthcheck proxy rollback; do
  status=$(events "$WORK/live.sse" | jq -rc --arg k "$key" \
    'select(.type == "step" and .key == $k) | .status' | tail -1)
  [ -n "$status" ] || fail "no event for the \"$key\" step"
  printf '    \033[2m%-14s → %s\033[0m\n' "$key" "$status"
done
pass "the $EXPECTED_STEPS steps emitted their state change"

# `allocate_port` and `proxy` do not depend on the worker: the driver decides.
jq -e 'select(.type == "step" and .key == "build") | .status == "skipped"' \
  <<< "$(events "$WORK/live.sse" | jq -c 'select(.type=="step" and .key=="build")' | tail -1)" >/dev/null \
  || info "build: not skipped (the AppSpec contains a service to build)"

FINAL=$(events "$WORK/live.sse" | jq -rc 'select(.type == "deployment") | .status' | tail -1)
[ "$FINAL" = "success" ] || fail "deployment ended as \"$FINAL\": $(logs "$WORK/live.sse" | jq -rc '.line' | tail -5)"
pass "deployment ended as \"success\""

step "6. Refresh along the way: the past logs are found"
REFRESH_LOGS=$(logs "$WORK/refresh.sse" | wc -l | tr -d ' ')
[ "$REFRESH_LOGS" -gt 0 ] || fail "the reconnected client received nothing"

# The preflight took place before this client connected: it must still see it,
# replayed from deployment_steps.log.
logs "$WORK/refresh.sse" | jq -rc 'select(.step == "preflight") | .line' | grep -q . \
  || fail "the logs from before the connection are missing — there is a gap"
pass "$REFRESH_LOGS line(s), including those from before the connection"
info "first replayed line: $(logs "$WORK/refresh.sse" | jq -rc '.line' | head -1)"

# The seam between replay and live must neither lose nor duplicate: the
# reconnected client must receive exactly what the first one saw.
LIVE_SET=$(logs "$WORK/live.sse" | jq -rc '"\(.ts)|\(.step)|\(.line)"' | sort)
REFRESH_SET=$(logs "$WORK/refresh.sse" | jq -rc '"\(.ts)|\(.step)|\(.line)"' | sort)
if [ "$LIVE_SET" != "$REFRESH_SET" ]; then
  printf '    \033[2mmissing for the reconnected client:\033[0m\n'
  comm -23 <(printf '%s\n' "$LIVE_SET") <(printf '%s\n' "$REFRESH_SET") | head -5
  printf '    \033[2mextra for the reconnected client:\033[0m\n'
  comm -13 <(printf '%s\n' "$LIVE_SET") <(printf '%s\n' "$REFRESH_SET") | head -5
  fail "the history/live seam loses or duplicates lines"
fi
pass "the reconnected client received exactly the same lines, neither loss nor duplicate"

step "7. The URL answers"
code=$(req GET "/api/deployments/$DEPLOY_ID")
[ "$code" = "200" ] || fail "GET /api/deployments/$DEPLOY_ID → HTTP $code"

URL=$(jq -r '.url // empty' "$BODY")
PORT=$(jq -r '.publishedPort // empty' "$BODY")
[ -n "$URL" ] || fail "the deployment produced no URL"
pass "URL: $URL (port $PORT)"

jq -e '[.steps[] | select(.status == "success")] | length >= 6' "$BODY" >/dev/null \
  || fail "too few successful steps: $(jq -c '[.steps[] | {key, status}]' "$BODY")"
jq -e '[.steps[] | select(.log | length > 0)] | length >= 5' "$BODY" >/dev/null \
  || fail "the logs are not persisted in deployment_steps.log"
pass "logs persisted in deployment_steps.log"

# The URL carries the host name seen by the worker. From this script, we go
# through the port published on the local machine — it is the same container
# at the end.
PROBE="${PROBE_URL:-http://127.0.0.1:$PORT}"
http=$(curl -s -o "$WORK/page.html" -w '%{http_code}' --max-time 15 "$PROBE" || echo 000)
[ "$http" = "200" ] || fail "$PROBE → HTTP $http"
pass "$PROBE → HTTP 200"
info "$(head -c 60 "$WORK/page.html" | tr -d '\n')"

step "8. Traceability"
code=$(req GET "/api/audit-logs?resourceType=deployment&pageSize=20")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
for action in deployment.created deployment.succeeded; do
  jq -e --arg a "$action" --arg id "$DEPLOY_ID" \
    '[.items[] | select(.action == $a and .resourceId == $id)] | length > 0' "$BODY" >/dev/null \
    || fail "action \"$action\" missing from the audit log"
  pass "audit: $action"
done

printf '\n\033[32m✓ Deployment and live logs verified.\033[0m\n'
printf '\033[2m  Follow-up: %s/deployments/%s\033[0m\n' "$BASE_URL" "$DEPLOY_ID"
printf '\n'
