#!/usr/bin/env bash
#
# Checks the supervision of deployed applications:
#
#   1. the list only shows what really runs
#   2. the SSE stream brings up a services state
#   3. it brings up log lines, attributed to the right service
#   4. it HOLDS over time (the timeout guards trap)
#   5. the restart goes through the queue and publishes its life cycle
#   6. a failed deployment cannot be supervised
#   7. the action is traced in the audit log
#   8. an application whose LAST UPDATE FAILED stays listed, with a state that
#      says so — it still runs, in its previous version
#
# Usage:
#   ./scripts/verify-supervision.sh
#   BASE_URL=http://localhost:3200 ./scripts/verify-supervision.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
CLIENT_IP="${CLIENT_IP:-198.51.100.42}"
TARGET_NAME="${TARGET_NAME:-cible-de-verification}"
# The script's own material: it touches no application already running.
FAILED_UPDATE_SLUG="${FAILED_UPDATE_SLUG:-supervision-maj-ratee}"
IMAGE_OK="${IMAGE_OK:-docker.io/library/nginx:1.29-alpine}"
IMAGE_KO="${IMAGE_KO:-docker.io/library/httpd:2.4-alpine}"

# Beyond the SSH guard's default (30 s): it is precisely the duration that
# revealed that the log following was cut by a timeout it should not undergo.
# Do not go below.
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

# Extracts the data of a given SSE event type.
events() { grep -A1 "^event: $1\$" "$SSE" | grep '^data:' | sed 's/^data: //'; }

# ─── helpers of the "last update failed" scenario ─────────────────────────────

# Healthy AppSpec: an exposed service, an image, a health route.
spec_ok() {
  jq -n --arg n "$1" --arg v "$2" --arg i "$IMAGE_OK" \
    '{name:$n, version:$v, services:[{
        name:"web", source:{type:"image", ref:$i}, port:80, exposed:true,
        healthcheck:{path:"/", intervalSec:2, timeoutSec:3, retries:4}
      }]}'
}

# AppSpec whose PIPELINE probe fails while the container is fine. Same recipe
# as verify-ports-rollback.sh: the service listens on 80, the driver publishes
# 8080, and nobody listens behind it. So the faulty step is `healthcheck`, after
# `deploy` replaced the containers — the exact case that made the application
# disappear from this screen.
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
    [ "$code" = "200" ] || fail "PATCH /api/applications/$id → HTTP $code: $(cat "$BODY")"
    printf '%s' "$id"
    return
  fi

  jq -n --argjson spec "$spec" '{appSpec:$spec}' > "$WORK/create.json"
  code=$(req POST /api/applications "@$WORK/create.json")
  [ "$code" = "201" ] || fail "POST /api/applications → HTTP $code: $(cat "$BODY")"
  jq -r .id "$BODY"
}

# Deploys and waits for the verdict. Echoes: "<deploymentId> <status>".
# `autoRollback:false`: we want an outright `failed`, not a `rolled_back`.
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

step "1. Sign-in"
login
pass "signed in as $ADMIN_EMAIL"

step "2. The supervised applications"
code=$(req GET /api/apps)
[ "$code" = "200" ] || fail "GET /api/apps → HTTP $code: $(cat "$BODY")"

COUNT=$(jq -r '.items | length' "$BODY")
[ "$COUNT" -ge 1 ] || fail "no running application — deploy one first"
pass "$COUNT supervised application(s)"

# Only "success" and "rolled_back" represent something that runs.
jq -e '[.items[] | select(.status != "success" and .status != "rolled_back")] | length == 0' \
  "$BODY" >/dev/null || fail "the list contains a deployment that does not run"
pass "the list only contains running deployments"

# Starting snapshot: at the end of the script, it must be identical. The
# identity of a supervised row is the application+target PAIR, not the name
# alone: the same application can run on two machines, and two "demo-api" rows
# are then not a duplicate but two distinct deployments. Comparing the names
# alone would make this normal case pass for a leak.
live_pairs() { jq -r '[.items[] | "\(.applicationSlug)@\(.targetName)"] | sort | join(", ")' "$BODY"; }

LIVE_BEFORE=$(live_pairs)

APP_ID=$(jq -r '.items[0].id' "$BODY")
APP_SLUG=$(jq -r '.items[0].applicationSlug' "$BODY")
APP_URL=$(jq -r '.items[0].url // empty' "$BODY")
info "subject: \"$APP_SLUG\" ($APP_ID)"

step "3. Live log stream (${STREAM_SECONDS} s)"
# Some traffic, so that the application has something to say.
if [ -n "$APP_URL" ]; then
  ( sleep 4; for _ in $(seq 1 30); do curl -s -o /dev/null --max-time 2 "$APP_URL/" || true; done ) &
fi

curl -sN --max-time "$STREAM_SECONDS" -b "$JAR" "$BASE_URL/api/apps/$APP_ID/logs" > "$SSE" || true
wait 2>/dev/null || true

