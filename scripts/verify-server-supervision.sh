#!/usr/bin/env bash
#
# Checks per-server supervision:
#
#   1. the readout of a reachable target returns CONSISTENT metrics —
#      cross-checked with the machine itself (nproc, /proc/loadavg, /proc/meminfo)
#   2. a missing metric returns `null`, never zero, and does not take the rest
#      away
#   3. an UNREACHABLE target returns a readout with an explicit error, and its
#      applications stay listed
#   4. the screen groups by server: an application appears under its target,
#      and under it alone
#   5. `target:read` is required to read a machine
#   6. the readout goes through the QUEUE, not through an SSH session opened by
#      the panel
#
# Prerequisite: a deployable Docker target — `./scripts/setup-test-target.sh`
# provisions one. The script creates its own application and its own dead
# target, and deletes both at the end.
#
# Usage:
#   ./scripts/verify-server-supervision.sh
#   BASE_URL=http://localhost:3100 TARGET_NAME=my-vm ./scripts/verify-server-supervision.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
CLIENT_IP="${CLIENT_IP:-198.51.100.42}"
TARGET_NAME="${TARGET_NAME:-verification-target}"
# Docker-in-docker container carrying the target: it is the one queried
# directly to cross-check the readout, and on it that a command is hidden.
TARGET_SERVICE="${TARGET_SERVICE:-ssh-target}"

# The script's own material. Nothing that already existed is touched.
APP_NAME="${APP_NAME:-verif-supervision-serveur}"
DEAD_TARGET_NAME="${DEAD_TARGET_NAME:-verif-supervision-injoignable}"
# TEST-NET-3 (RFC 5737): documented as non-routable, so unreachable everywhere
# and forever — not somebody else's host that we would go and probe.
DEAD_HOST="${DEAD_HOST:-203.0.113.10}"
# Second dead address, to cut off the target carrying the application
# temporarily: `targets` enforces the uniqueness of (host, port, ssh_user), and
# reusing the first one would make the switch fail on a constraint.
DEAD_HOST_FLIP="${DEAD_HOST_FLIP:-203.0.113.11}"
ROLE_KEY="${ROLE_KEY:-verif-supervision-sans-cible}"
VIEWER_EMAIL="${VIEWER_EMAIL:-supervision-sans-cible@example.test}"
VIEWER_PASSWORD="${VIEWER_PASSWORD:-motdepasse-tres-long}"
IMAGE_OK="${IMAGE_OK:-docker.io/library/nginx:1.29-alpine}"
KEY_PATH="${KEY_PATH:-.test-target-key}"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
VIEWER_JAR="$WORK/viewer.jar"
BODY="$WORK/body.json"
HTML="$WORK/apps.html"

# What the script changed on the machine or in the database, and that it must
# give back as it found it even if it dies along the way. Each entry is
# "name|path": `df` lives in /bin and `nproc` in /usr/bin, putting them back at
# the same place is not an assumption we can afford.
HIDDEN=''
ORIGINAL_HOST=''
TARGET_ID=''

restore_all() {
  local entry name path
  for entry in $HIDDEN; do
    name="${entry%%|*}"
    path="${entry#*|}"
    docker compose exec -T "$TARGET_SERVICE" \
      sh -lc "[ -f /tmp/$name.hidden ] && mv /tmp/$name.hidden '$path'" >/dev/null 2>&1 || true
  done
  if [ -n "$ORIGINAL_HOST" ] && [ -n "$TARGET_ID" ]; then
    docker compose exec -T postgres psql -U tp -d tp -tAc \
      "update targets set host = '$ORIGINAL_HOST' where id = '$TARGET_ID';" >/dev/null 2>&1 || true
  fi
}

trap 'restore_all; rm -rf "$WORK"' EXIT

command -v jq >/dev/null || { echo "jq is required"; exit 1; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
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

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }

