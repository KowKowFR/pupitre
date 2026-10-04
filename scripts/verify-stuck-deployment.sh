#!/usr/bin/env bash
#
# Checks the unblocking of a stuck deployment.
#
# The fixed defect: when the worker dies in mid-run and BullMQ ends up giving up
# its job, the deployment stays `running` in the database forever. The
# destruction refuses it, the purge refuses it (`in_progress`), and the
# application carrying it becomes indelible. The only recourse was SQL.
#
#   1. what is NOT a ghost — it is the test that matters:
#      a. a job waiting its turn (worker stopped), even past the grace window:
#         the detector is not a timer
#      b. a job running on a long deployment
#   2. the real ghost: two restarts in flight, BullMQ gives the job up ("job
#      stalled more than allowable limit") without ever calling our handler —
#      the worker notices and stops the deployment as failed, WITHOUT replaying
#      it
#   3. the ghost nothing announces: job gone from the queue (Redis is only a
#      cache here) — no event left to listen to, it is the manual gesture that
#      decides
#   4. the required permission is `deployment:purge`, checked with an account
#      that has everything but it
#   5. the recorded message names what remains to check on the target
#   6. after unblocking, the deployment is destroyed and the application deleted
#
# Side finding, outside this work's scope (it belongs to the Docker driver): the
# "docker compose up --wait" started over SSH runs on the TARGET and survives the
# worker's death. It can put its container back up after the destruction. The
# script names it and cleans it up rather than pretending not to see — it is
# exactly the leftover the recorded message asks to go and check on the machine.
#
# The script creates its own material ("sd-*" applications, verification role
# and account) and cleans it up. The `/api/apps` inventory is compared before
# and after: no application in service is touched.
#
# The "vps" target is NEVER called upon. Everything plays out on
# "verification-target" (the ssh-target container).
#
# The worker is stopped and restarted several times: it is the very subject of
# the test. Count about twelve minutes.
#
# Usage:
#   ./scripts/verify-stuck-deployment.sh
#   BASE_URL=http://localhost:3200 TARGET_NAME=my-vm ./scripts/verify-stuck-deployment.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
TARGET_NAME="${TARGET_NAME:-verification-target}"
CLIENT_IP="${CLIENT_IP:-198.51.100.42}"
IMAGE="${IMAGE:-docker.io/library/nginx:1.29-alpine}"

# Two throwaway applications: one for the observed ghost, the other for the
# ghost whose job disappeared.
FIGE_SLUG="${FIGE_SLUG:-sd-fige}"
PERDUE_SLUG="${PERDUE_SLUG:-sd-perdue}"

ROLE_KEY="${ROLE_KEY:-sd-verif-sans-purge}"
LIMITED_EMAIL="${LIMITED_EMAIL:-sd-sans-purge@example.test}"
LIMITED_PASSWORD="${LIMITED_PASSWORD:-motdepasse-tres-long}"

# The detector's grace window (STUCK_DEPLOYMENT_GRACE_MS), in seconds.
GRACE_SEC="${GRACE_SEC:-60}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
LJAR="$WORK/limite.jar"
BODY="$WORK/body.json"

# The worker is stopped several times: whatever happens, it starts again.
cleanup() {
  docker compose start worker >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

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

# Same thing, with the jar of the account that does not have `deployment:purge`.
lreq() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -H "x-forwarded-for: $CLIENT_IP" -b "$LJAR" -c "$LJAR")
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }
redis_cli() { docker compose exec -T redis redis-cli "$@"; }
target_docker() { docker compose exec -T ssh-target docker "$@"; }
# Shell on the target: `target_docker` already prefixes "docker", it cannot run
# anything else.
target_sh() { docker compose exec -T ssh-target sh -c "$1"; }

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

# Short AppSpec: the deployment completes in about thirty seconds.
spec_courte() {
  jq -n --arg n "$1" --arg i "$IMAGE" \
    '{name:$n, version:"1.0.0", services:[{
        name:"web",
        source:{type:"image", ref:$i},
        port:80,
        exposed:true,
        healthcheck:{path:"/", intervalSec:2, timeoutSec:3, retries:4}
      }]}'
}

