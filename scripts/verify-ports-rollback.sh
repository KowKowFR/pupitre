#!/usr/bin/env bash
#
# Life cycle: port allocation, ufw, and automatic rollback.
#
#   1. Two apps on the SAME Docker target → two distinct ports, two ufw rules
#      (or, if ufw is inactive, the expected warning and nothing broken)
#   2. Destroying the first one → port released, rule removed, the second intact
#   3. A healthy v1, then a v2 whose healthcheck fails → automatic rollback →
#      the URL still answers the v1, `rolled_back` status, diagnostic visible in
#      the logs
#   4. `pnpm typecheck` covers scripts/test-parity.ts — the Docker / K3s parity
#      itself is played by `pnpm test:parity`, which requires two targets
#
# The script takes exactly the same routes as the UI. Prerequisite: a deployable
# Docker target — `./scripts/setup-test-target.sh` provisions one.
#
# Usage:
#   ./scripts/verify-ports-rollback.sh
#   BASE_URL=http://localhost:3100 TARGET_NAME=my-vm ./scripts/verify-ports-rollback.sh
#
# Rerunnable: the test applications are destroyed then recreated at each pass.
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
TARGET_NAME="${TARGET_NAME:-verification-target}"
CLIENT_IP="${CLIENT_IP:-198.51.100.42}"
# Deliberately narrow range: it proves that the range is indeed read on the
# target, and it stays within the ten ports the test container publishes.
RANGE_START="${RANGE_START:-30000}"
RANGE_END="${RANGE_END:-30009}"
# Container carrying the test target: used for the "closest" ufw checks.
TARGET_CONTAINER="${TARGET_CONTAINER:-ssh-target}"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
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

# Better Auth limits repeated sign-ins from the same IP. The verification
# scripts follow one another: we wait rather than fall back by mistake on the
# sign-up, which would give a misleading message.
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
  printf '      2. or promote this account from %s/admin/users\n' "$BASE_URL"
  exit 1
}

# ─── domain helpers ───────────────────────────────────────────────────────────

# Minimal AppSpec: an exposed service, an image, a health route.
spec_json() {
  local name="$1" version="$2" image="$3" health_path="$4"
  jq -n --arg n "$name" --arg v "$version" --arg i "$image" --arg p "$health_path" \
    '{name:$n, version:$v, services:[{
        name:"web",
        source:{type:"image", ref:$i},
        port:80,
        exposed:true,
        healthcheck:{path:$p, intervalSec:2, timeoutSec:3, retries:4}
      }]}'
}

# AppSpec whose **pipeline probe** fails, but whose container is fine.
#
# The nuance is necessary: `docker compose up --wait` already refuses to give
# control back if the container's healthcheck fails, and the faulty step would
# then be `deploy`, not `healthcheck`. Yet the automatic rollback triggers on
# `healthcheck` — it is there that the question "does this deployment really
# serve the application?" is asked.
#
# So the two probes are separated: `healthcheck.port` (80) is the one where the
# server really listens, so the container is healthy; `port` (8080) is the one
# the driver publishes, and nobody listens behind it. The pipeline probes the
# published port from the target and finds a closed door: "unreachable"
# outcome.
spec_json_broken() {
  local name="$1" version="$2" image="$3"
  jq -n --arg n "$name" --arg v "$version" --arg i "$image" \
    '{name:$n, version:$v, services:[{
        name:"web",
        source:{type:"image", ref:$i},
        port:8080,
        exposed:true,
        healthcheck:{path:"/", port:80, intervalSec:2, timeoutSec:3, retries:3}
      }]}'
}

# Creates the application, or replaces its AppSpec if it already exists.
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
  local app_id="$1" target_id="$2" auto_rollback="${3:-true}" code id status
  code=$(req POST /api/deployments \
    "{\"applicationId\":\"$app_id\",\"targetId\":\"$target_id\",\"runtime\":\"docker\",\"proxy\":\"traefik\",\"autoRollback\":$auto_rollback}")
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