# Command run ON the target machine, to cross-check the readout.
on_target() { docker compose exec -T "$TARGET_SERVICE" sh -lc "$1" | tr -d '\r'; }

assert_admin() {
  local role
  role=$(jq -r '.user.role // empty' "$BODY")
  [ "$role" = "admin" ] && return 0
  fail "\"$ADMIN_EMAIL\" has the role \"${role:-none}\", not \"admin\" — see /admin/users"
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

# Reads a target and leaves the report in $BODY. Echoes: the HTTP code.
metrics() { req GET "/api/targets/$1/metrics"; }

# Hides a command on the target machine, to try out the "missing" path.
hide_command() {
  local name="$1" path
  path=$(on_target "command -v $name")
  [ -n "$path" ] || fail "\"$name\" is already missing from the target — nothing to try out"
  on_target "mv '$path' /tmp/$name.hidden" >/dev/null
  HIDDEN="$HIDDEN $name|$path"
}

restore_command() {
  local name="$1" entry path=''
  for entry in $HIDDEN; do
    if [ "${entry%%|*}" = "$name" ]; then path="${entry#*|}"; fi
  done
  [ -n "$path" ] || fail "\"$name\" was not hidden by this script"
  on_target "mv /tmp/$name.hidden '$path'" >/dev/null
  HIDDEN=$(printf '%s' "$HIDDEN" | sed "s#[[:space:]]*$name|[^ ]*##")
}

# Cuts the /apps page into per-server sections and returns the given target's.
#
# The attribute only exists in this literal form in the DOM: in the RSC payload
# embedded further down, it is serialized as escaped JSON
# (`\"data-server-id\":\"…\"`). So the cutting cannot get the wrong half.
server_section() {
  awk -v RS='data-server-id="' -v id="$1" 'index($0, id) == 1 { print; exit }' "$HTML"
}

step "1. Sign-in"
login
pass "signed in as $ADMIN_EMAIL"

step "2. Prerequisites"
# `grep -q` closes the pipe at the first success: under `pipefail`, the
# producer dies of a SIGPIPE and makes the whole pipeline fail. So the output is
# materialized before being filtered, here as everywhere else in this script.
RUNNING=$(docker compose ps --format '{{.Service}}' 2>/dev/null || true)
printf '%s\n' "$RUNNING" | grep -qx "$TARGET_SERVICE" \
  || fail "the \"$TARGET_SERVICE\" container is not running — run ./scripts/setup-test-target.sh"

code=$(req GET /api/targets)
[ "$code" = "200" ] || fail "GET /api/targets → HTTP $code"
TARGET_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY" | head -1)
[ -n "$TARGET_ID" ] || fail "target \"$TARGET_NAME\" not found — run ./scripts/setup-test-target.sh"
ORIGINAL_HOST=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .host' "$BODY" | head -1)
pass "target \"$TARGET_NAME\" — $TARGET_ID ($ORIGINAL_HOST)"

# A second registered target serves as the control for the grouping test: an
# application must only appear under its own.
WITNESS_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name != $n) | .id' "$BODY" | head -1)


# Cleanup from an interrupted previous run. Entirely "best effort": nothing it
# does is a criterion, it only levels the ground again.
precleanup() {
  local ids id
  req GET /api/apps >/dev/null || true
  ids=$(jq -r --arg s "$APP_NAME" '.items[] | select(.applicationSlug == $s) | .id' "$BODY" 2>/dev/null || true)
  for id in $ids; do
    info "leftover from a previous run: deployment $id — destruction"
    req DELETE "/api/deployments/$id" >/dev/null || true
    for _ in $(seq 1 90); do
      sleep 2
      req GET "/api/deployments/$id" >/dev/null || true
      if [ "$(jq -r '.status // ""' "$BODY")" = "destroyed" ]; then break; fi
    done
    req DELETE "/api/deployments/$id/purge" >/dev/null || true
  done

  req GET /api/applications >/dev/null || true
  id=$(jq -r --arg s "$APP_NAME" '.items[] | select(.slug == $s) | .id' "$BODY" 2>/dev/null | head -1)
  if [ -n "$id" ]; then req DELETE "/api/applications/$id" >/dev/null || true; fi

  req GET /api/targets >/dev/null || true
  id=$(jq -r --arg n "$DEAD_TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY" 2>/dev/null | head -1)
  if [ -n "$id" ]; then req DELETE "/api/targets/$id" >/dev/null || true; fi

  id=$(psql_q "select id from users where email = '$VIEWER_EMAIL';" 2>/dev/null || true)
  if [ -n "$id" ]; then req DELETE "/api/admin/users/$id" >/dev/null || true; fi
  req DELETE "/api/admin/roles/$ROLE_KEY" >/dev/null 2>&1 || true
}

