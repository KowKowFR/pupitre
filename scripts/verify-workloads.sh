#!/usr/bin/env bash
#
# Checks a target's workload management:
#
#   1. the inventory shows the panel's workloads AND the others, told apart
#   2. a workload deployed by the panel REFUSES to be deleted → 409
#   3. a foreign workload is updated, through the queue, publishing its progress
#   4. a foreign workload is deleted, and really disappears from the machine
#   5. `workload:read` is enough to read, `workload:manage` is required to write
#   6. the audit keeps the action, with the workload's name and the target
#   7. the applications deployed by the panel still run at the end
#
# Usage:
#   ./scripts/verify-workloads.sh
#   BASE_URL=http://localhost:3200 ./scripts/verify-workloads.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
TARGET_NAME="${TARGET_NAME:-cible-de-verification}"
COBAYE="${COBAYE:-cobaye-verif}"
VIEWER_EMAIL="${VIEWER_EMAIL:-workload-viewer@example.test}"
VIEWER_PASSWORD="${VIEWER_PASSWORD:-motdepasse-tres-long}"
CLIENT_IP="${CLIENT_IP:-198.51.100.77}"

WORK="$(mktemp -d)"
ADMIN_JAR="$WORK/admin.jar"
VIEWER_JAR="$WORK/viewer.jar"
JAR="$ADMIN_JAR"
BODY="$WORK/body.json"
SSE="$WORK/sse.txt"
SSE_PID=""

cleanup() {
  [ -n "$SSE_PID" ] && { kill "$SSE_PID"; wait "$SSE_PID"; } 2>/dev/null || true
  # The guinea pigs do not survive the script, whatever happens.
  docker compose exec -T ssh-target sh -c \
    "docker rm -f \$(docker ps -aq --filter name=^${COBAYE}) >/dev/null 2>&1" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

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

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }
on_target() { docker compose exec -T ssh-target sh -c "$1"; }

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

login_viewer() {
  local code
  JAR="$VIEWER_JAR"
  for _ in 1 2 3 4 5; do
    code=$(req POST /api/auth/sign-in/email \
      "{\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\"}")
    case "$code" in
      200) return 0 ;;
      429) sleep 6 ;;
      *)   fail "viewer sign-in failed (HTTP $code): $(cat "$BODY")" ;;
    esac
  done
  fail "viewer sign-in failed after several attempts"
}

# Waits for a BullMQ job to be done. Returns its final state.
await_job() {
  local job_id="$1" deadline=$((SECONDS + 180)) state
  while [ "$SECONDS" -lt "$deadline" ]; do
    req GET "/api/queue/jobs/$job_id" >/dev/null
    state=$(jq -r '.state' "$BODY")
    case "$state" in
      completed|failed) echo "$state"; return 0 ;;
    esac
    sleep 1
  done
  echo "timeout"
}

inventory() {
  local code
  code=$(req GET "/api/targets/$TARGET_ID/workloads")
  [ "$code" = "200" ] || fail "GET workloads → HTTP $code: $(cat "$BODY")"
  cp "$BODY" "$WORK/inventory.json"
}

step "1. Sign-in"
login
pass "signed in as $ADMIN_EMAIL"

step "2. The verification target"
code=$(req GET /api/targets)
[ "$code" = "200" ] || fail "GET /api/targets → HTTP $code"
TARGET_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY" | head -1)
[ -n "$TARGET_ID" ] || fail "no target named \"$TARGET_NAME\""
pass "target \"$TARGET_NAME\" → $TARGET_ID"

# The panel's applications, as they are BEFORE any handling.
req GET /api/apps >/dev/null
cp "$BODY" "$WORK/apps-before.json"
APPS_BEFORE=$(jq -r '[.items[].id] | sort | join(",")' "$WORK/apps-before.json")
APPS_COUNT=$(jq -r '.total' "$WORK/apps-before.json")
[ "$APPS_COUNT" -ge 1 ] || fail "no deployed application: nothing to protect, the test would lose its meaning"
info "$APPS_COUNT application(s) deployed by the panel before the test"