grep -q '^event: ready' "$SSE" || fail "the stream did not open: $(head -c 300 "$SSE")"
pass "stream open"

if grep -q '^event: error' "$SSE"; then
  fail "the stream reported an error: $(events error | head -1)"
fi

events status | tail -1 > "$WORK/status.json"
[ -s "$WORK/status.json" ] || fail "no services state brought up"
SERVICES=$(jq -r '[.services[].name] | join(", ")' "$WORK/status.json")
[ -n "$SERVICES" ] || fail "the state contains no service"
pass "services state: $SERVICES"

LINES=$(grep -c '^event: log' "$SSE" || true)
[ "$LINES" -ge 1 ] || fail "no log line received"
pass "$LINES log line(s) received"

step "4. The stream holds over time"
# The trap: a timeout guard on the SSH side cut "logs -f" after 30 s. A
# "stream.stopped" before the end of the test means the cut came back.
if events lifecycle | jq -e 'select(.action == "stream.stopped")' >/dev/null 2>&1; then
  DETAIL=$(events lifecycle | jq -r 'select(.action == "stream.stopped") | .detail')
  fail "the stream cut itself off before ${STREAM_SECONDS} s ($DETAIL)"
fi
pass "no premature cut over ${STREAM_SECONDS} s"

step "5. The service names match"
# Compose prefixes with the CONTAINER name ("api-1"), the state reports the
# SERVICE name ("api"). If they diverge, the interface's per-service filter
# never finds anything — a silent outage.
events log | jq -r '.service // empty' | sort -u > "$WORK/vus.txt"
jq -r '.services[].name' "$WORK/status.json" | sort -u > "$WORK/connus.txt"

if [ -s "$WORK/vus.txt" ]; then
  INTRUS=$(comm -23 "$WORK/vus.txt" "$WORK/connus.txt" || true)
  [ -z "$INTRUS" ] || fail "service unknown to the state in the logs: $(echo "$INTRUS" | tr '\n' ' ')"
  pass "all the services seen in the logs exist in the state"
else
  info "no prefixed line — nothing to cross-check"
fi

step "6. Restart"
code=$(req POST "/api/apps/$APP_ID/restart")
[ "$code" = "202" ] || [ "$code" = "200" ] || fail "POST restart → HTTP $code: $(cat "$BODY")"
JOB=$(jq -r '.jobId // "?"' "$BODY")
pass "restart queued (job $JOB) — the route does not do the work itself"

# The life cycle is published on the stream: we reopen it to observe it.
curl -sN --max-time 40 -b "$JAR" "$BASE_URL/api/apps/$APP_ID/logs" > "$SSE" || true

if events lifecycle | jq -e 'select(.action == "restart" and .done == true)' \
     >/dev/null 2>&1; then
  pass "life cycle observed: $(events lifecycle | jq -r 'select(.action == "restart") | .detail' | tail -1)"
else
  info "the restart ended before the stream reopened — checking the state"
  events status | tail -1 | jq -e '[.services[] | select(.state == "running")] | length >= 1' \
    >/dev/null || fail "no service running after the restart"
  pass "the services run after the restart"
fi

step "7. A deployment that does not run cannot be supervised"
code=$(req GET "/api/deployments?status=failed&pageSize=1")
DEAD=""
[ "$code" = "200" ] && DEAD=$(jq -r '.items[0].id // empty' "$BODY" 2>/dev/null || true)
if [ -n "$DEAD" ]; then
  code=$(curl -s -o "$BODY" -w '%{http_code}' -b "$JAR" "$BASE_URL/api/apps/$DEAD/logs")
  [ "$code" = "409" ] || fail "failed deployment: expected 409, got $code"
  pass "stream refused on a failed deployment → 409"
else
  info "no failed deployment at hand — case not exercised"
fi

step "8. Traceability"
code=$(req GET "/api/audit-logs?resourceType=deployment&pageSize=30")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
jq -e '[.items[] | select(.action == "app.restart.requested")] | length > 0' "$BODY" >/dev/null \
  || fail "action \"app.restart.requested\" missing from the audit log"
pass "audit: app.restart.requested"

# ─── 9. A failed update does not make the application disappear ───────────────
#
# The fixed defect: the screen only kept the LAST deployment of the
# (application, target) pair, and only if it was `success` or `rolled_back`. As
# soon as a deployment failed behind a version in service, the application left
# the list — although its containers were still running.

step "9. An application whose last update failed stays listed"

req GET /api/targets >/dev/null
TARGET_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY")
[ -n "$TARGET_ID" ] || fail "target \"$TARGET_NAME\" not found — run ./scripts/setup-test-target.sh"
info "target $TARGET_NAME — $TARGET_ID"