step "3. Material: an application deployed on the target"
precleanup

# Starting snapshot, taken AFTER the cleanup: at the end of the script, it must be identical.
req GET /api/apps >/dev/null
LIVE_BEFORE=$(jq -r '[.items[].applicationSlug] | sort | join(",")' "$BODY")
info "applications running before the test: ${LIVE_BEFORE:-none}"

jq -n --arg n "$APP_NAME" --arg i "$IMAGE_OK" \
  '{appSpec:{name:$n, version:"1.0.0", services:[{
      name:"web", source:{type:"image", ref:$i}, port:80, exposed:true,
      healthcheck:{path:"/", intervalSec:2, timeoutSec:3, retries:4}}]}}' > "$WORK/app.json"

req GET /api/applications >/dev/null
APP_ID=$(jq -r --arg s "$APP_NAME" '.items[] | select(.slug == $s) | .id' "$BODY" | head -1)
if [ -n "$APP_ID" ]; then
  code=$(req PATCH "/api/applications/$APP_ID" "@$WORK/app.json")
  [ "$code" = "200" ] || fail "PATCH /api/applications/$APP_ID → HTTP $code: $(cat "$BODY")"
else
  code=$(req POST /api/applications "@$WORK/app.json")
  [ "$code" = "201" ] || fail "POST /api/applications → HTTP $code: $(cat "$BODY")"
  APP_ID=$(jq -r .id "$BODY")
fi
APP_SLUG=$(jq -r '.slug' "$BODY")
pass "application \"$APP_SLUG\" ($APP_ID)"

code=$(req POST /api/deployments \
  "{\"applicationId\":\"$APP_ID\",\"targetId\":\"$TARGET_ID\",\"runtime\":\"docker\",\"proxy\":\"traefik\",\"autoRollback\":false}")
[ "$code" = "202" ] || fail "POST /api/deployments → HTTP $code: $(cat "$BODY")"
DEP_ID=$(jq -r .id "$BODY")

DEP_STATUS=''
for _ in $(seq 1 150); do
  sleep 2
  req GET "/api/deployments/$DEP_ID" >/dev/null
  DEP_STATUS=$(jq -r .status "$BODY")
  case "$DEP_STATUS" in success|failed|rolled_back|destroyed) break ;; esac
done
[ "$DEP_STATUS" = "success" ] \
  || fail "deployment $DEP_ID ended as \"$DEP_STATUS\": $(jq -r '.error // ""' "$BODY")"
pass "deployment $DEP_ID running"

step "4. A consistent readout, cross-checked with the machine"
code=$(metrics "$TARGET_ID")
[ "$code" = "200" ] || fail "GET /api/targets/$TARGET_ID/metrics → HTTP $code: $(cat "$BODY")"
cp "$BODY" "$WORK/metrics.json"
jq -e '.reachable == true' "$BODY" >/dev/null || fail "the target is announced unreachable"
pass "readout taken with $(jq -r '.latencyMs' "$BODY") ms of SSH latency"

