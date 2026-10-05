#!/usr/bin/env bash
#
# Checks the purge of the deployments' history.
#
# Purging is NOT destroying: `DELETE /api/deployments/:id` takes the application
# down on the target machine, the purge only erases the trace in the database.
# This script proves that the two gestures stay distinct and that the safeguard
# holds:
#
#   1. the preview (dryRun) announces an exact count
#   2. a historical run is purged — steps and logs go with it
#   3. a RUNNING application refuses to be purged → 409
#   4. the purged run's audit entries are still there
#   5. an orphan port reservation is given back to the target
#   6. `deployment:purge` is required — a viewer gets a 403
#   7. a version in service whose LAST UPDATE FAILED still refuses the purge →
#      409, while the failed deployment, for its part, is purged
#
# The script creates its own material ("purge-verif" application): it touches
# no application already running. The live applications are only called upon in
# preview, which writes nothing.
#
# Usage:
#   ./scripts/verify-purge.sh
#   BASE_URL=http://localhost:3200 TARGET_NAME=my-vm ./scripts/verify-purge.sh
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
# Second set of material, for the "failed update" scenario (§ 9).
MAJ_SLUG="${MAJ_SLUG:-purge-maj-ratee}"
IMAGE_KO="${IMAGE_KO:-docker.io/library/httpd:2.4-alpine}"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
VJAR="$WORK/viewer.jar"
BODY="$WORK/body.json"
trap 'rm -rf "$WORK"' EXIT

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

# Same thing, with the viewer's cookie jar.
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

# AppSpec whose PIPELINE probe fails while the container is fine. Same recipe
# as verify-ports-rollback.sh: the service listens on 80, the driver publishes
# 8080, nobody listens behind it. So the faulty step is `healthcheck`, after
# `deploy` replaced the containers.
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

# ─── 1. Context ───────────────────────────────────────────────────────────────

step "1. Sign-in and target"
login
pass "signed in as $ADMIN_EMAIL"

req GET /api/targets >/dev/null
TARGET_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY")
[ -n "$TARGET_ID" ] || fail "target \"$TARGET_NAME\" not found — run ./scripts/setup-test-target.sh"
pass "target $TARGET_NAME — $TARGET_ID"

# Applications running BEFORE the script's pass: they must be strictly
# identical at the end.
req GET /api/apps >/dev/null
LIVE_BEFORE=$(jq -r '[.items[].applicationSlug] | sort | join(",")' "$BODY")
[ -n "$LIVE_BEFORE" ] || warn "no running application: the 409 test will rely on the script's own"
pass "applications running before the purge: ${LIVE_BEFORE:-none}"

# ─── 2. Test material ─────────────────────────────────────────────────────────

step "2. Two runs of \"$APP_SLUG\" — a historical v1, a v2 in service"
APP_ID=$(upsert_app "$APP_SLUG" "$(spec_json "$APP_SLUG" 1.0.0)")
pass "application $APP_SLUG — $APP_ID"

read -r DEPLOY_V1 STATUS_V1 <<< "$(deploy_and_wait "$APP_ID" "$TARGET_ID")"
[ "$STATUS_V1" = "success" ] || fail "the v1 was supposed to succeed, status \"$STATUS_V1\""
req GET "/api/deployments/$DEPLOY_V1" >/dev/null
PORT_V1=$(jq -r '.publishedPort // empty' "$BODY")
pass "v1 deployed — $DEPLOY_V1, port $PORT_V1"

read -r DEPLOY_V2 STATUS_V2 <<< "$(deploy_and_wait "$APP_ID" "$TARGET_ID")"
[ "$STATUS_V2" = "success" ] || fail "the v2 was supposed to succeed, status \"$STATUS_V2\""
pass "v2 deployed — $DEPLOY_V2: it is the one in service"

STEPS_V1=$(psql_q "select count(*) from deployment_steps where deployment_id = '$DEPLOY_V1';")
[ "$STEPS_V1" -gt 0 ] || fail "the v1 has no step in the database"
pass "the v1 carries $STEPS_V1 steps in the database"

# ─── 3. Preview ───────────────────────────────────────────────────────────────

step "3. The preview announces an exact count"

code=$(req POST /api/deployments/purge "{\"ids\":[\"$DEPLOY_V1\"],\"dryRun\":true}")
[ "$code" = "200" ] || fail "POST /api/deployments/purge (dryRun) → HTTP $code: $(cat "$BODY")"
jq -e '.matched == 1 and .purgedCount == 1 and .refusedCount == 0 and .dryRun == true' "$BODY" \
  >/dev/null || fail "unexpected preview: $(jq -c '{matched,purgedCount,refusedCount}' "$BODY")"
