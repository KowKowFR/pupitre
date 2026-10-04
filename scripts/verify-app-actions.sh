#!/usr/bin/env bash
#
# The operating gestures of a running application, on BOTH runtimes.
#
#   1. Stop       → the processes stop, nothing is taken down: the volume's data
#                   survives, the port stays reserved, the address stops
#                   answering. On Compose the containers stay `exited`; on K3s
#                   the Deployments go to zero replicas and the PVCs, Service and
#                   Ingress stay in place.
#   2. Start      → the same version starts again, the port is taken back, the
#                   data is still there, the health becomes `healthy` again.
#   3. Refusals   → stopping twice, starting what runs, restarting what is
#                   stopped, rolling back without a previous version: four 409s
#                   that name the reason, not four dead buttons.
#   4. RBAC       → a viewer gets 403 on `deployment:restart`, and the refusal is
#                   in the activity log.
#   5. Audit      → `app.stop.requested`, `app.stopped`, `app.start.requested`,
#                   `app.started` with the actor and the IP.
#   6. Destroy    → from the application screen, it is the deployment's route
#                   that is called: nothing left on the machine, port given back,
#                   namespace gone.
#
# The script takes exactly the same routes as the interface.
#
# Prerequisites: a deployable Docker target and K3s target.
#   ./scripts/setup-test-target.sh   provisions the first one
#   docs/getting-started.md          explains the second one
#
# Usage:
#   ./scripts/verify-app-actions.sh
#   BASE_URL=http://localhost:3006 ./scripts/verify-app-actions.sh
#   ONLY=docker ./scripts/verify-app-actions.sh      # a single runtime
#
# Rerunnable: the test applications are destroyed at the end of the run, and
# recreated at each pass.
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
VIEWER_EMAIL="${VIEWER_EMAIL:-viewer@example.test}"
VIEWER_PASSWORD="${VIEWER_PASSWORD:-motdepasse-tres-long}"
DOCKER_TARGET="${DOCKER_TARGET:-verification-target}"
K3S_TARGET="${K3S_TARGET:-verification-k3s-target}"
# Containers carrying the test targets: used for the "closest" checks, those
# that look at the machine and not at the panel's database.
DOCKER_CONTAINER="${DOCKER_CONTAINER:-pupitre-ssh-target-1}"
K3S_CONTAINER="${K3S_CONTAINER:-pupitre-k3s-target-1}"
# Port through which the workstation reaches the K3s target's Ingress.
K3S_HTTP_PORT="${K3S_HTTP_PORT:-8080}"
CLIENT_IP="${CLIENT_IP:-198.51.100.77}"
# `docker`, `k3s`, or empty for both.
ONLY="${ONLY:-}"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
VIEWER_JAR="$WORK/viewer.jar"
BODY="$WORK/body.json"
trap 'rm -rf "$WORK"' EXIT

command -v jq >/dev/null || { echo "jq is required"; exit 1; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
info() { printf '    \033[2m%s\033[0m\n' "$1"; }

req() {
  local method="$1" path="$2" data="${3:-}" jar="${4:-$JAR}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -H "x-forwarded-for: $CLIENT_IP" -b "$jar" -c "$jar")
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}

# ─── sign-in ──────────────────────────────────────────────────────────────────

login() {
  local code
  for _ in 1 2 3 4 5; do
    code=$(req POST /api/auth/sign-in/email \
      "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
    case "$code" in
      200) break ;;
      429) sleep 6 ;;
      *)
        code=$(req POST /api/auth/sign-up/email \
          "{\"name\":\"Admin\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
        [ "$code" = "200" ] || fail "sign-in failed (HTTP $code): $(cat "$BODY")"
        break
        ;;
    esac
  done
  [ "$(jq -r '.user.role // empty' "$BODY")" = "admin" ] \
    || fail "\"$ADMIN_EMAIL\" is not an administrator — rerun with an admin account"
}

# ─── domain helpers ───────────────────────────────────────────────────────────