# ── cores: exact value, otherwise the load is comparable to nothing
REAL_CORES=$(on_target 'nproc')
API_CORES=$(jq -r '.load.cores' "$BODY")
[ "$API_CORES" = "$REAL_CORES" ] || fail "cores: the readout says $API_CORES, the machine says $REAL_CORES"
pass "cores: $API_CORES — identical to \"nproc\" on the machine"

# ── load: a value that moves between two readings, the order of magnitude is checked
REAL_LOAD=$(on_target 'cat /proc/loadavg' | awk '{print $1}')
API_LOAD=$(jq -r '.load.one' "$BODY")
awk -v a="$API_LOAD" -v b="$REAL_LOAD" 'BEGIN { exit !(a >= 0 && b >= 0 && (a - b < 2) && (b - a < 2)) }' \
  || fail "load: the readout says $API_LOAD, the machine says $REAL_LOAD — gap too large"
pass "1 min load: $API_LOAD (machine: $REAL_LOAD) — /proc/loadavg agrees"

# ── the load relative to the cores, which is the only comparable value
API_PER_CORE=$(jq -r '.load.perCore' "$BODY")
awk -v p="$API_PER_CORE" -v l="$API_LOAD" -v c="$API_CORES" \
  'BEGIN { d = p - l / c; if (d < 0) d = -d; exit !(d < 0.01) }' \
  || fail "perCore ($API_PER_CORE) is not load/cores ($API_LOAD/$API_CORES)"
pass "load per core: $API_PER_CORE — that is $API_LOAD ÷ $API_CORES"

# ── memory: MemTotal is stable, it is required down to the kibibyte
REAL_MEMTOTAL=$(on_target 'cat /proc/meminfo' | awk '/^MemTotal:/ {print $2}')
API_MEMTOTAL=$(jq -r '.memory.totalKb' "$BODY")
[ "$API_MEMTOTAL" = "$REAL_MEMTOTAL" ] \
  || fail "MemTotal: the readout says $API_MEMTOTAL kB, the machine says $REAL_MEMTOTAL kB"
pass "MemTotal: $API_MEMTOTAL kB — identical to /proc/meminfo"

# `MemAvailable` and not `MemFree`: on Linux, "free" memory is cache.
jq -e '.memory.availableKb > 0 and .memory.usedKb == (.memory.totalKb - .memory.availableKb)' \
  "$BODY" >/dev/null || fail "the used memory does not derive from MemAvailable"
pass "used = MemTotal − MemAvailable ($(jq -r '.memory.usedPercent' "$BODY") %)"

# ── disk: the partition carrying the deployments, not only `/`
API_DISK_PATH=$(jq -r '.disk.path' "$BODY")
REAL_DF=$(on_target "df -Pk '$API_DISK_PATH'" | tail -1 | awk '{print $2}')
API_DISK_SIZE=$(jq -r '.disk.sizeKb' "$BODY")
[ "$API_DISK_SIZE" = "$REAL_DF" ] \
  || fail "disk: the readout says $API_DISK_SIZE kB, \"df -Pk $API_DISK_PATH\" says $REAL_DF kB"
pass "disk \"$API_DISK_PATH\": $API_DISK_SIZE kB — identical to df -Pk"

# ── uptime and kernel
REAL_UPTIME=$(on_target 'cat /proc/uptime' | awk '{printf "%d", $1}')
API_UPTIME=$(jq -r '.uptimeSeconds' "$BODY")
awk -v a="$API_UPTIME" -v b="$REAL_UPTIME" 'BEGIN { d = a - b; if (d < 0) d = -d; exit !(d < 120) }' \
  || fail "uptime: the readout says $API_UPTIME s, the machine says $REAL_UPTIME s"
pass "uptime: $API_UPTIME s (machine: $REAL_UPTIME s)"

