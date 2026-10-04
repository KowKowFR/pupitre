#!/usr/bin/env bash
#
# Checks the setup guide:
#
#   1. on a blank state, the guide is offered — and the redirect fires
#   2. the redirect does not repeat: nobody is trapped in the screen
#   3. a step cleared is persisted, and survives a new sign-in
#   4. skipping an optional step is distinct from completing it
#   5. a target created by the guide is IDENTICAL to a target created through
#      /targets/new — same columns, same audit, same preflight queued
#   6. a viewer is offered no step they cannot complete
#   7. finishing makes the guide disappear, and it does not come back
#   8. restarting from the settings rearms it
#   9. the audit keeps what was done
#
# Usage:
#   ./scripts/verify-onboarding.sh
#   BASE_URL=http://localhost:3200 ./scripts/verify-onboarding.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
VIEWER_EMAIL="${VIEWER_EMAIL:-onboarding-viewer@example.test}"
VIEWER_PASSWORD="${VIEWER_PASSWORD:-motdepasse-tres-long}"
CLIENT_IP="${CLIENT_IP:-198.51.100.61}"
# Compose command aimed at the stack to check. Can be overridden to run the
# script against an isolated stack: DC="docker compose -p my-stack".
DC="${DC:-docker compose}"

# The two targets to compare. They differ ONLY by name and host: everything
# else must be identical in the database, otherwise the guide would have a
# creation path of its own.
TARGET_A="${TARGET_A:-verif-onboarding-ecran}"
TARGET_B="${TARGET_B:-verif-onboarding-assistant}"
HOST_A="127.0.0.2"
HOST_B="127.0.0.3"
# Port 2: nothing listens, the connection is refused immediately. The preflight
# fails in one second instead of keeping the worker busy for a minute — it is a
# shared environment.
DEAD_PORT=2
CREDENTIAL='verification-onboarding-credential-en-clair'

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
JAR2="$WORK/admin-2.jar"
VIEWER_JAR="$WORK/viewer.jar"
BODY="$WORK/body.json"
trap 'rm -rf "$WORK"' EXIT

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

# HTML page, without following redirects: it is the redirect itself we want to
# observe. Returns "code|location".
page() {
  local path="$1" jar="${2:-$JAR}"
  curl -s -o /dev/null -w '%{http_code}|%{redirect_url}' \
    -H "x-forwarded-for: $CLIENT_IP" -b "$jar" -c "$jar" "$BASE_URL$path"
}

psql_q() { $DC exec -T postgres psql -U tp -d tp -tAc "$1"; }

login() {
  local jar="${1:-$JAR}" code
  for _ in 1 2 3 4 5; do
    code=$(req POST /api/auth/sign-in/email \
      "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" "$jar")
    case "$code" in
      200) assert_admin; return 0 ;;
      429) sleep 6 ;;
      *)   break ;;
    esac
  done
  code=$(req POST /api/auth/sign-up/email \
    "{\"name\":\"Admin\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" "$jar")
  [ "$code" = "200" ] || fail "sign-in failed (HTTP $code): $(cat "$BODY")"
  assert_admin
}

assert_admin() {
  local role
  role=$(jq -r '.user.role // empty' "$BODY")
  [ "$role" = "admin" ] && return 0
  fail "\"$ADMIN_EMAIL\" has the role \"${role:-none}\", not \"admin\" — see /admin/users"
}

onboarding_json() { psql_q "select value->'onboarding' from app_settings where id = 1;"; }

# The settings row is read with a 5 s cache per process: after a touch-up in
# SQL, it must be left to expire before querying the panel.
settle() { sleep 6; }

cleanup_targets() {
  local id
  for name in "$TARGET_A" "$TARGET_B"; do
    id=$(psql_q "select id from targets where name = '$name';")
    [ -n "$id" ] && req DELETE "/api/targets/$id" >/dev/null 2>&1 || true
  done
}