pass "1 run aimed at, 1 purgeable, 0 refused — $(jq -c '.purgedByStatus' "$BODY")"

# Nothing moved: a preview does not purge.
still=$(psql_q "select count(*) from deployments where id = '$DEPLOY_V1';")
[ "$still" = "1" ] || fail "the preview erased the deployment"
pass "after the preview, the v1 is still in the database"

# Count per filter, set against SQL: it is the "exact count" test.
SQL_FAILED=$(psql_q "select count(*) from deployments where status = 'failed';")
code=$(req POST /api/deployments/purge '{"statuses":["failed"],"dryRun":true}')
[ "$code" = "200" ] || fail "POST purge statuses=failed → HTTP $code: $(cat "$BODY")"
API_FAILED=$(jq -r '.matched' "$BODY")
[ "$API_FAILED" = "$SQL_FAILED" ] \
  || fail "wrong count: the API announces $API_FAILED failed runs, SQL counts $SQL_FAILED"
pass "filter by \"failed\" status: $API_FAILED announced, $SQL_FAILED in the database — identical"

# Age: nothing is ten years old.
code=$(req POST /api/deployments/purge '{"olderThanDays":3650,"dryRun":true}')
[ "$code" = "200" ] || fail "POST purge olderThanDays → HTTP $code: $(cat "$BODY")"
jq -e '.matched == 0 and .purgedCount == 0' "$BODY" >/dev/null \
  || fail "\"older than 3650 days\" should aim at nothing: $(jq -c '{matched}' "$BODY")"
pass "filter \"older than 3650 days\" → 0 runs"

# An empty filter would aim at the whole history: it is refused.
code=$(req POST /api/deployments/purge '{"dryRun":true}')
[ "$code" = "422" ] || fail "an empty filter should be refused (HTTP $code)"
pass "empty filter refused → 422"

# ─── 4. THE test: a running application is not purged ─────────────────────────

step "4. A RUNNING application refuses to be purged → 409"

code=$(req DELETE "/api/deployments/$DEPLOY_V2/purge")
[ "$code" = "409" ] || fail "purge of the v2 in service: expected 409, got $code — $(cat "$BODY")"
jq -e '.error.message | test("Détruisez-la d.abord|Destroy it first")' "$BODY" >/dev/null \
  || fail "the message does not say what to do: $(jq -r '.error.message' "$BODY")"
pass "409 — $(jq -r '.error.message' "$BODY")"

# It is still there, and still running.
psql_q "select count(*) from deployments where id = '$DEPLOY_V2';" | grep -q '^1$' \
  || fail "the v2 disappeared despite the refusal"
pass "the v2 is intact in the database"

# In bulk: the mix of purgeable + in service must be reported honestly.
code=$(req POST /api/deployments/purge \
  "{\"ids\":[\"$DEPLOY_V1\",\"$DEPLOY_V2\"],\"dryRun\":true}")
[ "$code" = "200" ] || fail "POST purge (mixed) → HTTP $code"
jq -e '.matched == 2 and .purgedCount == 1 and .refusedCount == 1' "$BODY" >/dev/null \
  || fail "wrong mixed count: $(jq -c '{matched,purgedCount,refusedCount}' "$BODY")"
jq -e '.refused[0].reason == "live"' "$BODY" >/dev/null \
  || fail "unexpected refusal reason: $(jq -c '.refused' "$BODY")"
pass "2 aimed at → 1 purgeable, 1 refused (reason \"live\"): the counter does not lie"

# The applications already running before the script: same rules, in preview
# only — nothing is written.
req GET /api/apps >/dev/null
jq -r '.items[].id' "$BODY" > "$WORK/live-ids.txt"
LIVE_IDS=$(jq -c '[.items[].id]' "$BODY")
LIVE_N=$(jq -r 'length' <<< "$LIVE_IDS")
if [ "$LIVE_N" -gt 0 ]; then
  code=$(req POST /api/deployments/purge "{\"ids\":$LIVE_IDS,\"dryRun\":true}")
  [ "$code" = "200" ] || fail "POST purge (running apps, dryRun) → HTTP $code"
  jq -e --argjson n "$LIVE_N" '.purgedCount == 0 and .refusedCount == $n' "$BODY" >/dev/null \
    || fail "running applications would be purged: $(jq -c '{purgedCount,refusedCount}' "$BODY")"
  pass "the $LIVE_N running applications are all refused"
  info "$(jq -r '[.refused[] | "\(.applicationSlug) v\(.version) → \(.reason)"] | join("  ")' "$BODY")"