# A deployment's complete log, all steps together.
deployment_log() {
  req GET "/api/deployments/$1" >/dev/null
  jq -r '[.steps[].log] | join("")' "$BODY"
}

# `ufw status` on the target. Empty if it cannot be reached directly.
ufw_status() {
  docker compose exec -T "$TARGET_CONTAINER" sh -lc 'ufw status 2>/dev/null || true' 2>/dev/null || true
}

# ─── 1. Context ───────────────────────────────────────────────────────────────

step "1. Sign-in and target"
login
pass "signed in as $ADMIN_EMAIL"

req GET /api/targets >/dev/null
TARGET_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY")
[ -n "$TARGET_ID" ] || fail "target \"$TARGET_NAME\" not found — run ./scripts/setup-test-target.sh"
jq -e --arg n "$TARGET_NAME" \
  '.items[] | select(.name == $n) | .runtimesAvailable.docker.available == true' "$BODY" >/dev/null \
  || fail "the target \"$TARGET_NAME\" has no Docker runtime — run a preflight"
pass "$TARGET_NAME — $TARGET_ID"

step "2. Port range per target"
code=$(req PATCH "/api/targets/$TARGET_ID" \
  "{\"portRangeStart\":$RANGE_START,\"portRangeEnd\":$RANGE_END}")
[ "$code" = "200" ] || fail "PATCH /api/targets/$TARGET_ID → HTTP $code: $(cat "$BODY")"
jq -e --argjson s "$RANGE_START" --argjson e "$RANGE_END" \
  '.portRangeStart == $s and .portRangeEnd == $e' "$BODY" >/dev/null \
  || fail "the range was not saved: $(jq -c '{portRangeStart, portRangeEnd}' "$BODY")"
pass "range of \"$TARGET_NAME\" set to $RANGE_START-$RANGE_END"

# An inverted range must be refused — it is data, not wishful thinking.
code=$(req PATCH "/api/targets/$TARGET_ID" \
  "{\"portRangeStart\":$RANGE_END,\"portRangeEnd\":$RANGE_START}")
[ "$code" = "409" ] || fail "an inverted range should be refused (HTTP $code)"
pass "an inverted range is refused (HTTP 409)"

code=$(req GET "/api/targets/$TARGET_ID/ports")
[ "$code" = "200" ] || fail "GET /api/targets/$TARGET_ID/ports → HTTP $code: $(cat "$BODY")"
jq -e --argjson s "$RANGE_START" --argjson e "$RANGE_END" \
  '.range.min == $s and .range.max == $e and .capacity == ($e - $s + 1)' "$BODY" >/dev/null \
  || fail "GET /ports does not reflect the range: $(jq -c '{range, capacity}' "$BODY")"
pass "GET /api/targets/:id/ports — range, capacity, occupancy, free ports"
info "$(jq -c '{range, capacity, used, free}' "$BODY")"

# ─── 3. Two applications, two ports ───────────────────────────────────────────

step "3. Two applications on the same target → two distinct ports"

APP_A=$(upsert_app 'cycle-alpha' "$(spec_json cycle-alpha 1.0.0 docker.io/library/nginx:1.29-alpine /)")
APP_B=$(upsert_app 'cycle-beta'  "$(spec_json cycle-beta  1.0.0 docker.io/library/nginx:1.29-alpine /)")
pass "applications cycle-alpha and cycle-beta ready"

read -r DEPLOY_A STATUS_A <<< "$(deploy_and_wait "$APP_A" "$TARGET_ID")"
[ "$STATUS_A" = "success" ] \
  || fail "cycle-alpha: status \"$STATUS_A\" — $(deployment_log "$DEPLOY_A" | tail -c 500)"
req GET "/api/deployments/$DEPLOY_A" >/dev/null
PORT_A=$(jq -r '.publishedPort // empty' "$BODY")
pass "cycle-alpha deployed — port $PORT_A"