# Minimal AppSpec, with a volume: it is what proves that stopping loses nothing.
# Empty `ingress_host` = exposure through a published port (Docker).
spec_json() {
  local name="$1" ingress_host="$2"
  jq -n --arg n "$name" --arg h "$ingress_host" '
    {
      name: $n,
      version: "1.0.0",
      services: [{
        name: "web",
        source: { type: "image", ref: "docker.io/library/nginx:1.29-alpine" },
        port: 80,
        exposed: true,
        volumes: [{ name: "donnees", mountPath: "/data", size: "1Gi" }],
        healthcheck: { path: "/", intervalSec: 2, timeoutSec: 3, retries: 6 }
      }]
    }
    + (if $h == "" then {} else { ingress: { host: $h, tls: false, targetService: "web" } } end)'
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

deploy_and_wait() {
  local app_id="$1" target_id="$2" runtime="$3" code id status
  code=$(req POST /api/deployments \
    "{\"applicationId\":\"$app_id\",\"targetId\":\"$target_id\",\"runtime\":\"$runtime\",\"proxy\":\"traefik\",\"autoRollback\":false}")
  [ "$code" = "202" ] || fail "POST /api/deployments → HTTP $code: $(cat "$BODY")"
  id=$(jq -r .id "$BODY")

  for _ in $(seq 1 180); do
    sleep 2
    req GET "/api/deployments/$id" >/dev/null
    status=$(jq -r .status "$BODY")
    case "$status" in
      success|failed|rolled_back|destroyed) printf '%s %s' "$id" "$status"; return ;;
    esac
  done
  fail "deployment $id did not complete in 6 minutes (status \"$status\")"
}

deployment_log() {
  req GET "/api/deployments/$1" >/dev/null
  jq -r '[.steps[].log] | join("")' "$BODY"
}

# State read through the same route as the screen: `GET /api/apps/:id/state`.
app_state() {
  local code
  code=$(req GET "/api/apps/$1/state")
  [ "$code" = "200" ] || fail "GET /api/apps/$1/state → HTTP $code: $(cat "$BODY")"
}

# Queues a gesture, then waits for the state to switch.
#
# Several attempts are planned, and it is an assumed admission: in development,
# two worktrees can each run their worker on the same Redis, and the one that
# does not know the job's name refuses it instead of giving it back. With a
# single worker — the normal case —, the first attempt is always enough.
#
# A 409 along the way is not a failure: it is the proof that an earlier attempt
# ended up taking. The state is checked again before concluding.
GESTURE_ATTEMPTS="${GESTURE_ATTEMPTS:-4}"

gesture_and_wait() {
  local deployment_id="$1" path="$2" expect="$3" attempt code
  for attempt in $(seq 1 "$GESTURE_ATTEMPTS"); do
    code=$(req POST "/api/apps/$deployment_id/$path")
    if [ "$code" = "409" ]; then
      app_state "$deployment_id"
      jq -e "$expect" "$BODY" >/dev/null && return 0
      fail "POST /api/apps/$deployment_id/$path → 409: $(jq -r '.error.message' "$BODY")"
    fi
    [ "$code" = "202" ] || fail "POST /api/apps/$deployment_id/$path → HTTP $code: $(cat "$BODY")"

    for _ in $(seq 1 25); do
      sleep 2
      app_state "$deployment_id"
      if jq -e "$expect" "$BODY" >/dev/null; then return 0; fi
    done
    warn "\"$path\" without effect in 50 s (attempt $attempt) — asking again"
  done
  fail "the \"$path\" gesture changed nothing: $(jq -c '{stoppedAt,status}' "$BODY")"
}

# Expected refusal: the code AND the reason, because a mute 409 is worth nothing.
expect_conflict() {
  local method="$1" path="$2" needle="$3" code
  code=$(req "$method" "$path")
  [ "$code" = "409" ] || fail "$method $path: expected 409, got $code — $(cat "$BODY")"
  jq -e --arg n "$needle" '.error.message | test($n)' "$BODY" >/dev/null \
    || fail "$method $path: unexpected message — $(jq -r '.error.message' "$BODY")"
  pass "409 — $(jq -r '.error.message' "$BODY")"
}

# HTTP code, or 000 when nothing answers. `curl -w` already prints "000" on a
# refused connection, but it exits with an error: without this guard, `set -e`
# would stop the script at the very moment when the lack of an answer is the
# expected result.
http_code() {
  local url="$1" host="${2:-}" out
  local args=(-s -o /dev/null -w '%{http_code}' --max-time 10 "$url")
  [ -n "$host" ] && args+=(-H "Host: $host")
  out=$(curl "${args[@]}" 2>/dev/null || true)
  printf '%s' "${out:-000}"
}

on_docker() { docker exec "$DOCKER_CONTAINER" sh -c "$1"; }
on_k3s() { docker exec "$K3S_CONTAINER" sh -c "$1"; }

