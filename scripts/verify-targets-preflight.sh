#!/usr/bin/env bash
#
# Target machines: real preflight, encrypted credential, never returned by the API.
#
#   1. Add a target with an SSH key
#   2. Run the preflight, see "Docker ✓ / K3s ✗" without reloading the page
#   3. Check in the database that the credential is encrypted and unreadable
#   4. Check that GET /api/targets/:id never returns the credential
#
# The script mounts a real SSH target (`ssh-target` container, `test` profile)
# equipped with a Docker client plugged into the host's socket. Nothing is
# simulated: `docker info` queries a real daemon. `kubectl` is missing, hence
# "K3s ✗".
#
# Usage:
#   ./scripts/verify-targets-preflight.sh
#   BASE_URL=http://localhost:3100 ./scripts/verify-targets-preflight.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
# Dedicated target: `setup-test-target.sh` registers others, which carry the
# other scripts' deployments. A target carrying a live deployment cannot be
# deleted — it is one of the rules checked here.
TARGET_NAME="${TARGET_NAME:-preflight-target}"
# Key already provisioned by `setup-test-target.sh`, if any.
SHARED_KEY="${SHARED_KEY:-.test-target-key}"
CLIENT_IP="${CLIENT_IP:-198.51.100.42}"
# Host name of the target as seen from the worker.
TARGET_HOST="${TARGET_HOST:-ssh-target}"
TARGET_PORT="${TARGET_PORT:-22}"

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
  local method="$1" path="$2" jar="${3:-}" data="${4:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -H "x-forwarded-for: $CLIENT_IP")
  [ -n "$jar" ] && args+=(-b "$jar" -c "$jar")
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }

step "0. SSH test target"
if [ -f "$SHARED_KEY" ] && docker compose ps ssh-target 2>/dev/null | grep -q ssh-target; then
  # Rebuilding the image would change the authorized key and invalidate the
  # targets already registered by `setup-test-target.sh`. We reuse what exists.
  cp "$SHARED_KEY" "$WORK/id_ed25519"
  cp "$SHARED_KEY.pub" "$WORK/id_ed25519.pub"
  chmod 600 "$WORK/id_ed25519"
  pass "existing key and container reused"
else
  ssh-keygen -q -t ed25519 -N '' -C 'verify-targets-preflight' -f "$WORK/id_ed25519"
  pass "throwaway ed25519 key pair generated"
  TEST_TARGET_PUBLIC_KEY="$(cat "$WORK/id_ed25519.pub")" \
    docker compose --profile test up -d --build ssh-target >/dev/null 2>&1 \
    || fail "could not start the ssh-target container"
fi

for _ in $(seq 1 30); do
  docker compose exec -T ssh-target sh -c 'pgrep sshd >/dev/null' 2>/dev/null && break
  sleep 1
done
docker compose exec -T ssh-target sh -c 'pgrep sshd >/dev/null' \
  || fail "sshd does not start in ssh-target"
pass "ssh-target container ready (docker-cli present, kubectl missing)"
info "$(docker compose exec -T ssh-target docker version --format '{{.Server.Version}}' 2>/dev/null \
        | sed 's/^/Docker daemon seen by the target: /' || echo 'Docker daemon unreachable')"

step "1. Administrator sign-in"
code=$(req POST /api/auth/sign-in/email "$JAR" \
  "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
if [ "$code" != "200" ]; then
  code=$(req POST /api/auth/sign-up/email "$JAR" \
    "{\"name\":\"Admin\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
  [ "$code" = "200" ] || fail "sign-in and sign-up failed (HTTP $code): $(cat "$BODY")"
  pass "administrator created (first run)"
else
  pass "signed in as $ADMIN_EMAIL"
fi

step "2. Adding a target with an SSH key"
# The body is built by jq: the private key spans several lines.
jq -n --arg name "$TARGET_NAME" --arg host "$TARGET_HOST" \
      --argjson port "$TARGET_PORT" --arg key "$(cat "$WORK/id_ed25519")" \
  '{name:$name, host:$host, port:$port, sshUser:"tp", authMethod:"key",
    sudoMethod:"nopasswd", credential:$key, labels:{env:"test"}}' > "$WORK/create.json"

code=$(req POST /api/targets "$JAR" "@$WORK/create.json")

if [ "$code" = "409" ]; then
  # The `(host, port, ssh_user)` uniqueness constraint forbids two targets
  # aimed at the same machine, and a target carrying a live deployment cannot
  # be deleted. So the existing target is reused: its credential is rewritten
  # through the API, which is enough to check encryption and non-exposure.
  req GET /api/targets "$JAR" >/dev/null
  TARGET_ID=$(jq -r --arg h "$TARGET_HOST" --argjson p "$TARGET_PORT" \
    '.items[] | select(.host == $h and .port == $p) | .id' "$BODY" | head -1)
  [ -n "$TARGET_ID" ] || fail "conflict reported but no matching target: $(cat "$BODY")"

  jq '{credential: .credential, labels: .labels}' "$WORK/create.json" > "$WORK/patch.json"
  code=$(req PATCH "/api/targets/$TARGET_ID" "$JAR" "@$WORK/patch.json")
  [ "$code" = "200" ] || fail "PATCH /api/targets/$TARGET_ID → HTTP $code: $(cat "$BODY")"
  pass "existing target reused, credential rewritten: $TARGET_ID"
else
  [ "$code" = "201" ] || fail "POST /api/targets → HTTP $code: $(cat "$BODY")"
  TARGET_ID=$(jq -r .id "$BODY")
  pass "target created: $TARGET_ID"
fi
info "$(jq -c '{name,host,port,sshUser,authMethod,sudoMethod,status}' "$BODY")"

step "3. The credential is never returned by the API"
for path in "/api/targets" "/api/targets/$TARGET_ID"; do
  code=$(req GET "$path" "$JAR")
  [ "$code" = "200" ] || fail "GET $path → HTTP $code"

  # No JSON key, at any depth, must look like a secret.
  leaked=$(jq -r '[paths(scalars) | join(".")] | map(select(
      test("credential|password|privateKey|secret"; "i"))) | join(", ")' "$BODY")
  [ -z "$leaked" ] || fail "$path exposes a sensitive field: $leaked"

  # And the private key's content must appear nowhere.
  grep -qF 'BEGIN OPENSSH PRIVATE KEY' "$BODY" && fail "$path returns the private key"
  grep -qF 'v1:' "$BODY" && fail "$path returns the encrypted value"
  pass "$path: no credential field, no trace of the key"