read -r DEPLOY_B STATUS_B <<< "$(deploy_and_wait "$APP_B" "$TARGET_ID")"
[ "$STATUS_B" = "success" ] \
  || fail "cycle-beta: status \"$STATUS_B\" — $(deployment_log "$DEPLOY_B" | tail -c 500)"
req GET "/api/deployments/$DEPLOY_B" >/dev/null
PORT_B=$(jq -r '.publishedPort // empty' "$BODY")
pass "cycle-beta deployed — port $PORT_B"

[ -n "$PORT_A" ] && [ -n "$PORT_B" ] || fail "a deployment published no port"
[ "$PORT_A" != "$PORT_B" ] || fail "the two applications got the same port ($PORT_A)"
pass "two distinct ports: $PORT_A ≠ $PORT_B"

for port in "$PORT_A" "$PORT_B"; do
  [ "$port" -ge "$RANGE_START" ] && [ "$port" -le "$RANGE_END" ] \
    || fail "port $port falls outside the $RANGE_START-$RANGE_END range declared by the target"
done
pass "both ports fit in the target's $RANGE_START-$RANGE_END range"

for port in "$PORT_A" "$PORT_B"; do
  http=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://127.0.0.1:$port" || echo 000)
  [ "$http" = "200" ] || fail "http://127.0.0.1:$port → HTTP $http"
done
pass "both URLs answer — HTTP 200 on $PORT_A and $PORT_B"

req GET "/api/targets/$TARGET_ID/ports" >/dev/null
jq -e --argjson a "$PORT_A" --argjson b "$PORT_B" \
  '([.allocations[].port] | index($a)) != null and ([.allocations[].port] | index($b)) != null' \
  "$BODY" >/dev/null || fail "GET /ports does not show both reservations"
jq -e '[.allocations[] | select(.applicationSlug == "cycle-alpha")] | length == 1' "$BODY" >/dev/null \
  || fail "GET /ports does not assign the port to the right application"
pass "GET /ports assigns each port to its application"
info "$(jq -rc '[.allocations[] | "\(.applicationSlug)→\(.port)"] | join("  ")' "$BODY")"

# ─── 4. Pare-feu ──────────────────────────────────────────────────────────────

step "4. Pare-feu UFW"
UFW_OUT="$(ufw_status)"
LOG_A="$(deployment_log "$DEPLOY_A")"

if printf '%s' "$UFW_OUT" | grep -qi 'Status: active'; then
  UFW_MODE=active
  printf '%s' "$UFW_OUT" | grep -q "$PORT_A/tcp" \
    || fail "no ufw rule for port $PORT_A"
  printf '%s' "$UFW_OUT" | grep "$PORT_A/tcp" | grep -q 'pupitre:cycle-alpha' \
    || fail "the rule of port $PORT_A does not carry the \"pupitre:cycle-alpha\" comment"
  printf '%s' "$UFW_OUT" | grep "$PORT_B/tcp" | grep -q 'pupitre:cycle-beta' \
    || fail "the rule of port $PORT_B does not carry the \"pupitre:cycle-beta\" comment"
  pass "two ufw rules created, each with its pupitre:{slug} comment"
elif printf '%s' "$UFW_OUT" | grep -qi 'Status: inactive'; then
  UFW_MODE=inactive
  printf '%s' "$LOG_A" | grep -qE 'ufw inactif|ufw is inactive' \
    || fail "ufw is inactive on the target, but there is no warning in the deployment's logs"
  pass "ufw inactive on the target → warning emitted, and nothing broke"
  info "$(printf '%s' "$LOG_A" | grep -oE 'ufw (inactif|is inactive)[^"]*' | head -1)"
  warn "\"ufw active\" path not tested here: the test target does not enable it"
else
  UFW_MODE=unknown
  warn "could not read \"ufw status\" on $TARGET_CONTAINER — check through the logs alone"
  printf '%s' "$LOG_A" | grep -qE 'ufw (allow|inactif|absent|is inactive|is not installed)' \
    || fail "the deployment said nothing about the firewall"
  pass "the deployment did rule on the firewall"