fi

# ─── 5. Purging a historical run ──────────────────────────────────────────────

step "5. A historical run is purged — steps and logs go with it"

AUDIT_BEFORE=$(psql_q "select count(*) from audit_logs where resource_id = '$DEPLOY_V1';")
[ "$AUDIT_BEFORE" -gt 0 ] || fail "no audit entry for the v1: the audit test would be empty"
info "$AUDIT_BEFORE audit entry(ies) for the v1 before the purge"

code=$(req DELETE "/api/deployments/$DEPLOY_V1/purge")
[ "$code" = "200" ] || fail "DELETE /api/deployments/$DEPLOY_V1/purge → HTTP $code: $(cat "$BODY")"
pass "v1 purged — $(jq -c '{purged, releasedPorts, rollbackTargetsLost}' "$BODY")"

[ "$(psql_q "select count(*) from deployments where id = '$DEPLOY_V1';")" = "0" ] \
  || fail "the v1 is still in the database"
pass "the deployment row disappeared"

[ "$(psql_q "select count(*) from deployment_steps where deployment_id = '$DEPLOY_V1';")" = "0" ] \
  || fail "the v1's steps survived the purge"
pass "the $STEPS_V1 steps (and their logs) went in cascade"

[ "$(psql_q "select count(*) from scan_runs where deployment_id = '$DEPLOY_V1';")" = "0" ] \
  || fail "scan_runs of the v1 survived"
pass "no orphan scan_run"

# The v2 still runs: its port reservation must above all not move.
ALLOC=$(psql_q "select count(*) from port_allocations where target_id = '$TARGET_ID' and application_id = '$APP_ID';")
[ "$ALLOC" = "1" ] || fail "purging the v1 took away the port reservation of the v2 in service"
pass "the port reservation of $APP_SLUG is intact — the v2 still runs"

http=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://127.0.0.1:$PORT_V1" || echo 000)
[ "$http" = "200" ] || warn "http://127.0.0.1:$PORT_V1 → HTTP $http (port not published outside the target?)"
[ "$http" = "200" ] && pass "the application still answers on $PORT_V1"

# ─── 6. The audit outlives what it describes ──────────────────────────────────

step "6. The purged run's audit entries are still there"

AUDIT_AFTER=$(psql_q "select count(*) from audit_logs where resource_id = '$DEPLOY_V1';")
[ "$AUDIT_AFTER" -ge "$AUDIT_BEFORE" ] \
  || fail "audit entries disappeared with the deployment ($AUDIT_BEFORE → $AUDIT_AFTER)"
pass "$AUDIT_AFTER audit entry(ies) for a deployment that no longer exists"
info "$(psql_q "select string_agg(distinct action, ', ') from audit_logs where resource_id = '$DEPLOY_V1';")"

psql_q "select count(*) from audit_logs where action = 'deployment.purged' and resource_id = '$DEPLOY_V1';" \
  | grep -q '^1$' || fail "the purge itself is not logged"
pass "the purge left its own \"deployment.purged\" entry"
info "$(psql_q "select after::text from audit_logs where action = 'deployment.purged' and resource_id = '$DEPLOY_V1';" | head -c 300)"

# ─── 7. Orphan port reservation ───────────────────────────────────────────────

step "7. The purge gives back an orphan port reservation"

destroy_and_wait "$DEPLOY_V2"
pass "v2 destroyed on the target — the application no longer runs"

# The destroy already releases the reservation. We set one again by hand to
# prove the only point the purge must guarantee: if a reservation survives the
# last deployment of a pair (worker crash, destroy never played), it is the
# purge that gives it back. Without this row, the test would pass without
# demonstrating anything.
psql_q "insert into port_allocations (target_id, port, application_id)
        values ('$TARGET_ID', $PORT_V1, '$APP_ID')
        on conflict do nothing;" >/dev/null
ORPHAN=$(psql_q "select count(*) from port_allocations where target_id = '$TARGET_ID' and application_id = '$APP_ID';")
[ "$ORPHAN" = "1" ] || fail "could not set the orphan reservation again (port $PORT_V1 already taken?)"
pass "orphan reservation set again: port $PORT_V1 for $APP_SLUG"