REAL_KERNEL=$(on_target 'uname -r')
API_KERNEL=$(jq -r '.os.kernel' "$BODY")
[ "$API_KERNEL" = "$REAL_KERNEL" ] || fail "kernel: \"$API_KERNEL\" ≠ \"$REAL_KERNEL\""
pass "kernel: $API_KERNEL — $(jq -r '.os.prettyName' "$BODY")"

jq -e '[.probes[] | select(.status == "failed")] | length == 0' "$BODY" >/dev/null \
  || fail "a readout failed: $(jq -c '[.probes[] | select(.status == "failed")]' "$BODY")"
pass "the $(jq -r '.probes | length' "$BODY") readouts passed"

step "5. A missing metric returns \"null\", not zero"
hide_command nproc
code=$(metrics "$TARGET_ID")
[ "$code" = "200" ] || fail "GET metrics without nproc → HTTP $code: $(cat "$BODY")"

jq -e '.load.cores == null' "$BODY" >/dev/null \
  || fail "cores: expected null, got $(jq -c '.load.cores' "$BODY")"
jq -e '.load.perCore == null' "$BODY" >/dev/null \
  || fail "perCore: expected null, got $(jq -c '.load.perCore' "$BODY")"
pass "without \"nproc\": cores = null and perCore = null — not 0, not 1"

jq -e '.load.one >= 0 and .memory != null and .disk != null and .uptimeSeconds != null' "$BODY" \
  >/dev/null || fail "the whole readout was taken away by the lack of nproc"
pass "the rest of the readout survives — load $(jq -r '.load.one' "$BODY"), memory, disk, uptime"

jq -e '[.probes[] | select(.key == "cpu")] | .[0].status == "failed" and (.[0].error | test("nproc"))' \
  "$BODY" >/dev/null || fail "the \"cpu\" readout does not say why it failed"
pass "the reason is stated: $(jq -r '[.probes[] | select(.key == "cpu")] | .[0].error' "$BODY")"

restore_command nproc

# Same trial on the disk: a missing command must never become "0 %".
hide_command df
code=$(metrics "$TARGET_ID")
[ "$code" = "200" ] || fail "GET metrics without df → HTTP $code"
jq -e '.disk == null' "$BODY" >/dev/null \
  || fail "disk: expected null, got $(jq -c '.disk' "$BODY")"
jq -e '.memory != null and .load != null' "$BODY" >/dev/null \
  || fail "the lack of df took away the memory or the load"
pass "without \"df\": disk = null, memory and load intact"
restore_command df

code=$(metrics "$TARGET_ID")
jq -e '.load.cores != null and .disk != null' "$BODY" >/dev/null \
  || fail "the commands were not given back to the machine"
pass "commands restored, readout complete again"

step "6. An unreachable target"
# a) a target that never answered
jq -n --arg n "$DEAD_TARGET_NAME" --arg h "$DEAD_HOST" --arg key "$(cat "$KEY_PATH")" \
  '{name:$n, host:$h, port:22, sshUser:"tp", authMethod:"key", sudoMethod:"nopasswd",
    credential:$key, labels:{env:"test"}, portRangeStart:30000, portRangeEnd:30009}' \
  > "$WORK/dead.json"
req GET /api/targets >/dev/null
DEAD_ID=$(jq -r --arg n "$DEAD_TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY" | head -1)
if [ -z "$DEAD_ID" ]; then
  code=$(req POST /api/targets "@$WORK/dead.json")
  [ "$code" = "201" ] || fail "POST /api/targets → HTTP $code: $(cat "$BODY")"
  DEAD_ID=$(jq -r .id "$BODY")
fi
pass "dead target \"$DEAD_TARGET_NAME\" ($DEAD_HOST) — $DEAD_ID"

code=$(metrics "$DEAD_ID")
[ "$code" = "200" ] || fail "an unreachable target must return 200 with a report, not $code"
jq -e '.reachable == false and (.error | length > 0)' "$BODY" >/dev/null \
  || fail "the report does not say why: $(cat "$BODY")"