# LONG AppSpec, and deliberately legitimate: the health path does not exist, so
# `docker compose up --wait` waits for the container to become healthy — which
# it never will — until its five-minute bound. It is a perfectly normal
# deployment that takes long, exactly like a big `docker pull` or a build. The
# detector must above all not take it for a dead one.
spec_longue() {
  jq -n --arg n "$1" --arg i "$IMAGE" \
    '{name:$n, version:"1.0.0", services:[{
        name:"web",
        source:{type:"image", ref:$i},
        port:80,
        exposed:true,
        healthcheck:{path:"/jamais-la", intervalSec:8, timeoutSec:3, retries:45}
      }]}'
}

upsert_app() {
  local slug="$1" spec="$2" id code
  req GET /api/applications >/dev/null
  id=$(jq -r --arg s "$slug" '.items[] | select(.slug == $s) | .id' "$BODY" | head -1)
  if [ -n "$id" ]; then printf '%s' "$id"; return; fi

  jq -n --argjson spec "$spec" '{appSpec:$spec}' > "$WORK/create.json"
  code=$(req POST /api/applications "@$WORK/create.json")
  [ "$code" = "201" ] || fail "POST /api/applications → HTTP $code: $(cat "$BODY")"
  jq -r .id "$BODY"
}

# Queues a deployment. Echoes: "<deploymentId> <jobId>".
enqueue() {
  local app_id="$1" target_id="$2" code
  code=$(req POST /api/deployments \
    "{\"applicationId\":\"$app_id\",\"targetId\":\"$target_id\",\"runtime\":\"docker\",\"proxy\":\"traefik\",\"autoRollback\":false}")
  [ "$code" = "202" ] || fail "POST /api/deployments → HTTP $code: $(cat "$BODY")"
  printf '%s %s' "$(jq -r .id "$BODY")" "$(jq -r .jobId "$BODY")"
}

deployment_status() { psql_q "select status from deployments where id = '$1';"; }

# The panel's verdict on a deployment, from /api/deployments/stuck.
# Echoes: "<ghost> <job state or 'none'>".
verdict() {
  local id="$1"
  req GET /api/deployments/stuck >/dev/null
  jq -r --arg d "$id" \
    '[.items[] | select(.id == $d)] | if length == 0 then "absent –"
      else "\(.[0].ghost) \(.[0].job.state // "none")" end' "$BODY"
}

# Waits for a given step to be running. Used to cause the interruption during
# the LONG step, the only one that leaves BullMQ time to notice twice that the
# job is stuck.
wait_step() {
  local id="$1" key="$2" limit="${3:-90}"
  for _ in $(seq 1 "$limit"); do
    if [ "$(psql_q "select status from deployment_steps where deployment_id = '$id' and key = '$key';")" = "running" ]; then
      return 0
    fi
    sleep 2
  done
  fail "step \"$key\" of $id never started"
}

started_at_of() { psql_q "select started_at from deployments where id = '$1';"; }

wait_status() {
  local id="$1" want="$2" limit="${3:-90}" seen
  for _ in $(seq 1 "$limit"); do
    seen=$(deployment_status "$id")
    [ "$seen" = "$want" ] && return 0
    sleep 2
  done
  fail "deployment $id stayed \"$(deployment_status "$id")\" instead of \"$want\""
}

# ─── 1. Context ───────────────────────────────────────────────────────────────

step "1. Sign-in, target and starting inventory"
login
pass "signed in as $ADMIN_EMAIL"

req GET /api/targets >/dev/null
TARGET_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY")
[ -n "$TARGET_ID" ] || fail "target \"$TARGET_NAME\" not found — run ./scripts/setup-test-target.sh"
TARGET_HOST=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .host' "$BODY")
pass "target $TARGET_NAME ($TARGET_HOST) — $TARGET_ID"

req GET /api/apps >/dev/null
LIVE_BEFORE=$(jq -r '[.items[].applicationSlug] | sort | join(",")' "$BODY")
pass "applications in service before: ${LIVE_BEFORE:-none}"