step "3. Setting up a workload foreign to the panel"
on_target "docker rm -f $COBAYE >/dev/null 2>&1" >/dev/null 2>&1 || true
on_target "docker run -d --name $COBAYE nginx:alpine" >/dev/null \
  || fail "could not start the guinea pig on the target"
pass "container \"$COBAYE\" started on the target, outside the panel"

step "4. The inventory sees everything, and tells apart"
inventory
TOTAL=$(jq -r '.total' "$WORK/inventory.json")
MANAGED=$(jq -r '.managed' "$WORK/inventory.json")
jq -e '.runtimes | length >= 1' "$WORK/inventory.json" >/dev/null \
  || fail "no runtime queried"
jq -e '[.runtimes[] | select(.ok | not)] | length == 0' "$WORK/inventory.json" >/dev/null \
  || fail "a runtime could not say anything: $(jq -c '.runtimes' "$WORK/inventory.json")"
pass "$TOTAL workload(s) seen on $(jq -r '[.runtimes[].runtime] | join(", ")' "$WORK/inventory.json")"

jq -e --arg n "$COBAYE" \
  '[.items[] | select(.name == $n and .managed == false)] | length == 1' \
  "$WORK/inventory.json" >/dev/null \
  || fail "\"$COBAYE\" missing from the inventory, or wrongly marked as managed by the panel"
pass "\"$COBAYE\" present, marked outside the panel"

[ "$MANAGED" -ge 1 ] || fail "no workload marked as deployed by the panel"
jq -e '[.items[] | select(.managed) | select(.managedApp == null)] | length == 0' \
  "$WORK/inventory.json" >/dev/null \
  || fail "a panel workload does not say which application it comes from"
pass "$MANAGED workload(s) recognized as deployed by the panel: $(
  jq -r '[.items[] | select(.managed) | "\(.name) → \(.managedApp)"] | join(", ")' "$WORK/inventory.json")"

step "5. THE test: a panel workload refuses to be deleted"
MANAGED_REF=$(jq -r '[.items[] | select(.managed)][0].ref' "$WORK/inventory.json")
MANAGED_NAME=$(jq -r '[.items[] | select(.managed)][0].name' "$WORK/inventory.json")
code=$(req DELETE "/api/targets/$TARGET_ID/workloads/$MANAGED_REF")
[ "$code" = "409" ] || fail "deleting a panel workload: expected 409, got $code"
jq -e '.error.code == "conflict"' "$BODY" >/dev/null || fail "unexpected error code"
MSG=$(jq -r '.error.message' "$BODY")
case "$MSG" in
  *"$MANAGED_NAME"*) : ;;
  *) fail "the message does not name the workload: $MSG" ;;
esac
case "$MSG" in
  *deployment:destroy*) : ;;
  *) fail "the message does not say what to do instead: $MSG" ;;
esac
pass "refused → 409"
info "$MSG"

# And it is still there.
on_target "docker ps --format '{{.Names}}'" | grep -qx "$MANAGED_NAME" \
  || fail "\"$MANAGED_NAME\" disappeared from the machine despite the refusal"
pass "\"$MANAGED_NAME\" still runs on the machine"

step "6. Updating the foreign workload — through the queue, with its progress"
COBAYE_REF=$(jq -r --arg n "$COBAYE" '.items[] | select(.name == $n) | .ref' "$WORK/inventory.json")

# We subscribe BEFORE queuing: subscribing afterwards means losing the start.
curl -s -N -b "$ADMIN_JAR" --max-time 120 \
  "$BASE_URL/api/targets/$TARGET_ID/workloads/events" > "$SSE" &
SSE_PID=$!
sleep 2

code=$(req POST "/api/targets/$TARGET_ID/workloads/$COBAYE_REF/update")
[ "$code" = "202" ] || fail "update: expected 202 (queued), got $code: $(cat "$BODY")"
JOB_ID=$(jq -r '.jobId' "$BODY")
CHANNEL=$(jq -r '.channel' "$BODY")
[ -n "$JOB_ID" ] && [ "$JOB_ID" != "null" ] || fail "no job identifier"
pass "update queued (job $JOB_ID) — the route ran nothing itself"
info "progress published on \"$CHANNEL\""