step "1. Sign-in"
login
pass "signed in as $ADMIN_EMAIL"

# Cleanup from a previous run, before any measure.
cleanup_targets

# We keep the instance's identity to set it back at the end: this environment is
# shared, the guide is going to change it.
# A blank database has no row yet: the schema's defaults are then set back.
ORIGINAL_NAME=$(psql_q "select value->>'instanceName' from app_settings where id = 1;")
ORIGINAL_TAGLINE=$(psql_q "select value->>'instanceTagline' from app_settings where id = 1;")
ORIGINAL_LOCALE=$(psql_q "select value->>'locale' from app_settings where id = 1;")
ORIGINAL_TIMEZONE=$(psql_q "select value->>'timezone' from app_settings where id = 1;")
[ -n "$ORIGINAL_NAME" ] || ORIGINAL_NAME='Pupitre'
[ -n "$ORIGINAL_TAGLINE" ] || ORIGINAL_TAGLINE='Deployment control plane'
# The guide below sets the locale and the time zone too: put them back as well,
# or a shared instance would be left in another language.
[ -n "$ORIGINAL_LOCALE" ] || ORIGINAL_LOCALE='en-US'
[ -n "$ORIGINAL_TIMEZONE" ] || ORIGINAL_TIMEZONE='Europe/Paris'
info "original identity: \"$ORIGINAL_NAME\" / \"$ORIGINAL_TAGLINE\""

step "2. Blank state: the guide is offered"
# Exactly the documented gesture: the key is removed, nothing else is broken.
psql_q "update app_settings set value = value - 'onboarding' where id = 1;" >/dev/null
settle

code=$(req GET /api/onboarding)
[ "$code" = "200" ] || fail "GET /api/onboarding → HTTP $code: $(cat "$BODY")"
jq -e '.state.status == "pending"' "$BODY" >/dev/null \
  || fail "expected state \"pending\", got \"$(jq -r .state.status "$BODY")\""
jq -e '.applies == true' "$BODY" >/dev/null || fail "the guide should concern an admin"
STEP_COUNT=$(jq -r '.steps | length' "$BODY")
[ "$STEP_COUNT" -ge 7 ] || fail "only $STEP_COUNT steps offered to an admin"
pass "key missing → \"pending\", $STEP_COUNT steps offered: $(jq -r '[.steps[].id] | join(", ")' "$BODY")"

result=$(page /)
[ "${result%%|*}" = "307" ] || fail "GET / expected 307, got ${result%%|*}"
case "${result#*|}" in
  */onboarding) pass "GET / → 307 to ${result#*|}" ;;
  *) fail "redirected to \"${result#*|}\", not to /onboarding" ;;
esac

step "3. One does not leave the guide until it is settled"
# Contract: `pending` and `in_progress` bring back to the guide from any page.
# Only "finished" and "abandoned" free from it, and abandoning goes through a
# confirmation that names what is left behind.
after=$(onboarding_json | jq -r .status)
[ "$after" = "in_progress" ] || fail "after the offer, status \"$after\" instead of \"in_progress\""
pass "having been offered is recorded (\"in_progress\")"

for path in / /targets /applications /deployments /admin/settings /jobs; do
  result=$(page "$path")
  [ "${result%%|*}" = "307" ] || fail "journey not settled: GET $path expected 307, got ${result%%|*}"
done
pass "six different screens all send back to the guide"

# The point that told the old contract apart from the new one: the redirect does
# not give way on the second pass.
result=$(page /)
[ "${result%%|*}" = "307" ] || fail "second GET / expected 307, got ${result%%|*} — the door gave way"
pass "and it does not give way on the second pass"

result=$(page /onboarding)
[ "${result%%|*}" = "200" ] || fail "GET /onboarding expected 200, got ${result%%|*}"
pass "the guide, for its part, stays reachable"