# Cleanup from an interrupted previous run.
for slug in "$FIGE_SLUG" "$PERDUE_SLUG"; do
  req GET /api/applications >/dev/null
  stale=$(jq -r --arg s "$slug" '.items[] | select(.slug == $s) | .id' "$BODY" | head -1)
  [ -n "$stale" ] || continue
  # A leftover of this script may be stuck: it is unblocked before forcing.
  for d in $(psql_q "select id from deployments where application_id = '$stale' and status in ('pending','running');"); do
    req POST "/api/deployments/$d/unblock" '{}' >/dev/null 2>&1 || true
  done
  req POST "/api/applications/$stale/cascade" "{\"force\":true,\"confirm\":\"$slug\"}" >/dev/null 2>&1 || true
  warn "leftover from a previous run: \"$slug\" erased by force"
  sleep 5
done
req DELETE "/api/admin/roles/$ROLE_KEY" >/dev/null 2>&1 || true

# ─── 2. What is NOT a ghost ───────────────────────────────────────────────────

step "2. A job waiting its turn is not a ghost"
info "worker stopped: the deployment will stay \"pending\", its job in the queue"

docker compose stop worker >/dev/null
FIGE_ID=$(upsert_app "$FIGE_SLUG" "$(spec_longue "$FIGE_SLUG")")
read -r FIGE_DEPLOY FIGE_JOB <<< "$(enqueue "$FIGE_ID" "$TARGET_ID")"
pass "deployment $FIGE_DEPLOY queued (BullMQ job #$FIGE_JOB), worker stopped"

[ "$(deployment_status "$FIGE_DEPLOY")" = "pending" ] \
  || fail "the deployment should be \"pending\", it is \"$(deployment_status "$FIGE_DEPLOY")\""

read -r GHOST STATE <<< "$(verdict "$FIGE_DEPLOY")"
[ "$GHOST" = "false" ] || fail "a waiting deployment is taken for a ghost"
[ "$STATE" = "wait" ] || fail "expected job state \"wait\", got \"$STATE\""
pass "verdict: not a ghost — the job is in the \"$STATE\" state"

code=$(req POST "/api/deployments/$FIGE_DEPLOY/unblock" '{}')
[ "$code" = "409" ] || fail "unblocking: expected 409, got $code — $(cat "$BODY")"
jq -e '.error.code == "deployment_not_stuck"' "$BODY" >/dev/null \
  || fail "unexpected error code: $(jq -c .error.code "$BODY")"
pass "unblocking refused → $(jq -r '.error.message' "$BODY" | head -c 150)…"

info "we let the grace window go by ($GRACE_SEC s): the verdict must not change"
sleep $((GRACE_SEC + 20))
read -r GHOST STATE <<< "$(verdict "$FIGE_DEPLOY")"
[ "$GHOST" = "false" ] || fail "the detector concluded death through the mere passing of time"
pass "still not a ghost after $((GRACE_SEC + 20)) s — the detector is NOT a timer"

step "3. A long deployment, really running, is not a ghost either"
docker compose start worker >/dev/null
wait_status "$FIGE_DEPLOY" running 60
pass "worker restarted, deployment gone \"running\""

# The "Starting the services" step waits for the container to become healthy:
# a five-minute bound. A long deployment, but perfectly alive.
wait_step "$FIGE_DEPLOY" deploy 120
read -r GHOST STATE <<< "$(verdict "$FIGE_DEPLOY")"
[ "$STATE" = "active" ] || fail "expected job \"active\", got \"$STATE\""
[ "$GHOST" = "false" ] || fail "a running deployment is taken for a ghost"
pass "verdict: not a ghost — job \"$STATE\", step \"Starting the services\" (bound: 5 min)"

code=$(req POST "/api/deployments/$FIGE_DEPLOY/unblock" '{}')
[ "$code" = "409" ] || fail "unblocking: expected 409, got $code"
jq -e '.error.details.job.state == "active"' "$BODY" >/dev/null \
  || fail "the refusal does not name the job's state: $(jq -c .error.details "$BODY")"
pass "unblocking refused, and the refusal says why:"
info "$(jq -r '.error.message' "$BODY")"

# ─── 4. The real ghost ────────────────────────────────────────────────────────