done

step "4. In the database, the credential is encrypted and unreadable"
stored=$(psql_q "select encrypted_credential from targets where id = '$TARGET_ID';")
[ -n "$stored" ] || fail "no row in the database for $TARGET_ID"

case "$stored" in
  v1:*) pass "versioned format: $(printf '%s' "$stored" | cut -c1-3)…" ;;
  *)    fail "the credential does not start with \"v1:\": $(printf '%s' "$stored" | cut -c1-40)" ;;
esac

fields=$(printf '%s' "$stored" | awk -F: '{print NF}')
[ "$fields" = "4" ] || fail "format attendu version:iv:authTag:ciphertext, $fields champ(s)"
pass "four fields: version:iv:authTag:ciphertext"

printf '%s' "$stored" | grep -qF 'BEGIN OPENSSH PRIVATE KEY' \
  && fail "the private key appears in clear in the database"
printf '%s' "$stored" | grep -qiE 'ssh-ed25519|PRIVATE KEY' \
  && fail "fragments of the key appear in the database"
pass "no readable fragment of the private key"
info "stored length: $(printf '%s' "$stored" | wc -c | tr -d ' ') bytes"
info "$(printf '%s' "$stored" | cut -c1-72)…"

step "5. Running the preflight"
code=$(req POST "/api/targets/$TARGET_ID/preflight" "$JAR" '{}')
[ "$code" = "202" ] || fail "POST preflight → HTTP $code: $(cat "$BODY")"
JOB_ID=$(jq -r .jobId "$BODY")
pass "job queued: $JOB_ID"

deadline=$(( $(date +%s) + 120 ))
state=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep 1
  code=$(req GET "/api/queue/jobs/$JOB_ID" "$JAR")
  [ "$code" = "200" ] || fail "GET /api/queue/jobs/$JOB_ID → HTTP $code"
  state=$(jq -r .state "$BODY")
  case "$state" in
    completed) break ;;
    failed)    fail "preflight failed: $(jq -r .failedReason "$BODY")" ;;
  esac
done
[ "$state" = "completed" ] || fail "the preflight did not complete (state \"$state\")"
pass "job completed — $(jq -c '.result | {status, reachable, runtimes}' "$BODY")"

step "6. Docker ✓ / K3s ✗"
code=$(req GET "/api/targets/$TARGET_ID" "$JAR")
[ "$code" = "200" ] || fail "GET /api/targets/$TARGET_ID → HTTP $code"

jq -e '.runtimesAvailable.docker.available == true' "$BODY" >/dev/null \
  || fail "Docker was not detected: $(jq -c '.runtimesAvailable' "$BODY")"
docker_version=$(jq -r '.runtimesAvailable.docker.version' "$BODY")
[ "$docker_version" != "null" ] || fail "Docker detected but without a version"
pass "Docker ✓ $docker_version"

jq -e '.runtimesAvailable.k3s.available == false' "$BODY" >/dev/null \
  || fail "K3s should not be available: $(jq -c '.runtimesAvailable.k3s' "$BODY")"
pass "K3s ✗ (kubectl missing from the target)"

jq -e '.status == "ok"' "$BODY" >/dev/null \
  || fail "expected status \"ok\", got \"$(jq -r .status "$BODY")\""