step "3 bis. The guide's shell is bare"
# No rail: offering twelve destinations while the first step is being
# explained is offering twelve ways to get lost.
OB_HTML="$WORK/onboarding.html"
curl -s -b "$JAR" -c "$JAR" "$BASE_URL/onboarding" -o "$OB_HTML"
for marker in 'href="/targets"' 'href="/deployments"' 'href="/jobs"'; do
  grep -q -- "$marker" "$OB_HTML" && fail "the rail is present in the guide ($marker)"
done
pass "no rail link in the guide"

grep -qE "Ce panel orchestre|This panel orchestrates" "$OB_HTML" \
  || fail "the step's detail is not rendered"
pass "each step carries its detailed explanation"

grep -qE "Plus tard|>Later<" "$OB_HTML" || fail "no visible way out of the guide"
pass "a way out stays visible — forcing is not locking in"

step "3 ter. Leaving goes through a confirmation, then frees"
# The modal is rendered on the client side: we look for it in the chunk served
# by the page, as Radix's initial HTML does not carry the content of a closed
# dialog.
CHUNKS=$(grep -oE '/_next/static/chunks/[A-Za-z0-9_.-]+\.js' "$OB_HTML" | sort -u)
found=0
# `curl | grep -q` is a trap under `set -o pipefail`: `grep` exits at the first
# match, `curl` then gets a SIGPIPE, and the pipe reports `curl`'s failure
# although the search succeeded. So the check failed precisely when the string
# was there — not always, only when the chunk is big enough for `curl` to still
# be writing when `grep` stops, that is on a development server and not on a
# built image. We read first, we search afterwards: no more pipe, no more race.
for chunk in $CHUNKS; do
  body=$(curl -s -b "$JAR" "$BASE_URL$chunk")
  case $body in *"Quitter l'assistant sans"* | *"Leave the setup guide unfinished"*) found=1; break ;; esac
done
[ "$found" = "1" ] || fail "the abandon confirmation is missing from the served code"
pass "the abandon confirmation is indeed served to the browser"

code=$(req PATCH /api/onboarding '{"action":"dismiss"}')
[ "$code" = "200" ] || fail "dismiss → HTTP $code: $(cat "$BODY")"
result=$(page /)
[ "${result%%|*}" = "200" ] \
  || fail "after abandoning, GET / expected 200, got ${result%%|*} — the screen would be a trap"
pass "abandon confirmed: the panel becomes reachable again"

# The journey is resumed for the rest of the script.
code=$(req PATCH /api/onboarding '{"action":"restart"}')
[ "$code" = "200" ] || fail "restart → HTTP $code"
page / >/dev/null
pass "journey resumed for what follows"

step "4. A step cleared is persisted"
# The guide has no route of its own for the identity: it calls the
# /admin/settings one, the same, with a partial patch.
code=$(req PATCH /api/settings \
  '{"instanceName":"Instance de vérification","instanceTagline":"assistant","timezone":"Europe/Paris","locale":"fr-FR","dateStyle":"short","timeStyle":"medium"}')
[ "$code" = "200" ] || fail "PATCH /api/settings → HTTP $code: $(cat "$BODY")"
pass "identity saved through PATCH /api/settings (no parallel route)"

code=$(req PATCH /api/onboarding '{"action":"complete","step":"identity"}')
[ "$code" = "200" ] || fail "PATCH /api/onboarding → HTTP $code: $(cat "$BODY")"
jq -e '.state.completed | index("identity") != null' "$BODY" >/dev/null \
  || fail "\"identity\" missing from the completed steps"
jq -e '.state.currentStep == "target"' "$BODY" >/dev/null \
  || fail "current step \"$(jq -r .state.currentStep "$BODY")\" instead of \"target\""
pass "step \"identity\" completed, the guide moves on to \"target\""

stored=$(onboarding_json)
[ "$(jq -r .currentStep <<< "$stored")" = "target" ] \
  || fail "the database does not keep the current step: $stored"