step "4. Two restarts in flight: BullMQ gives the job up"
info "a single restart is not enough — BullMQ recovers the stuck job and replays"
info "it. It is at the SECOND recovery that it exceeds maxStalledCount and fails it"
info "WITHOUT calling our handler: nobody then writes the verdict."

STARTED_BEFORE=$(started_at_of "$FIGE_DEPLOY")
docker compose restart worker >/dev/null
pass "restart #1 in the middle of the \"Starting the services\" step"

# Proof of the recovery: `markDeploymentRunning()` rewrites `started_at` at
# each start of the pipeline. As long as the timestamp has not moved, the job
# still lingers in `active` with nobody at the end — waiting for it is the only
# way not to confuse "not recovered yet" and "recovered".
RECOVERED=""
for _ in $(seq 1 60); do
  sleep 5
  if [ "$(started_at_of "$FIGE_DEPLOY")" != "$STARTED_BEFORE" ]; then RECOVERED=oui; break; fi
done
[ -n "$RECOVERED" ] || fail "BullMQ did not recover the job after the first restart"
pass "BullMQ recovered the job on its own and replayed it — the status stays \"$(deployment_status "$FIGE_DEPLOY")\""
info "by the way: this automatic resumption redeploys on top of what the"
info "first pass had already started. It is BullMQ, not us; and it is"
info "exactly why the unblocking, for its part, never replays anything."

wait_step "$FIGE_DEPLOY" deploy 120
docker compose restart worker >/dev/null
pass "restart #2, again in the middle of the \"Starting the services\" step"

FAILED_REASON=""
for _ in $(seq 1 60); do
  sleep 5
  FAILED_REASON=$(redis_cli hget "bull:ops:$FIGE_JOB" failedReason | tr -d '\r')
  if [ -n "$FAILED_REASON" ]; then break; fi
done
[ -n "$FAILED_REASON" ] || fail "BullMQ did not give up job #$FIGE_JOB in $((60 * 5)) s"
pass "job #$FIGE_JOB given up by BullMQ: \"$FAILED_REASON\""
if [ "$FAILED_REASON" != "job stalled more than allowable limit" ]; then
  warn "unexpected reason — the test stays valid, the job is indeed dead"
fi

# It is HERE that the panel lied: the job is dead, the database says "running".
# The worker listens to its own `failed` event and stops the deployment.
wait_status "$FIGE_DEPLOY" failed 60
pass "the worker noticed: deployment stopped as \"failed\", without a replay"

read -r GHOST STATE <<< "$(verdict "$FIGE_DEPLOY")"
[ "$GHOST" = "absent" ] || fail "the deployment still appears among the deployments in progress"
pass "it no longer appears among the deployments \"in progress\""

# The pipeline was NOT replayed a third time: the step it stopped on is marked
# failed, the rest is skipped.
FAILED_STEP=$(psql_q "select failed_step from deployments where id = '$FIGE_DEPLOY';")
SKIPPED=$(psql_q "select count(*) from deployment_steps where deployment_id = '$FIGE_DEPLOY' and status = 'skipped';")
pass "stopped on the \"$FAILED_STEP\" step, $SKIPPED step(s) skipped"

step "5. The recorded message says what remains to check on the target"
MESSAGE=$(psql_q "select error from deployments where id = '$FIGE_DEPLOY';")
printf '\n\033[2m%s\033[0m\n\n' "$MESSAGE"

for needle in "app-$FIGE_SLUG" "$TARGET_NAME" "$TARGET_HOST"; do
  grep -qF -- "$needle" <<< "$MESSAGE" || fail "the message does not mention \"$needle\""
  pass "the message names \"$needle\""
done
grep -qE "Détruisez|Destroy this deployment" <<< "$MESSAGE" \
  || fail "the message does not say to destroy the deployment"
pass "the message says to destroy the deployment"
grep -qF "job stalled more than allowable limit" <<< "$MESSAGE" \
  || fail "the message does not say what BullMQ did with the job"
pass "the message says why it is final, not only \"interrupted\""