fi

# ─── 5. Destroy: the port is given back, the neighbor is intact ───────────────

step "5. Destroying the first one → port released, the second intact"
destroy_and_wait "$DEPLOY_A"
pass "cycle-alpha destroyed"

req GET "/api/targets/$TARGET_ID/ports" >/dev/null
jq -e --argjson a "$PORT_A" '([.allocations[].port] | index($a)) == null' "$BODY" >/dev/null \
  || fail "port $PORT_A is still reserved after the destroy"
pass "port $PORT_A released — it can be allocated again"

jq -e --argjson b "$PORT_B" '([.allocations[].port] | index($b)) != null' "$BODY" >/dev/null \
  || fail "destroying cycle-alpha took away cycle-beta's reservation"
pass "cycle-beta's reservation is intact"

http=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://127.0.0.1:$PORT_B" || echo 000)
[ "$http" = "200" ] || fail "cycle-beta no longer answers after its neighbor's destroy (HTTP $http)"
pass "cycle-beta still answers — HTTP 200 on $PORT_B"

http=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT_A" || echo 000)
[ "$http" != "200" ] || fail "cycle-alpha still answers on $PORT_A after destruction"
pass "nothing listens on $PORT_A any more"

if [ "$UFW_MODE" = active ]; then
  UFW_OUT="$(ufw_status)"
  printf '%s' "$UFW_OUT" | grep -q "$PORT_A/tcp" \
    && fail "the ufw rule of port $PORT_A survives the destroy"
  printf '%s' "$UFW_OUT" | grep "$PORT_B/tcp" | grep -q 'pupitre:cycle-beta' \
    || fail "the destroy took away cycle-beta's ufw rule"
  pass "ufw rule of $PORT_A removed through its comment, the one of $PORT_B intact"
else
  LOG_A="$(deployment_log "$DEPLOY_A")"
  printf '%s' "$LOG_A" | grep -qE 'ufw (inactif|absent|is inactive|is not installed)' \
    || fail "the destroy said nothing about the firewall"
  pass "ufw $UFW_MODE: the destroy flags it and does not fail"
fi

# ─── 6. Automatic rollback ────────────────────────────────────────────────────

step "6. Healthy v1, v2 with a broken healthcheck → automatic rollback"

APP_C=$(upsert_app 'cycle-rollback' \
  "$(spec_json cycle-rollback 1.0.0 docker.io/library/nginx:1.29-alpine /)")
read -r DEPLOY_V1 STATUS_V1 <<< "$(deploy_and_wait "$APP_C" "$TARGET_ID")"
[ "$STATUS_V1" = "success" ] \
  || fail "the v1 was supposed to succeed, status \"$STATUS_V1\" — $(deployment_log "$DEPLOY_V1" | tail -c 500)"
req GET "/api/deployments/$DEPLOY_V1" >/dev/null
PORT_C=$(jq -r '.publishedPort // empty' "$BODY")
V1_BODY="$(curl -s --max-time 15 "http://127.0.0.1:$PORT_C" || true)"
printf '%s' "$V1_BODY" | grep -qi 'nginx' \
  || fail "the v1 does not serve the expected nginx page on $PORT_C"
pass "v1 (nginx) deployed and healthy — port $PORT_C"

# The v2 changes image and publishes a port behind which nothing listens: the
# container starts and declares itself healthy, but the application is
# unreachable through the path the panel exposes. It is the `healthcheck` step
# that finds out — exactly the case the automatic rollback must catch.
upsert_app 'cycle-rollback' \
  "$(spec_json_broken cycle-rollback 2.0.0 docker.io/library/httpd:2.4-alpine)" >/dev/null
read -r DEPLOY_V2 STATUS_V2 <<< "$(deploy_and_wait "$APP_C" "$TARGET_ID" true)"

[ "$STATUS_V2" = "rolled_back" ] \
  || fail "expected \"rolled_back\", got \"$STATUS_V2\" — $(deployment_log "$DEPLOY_V2" | tail -c 800)"