MAJ_APP=$(upsert_app "$FAILED_UPDATE_SLUG" "$(spec_ok "$FAILED_UPDATE_SLUG" 1.0.0)")
read -r MAJ_V1 MAJ_S1 <<< "$(deploy_and_wait "$MAJ_APP" "$TARGET_ID")"
[ "$MAJ_S1" = "success" ] || fail "the v1 was supposed to succeed, status \"$MAJ_S1\""
pass "v1 of \"$FAILED_UPDATE_SLUG\" in service — $MAJ_V1"

req GET /api/apps >/dev/null
jq -e --arg s "$FAILED_UPDATE_SLUG" '[.items[] | select(.applicationSlug == $s)] | length == 1' \
  "$BODY" >/dev/null || fail "\"$FAILED_UPDATE_SLUG\" does not appear in /api/apps after the v1"
pass "it is listed in /api/apps"

upsert_app "$FAILED_UPDATE_SLUG" "$(spec_ko "$FAILED_UPDATE_SLUG" 2.0.0)" >/dev/null
read -r MAJ_V2 MAJ_S2 <<< "$(deploy_and_wait "$MAJ_APP" "$TARGET_ID")"
[ "$MAJ_S2" = "failed" ] || fail "the v2 was supposed to fail outright, status \"$MAJ_S2\""
req GET "/api/deployments/$MAJ_V2" >/dev/null
jq -e '.failedStep == "healthcheck"' "$BODY" >/dev/null \
  || fail "the failure was supposed to be on \"healthcheck\", not \"$(jq -r .failedStep "$BODY")\""
pass "v2 failed at the healthcheck step — $MAJ_V2"

# THE test: the application is still there.
req GET /api/apps >/dev/null
jq -e --arg s "$FAILED_UPDATE_SLUG" '[.items[] | select(.applicationSlug == $s)] | length == 1' \
  "$BODY" >/dev/null \
  || fail "\"$FAILED_UPDATE_SLUG\" disappeared from /api/apps after a failed deployment — that is the defect"
pass "it is STILL listed after the failed deployment"

# And it is indeed the v1 that is presented as in service: it is the one
# running, and the only identifier on which logs and restart make sense.
jq -e --arg s "$FAILED_UPDATE_SLUG" --arg id "$MAJ_V1" \
  '[.items[] | select(.applicationSlug == $s)][0] | .id == $id and .status == "success"' \
  "$BODY" >/dev/null || fail "the row does not carry the v1 in service: $(jq -c --arg s "$FAILED_UPDATE_SLUG" '[.items[]|select(.applicationSlug==$s)][0]|{id,status}' "$BODY")"
pass "the row carries the v1 in service, not the failed v2"

# The state says it outright rather than keeping quiet about it.
jq -e --arg s "$FAILED_UPDATE_SLUG" --arg id "$MAJ_V2" \
  '[.items[] | select(.applicationSlug == $s)][0].lastFailedUpdate
     | . != null and .deploymentId == $id and .failedStep == "healthcheck"
       and .mayHaveReplacedServices == true' \
  "$BODY" >/dev/null \
  || fail "the state does not flag the failed update: $(jq -c --arg s "$FAILED_UPDATE_SLUG" '[.items[]|select(.applicationSlug==$s)][0].lastFailedUpdate' "$BODY")"
pass "the state carries \"last update failed\" — v2, healthcheck step"

# The application logs stay reachable on the version in service.
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" --max-time 8 \
  "$BASE_URL/api/apps/$MAJ_V1/logs" || true)
[ "$code" = "200" ] || fail "the log stream of the v1 in service should open (HTTP $code)"
pass "the log stream of the version in service still opens"

step "10. Cleanup"
destroy_and_wait "$MAJ_V1"
pass "test deployment destroyed on the target"
code=$(req DELETE "/api/deployments/$MAJ_V2/purge")
[ "$code" = "200" ] || info "purge of the failed v2 → HTTP $code: $(jq -r '.error.message // ""' "$BODY")"
code=$(req DELETE "/api/deployments/$MAJ_V1/purge")
[ "$code" = "200" ] || info "purge of the destroyed v1 → HTTP $code: $(jq -r '.error.message // ""' "$BODY")"
code=$(req DELETE "/api/applications/$MAJ_APP")
[ "$code" = "200" ] || info "deleting $FAILED_UPDATE_SLUG → HTTP $code: $(cat "$BODY")"
pass "test application deleted"

req GET /api/apps >/dev/null
LIVE_AFTER=$(live_pairs)
[ "$LIVE_AFTER" = "$LIVE_BEFORE" ] \
  || fail "the running applications changed: \"$LIVE_BEFORE\" → \"$LIVE_AFTER\""
pass "the applications really running are intact: ${LIVE_AFTER:-none}"

printf '\n\033[32m✓ Supervision verified.\033[0m\n'
printf '\033[2m  Screen: %s/apps\033[0m\n\n' "$BASE_URL"