PORT=$(psql_q "select coalesce(d.published_port, p.port) from deployments d
  left join port_allocations p on p.target_id = d.target_id and p.application_id = d.application_id
  where d.id = '$FIGE_DEPLOY';")
if [ -n "$PORT" ]; then
  grep -qF "$PORT" <<< "$MESSAGE" || fail "the message does not name port $PORT, still reserved"
  pass "the message names port $PORT, still reserved for this application"
fi

# The activity log carries the same trace, written by the worker.
code=$(req GET "/api/audit-logs?resourceType=deployment&pageSize=25")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
jq -e --arg d "$FIGE_DEPLOY" \
  '[.items[] | select(.action == "deployment.unblocked" and .resourceId == $d)] | length > 0' \
  "$BODY" >/dev/null || fail "no \"deployment.unblocked\" entry for $FIGE_DEPLOY"
pass "activity logs: deployment.unblocked"

# ─── 6. After unblocking, the application can be deleted again ────────────────

step "6. After unblocking: destruction possible, then deletion of the application"

# The deployment had stopped AFTER the services started: the panel still
# considers that the target may carry something, and so refuses to erase the
# application without going through the destruction. It is deliberate — it is
# precisely what the message asks to do.
code=$(req DELETE "/api/applications/$FIGE_ID")
[ "$code" = "409" ] || fail "deletion without destruction: expected 409, got $code"
pass "deletion still refused → $(jq -r '.error.code' "$BODY") (containers may be running)"

code=$(req DELETE "/api/deployments/$FIGE_DEPLOY")
[ "$code" = "202" ] || fail "DELETE /api/deployments/$FIGE_DEPLOY → HTTP $code: $(cat "$BODY")"
pass "destruction queued — it was impossible as long as the status said \"in progress\""
wait_status "$FIGE_DEPLOY" destroyed 90

code=$(req DELETE "/api/applications/$FIGE_ID")
[ "$code" = "200" ] || fail "deleting the application → HTTP $code: $(cat "$BODY")"
pass "application \"$FIGE_SLUG\" deleted — the loop is closed"

# Known leftover, and it is precisely what the recorded message talks about:
# the `docker compose up --wait` started over SSH survives the worker's death (it
# runs on the TARGET, not in the worker) and can put its container back up after
# the destruction. The panel cannot know it from here — it says so, and that is
# all that is asked of it. We leave a bit of time, then name the leftover and
# clean it up by hand, as an operator would.
LEFTOVER=""
for _ in $(seq 1 15); do
  if target_docker ps -a --format '{{.Names}}' | grep -q "^app-$FIGE_SLUG"; then
    LEFTOVER=oui; sleep 4
  else
    LEFTOVER=""; break
  fi
done
if [ -n "$LEFTOVER" ]; then
  warn "an \"app-$FIGE_SLUG\" container remains on $TARGET_NAME — exactly the"
  info "leftover the message announced. Origin: an orphan \"docker compose up --wait\","
  info "started over SSH and still alive on the target after the worker's death:"
  target_sh "ps aux | grep -F 'compose up -d --remove-orphans' | grep -v grep" || true
  target_sh "pkill -f 'compose up -d --remove-orphans'" || true
  target_docker rm -f "app-$FIGE_SLUG-web-1" >/dev/null 2>&1 || true
  pass "leftover cleaned up by hand — the panel had said where to look"
else
  pass "no \"app-$FIGE_SLUG\" container left on $TARGET_NAME"
fi

# ─── 7. The ghost whose job disappeared ───────────────────────────────────────

step "7. Job gone from the queue: it is the manual gesture that decides"
info "Redis is only a cache here — the database is the source of truth. A lost"
info "job (Redis emptied, retention, eviction) produces no event: the worker"
info "has nothing to listen to, nobody will come."

docker compose stop worker >/dev/null
PERDUE_ID=$(upsert_app "$PERDUE_SLUG" "$(spec_courte "$PERDUE_SLUG")")
read -r PERDUE_DEPLOY PERDUE_JOB <<< "$(enqueue "$PERDUE_ID" "$TARGET_ID")"
pass "deployment $PERDUE_DEPLOY queued (job #$PERDUE_JOB), worker stopped"

redis_cli lrem bull:ops:wait 0 "$PERDUE_JOB" >/dev/null
redis_cli del "bull:ops:$PERDUE_JOB" >/dev/null
[ "$(redis_cli exists "bull:ops:$PERDUE_JOB" | tr -d '\r')" = "0" ] \
  || fail "job #$PERDUE_JOB is still in Redis"
pass "job #$PERDUE_JOB erased from the queue — the database, for its part, still says \"pending\""

docker compose start worker >/dev/null
sleep 10
[ "$(deployment_status "$PERDUE_DEPLOY")" = "pending" ] \
  || fail "the deployment moved: $(deployment_status "$PERDUE_DEPLOY")"
pass "worker restarted: nothing takes this deployment up again, it stays \"pending\""

info "we wait for the grace window before concluding"
sleep $((GRACE_SEC + 10))
read -r GHOST STATE <<< "$(verdict "$PERDUE_DEPLOY")"
[ "$GHOST" = "true" ] || fail "the ghost is not detected (ghost=$GHOST, job=$STATE)"
[ "$STATE" = "none" ] || fail "a job remains: $STATE"
pass "verdict: proven ghost — no runnable job carries it"

# ─── 8. The permission ────────────────────────────────────────────────────────

step "8. Unblocking requires \"deployment:purge\""
info "it does not touch the machine: it corrects a record, like the purge."

# A role that has EVERYTHING on deployments except the purge.
code=$(req POST /api/admin/roles \
  "{\"key\":\"$ROLE_KEY\",\"label\":\"Vérification sans purge\",\"permissions\":[\"application:read\",\"target:read\",\"deployment:read\",\"deployment:create\",\"deployment:rollback\",\"deployment:destroy\"]}")
case "$code" in
  201) pass "role \"$ROLE_KEY\" created: everything on deployments EXCEPT deployment:purge" ;;
  409) pass "role \"$ROLE_KEY\" already present" ;;
  *)   fail "POST /api/admin/roles → HTTP $code: $(cat "$BODY")" ;;