pass "persisted in app_settings' JSONB, without a migration: $(jq -c '{status,currentStep,completed,skipped}' <<< "$stored")"

# Complete new sign-in, new cookie: we come back to the right place.
login "$JAR2"
code=$(req GET /api/onboarding '' "$JAR2")
[ "$code" = "200" ] || fail "GET /api/onboarding after the new sign-in → HTTP $code"
jq -e '.state.currentStep == "target"' "$BODY" >/dev/null \
  || fail "after the new sign-in, we start again from \"$(jq -r .state.currentStep "$BODY")\""
pass "after the new sign-in, we resume on \"target\" — nothing to start over"

step "5. Skipping a step is not completing it"
code=$(req PATCH /api/onboarding '{"action":"skip","step":"role"}')
[ "$code" = "200" ] || fail "skip role → HTTP $code: $(cat "$BODY")"
jq -e '.state.skipped | index("role") != null' "$BODY" >/dev/null \
  || fail "\"role\" is not marked skipped"
jq -e '.state.completed | index("role") == null' "$BODY" >/dev/null \
  || fail "\"role\" is counted as completed although it was skipped"
jq -e '[.steps[] | select(.id == "role")][0].outcome == "skipped"' "$BODY" >/dev/null \
  || fail "the \"role\" step is not reported \"skipped\""
pass "\"role\" skipped: skipped=[$(jq -r '.state.skipped | join(",")' "$BODY")], completed does not contain it"

code=$(req PATCH /api/onboarding '{"action":"skip","step":"welcome"}')
[ "$code" = "409" ] || fail "skipping a non-optional step: expected 409, got $code"
jq -e '.error.code == "step_not_optional"' "$BODY" >/dev/null || fail "unexpected error code"
pass "a non-optional step cannot be skipped → 409 step_not_optional"

code=$(req PATCH /api/onboarding '{"action":"complete","step":"role"}')
[ "$code" = "200" ] || fail "complete role → HTTP $code"
jq -e '.state.skipped | index("role") == null' "$BODY" >/dev/null \
  || fail "completing a step did not remove it from the skipped steps"
pass "completing a skipped step switches its state — the two do not coexist"

code=$(req PATCH /api/onboarding '{"action":"skip","step":"role"}')
[ "$code" = "200" ] || fail "skip role → HTTP $code"
pass "\"role\" set back to \"skipped\" for the rest of the journey"

step "6. The guide's target is the one of /targets/new"
payload() {
  printf '{"name":"%s","host":"%s","port":%s,"sshUser":"verif","authMethod":"key","sudoMethod":"nopasswd","credential":"%s","portRangeStart":30000,"portRangeEnd":30009,"labels":{"env":"verification"}}' \
    "$1" "$2" "$DEAD_PORT" "$CREDENTIAL"
}

# Path A — what /targets/new does: POST /api/targets, then the list's "Test
# the connection" button.
code=$(req POST /api/targets "$(payload "$TARGET_A" "$HOST_A")")
[ "$code" = "201" ] || fail "POST /api/targets (screen) → HTTP $code: $(cat "$BODY")"
ID_A=$(jq -r .id "$BODY")
code=$(req POST "/api/targets/$ID_A/preflight")
[ "$code" = "202" ] || fail "preflight (screen) → HTTP $code: $(cat "$BODY")"
JOB_A=$(jq -r .jobId "$BODY")
pass "/targets/new path: target $ID_A, preflight queued (job $JOB_A)"

# Path B — what the guide does: the SAME form, the SAME route, the SAME
# preflight, plus the only gesture that belongs to it — remembering.
code=$(req POST /api/targets "$(payload "$TARGET_B" "$HOST_B")")
[ "$code" = "201" ] || fail "POST /api/targets (assistant) → HTTP $code: $(cat "$BODY")"
ID_B=$(jq -r .id "$BODY")
code=$(req POST "/api/targets/$ID_B/preflight")
[ "$code" = "202" ] || fail "preflight (assistant) → HTTP $code: $(cat "$BODY")"
JOB_B=$(jq -r .jobId "$BODY")
code=$(req PATCH /api/onboarding '{"action":"complete","step":"target"}')
[ "$code" = "200" ] || fail "complete target → HTTP $code"
pass "guide path: target $ID_B, preflight queued (job $JOB_B), step remembered"