code=$(req DELETE "/api/deployments/$DEPLOY_V2/purge")
[ "$code" = "200" ] || fail "purge of the destroyed v2 → HTTP $code: $(cat "$BODY")"
jq -e --argjson p "$PORT_V1" '[.releasedPorts[].port] | index($p) != null' "$BODY" >/dev/null \
  || fail "the purge does not announce the release of port $PORT_V1: $(jq -c '.releasedPorts' "$BODY")"
pass "the purge announces the port given back — $(jq -c '.releasedPorts' "$BODY")"

[ "$(psql_q "select count(*) from port_allocations where target_id = '$TARGET_ID' and application_id = '$APP_ID';")" = "0" ] \
  || fail "port $PORT_V1 stays reserved after the purge of the last deployment"
pass "no reservation left in the database for $APP_SLUG — the port can be allocated again"

req GET "/api/targets/$TARGET_ID/ports" >/dev/null
jq -e --arg s "$APP_SLUG" '[.allocations[] | select(.applicationSlug == $s)] | length == 0' "$BODY" \
  >/dev/null || fail "GET /ports still shows a reservation for $APP_SLUG"
pass "GET /api/targets/:id/ports confirms it"

# ─── 8. Permission ────────────────────────────────────────────────────────────

step "8. \"deployment:purge\" is required"

code=$(req POST /api/admin/users \
  "{\"name\":\"Viewer purge\",\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\",\"role\":\"viewer\"}")
case "$code" in
  201) pass "viewer user created" ;;
  409) pass "viewer user already present" ;;
  *)   fail "POST /api/admin/users → HTTP $code: $(cat "$BODY")" ;;
esac
VIEWER_ID=$(psql_q "select id from users where email = '$VIEWER_EMAIL';")

for _ in 1 2 3 4 5; do
  code=$(vreq POST /api/auth/sign-in/email \
    "{\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\"}")
  [ "$code" = "429" ] || break
  sleep 6
done
[ "$code" = "200" ] || fail "viewer sign-in failed (HTTP $code): $(cat "$BODY")"
pass "signed in as $VIEWER_EMAIL"

# It reads the history — it is indeed a viewer, not a broken account.
code=$(vreq GET /api/deployments)
[ "$code" = "200" ] || fail "the viewer cannot even read the deployments (HTTP $code)"
ANY_ID=$(jq -r '.items[0].id // empty' "$BODY")
pass "the viewer does read the history"

code=$(vreq POST /api/deployments/purge '{"statuses":["failed"],"dryRun":true}')
[ "$code" = "403" ] || fail "bulk purge by a viewer: expected 403, got $code"
jq -e '.error.details.permission == "deployment:purge"' "$BODY" >/dev/null \
  || fail "the 403 does not name the permission: $(cat "$BODY")"
pass "bulk purge refused to the viewer → 403 deployment:purge"

if [ -n "$ANY_ID" ]; then
  code=$(vreq DELETE "/api/deployments/$ANY_ID/purge")
  [ "$code" = "403" ] || fail "single purge by a viewer: expected 403, got $code"
  pass "single purge refused to the viewer → 403"
fi

# ─── 9. The hole: a failed update behind a version in service ─────────────────
#
# The fixed defect: "in service" was computed on the LAST deployment of the
# (application, target) pair. A failed deployment took the lead, the `success`
# version below stopped being considered live — and became purgeable, although
# its containers were still running. Purging that trace meant losing the
# reserved port, the rollback and the destruction.

step "9. A failed update does not make the version in service purgeable"

MAJ_APP=$(upsert_app "$MAJ_SLUG" "$(spec_json "$MAJ_SLUG" 1.0.0)")
read -r MAJ_V1 MAJ_S1 <<< "$(deploy_and_wait "$MAJ_APP" "$TARGET_ID")"
[ "$MAJ_S1" = "success" ] || fail "the v1 of $MAJ_SLUG was supposed to succeed, status \"$MAJ_S1\""
req GET "/api/deployments/$MAJ_V1" >/dev/null
MAJ_PORT=$(jq -r '.publishedPort // empty' "$BODY")
pass "v1 in service — $MAJ_V1, port $MAJ_PORT"