# The log is filtered by action on the server side; the sorting by resource is
# done here, `auditQuerySchema` not exposing `resourceId`.
audit_count() {
  local action="$1" resource="$2" code
  code=$(req GET "/api/audit-logs?action=$action&pageSize=100")
  [ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code: $(cat "$BODY")"
  jq -r --arg r "$resource" '[.items[] | select(.resourceId == $r)] | length' "$BODY"
}

# ─── 0. Context ───────────────────────────────────────────────────────────────

step "0. The panel answers, and we sign in"
code=$(req GET /api/health)
[ "$code" = "200" ] || fail "GET /api/health → HTTP $code"
pass "/api/health → $(jq -c '{status,db,redis}' "$BODY")"
login
pass "signed in as $ADMIN_EMAIL"

req GET /api/targets >/dev/null
DOCKER_TARGET_ID=$(jq -r --arg n "$DOCKER_TARGET" '.items[] | select(.name == $n) | .id' "$BODY")
K3S_TARGET_ID=$(jq -r --arg n "$K3S_TARGET" '.items[] | select(.name == $n) | .id' "$BODY")

RUNTIMES=""
if [ "$ONLY" = "" ] || [ "$ONLY" = "docker" ]; then
  [ -n "$DOCKER_TARGET_ID" ] || fail "target \"$DOCKER_TARGET\" not found"
  RUNTIMES="docker"
  pass "Docker target \"$DOCKER_TARGET\" — $DOCKER_TARGET_ID"
fi
if [ "$ONLY" = "" ] || [ "$ONLY" = "k3s" ]; then
  [ -n "$K3S_TARGET_ID" ] || fail "target \"$K3S_TARGET\" not found"
  RUNTIMES="$RUNTIMES k3s"
  pass "K3s target \"$K3S_TARGET\" — $K3S_TARGET_ID"
fi

# ─── the same sequence, on each runtime ───────────────────────────────────────

for RUNTIME in $RUNTIMES; do
  if [ "$RUNTIME" = "docker" ]; then
    SLUG="geste-docker"; TARGET_ID="$DOCKER_TARGET_ID"; TARGET_NAME="$DOCKER_TARGET"
    INGRESS_HOST=""
  else
    SLUG="geste-k3s"; TARGET_ID="$K3S_TARGET_ID"; TARGET_NAME="$K3S_TARGET"
    INGRESS_HOST="geste-k3s.localtest.me"
  fi
  NAMESPACE="app-$SLUG"

  step "── $RUNTIME ──  1. A running application on \"$TARGET_NAME\""
  APP_ID=$(upsert_app "$SLUG" "$(spec_json "$SLUG" "$INGRESS_HOST")")
  read -r DEPLOY_ID STATUS <<< "$(deploy_and_wait "$APP_ID" "$TARGET_ID" "$RUNTIME")"
  [ "$STATUS" = "success" ] \
    || fail "$SLUG: status \"$STATUS\" — $(deployment_log "$DEPLOY_ID" | tail -c 800)"

  app_state "$DEPLOY_ID"
  PORT=$(jq -r '.publishedPort // empty' "$BODY")
  jq -e '.stoppedAt == null' "$BODY" >/dev/null || fail "a new application is declared stopped"
  pass "$SLUG deployed — deployment $DEPLOY_ID${PORT:+, port $PORT}"

  # A mark written in the volume: it is what will tell, after the stop and the
  # restart, whether the data survived. A count of containers does not prove
  # it.
  MARK="marque-$(date +%s)"
  if [ "$RUNTIME" = "docker" ]; then
    CONTAINER=$(on_docker "docker ps -q --filter label=com.docker.compose.project=$NAMESPACE" | head -1)
    [ -n "$CONTAINER" ] || fail "no container for the $NAMESPACE project"
    on_docker "docker exec $CONTAINER sh -c 'echo $MARK > /data/marque'" >/dev/null
  else
    on_k3s "kubectl -n $NAMESPACE exec deploy/web -- sh -c 'echo $MARK > /data/marque'" >/dev/null
  fi
  pass "mark \"$MARK\" written in the volume"

  if [ "$RUNTIME" = "docker" ]; then
    HTTP=$(http_code "http://127.0.0.1:$PORT")
    [ "$HTTP" = "200" ] || fail "http://127.0.0.1:$PORT → HTTP $HTTP"
    pass "the address answers — HTTP 200 on port $PORT"
  else
    HTTP=$(http_code "http://127.0.0.1:$K3S_HTTP_PORT/" "$INGRESS_HOST")
    if [ "$HTTP" = "200" ]; then
      pass "the Ingress answers — HTTP 200 on $INGRESS_HOST"
    else
      warn "the Ingress answers HTTP $HTTP from the workstation — check deferred to the pods"
    fi
  fi

  # ─── 2. Stop ────────────────────────────────────────────────────────────────

  step "── $RUNTIME ──  2. Stop"
  gesture_and_wait "$DEPLOY_ID" stop '.stoppedAt != null'
  pass "stopped — stoppedAt = $(jq -r .stoppedAt "$BODY")"

  jq -e '.status == "success"' "$BODY" >/dev/null \
    || fail "the deployment status moved: $(jq -r .status "$BODY") — a stop is not an outcome"
  pass "the deployment status stays \"success\": stopping is not undoing"

  if [ "$RUNTIME" = "docker" ]; then
    STATES=$(on_docker "docker ps -a --filter label=com.docker.compose.project=$NAMESPACE --format '{{.State}}'" | tr '\n' ' ')
    printf '%s' "$STATES" | grep -q 'exited' \
      || fail "the $NAMESPACE containers are not stopped: \"$STATES\""
    printf '%s' "$STATES" | grep -q 'running' \
      && fail "a $NAMESPACE container still runs: \"$STATES\""
    pass "containers in the \"exited\" state — they are not deleted"

    VOLUMES=$(on_docker "docker volume ls -q --filter label=com.docker.compose.project=$NAMESPACE" | wc -l | tr -d ' ')
    [ "$VOLUMES" -ge 1 ] || fail "the $NAMESPACE volumes disappeared"
    pass "$VOLUMES volume(s) still in place"

    HTTP=$(http_code "http://127.0.0.1:$PORT")
    [ "$HTTP" = "000" ] || fail "port $PORT still answers (HTTP $HTTP) after the stop"
    pass "port $PORT no longer answers — the binding is given back with the container"
  else
    REPLICAS=$(on_k3s "kubectl -n $NAMESPACE get deploy -o jsonpath='{.items[*].spec.replicas}'" | tr -d ' ')
    [ "$REPLICAS" = "0" ] || fail "the Deployments are not at zero replicas: \"$REPLICAS\""
    pass "Deployments at zero replicas"

    PODS=$(on_k3s "kubectl -n $NAMESPACE get pods --no-headers 2>/dev/null | wc -l" | tr -d ' ')
    [ "$PODS" = "0" ] || fail "$PODS pod(s) remain in $NAMESPACE"
    pass "no pod left in $NAMESPACE"

    KEPT=$(on_k3s "kubectl -n $NAMESPACE get pvc,svc,ingress --no-headers 2>/dev/null | wc -l" | tr -d ' ')
    [ "$KEPT" -ge 3 ] || fail "PVC, Service or Ingress disappeared ($KEPT left)"
    pass "PVC, Service and Ingress kept ($KEPT objects)"

    HTTP=$(http_code "http://127.0.0.1:$K3S_HTTP_PORT/" "$INGRESS_HOST")
    [ "$HTTP" != "200" ] || fail "the Ingress still serves the application after the stop"
    pass "the Ingress no longer serves the application (HTTP $HTTP) — the object stays, the workload is gone"
  fi

  # The port stays reserved: nobody else must be able to take it.
  if [ "$RUNTIME" = "docker" ]; then
    req GET "/api/targets/$TARGET_ID/ports" >/dev/null
    jq -e --argjson p "$PORT" --arg s "$SLUG" \
      '[.allocations[] | select(.port == $p and .applicationSlug == $s)] | length == 1' "$BODY" \
      >/dev/null || fail "the reservation of port $PORT was given back during the stop"
    pass "port $PORT stays reserved for \"$SLUG\" during the stop"
  fi

  step "── $RUNTIME ──  3. The refusals"
  expect_conflict POST "/api/apps/$DEPLOY_ID/stop" 'déjà arrêtée|been stopped since'
  expect_conflict POST "/api/apps/$DEPLOY_ID/restart" 'démarrez-la|start it rather'

  # ─── 4. Start ───────────────────────────────────────────────────────────────

  step "── $RUNTIME ──  4. Start"
  gesture_and_wait "$DEPLOY_ID" start '.stoppedAt == null'
  pass "started — stoppedAt null again"

  expect_conflict POST "/api/apps/$DEPLOY_ID/start" "n'est pas arrêtée|is not stopped"

  if [ "$RUNTIME" = "docker" ]; then
    CONTAINER=$(on_docker "docker ps -q --filter label=com.docker.compose.project=$NAMESPACE" | head -1)
    [ -n "$CONTAINER" ] || fail "no running container after the start"
    READ_BACK=$(on_docker "docker exec $CONTAINER cat /data/marque" | tr -d '\r\n')
    HTTP=$(http_code "http://127.0.0.1:$PORT")
  else
    READ_BACK=$(on_k3s "kubectl -n $NAMESPACE exec deploy/web -- cat /data/marque" | tr -d '\r\n')
    HTTP=$(http_code "http://127.0.0.1:$K3S_HTTP_PORT/" "$INGRESS_HOST")
  fi

  [ "$READ_BACK" = "$MARK" ] \
    || fail "the volume's mark was lost: \"$READ_BACK\" instead of \"$MARK\""
  pass "the mark \"$MARK\" is intact — the stop lost nothing"

  if [ "$HTTP" = "200" ]; then
    pass "the address answers again — HTTP 200"
  elif [ "$RUNTIME" = "k3s" ]; then
    warn "the Ingress answers HTTP $HTTP from the workstation"
  else
    fail "port $PORT does not answer after the start (HTTP $HTTP)"
  fi

  app_state "$DEPLOY_ID"
  jq -e --argjson p "${PORT:-null}" '.publishedPort == $p' "$BODY" >/dev/null \
    || fail "the published port changed: $(jq -r .publishedPort "$BODY")"
  pass "same version, same port: the start redeployed nothing"

  # ─── 5. L'audit ─────────────────────────────────────────────────────────────

  step "── $RUNTIME ──  5. The activity log"
  # The audit entry is written by the worker **after** the gesture and its
  # health probe: it arrives a few seconds after the state switch we waited
  # for. We leave it that delay rather than racing the worker.
  for action in app.stop.requested app.stopped app.start.requested app.started; do
    COUNT=0
    for _ in $(seq 1 15); do
      COUNT=$(audit_count "$action" "$DEPLOY_ID")
      [ "$COUNT" -ge 1 ] && break
      sleep 2
    done
    [ "$COUNT" -ge 1 ] || fail "no \"$action\" entry for $DEPLOY_ID"
    pass "$action — $COUNT entry(ies)"
  done
  req GET "/api/audit-logs?action=app.stopped&pageSize=100" >/dev/null
  jq -e --arg r "$DEPLOY_ID" --arg ip "$CLIENT_IP" \
    '[.items[] | select(.resourceId == $r)][0] | .ip == $ip and .actorEmail != null' "$BODY" \
    >/dev/null || fail "the actor or their IP is missing from the audit: $(jq -c '.items[0]' "$BODY")"
  pass "the actor and their IP are traced — $(jq -rc --arg r "$DEPLOY_ID" '[.items[] | select(.resourceId == $r)][0] | {actorEmail, ip, action}' "$BODY")"

  # ─── 6. Rolling back, without a previous version ────────────────────────────

  step "── $RUNTIME ──  6. Going back to the previous version, when there is none"
  app_state "$DEPLOY_ID"
  if jq -e '.previous == null' "$BODY" >/dev/null; then
    expect_conflict POST "/api/deployments/$DEPLOY_ID/rollback" 'nulle part où revenir|nowhere to go back'
  else
    info "this application has a previous version ($(jq -r .previous.version "$BODY")) — refusal not applicable"
  fi

  # ─── 7. Destroy ─────────────────────────────────────────────────────────────

  step "── $RUNTIME ──  7. Destroy"
  code=$(req DELETE "/api/deployments/$DEPLOY_ID")
  [ "$code" = "202" ] || fail "DELETE /api/deployments/$DEPLOY_ID → HTTP $code: $(cat "$BODY")"
  for _ in $(seq 1 90); do
    sleep 2
    req GET "/api/deployments/$DEPLOY_ID" >/dev/null
    [ "$(jq -r .status "$BODY")" = "destroyed" ] && break
  done
  [ "$(jq -r .status "$BODY")" = "destroyed" ] || fail "the deployment was not destroyed"
  pass "deployment destroyed"

  if [ "$RUNTIME" = "docker" ]; then
    LEFT=$(on_docker "docker ps -aq --filter label=com.docker.compose.project=$NAMESPACE | wc -l" | tr -d ' ')
    [ "$LEFT" = "0" ] || fail "$LEFT container(s) remain for $NAMESPACE"
    VOL_LEFT=$(on_docker "docker volume ls -q --filter label=com.docker.compose.project=$NAMESPACE | wc -l" | tr -d ' ')
    [ "$VOL_LEFT" = "0" ] || fail "$VOL_LEFT volume(s) remain for $NAMESPACE"
    pass "no container nor volume left for $NAMESPACE"

    req GET "/api/targets/$TARGET_ID/ports" >/dev/null
    jq -e --argjson p "$PORT" '[.allocations[] | select(.port == $p)] | length == 0' "$BODY" \
      >/dev/null || fail "port $PORT is still reserved after the destruction"
    pass "port $PORT is given back to the pool"
  else
    NS_LEFT=$(on_k3s "kubectl get ns $NAMESPACE --no-headers 2>/dev/null | wc -l" | tr -d ' ')
    [ "$NS_LEFT" = "0" ] || fail "the $NAMESPACE namespace still exists"
    pass "the $NAMESPACE namespace is gone"
  fi

  # A destroyed application has no gestures left: the route says so.
  code=$(req POST "/api/apps/$DEPLOY_ID/stop")
  [ "$code" = "409" ] || fail "stopping a destroyed deployment: expected 409, got $code"
  pass "409 — $(jq -r '.error.message' "$BODY")"
done

# ─── 8. RBAC ──────────────────────────────────────────────────────────────────

step "8. RBAC: a viewer cannot stop"
code=$(req POST /api/admin/users \
  "{\"name\":\"Vera Viewer\",\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\",\"role\":\"viewer\"}")
case "$code" in
  201|409) : ;;
  *) fail "POST /api/admin/users → HTTP $code: $(cat "$BODY")" ;;