# Both preflights go to the end (connection refused): we wait, to also compare
# the status and the discovered runtimes.
for _ in $(seq 1 40); do
  states=$(psql_q "select count(*) from targets where name in ('$TARGET_A','$TARGET_B') and status <> 'unknown';")
  [ "$states" = "2" ] && break
  sleep 1
done
[ "$states" = "2" ] || info "a preflight did not give control back in time — comparison without the status"

# Column by column comparison. Excluded: what identifies the row (id, name,
# host), the timestamps, and the credential — encrypted under a random IV, two
# encryptions of the same text necessarily differ.
DIFF=$(psql_q "
  with rows as (
    select name,
           to_jsonb(t) - 'id' - 'name' - 'host' - 'created_at' - 'updated_at'
                       - 'encrypted_credential' - 'last_preflight_at' - 'preflight_report' as shape
    from targets t where name in ('$TARGET_A','$TARGET_B')
  )
  select case
    when (select shape from rows where name = '$TARGET_A')
       = (select shape from rows where name = '$TARGET_B')
    then 'identical' else 'different' end;")
[ "$DIFF" = "identical" ] || {
  psql_q "select name, to_jsonb(t) - 'id' - 'encrypted_credential' from targets t
          where name in ('$TARGET_A','$TARGET_B');"
  fail "the two targets differ in the database — the guide has a parallel path"
}
pass "same columns in the database: $(psql_q "select to_jsonb(t) - 'id' - 'name' - 'host' - 'created_at' - 'updated_at' - 'encrypted_credential' - 'last_preflight_at' - 'preflight_report' from targets t where name = '$TARGET_B';" | jq -c '{status,auth_method,sudo_method,labels,port,ssh_user,port_range_start,port_range_end}')"

# The credential is encrypted on both sides, and never in clear.
for name in "$TARGET_A" "$TARGET_B"; do
  enc=$(psql_q "select encrypted_credential from targets where name = '$name';")
  case "$enc" in v1:*) : ;; *) fail "\"$name\": credential not encrypted (\"${enc:0:12}…\")" ;; esac
  [ "$enc" = "$CREDENTIAL" ] && fail "\"$name\": credential in clear in the database"
done
pass "credential encrypted (v1:iv:tag:ciphertext) on both sides, never in clear"

# Same audit entry, down to the name and the host.
AUDIT_DIFF=$(psql_q "
  with entries as (
    select a.resource_id,
           (a."after" - 'name' - 'host') as shape,
           a.actor_id, a.ip
    from audit_logs a where a.action = 'target.created'
      and a.resource_id in ('$ID_A','$ID_B')
  )
  select case
    when (select count(*) from entries) = 2
     and (select shape from entries where resource_id = '$ID_A')
       = (select shape from entries where resource_id = '$ID_B')
     and (select count(distinct actor_id) from entries) = 1
     and (select count(distinct ip) from entries) = 1
    then 'identical' else 'different' end;")
[ "$AUDIT_DIFF" = "identical" ] || {
  psql_q "select resource_id, \"after\" from audit_logs
          where action = 'target.created' and resource_id in ('$ID_A','$ID_B');"
  fail "the two targets' audit entries differ"
}
pass "same \"target.created\" entry: same shape, same actor, same IP"

PREFLIGHTS=$(psql_q "select count(*) from audit_logs
  where action = 'target.preflight.requested' and resource_id in ('$ID_A','$ID_B');")
[ "$PREFLIGHTS" = "2" ] || fail "$PREFLIGHTS \"target.preflight.requested\" entry(ies) instead of 2"
pass "both queued a preflight, traced identically"

step "7. A viewer is offered no step"
code=$(req POST /api/admin/users \
  "{\"name\":\"Viewer assistant\",\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\",\"role\":\"viewer\"}")
case "$code" in
  201) pass "viewer user created" ;;
  409) pass "viewer user already present" ;;
  *)   fail "POST /api/admin/users → HTTP $code: $(cat "$BODY")" ;;