esac

code=$(req POST /api/admin/users \
  "{\"name\":\"Sans purge\",\"email\":\"$LIMITED_EMAIL\",\"password\":\"$LIMITED_PASSWORD\",\"role\":\"$ROLE_KEY\"}")
case "$code" in
  201|409) pass "account \"$LIMITED_EMAIL\" available" ;;
  *) fail "POST /api/admin/users → HTTP $code: $(cat "$BODY")" ;;
esac
LIMITED_ID=$(psql_q "select id from users where email = '$LIMITED_EMAIL';")

code=$(lreq POST /api/auth/sign-in/email \
  "{\"email\":\"$LIMITED_EMAIL\",\"password\":\"$LIMITED_PASSWORD\"}")
[ "$code" = "200" ] || fail "sign-in of the limited account → HTTP $code: $(cat "$BODY")"
pass "signed in as $LIMITED_EMAIL"

code=$(lreq POST "/api/deployments/$PERDUE_DEPLOY/unblock" '{}')
[ "$code" = "403" ] || fail "unblocking without permission: expected 403, got $code — $(cat "$BODY")"
jq -e '.error.details.permission == "deployment:purge"' "$BODY" >/dev/null \
  || fail "the required permission is not named: $(jq -c .error "$BODY")"
pass "refused → 403, permission \"deployment:purge\" required"

# And destroying is not enough either: the "pending" status still blocks.
code=$(lreq DELETE "/api/deployments/$PERDUE_DEPLOY")
[ "$code" = "409" ] || fail "destroying a deployment in progress: expected 409, got $code"
pass "deployment:destroy unblocks nothing: the destruction still refuses one \"in progress\""

code=$(req PATCH "/api/admin/roles/$ROLE_KEY" \
  '{"permissions":["application:read","target:read","deployment:read","deployment:create","deployment:rollback","deployment:destroy","deployment:purge"]}')
[ "$code" = "200" ] || fail "role PATCH → HTTP $code: $(cat "$BODY")"
pass "\"deployment:purge\" granted to the role"