state=$(await_job "$JOB_ID")
[ "$state" = "completed" ] || fail "the update job ended \"$state\": $(jq -r '.failedReason // "?"' "$BODY")"
pass "job completed by the worker"

sleep 1
# `wait` swallows the "Terminated" notice bash would emit otherwise.
{ kill "$SSE_PID"; wait "$SSE_PID"; } 2>/dev/null || true
SSE_PID=""

grep -q 'event: lifecycle' "$SSE" || fail "no life cycle event relayed over SSE"
grep -q '"status":"started"' "$SSE" || fail "the start was not published"
grep -q '"status":"succeeded"' "$SSE" || fail "the end was not published"
LOG_LINES=$(grep -c 'event: log' "$SSE" || true)
[ "$LOG_LINES" -ge 3 ] || fail "progress too poor: $LOG_LINES line(s)"
pass "$LOG_LINES progress line(s) relayed over SSE, plus the start and the end"
info "$(sed -n 's/^data: //p' "$SSE" | jq -r 'select(.line) | .line' 2>/dev/null \
        | sed -n '1p;$p' | paste -sd' … ' - || true)"

on_target "docker ps --format '{{.Names}}'" | grep -qx "$COBAYE" \
  || fail "\"$COBAYE\" did not survive its update"
on_target "docker ps -a --format '{{.Names}}'" | grep -q -- "-tp-prev-" \
  && fail "a backup container was left behind"
pass "\"$COBAYE\" still runs, and nothing was left behind"

step "7. Deleting the foreign workload"
# The update recreated the container: its reference changed.
inventory
COBAYE_REF=$(jq -r --arg n "$COBAYE" '.items[] | select(.name == $n) | .ref' "$WORK/inventory.json")
[ -n "$COBAYE_REF" ] && [ "$COBAYE_REF" != "null" ] || fail "\"$COBAYE\" not found after the update"

code=$(req DELETE "/api/targets/$TARGET_ID/workloads/$COBAYE_REF")
[ "$code" = "202" ] || fail "deletion: expected 202 (queued), got $code: $(cat "$BODY")"
JOB_ID=$(jq -r '.jobId' "$BODY")
pass "deletion queued (job $JOB_ID)"

state=$(await_job "$JOB_ID")
[ "$state" = "completed" ] || fail "the deletion job ended \"$state\": $(jq -r '.failedReason // "?"' "$BODY")"
pass "job completed by the worker"

on_target "docker ps -a --format '{{.Names}}'" | grep -qx "$COBAYE" \
  && fail "\"$COBAYE\" is still on the machine: the deletion did nothing"
pass "\"$COBAYE\" really disappeared from the target (docker ps -a)"

inventory
jq -e --arg n "$COBAYE" '[.items[] | select(.name == $n)] | length == 0' \
  "$WORK/inventory.json" >/dev/null || fail "the inventory still shows it"
pass "it disappeared from the inventory"

step "8. The permissions"
code=$(req POST /api/admin/users \
  "{\"name\":\"Lecteur charges\",\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\",\"role\":\"viewer\"}")
case "$code" in
  201) pass "viewer user created" ;;
  409) pass "viewer user already present" ;;
  *)   fail "POST /api/admin/users → HTTP $code: $(cat "$BODY")" ;;
esac
VIEWER_ID=$(psql_q "select id from users where email = '$VIEWER_EMAIL';")

perms=$(req GET /api/admin/roles >/dev/null; jq -r '[.items[] | select(.key=="viewer") | .permissions[]] | join(" ")' "$BODY")
case "$perms" in
  *workload:read*) : ;;
  *) fail "the viewer role does not have \"workload:read\" — the test would prove nothing" ;;
esac
case "$perms" in
  *workload:manage*) fail "the viewer role has \"workload:manage\" — the test would prove nothing" ;;
esac
pass "viewer carries \"workload:read\" and not \"workload:manage\""

login_viewer
code=$(req GET "/api/targets/$TARGET_ID/workloads")
[ "$code" = "200" ] || fail "viewer reading: expected 200, got $code"
pass "viewer reads the inventory → 200"