jq -e '.load == null and .memory == null and .disk == null and .uptimeSeconds == null' "$BODY" \
  >/dev/null || fail "an unreachable target returned metrics"
pass "readout with an explicit error: $(jq -r '.error' "$BODY")"

# b) the target CARRYING the application becomes unreachable
#    (switch in the database: changing the host through the API would re-encode
#    the credential for nothing, while we want exactly the same target at a
#    dead address)
psql_q "update targets set host = '$DEAD_HOST_FLIP' where id = '$TARGET_ID';" >/dev/null
pass "\"$TARGET_NAME\" temporarily points to $DEAD_HOST_FLIP"

code=$(metrics "$TARGET_ID")
[ "$code" = "200" ] || fail "GET metrics on a cut-off target → HTTP $code"
jq -e '.reachable == false' "$BODY" >/dev/null || fail "the cut-off target is announced reachable"
pass "readout impossible, and the report says so: $(jq -r '.error' "$BODY")"

code=$(req GET /api/apps)
[ "$code" = "200" ] || fail "GET /api/apps → HTTP $code"
jq -e --arg id "$DEP_ID" '[.items[] | select(.id == $id)] | length == 1' "$BODY" >/dev/null \
  || fail "the application disappeared from supervision because its machine no longer answers"
pass "the application \"$APP_SLUG\" stays listed although its machine no longer answers"

curl -s -b "$JAR" -c "$JAR" "$BASE_URL/apps" -o "$HTML"
printf '%s\n' "$(server_section "$TARGET_ID")" | grep -q "href=\"/apps?app=$DEP_ID\"" \
  || fail "the screen no longer shows the application under its unreachable target"
pass "the screen still shows it, under its server"

psql_q "update targets set host = '$ORIGINAL_HOST' where id = '$TARGET_ID';" >/dev/null
NOW_HOST=$(psql_q "select host from targets where id = '$TARGET_ID';")
[ "$NOW_HOST" = "$ORIGINAL_HOST" ] || fail "the target did not get its host back ($NOW_HOST)"
pass "\"$TARGET_NAME\" given back $ORIGINAL_HOST"
ORIGINAL_HOST=''

step "7. The screen groups by server"
curl -s -b "$JAR" -c "$JAR" "$BASE_URL/apps" -o "$HTML"
grep -q 'data-server-id="' "$HTML" || fail "no server rendered on /apps"
SERVERS=$(grep -o 'data-server-id="[^"]*"' "$HTML" | wc -l | tr -d ' ')
pass "$SERVERS server(s) rendered, one panel each"

printf '%s\n' "$(server_section "$TARGET_ID")" | grep -q "href=\"/apps?app=$DEP_ID\"" \
  || fail "\"$APP_SLUG\" does not appear under \"$TARGET_NAME\""
pass "\"$APP_SLUG\" appears under \"$TARGET_NAME\""

# … and under it alone: no other section must contain it.
FOREIGN=0
for id in $(grep -o 'data-server-id="[^"]*"' "$HTML" | sed 's/data-server-id="//; s/"$//'); do
  [ "$id" = "$TARGET_ID" ] && continue
  if printf '%s\n' "$(server_section "$id")" | grep -q "href=\"/apps?app=$DEP_ID\""; then
    FOREIGN=$((FOREIGN + 1))
    info "found under $id too"
  fi
done
[ "$FOREIGN" = "0" ] || fail "the application appears under $FOREIGN server(s) that are not its own"
pass "it appears under no other server"

# A server without an application says so rather than offering an empty disclosure.
if [ -n "$WITNESS_ID" ]; then
  WITNESS_SECTION=$(server_section "$WITNESS_ID")
  printf '%s' "$WITNESS_SECTION" | grep -qE 'Aucune application supervisée|No monitored application' \
    || fail "the control server does not announce that it is empty"
  if printf '%s' "$WITNESS_SECTION" | grep -q 'data-server-disclosure'; then
    fail "an empty server must not offer a disclosure"
  fi
  pass "a server without an application says so, and offers no disclosure"