pass "status: ok"
info "OS     : $(jq -r '.preflightReport.os.prettyName // "—"' "$BODY")"
info "latency: $(jq -r '.preflightReport.latencyMs' "$BODY") ms"
info "sudo   : $(jq -r 'if .preflightReport.sudo.nopasswd then "without a password" else "password required" end' "$BODY")"
info "disk   : $(jq -r '(.preflightReport.disk.availableKb / 1048576 * 10 | floor / 10 | tostring) + " GiB free"' "$BODY")"
info "tools  : $(jq -r '.preflightReport.tools | to_entries | map(select(.value) | .key) | join(", ")' "$BODY")"

step "7. Update without reloading the page"
# Replays the exact sequence of the client hook (`use-preflight.ts`): reset of
# the status, POST preflight, polling of the job, reading the data again. No
# page load in between — it is what `router.refresh()` does.
psql_q "update targets set status = 'unknown',
          runtimes_available = '{\"docker\":{\"available\":false,\"version\":null,\"composeVersion\":null},\"k3s\":{\"available\":false,\"version\":null,\"nodes\":null,\"readyNodes\":null,\"clusterReady\":false}}'::jsonb
        where id = '$TARGET_ID';" >/dev/null

req GET "/api/targets/$TARGET_ID" "$JAR" >/dev/null
before=$(jq -r '"\(.status) · Docker \(if .runtimesAvailable.docker.available then "✓" else "✗" end)"' "$BODY")
info "avant: $before"

code=$(req POST "/api/targets/$TARGET_ID/preflight" "$JAR" '{}')
[ "$code" = "202" ] || fail "POST preflight → HTTP $code"
job2=$(jq -r .jobId "$BODY")

polls=0
deadline=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep 1
  polls=$((polls + 1))
  req GET "/api/queue/jobs/$job2" "$JAR" >/dev/null
  [ "$(jq -r .state "$BODY")" = "completed" ] && break
done

req GET "/api/targets/$TARGET_ID" "$JAR" >/dev/null
after=$(jq -r '"\(.status) · Docker \(if .runtimesAvailable.docker.available then "✓" else "✗" end) \(.runtimesAvailable.docker.version // "")"' "$BODY")
info "after: $after"

[ "$before" != "$after" ] || fail "the data did not change after the preflight"
jq -e '.runtimesAvailable.docker.available == true' "$BODY" >/dev/null \
  || fail "Docker did not become available again"
pass "data refreshed after $polls poll(s) of /api/queue/jobs/$job2, without reloading the page"

step "8. Each check is independent"
jq -e '[.preflightReport.checks[] | select(.key == "k3s")] | length == 1' "$BODY" >/dev/null \
  || fail "the k3s check is missing from the report"
jq -e '.preflightReport.checks | map(select(.status == "success")) | length >= 6' "$BODY" >/dev/null \
  || fail "too few successful checks: $(jq -c '[.preflightReport.checks[] | {key,status}]' "$BODY")"
pass "$(jq -r '.preflightReport.checks | length' "$BODY") checks run, the missing kubectl made nothing fail"

step "9. Traceability"
# A filter by action rather than a single page: the script can be rerun, and
# the target's creation ends up leaving the twenty most recent entries once a
# few preflights are chained. The assertion, for its part, does not change.
for action in target.created target.preflight.requested target.preflight.completed; do
  code=$(req GET "/api/audit-logs?resourceType=target&action=$action&pageSize=50" "$JAR")
  [ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
  jq -e --arg a "$action" --arg id "$TARGET_ID" \
    '[.items[] | select(.action == $a and .resourceId == $id)] | length > 0' "$BODY" >/dev/null \
    || fail "action \"$action\" missing from the audit log"
  pass "audit: $action"
done

code=$(req GET "/api/audit-logs?resourceType=target&pageSize=50" "$JAR")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
grep -qF 'BEGIN OPENSSH PRIVATE KEY' "$BODY" && fail "the audit log contains the private key"
grep -qE '"v1:[A-Za-z0-9+/]' "$BODY" && fail "the audit log contains the encrypted value"
pass "no credential in the audit log"

step "10. No credential in the worker's logs"
# `grep -c` and not `grep -q`: under `set -o pipefail`, `grep -q` exits at the
# first match, `docker compose logs` gets a SIGPIPE, and the pipe reports the
# producer's failure. On a **negative** assertion like this one, this false
# negative makes the check **pass** although a secret leaked — silence would
# look like success. `grep -c` reads to the end.
if [ "$(docker compose logs worker 2>/dev/null | grep -cF 'BEGIN OPENSSH PRIVATE KEY')" != "0" ]; then
  fail "the private key appears in the worker's logs"
fi
pass "no private key in the worker's logs"

step "11. The RBAC permissions apply to targets too"
code=$(req GET /api/targets "")
[ "$code" = "401" ] || fail "without a session, expected 401, got $code"
pass "without a session → 401"

printf '\n\033[32m✓ Targets and preflight verified.\033[0m\n'
printf '\033[2m  Target kept for inspection in the UI: %s/targets/%s\033[0m\n' "$BASE_URL" "$TARGET_ID"
printf '\033[2m  Cleanup: docker compose --profile test down ssh-target\033[0m\n\n'