# Any workload is enough: the refusal comes from the permission, not the target.
ANY_REF=$(jq -r '.items[0].ref' "$WORK/inventory.json")
code=$(req DELETE "/api/targets/$TARGET_ID/workloads/$ANY_REF")
[ "$code" = "403" ] || fail "viewer deleting: expected 403, got $code"
jq -e '.error.details.permission == "workload:manage"' "$BODY" >/dev/null \
  || fail "the 403 does not name the missing permission"
pass "viewer does not delete → 403 \"workload:manage\""

code=$(req POST "/api/targets/$TARGET_ID/workloads/$ANY_REF/update")
[ "$code" = "403" ] || fail "viewer updating: expected 403, got $code"
pass "viewer does not update → 403"

JAR="$ADMIN_JAR"

step "9. Traceability"
code=$(req GET "/api/audit-logs?resourceType=target&pageSize=50")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"

for action in workload.remove.refused workload.update.requested workload.updated \
              workload.remove.requested workload.removed; do
  jq -e --arg a "$action" '[.items[] | select(.action == $a)] | length > 0' "$BODY" >/dev/null \
    || fail "action \"$action\" missing from the audit log"
  pass "audit: $action"
done

jq -e --arg n "$COBAYE" --arg t "$TARGET_NAME" \
  '[.items[] | select(.action == "workload.removed")
     | select(.after.workload == $n and .after.targetName == $t)] | length > 0' \
  "$BODY" >/dev/null \
  || fail "the deletion is not traced with the workload's name and the target"
pass "the deletion names \"$COBAYE\" and the target \"$TARGET_NAME\""

jq -e --arg n "$MANAGED_NAME" \
  '[.items[] | select(.action == "workload.remove.refused")
     | select(.after.workload == $n and .after.reason == "managed_by_panel")] | length > 0' \
  "$BODY" >/dev/null \
  || fail "the refusal is not traced"
pass "the refusal is traced, with its reason"

step "10. The panel's applications did not move"
code=$(req GET /api/apps)
[ "$code" = "200" ] || fail "GET /api/apps → HTTP $code"
APPS_AFTER=$(jq -r '[.items[].id] | sort | join(",")' "$BODY")
[ "$APPS_AFTER" = "$APPS_BEFORE" ] \
  || fail "the list of applications changed: \"$APPS_BEFORE\" → \"$APPS_AFTER\""
pass "the $APPS_COUNT application(s) are still there"

jq -e '[.items[] | select(.status != "success" and .status != "rolled_back")] | length == 0' "$BODY" \
  >/dev/null || fail "an application is no longer in a live state: $(jq -c '[.items[] | {applicationSlug, status}]' "$BODY")"
pass "all in a live state: $(jq -r '[.items[] | "\(.applicationSlug)=\(.status)"] | join(", ")' "$BODY")"

# Only those deployed on THIS target have containers there: the panel drives
# several, and the others would prove nothing here.
HERE=$(jq -r --arg t "$TARGET_NAME" '[.items[] | select(.targetName == $t) | .applicationSlug] | join(" ")' \
  "$WORK/apps-before.json")
[ -n "$HERE" ] || fail "no panel application on \"$TARGET_NAME\": the safeguard would have nothing to protect"
for slug in $HERE; do
  on_target "docker ps --format '{{.Names}}'" | grep -q "^app-$slug-" \
    || fail "no running container for \"$slug\" on the target"
done
pass "their containers still run on \"$TARGET_NAME\": $HERE"

step "11. Cleanup"
on_target "docker rm -f $COBAYE >/dev/null 2>&1" >/dev/null 2>&1 || true
remaining=$(on_target "docker ps -aq --filter name=^$COBAYE" | wc -l | tr -d ' ')
[ "$remaining" = "0" ] || fail "$remaining guinea pig(s) surviving on the target"
pass "no guinea pig survives on the target"

[ -n "$VIEWER_ID" ] && req DELETE "/api/admin/users/$VIEWER_ID" >/dev/null
pass "test user deleted"

printf '\n\033[32m✓ Workload management verified.\033[0m\n'
printf '\033[2m  Screen: %s/targets/%s\033[0m\n\n' "$BASE_URL" "$TARGET_ID"