esac
VIEWER_ID=$(psql_q "select id from users where email = '$VIEWER_EMAIL';")

for _ in 1 2 3 4 5; do
  code=$(req POST /api/auth/sign-in/email \
    "{\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\"}" "$VIEWER_JAR")
  [ "$code" = "429" ] || break
  sleep 6
done
[ "$code" = "200" ] || fail "viewer sign-in failed (HTTP $code): $(cat "$BODY")"
pass "signed in as $VIEWER_EMAIL"

code=$(req GET /api/onboarding '' "$VIEWER_JAR")
[ "$code" = "200" ] || fail "GET /api/onboarding (viewer) → HTTP $code"
jq -e '.applies == false' "$BODY" >/dev/null \
  || fail "the guide claims to apply to a viewer"
jq -e '.steps | length == 0' "$BODY" >/dev/null \
  || fail "$(jq -r '.steps | length' "$BODY") step(s) offered to a viewer: $(jq -c '[.steps[].id]' "$BODY")"
pass "no step offered: a step that would end in 403 is worse than a missing step"

code=$(req PATCH /api/onboarding '{"action":"finish"}' "$VIEWER_JAR")
[ "$code" = "403" ] || fail "writing by a viewer: expected 403, got $code"
jq -e '.error.code == "onboarding_not_applicable"' "$BODY" >/dev/null \
  || fail "unexpected error code: $(jq -c .error "$BODY")"
pass "writing refused → 403 onboarding_not_applicable"

code=$(req PATCH /api/onboarding '{"action":"restart"}' "$VIEWER_JAR")
[ "$code" = "403" ] || fail "restart by a viewer: expected 403, got $code"
pass "restart refused to a viewer (settings:manage required)"

result=$(page / "$VIEWER_JAR")
[ "${result%%|*}" = "200" ] || fail "a viewer is redirected to the guide (${result#*|})"
pass "a viewer is never redirected to the guide"

step "8. Finishing makes the guide disappear"
code=$(req PATCH /api/onboarding '{"action":"finish"}')
[ "$code" = "200" ] || fail "finish → HTTP $code: $(cat "$BODY")"
jq -e '.state.status == "completed"' "$BODY" >/dev/null || fail "status not \"completed\""
jq -e '.state.finishedAt != null' "$BODY" >/dev/null || fail "finishedAt not filled in"
jq -e '.state.dismissedAt == null' "$BODY" >/dev/null \
  || fail "finished AND abandoned at once — the two are not to be confused"
pass "status \"completed\", finished on $(jq -r .state.finishedAt "$BODY")"

result=$(page /)
[ "${result%%|*}" = "200" ] || fail "after finishing, GET / still redirects (${result#*|})"
pass "GET / → 200: the guide no longer imposes itself"

rm -f "$JAR2"
login "$JAR2"
result=$(page / "$JAR2")
[ "${result%%|*}" = "200" ] || fail "the guide comes back at the next sign-in (${result#*|})"
pass "nor at the next sign-in"

step "9. Abandoning is not finishing"
code=$(req PATCH /api/onboarding '{"action":"dismiss"}')
[ "$code" = "200" ] || fail "dismiss → HTTP $code"
jq -e '.state.status == "dismissed" and .state.dismissedAt != null and .state.finishedAt == null' \
  "$BODY" >/dev/null || fail "abandon badly recorded: $(jq -c .state "$BODY")"
pass "\"dismissed\" with its timestamp, and \"finishedAt\" set back to null"