esac

req GET /api/admin/users >/dev/null
VIEWER_ACCOUNT_ID=$(jq -r --arg e "$VIEWER_EMAIL" '.items[] | select(.email == $e) | .id' "$BODY" | head -1)
[ -n "$VIEWER_ACCOUNT_ID" ] || fail "account \"$VIEWER_EMAIL\" not found"
# Another script may have given it another role: we realign, otherwise the test
# proves nothing.
code=$(req PATCH "/api/admin/users/$VIEWER_ACCOUNT_ID/role" '{"role":"viewer"}')
[ "$code" = "200" ] || fail "realigning the role → HTTP $code: $(cat "$BODY")"

code=$(req POST /api/auth/sign-in/email \
  "{\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\"}" "$VIEWER_JAR")
[ "$code" = "200" ] || fail "viewer sign-in → HTTP $code: $(cat "$BODY")"
VIEWER_ID=$(jq -r '.user.id' "$BODY")
pass "signed in as a viewer — $VIEWER_ID"

# The identifier does not need to exist: RBAC decides before the database.
PROBE_ID="00000000-0000-4000-8000-000000000000"
for path in stop start; do
  code=$(req POST "/api/apps/$PROBE_ID/$path" "" "$VIEWER_JAR")
  [ "$code" = "403" ] || fail "viewer on /$path: expected 403, got $code — $(cat "$BODY")"
  jq -e '.error.details.permission == "deployment:restart"' "$BODY" >/dev/null \
    || fail "the refused permission is not \"deployment:restart\": $(cat "$BODY")"
  pass "403 on /$path — permission \"deployment:restart\""
done

# Reading, the viewer sees the state: it is `deployment:read`, like the page.
code=$(req GET "/api/apps/$PROBE_ID/state" "" "$VIEWER_JAR")
[ "$code" = "404" ] || fail "viewer on /state: expected 404 (permission granted), got $code"
pass "the viewer reads the state (404 on an unknown identifier, not 403)"

step "9. The refusal is in the activity log"
code=$(req GET "/api/audit-logs?action=permission.denied&actorId=$VIEWER_ID&pageSize=1")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
jq -e '.items | length >= 1' "$BODY" >/dev/null || fail "no refusal traced for the viewer"
pass "permission.denied — $(jq -rc '.items[0] | {actorEmail, action, ip}' "$BODY")"

printf '\n\033[32m✓ all checks passed\033[0m\n'