pass "\"rolled_back\" status — distinct from \"failed\""

req GET "/api/deployments/$DEPLOY_V2" >/dev/null
jq -e '.failedStep == "healthcheck"' "$BODY" >/dev/null \
  || fail "the failed step should be \"healthcheck\": $(jq -r .failedStep "$BODY")"
jq -e '[.steps[] | select(.key == "rollback" and .status == "success")] | length == 1' "$BODY" >/dev/null \
  || fail "the \"rollback\" step did not succeed: $(jq -c '[.steps[] | {key, status}]' "$BODY")"
pass "\"healthcheck\" step failed, \"rollback\" step succeeded"

# The diagnostic is captured before the rollback wipes the scene.
HEALTH_ERROR=$(jq -r '[.steps[] | select(.key == "healthcheck") | .error] | join("")' "$BODY")
printf '%s' "$HEALTH_ERROR" | grep -q 'docker compose ps' \
  || fail "the diagnostic was not captured in deployment_steps.error"
printf '%s' "$HEALTH_ERROR" | grep -q 'docker compose logs' \
  || fail "the services' logs are missing from the diagnostic"
printf '%s' "$HEALTH_ERROR" | grep -qiE 'injoignable|unreachable' \
  || fail "the \"unreachable\" outcome is not named: $(printf '%s' "$HEALTH_ERROR" | head -c 120)"
pass "diagnostic captured — docker compose ps + logs, \"unreachable\" outcome"
info "$(printf '%s' "$HEALTH_ERROR" | head -1 | cut -c1-110)"

LOG_V2="$(deployment_log "$DEPLOY_V2")"
printf '%s' "$LOG_V2" | grep -q 'docker compose ps' \
  || fail "the diagnostic was not broadcast in the log stream"
pass "diagnostic present in the stream too (so in the SSE)"

V2_BODY="$(curl -s --max-time 15 "http://127.0.0.1:$PORT_C" || true)"
printf '%s' "$V2_BODY" | grep -qi 'nginx' \
  || fail "after the rollback, the URL does not serve the v1: $(printf '%s' "$V2_BODY" | head -c 120)"
printf '%s' "$V2_BODY" | grep -qi 'it works' \
  && fail "after the rollback, it is still the v2 (httpd) that answers"
pass "http://127.0.0.1:$PORT_C serves the v1 (nginx) again"

req GET "/api/targets/$TARGET_ID/ports" >/dev/null
jq -e --argjson c "$PORT_C" '([.allocations[].port] | index($c)) != null' "$BODY" >/dev/null \
  || fail "the rollback released port $PORT_C, although the v1 runs on it"
pass "port $PORT_C kept: a version still runs on it"

step "7. Traceability of the rollback"
code=$(req GET "/api/audit-logs?resourceType=deployment&pageSize=50")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
jq -e --arg id "$DEPLOY_V2" \
  '[.items[] | select(.action == "deployment.rolled_back.automatic" and .resourceId == $id)] | length > 0' \
  "$BODY" >/dev/null || fail "no \"deployment.rolled_back.automatic\" in the audit log"