code=$(lreq POST "/api/deployments/$PERDUE_DEPLOY/unblock" '{}')
[ "$code" = "200" ] || fail "unblocking with the permission → HTTP $code: $(cat "$BODY")"
jq -e '.status == "failed"' "$BODY" >/dev/null || fail "unexpected status: $(jq -c .status "$BODY")"
pass "unblocking accepted from the same account, one permission later"
PERDUE_MESSAGE=$(jq -r .error "$BODY")
printf '\n\033[2m%s\033[0m\n\n' "$PERDUE_MESSAGE"

jq -e 'has("mayHaveStartedServices")' "$BODY" >/dev/null \
  || fail "the response does not say whether services may have started"
grep -qF "app-$PERDUE_SLUG" <<< "$PERDUE_MESSAGE" \
  || fail "the message does not name the \"app-$PERDUE_SLUG\" project"
pass "the message names the project and the target to check"

[ "$(deployment_status "$PERDUE_DEPLOY")" = "failed" ] \
  || fail "the database did not follow: $(deployment_status "$PERDUE_DEPLOY")"
pass "in the database: \"failed\""

# Twice in a row: the second call has nothing left to unblock.
code=$(req POST "/api/deployments/$PERDUE_DEPLOY/unblock" '{}')
[ "$code" = "409" ] || fail "second unblocking: expected 409, got $code"
pass "a second unblocking rewrites nothing → 409"

# ─── 9. Cleanup ───────────────────────────────────────────────────────────────

step "9. Cleanup"

code=$(req POST "/api/applications/$PERDUE_ID/cascade" "{\"confirm\":\"$PERDUE_SLUG\"}")
if [ "$code" = "202" ]; then
  JOB=$(jq -r .jobId "$BODY")
  for _ in $(seq 1 60); do
    sleep 2
    req GET "/api/applications/$PERDUE_ID/cascade?jobId=$JOB" >/dev/null
    if [ "$(jq -r '.state // empty' "$BODY")" = "completed" ]; then break; fi
  done
  pass "application \"$PERDUE_SLUG\" deleted in cascade"
else
  req DELETE "/api/applications/$PERDUE_ID" >/dev/null
  pass "application \"$PERDUE_SLUG\" deleted"
fi

req PATCH "/api/admin/users/$LIMITED_ID/role" '{"role":"viewer"}' >/dev/null
req DELETE "/api/admin/users/$LIMITED_ID" >/dev/null
req DELETE "/api/admin/roles/$ROLE_KEY" >/dev/null
pass "verification account and role deleted"

target_sh "pkill -f 'compose up -d --remove-orphans'" >/dev/null 2>&1 || true
for slug in "$FIGE_SLUG" "$PERDUE_SLUG"; do
  if target_docker ps -a --format '{{.Names}}' | grep -q "^app-$slug"; then
    target_docker rm -f "app-$slug-web-1" >/dev/null 2>&1 || true
    warn "\"app-$slug\" container removed by hand (orphan remote process)"
  fi
done
if target_docker ps -a --format '{{.Names}}' | grep -qE "^app-($FIGE_SLUG|$PERDUE_SLUG)"; then
  fail "a verification container resists on $TARGET_NAME"
fi
pass "no verification container on $TARGET_NAME"

LEFT=$(psql_q "select count(*) from deployments d join applications a on a.id = d.application_id
  where a.slug in ('$FIGE_SLUG', '$PERDUE_SLUG');")
[ "$LEFT" = "0" ] || fail "$LEFT verification deployment(s) remain in the database"
pass "no verification deployment row in the database"

req GET /api/apps >/dev/null
LIVE_AFTER=$(jq -r '[.items[].applicationSlug] | sort | join(",")' "$BODY")
[ "$LIVE_AFTER" = "$LIVE_BEFORE" ] \
  || fail "the inventory of applications in service changed: \"$LIVE_BEFORE\" → \"$LIVE_AFTER\""
pass "applications in service unchanged: ${LIVE_AFTER:-none}"

docker compose start worker >/dev/null 2>&1 || true
printf '\n\033[32m✓ Unblocking of stuck deployments verified.\033[0m\n'
printf '\033[2m  Screen: %s/deployments\033[0m\n\n' "$BASE_URL"