step "10. Restarting from the settings"
BEFORE_RUNS=$(onboarding_json | jq -r .runs)
code=$(req PATCH /api/onboarding '{"action":"restart"}')
[ "$code" = "200" ] || fail "restart → HTTP $code: $(cat "$BODY")"
jq -e '.state.status == "pending" and .state.currentStep == "welcome"' "$BODY" >/dev/null \
  || fail "the restart did not reset the journey: $(jq -c .state "$BODY")"
AFTER_RUNS=$(jq -r .state.runs "$BODY")
[ "$AFTER_RUNS" = "$((BEFORE_RUNS + 1))" ] \
  || fail "restart counter: $BEFORE_RUNS → $AFTER_RUNS"
pass "journey reset, restart #$AFTER_RUNS"

result=$(page /)
[ "${result%%|*}" = "307" ] || fail "after the restart, GET / expected 307, got ${result%%|*}"
pass "GET / → 307 to ${result#*|}: the restart rearms the redirect"

result=$(page /)
[ "${result%%|*}" = "307" ] \
  || fail "after the restart, the redirect should hold: GET / returned ${result%%|*}"
pass "and it holds — a restarted journey behaves as on the first day"

step "11. Traceability"
code=$(req GET "/api/audit-logs?resourceType=settings&pageSize=50")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
for action in onboarding.offered onboarding.step.completed onboarding.step.skipped \
              onboarding.completed onboarding.dismissed onboarding.restarted; do
  jq -e --arg a "$action" '[.items[] | select(.action == $a)] | length > 0' "$BODY" >/dev/null \
    || fail "action \"$action\" missing from the audit log"
  pass "audit: $action"
done

code=$(req GET "/api/audit-logs?resourceType=target&pageSize=50")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
for id in "$ID_A" "$ID_B"; do
  jq -e --arg i "$id" \
    '[.items[] | select(.resourceId == $i and .action == "target.created")] | length > 0' \
    "$BODY" >/dev/null || fail "creation of target $id missing from the log"
done
pass "audit: the two targets created, through the two paths, are traced identically"

step "12. Cleanup"
cleanup_targets
remaining=$(psql_q "select count(*) from targets where name in ('$TARGET_A','$TARGET_B');")
[ "$remaining" = "0" ] || fail "$remaining verification target(s) remain"
pass "verification targets deleted"

[ -n "$VIEWER_ID" ] && req DELETE "/api/admin/users/$VIEWER_ID" >/dev/null
pass "viewer user deleted"

code=$(req PATCH /api/settings \
  "$(jq -nc --arg n "$ORIGINAL_NAME" --arg t "$ORIGINAL_TAGLINE" \
      --arg l "$ORIGINAL_LOCALE" --arg z "$ORIGINAL_TIMEZONE" \
      '{instanceName:$n, instanceTagline:$t, locale:$l, timezone:$z}')")
[ "$code" = "200" ] || fail "restoring the identity → HTTP $code: $(cat "$BODY")"
pass "instance identity restored: \"$ORIGINAL_NAME\" / \"$ORIGINAL_TAGLINE\""

# The guide is set back to "finished": this environment is shared, it must not
# stay in discovery mode for the work next door.
code=$(req PATCH /api/onboarding '{"action":"finish"}')
[ "$code" = "200" ] || fail "setting back to \"finished\" → HTTP $code"
pass "guide set back to \"finished\": $(onboarding_json | jq -c '{status,runs}')"

code=$(req POST /api/auth/sign-in/email \
  "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" "$WORK/final.jar")
[ "$code" = "200" ] || fail "\"$ADMIN_EMAIL\" is no longer usable (HTTP $code)"
pass "$ADMIN_EMAIL can still sign in with their usual password"

printf '\n\033[32m✓ Setup guide verified.\033[0m\n'
printf '\033[2m  Screen: %s/onboarding — restart: %s/admin/settings\033[0m\n\n' "$BASE_URL" "$BASE_URL"