fi

# The populated server's disclosure is a real button, and it announces its state.
SECTION=$(server_section "$TARGET_ID")
printf '%s' "$SECTION" | grep -q 'aria-expanded="' || fail "the disclosure does not announce its state"
printf '%s' "$SECTION" | grep -q 'aria-controls="' || fail "the disclosure does not designate its panel"
printf '%s' "$SECTION" | grep -q '<button[^>]*aria-expanded' \
  || fail "the disclosure is not a <button> — it would not be operable with the keyboard"
PANEL_ID=$(printf '%s' "$SECTION" | grep -o 'aria-controls="[^"]*"' | head -1 | sed 's/aria-controls="//; s/"$//')
printf '%s' "$SECTION" | grep -q "id=\"$PANEL_ID\"" \
  || fail "aria-controls designates \"$PANEL_ID\", which does not exist in the page"
pass "disclosure: <button aria-expanded> → panel \"$PANEL_ID\", present in the page"

step "8. \"target:read\" is required"
req DELETE "/api/admin/roles/$ROLE_KEY" >/dev/null 2>&1 || true
code=$(req POST /api/admin/roles \
  "{\"key\":\"$ROLE_KEY\",\"label\":\"Supervision sans cible\",\"permissions\":[\"deployment:read\"]}")
[ "$code" = "201" ] || fail "POST /api/admin/roles → HTTP $code: $(cat "$BODY")"
pass "role \"$ROLE_KEY\": deployment:read only"

code=$(req POST /api/admin/users \
  "{\"name\":\"Supervision sans cible\",\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\",\"role\":\"$ROLE_KEY\"}")
case "$code" in
  201) pass "user created with this role" ;;
  409) pass "user already present" ;;
  *)   fail "POST /api/admin/users → HTTP $code: $(cat "$BODY")" ;;
esac
VIEWER_ID=$(psql_q "select id from users where email = '$VIEWER_EMAIL';")

code=$(req POST /api/auth/sign-in/email \
  "{\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\"}" "$VIEWER_JAR")
[ "$code" = "200" ] || fail "tester sign-in → HTTP $code: $(cat "$BODY")"

code=$(req GET "/api/targets/$TARGET_ID/metrics" '' "$VIEWER_JAR")
[ "$code" = "403" ] || fail "readout without target:read: expected 403, got $code"
jq -e '.error.code == "forbidden" and .error.details.permission == "target:read"' "$BODY" >/dev/null \
  || fail "the refusal does not name the missing permission: $(cat "$BODY")"
pass "readout refused → 403, permission \"target:read\" named"