AUDIT=$(jq -c --arg id "$DEPLOY_V2" \
  'first(.items[] | select(.action == "deployment.rolled_back.automatic" and .resourceId == $id))
   | {from: .before.version, to: .after.restoredVersion, reason: (.after.reason | tostring | .[0:60])}' \
  "$BODY")
pass "audit: deployment.rolled_back.automatic"
info "$AUDIT"
printf '%s' "$AUDIT" | grep -q '"from":"2.0.0"' || fail "the audit does not say which version we come from"
printf '%s' "$AUDIT" | grep -q '"to":"1.0.0"' || fail "the audit does not say which version we go to"
pass "the audit names the version left, the version restored and the reason"

step "8. Version history and redeployment"
code=$(req GET "/api/applications/$APP_C/versions")
[ "$code" = "200" ] || fail "GET /api/applications/$APP_C/versions → HTTP $code"
jq -e '.items | length >= 2' "$BODY" >/dev/null || fail "the history should carry at least two versions"
jq -e '[.items[] | select(.status == "rolled_back")] | length >= 1' "$BODY" >/dev/null \
  || fail "the history does not show the rolled-back version"
jq -e '[.items[] | select(.appVersion == "1.0.0" and .redeployable)] | length >= 1' "$BODY" >/dev/null \
  || fail "the v1 should be redeployable (frozen AppSpec)"
pass "GET /api/applications/:id/versions — $(jq -r '.items | length' "$BODY") version(s), target, status, author"
info "$(jq -rc '[.items[] | "#\(.version) \(.appVersion) \(.status)"] | join("  ")' "$BODY")"

V1_ID=$(jq -r 'first(.items[] | select(.appVersion == "1.0.0" and .redeployable) | .deploymentId)' "$BODY")
code=$(req POST "/api/applications/$APP_C/redeploy" \
  "{\"versionId\":\"$V1_ID\",\"targetId\":\"$TARGET_ID\"}")
[ "$code" = "202" ] || fail "POST /api/applications/:id/redeploy → HTTP $code: $(cat "$BODY")"
REDEPLOY_ID=$(jq -r .id "$BODY")
jq -e '.appVersion == "1.0.0"' "$BODY" >/dev/null \
  || fail "the redeployment does not replay the requested version's AppSpec"
pass "POST /api/applications/:id/redeploy — replays the frozen 1.0.0 AppSpec"

for _ in $(seq 1 150); do
  sleep 2
  req GET "/api/deployments/$REDEPLOY_ID" >/dev/null
  REDEPLOY_STATUS=$(jq -r .status "$BODY")
  case "$REDEPLOY_STATUS" in success|failed|rolled_back) break ;; esac
done
[ "$REDEPLOY_STATUS" = "success" ] \
  || fail "the redeployment ended as \"$REDEPLOY_STATUS\" — $(deployment_log "$REDEPLOY_ID" | tail -c 500)"
pass "the v1 redeployment succeeded"

# Retention: the five most recent versions, plus the one `current` points to if
# it is not among them — which is the case after a rollback. Hence six at worst,
# and never more.
RELEASES=$(docker compose exec -T "$TARGET_CONTAINER" \
  sh -lc 'ls -1d /opt/bootstrap/apps/cycle-rollback/*/ 2>/dev/null | grep -v /current/ | wc -l' \
  2>/dev/null | tr -d ' \r' || echo '')
if [ -n "$RELEASES" ] && [ "$RELEASES" -gt 0 ] 2>/dev/null; then
  [ "$RELEASES" -le 6 ] || fail "$RELEASES version directories on the target, the retention keeps 5 (+ current)"
  pass "retention: $RELEASES version directory(ies) kept on the target (5 + current)"
else
  warn "version directories unreadable from this workstation — retention not checked"
fi

# ─── 9. Parity ────────────────────────────────────────────────────────────────

step "9. Docker / K3s parity"
if pnpm typecheck >"$WORK/typecheck.log" 2>&1; then
  pass "pnpm typecheck passes — scripts/test-parity.ts still compiles"
else
  tail -20 "$WORK/typecheck.log"
  fail "pnpm typecheck fails"
fi
warn "test-parity.ts is NOT run here: it requires two targets — see \`pnpm test:parity\`"

# ─── cleanup ──────────────────────────────────────────────────────────────────

step "10. Cleanup"
destroy_and_wait "$REDEPLOY_ID"
destroy_and_wait "$DEPLOY_B"
pass "test deployments destroyed"

printf '\n\033[32m✓ Ports, ufw and rollback verified.\033[0m\n'
printf '\033[2m  ufw: %s · ports %s and %s allocated then given back · rollback %s → %s\033[0m\n' \
  "$UFW_MODE" "$PORT_A" "$PORT_B" "2.0.0" "1.0.0"
printf '\n'