upsert_app "$MAJ_SLUG" "$(spec_json_broken "$MAJ_SLUG" 2.0.0)" >/dev/null
read -r MAJ_V2 MAJ_S2 <<< "$(deploy_and_wait "$MAJ_APP" "$TARGET_ID")"
[ "$MAJ_S2" = "failed" ] || fail "the v2 was supposed to fail outright, status \"$MAJ_S2\""
req GET "/api/deployments/$MAJ_V2" >/dev/null
jq -e '.failedStep == "healthcheck"' "$BODY" >/dev/null \
  || fail "the failure was supposed to be on \"healthcheck\", not \"$(jq -r .failedStep "$BODY")\""
pass "v2 failed at the healthcheck step — $MAJ_V2"

# The application did not disappear from supervision: it is the other half of
# the same defect, checked in detail by verify-supervision.sh.
req GET /api/apps >/dev/null
jq -e --arg s "$MAJ_SLUG" '[.items[] | select(.applicationSlug == $s)] | length == 1' "$BODY" \
  >/dev/null || fail "\"$MAJ_SLUG\" disappeared from /api/apps after the failed deployment"
jq -e --arg s "$MAJ_SLUG" '[.items[] | select(.applicationSlug == $s)][0].lastFailedUpdate != null' \
  "$BODY" >/dev/null || fail "the state does not flag the failed update"
pass "still listed in /api/apps, with \"last update failed\""

# THE test: the underlying `success` v1 still refuses the purge.
code=$(req DELETE "/api/deployments/$MAJ_V1/purge")
[ "$code" = "409" ] || fail "purge of the v1 in service: expected 409, got $code — $(cat "$BODY")"
jq -e '.error.message | test("Détruisez-la d.abord|Destroy it first")' "$BODY" >/dev/null \
  || fail "the message does not say what to do: $(jq -r '.error.message' "$BODY")"
pass "409 — $(jq -r '.error.message' "$BODY")"

psql_q "select count(*) from deployments where id = '$MAJ_V1';" | grep -q '^1$' \
  || fail "the v1 disappeared despite the refusal"
[ "$(psql_q "select count(*) from port_allocations where target_id = '$TARGET_ID' and application_id = '$MAJ_APP';")" = "1" ] \
  || fail "the port reservation of $MAJ_SLUG was lost"
pass "the v1 and its port reservation are intact"

# The failed deployment, for its part, is purged normally: it is the handle of nothing.
code=$(req DELETE "/api/deployments/$MAJ_V2/purge")
[ "$code" = "200" ] || fail "purge of the failed v2: expected 200, got $code — $(cat "$BODY")"
pass "the failed v2 is purged — $(jq -c '{purged, releasedPorts}' "$BODY")"

[ "$(psql_q "select count(*) from deployments where id = '$MAJ_V2';")" = "0" ] \
  || fail "the v2 is still in the database"
[ "$(psql_q "select count(*) from port_allocations where target_id = '$TARGET_ID' and application_id = '$MAJ_APP';")" = "1" ] \
  || fail "purging the v2 took away the port reservation of the v1 in service"
pass "the v2 disappeared, the v1's reservation stayed"

# Cleanup of the § 9 material.
destroy_and_wait "$MAJ_V1"
code=$(req DELETE "/api/deployments/$MAJ_V1/purge")
[ "$code" = "200" ] || warn "purge of the destroyed v1 → HTTP $code: $(cat "$BODY")"
code=$(req DELETE "/api/applications/$MAJ_APP")
[ "$code" = "200" ] || warn "deleting $MAJ_SLUG → HTTP $code: $(cat "$BODY")"
pass "§ 9 material cleaned up"

# ─── 10. Nothing live was touched ─────────────────────────────────────────────

step "10. The running applications are intact"

req GET /api/apps >/dev/null
LIVE_AFTER=$(jq -r '[.items[].applicationSlug] | sort | join(",")' "$BODY")
[ "$LIVE_AFTER" = "$LIVE_BEFORE" ] \
  || fail "the running applications changed: \"$LIVE_BEFORE\" → \"$LIVE_AFTER\""
pass "still running: ${LIVE_AFTER:-none}"

step "11. Cleanup"
code=$(req DELETE "/api/applications/$APP_ID")
[ "$code" = "200" ] || warn "deleting $APP_SLUG → HTTP $code: $(cat "$BODY")"
[ "$code" = "200" ] && pass "test application deleted"
req DELETE "/api/admin/users/$VIEWER_ID" >/dev/null
pass "viewer user deleted"

printf '\n\033[32m✓ History purge verified.\033[0m\n'
printf '\033[2m  Screen: %s/deployments\033[0m\n\n' "$BASE_URL"