DENIED=$(psql_q "select count(*) from audit_logs
  where action = 'permission.denied' and resource_id = 'target:read'
    and actor_id = '$VIEWER_ID';")
[ "$DENIED" -ge 1 ] || fail "the refusal was not logged"
pass "refusal traced in the audit log ($DENIED row(s))"

# The screen stays viewable: seeing what runs only requires deployment:read.
curl -s -b "$VIEWER_JAR" -c "$VIEWER_JAR" "$BASE_URL/apps" -o "$WORK/viewer.html"
grep -q "$APP_SLUG" "$WORK/viewer.html" || fail "the tester no longer sees the applications"
grep -qE 'Relevé indisponible|Readout unavailable' "$WORK/viewer.html" \
  || fail "the screen does not say why it shows no metric"
pass "they see the applications, and the screen announces \"readout unavailable\""

step "9. The readout goes through the queue, not through a panel SSH session"
# `panel` and `worker` share ONE image (docker-compose.yml, x-app-image anchor):
# `/app/node_modules` is the worker's dependency tree, and `ssh2` is necessarily
# there — it is what opens the sessions. A `find /` on the panel container
# therefore sees it, and would see it even without this work. What must stay
# empty is the panel's **traced bundle**, `/app/web`: `ssh2` or `node-ssh` in
# it would mean that SSH session code leaked into Next's graph.
PANEL_SSH2=$(docker compose exec -T panel find /app/web -name ssh2 2>/dev/null || true)
PANEL_NODESSH=$(docker compose exec -T panel find /app/web -name node-ssh 2>/dev/null || true)
[ -z "$PANEL_SSH2$PANEL_NODESSH" ] \
  || fail "the panel's bundle ships an SSH layer: $PANEL_SSH2 $PANEL_NODESSH"
pass "no \"ssh2\" nor \"node-ssh\" in /app/web — the panel cannot open a session"
info "the image is shared with the worker: /app/node_modules does carry ssh2, it is its place"

# The positive proof: a `target:metrics` job was indeed consumed.
JOB_NAMES=$(docker compose exec -T redis sh -lc \
  'for k in $(redis-cli --scan --pattern "bull:supervision:*"); do redis-cli HGET "$k" name; done' \
  | tr -d '\r' | sort -u | paste -sd' ' -)
printf '%s' "$JOB_NAMES" | grep -q 'target:metrics' \
  || fail "no \"target:metrics\" job in the supervision queue (seen: $JOB_NAMES)"
pass "the \"supervision\" queue carries \"target:metrics\" jobs"

WORKER_LOG=$(docker compose logs worker --since 30m 2>&1 || true)
printf '%s\n' "$WORKER_LOG" | grep -q 'metrics reading completed' \
  || fail "the worker never logged a readout"
pass "it is the worker that opened the SSH sessions"

step "10. Cleanup"
code=$(req DELETE "/api/deployments/$DEP_ID")
[ "$code" = "202" ] || fail "DELETE /api/deployments/$DEP_ID → HTTP $code: $(cat "$BODY")"
for _ in $(seq 1 90); do
  sleep 2
  req GET "/api/deployments/$DEP_ID" >/dev/null
  [ "$(jq -r .status "$BODY")" = "destroyed" ] && break
done
[ "$(jq -r .status "$BODY")" = "destroyed" ] || fail "the deployment was not destroyed"
pass "deployment destroyed on the target"

code=$(req DELETE "/api/deployments/$DEP_ID/purge")
[ "$code" = "200" ] || info "purge → HTTP $code: $(jq -r '.error.message // ""' "$BODY")"
code=$(req DELETE "/api/applications/$APP_ID")
[ "$code" = "200" ] || [ "$code" = "204" ] || fail "DELETE /api/applications/$APP_ID → HTTP $code"
pass "application \"$APP_SLUG\" deleted"

code=$(req DELETE "/api/targets/$DEAD_ID")
[ "$code" = "200" ] || [ "$code" = "204" ] || fail "DELETE /api/targets/$DEAD_ID → HTTP $code"
pass "dead target deleted"

if [ -n "$VIEWER_ID" ]; then req DELETE "/api/admin/users/$VIEWER_ID" >/dev/null; fi
code=$(req DELETE "/api/admin/roles/$ROLE_KEY")
[ "$code" = "200" ] || fail "DELETE /api/admin/roles/$ROLE_KEY → HTTP $code: $(cat "$BODY")"
pass "test user and role deleted"

req GET /api/apps >/dev/null
LIVE_AFTER=$(jq -r '[.items[].applicationSlug] | sort | join(",")' "$BODY")
[ "$LIVE_AFTER" = "$LIVE_BEFORE" ] \
  || fail "the inventory changed: \"$LIVE_BEFORE\" → \"$LIVE_AFTER\""
pass "the running applications are exactly those from before: ${LIVE_AFTER:-none}"

printf '\n\033[32m✓ Per-server supervision verified.\033[0m\n'
printf '\033[2m  Screen: %s/apps\033[0m\n\n' "$BASE_URL"
