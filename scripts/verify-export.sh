#!/usr/bin/env bash
#
# Checks the logs export:
#
#   1. the text export of an existing deployment returns content, with the
#      right HTTP headers (content-type, content-disposition)
#   2. the JSONL export produces lines that all pass `jq -e .`
#   3. the number of exported lines matches EXACTLY the database's content
#      — it is what proves that the pagination truncates nothing
#   4. an unknown identifier returns 404, a malformed identifier 422
#   5. `deployment:read` is required: a user without this permission → 403
#   6. the export leaves a trace in the audit log
#
# Usage:
#   ./scripts/verify-export.sh
#   BASE_URL=http://localhost:3200 ./scripts/verify-export.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
ROLE_KEY="${ROLE_KEY:-export-verification}"
GUEST_EMAIL="${GUEST_EMAIL:-export-test@example.test}"
GUEST_PASSWORD="${GUEST_PASSWORD:-motdepasse-tres-long}"
CLIENT_IP="${CLIENT_IP:-198.51.100.77}"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
GUEST_JAR="$WORK/guest.jar"
BODY="$WORK/body.json"
HDR="$WORK/headers.txt"
OUT="$WORK/export.out"
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

# Downloads an export, keeping the headers and the body apart.
download() {
  local path="$1" jar="${2:-$JAR}"
  curl -s -D "$HDR" -o "$OUT" -w '%{http_code}' \
    -H "origin: $BASE_URL" -H "x-forwarded-for: $CLIENT_IP" \
    -b "$jar" -c "$jar" "$BASE_URL$path"
}

header_of() { tr -d '\r' < "$HDR" | grep -i "^$1:" | head -1 | cut -d' ' -f2-; }

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

assert_admin() {
  local role
  role=$(jq -r '.user.role // empty' "$BODY")
  [ "$role" = "admin" ] && return 0
  fail "\"$ADMIN_EMAIL\" has the role \"${role:-none}\", not \"admin\" — see /admin/users"
}

step "1. Sign-in"
login
pass "signed in as $ADMIN_EMAIL"

step "2. A deployment whose log is not empty"
DEPLOYMENT_ID=$(psql_q "select d.id from deployments d
  join deployment_steps s on s.deployment_id = d.id
  group by d.id having sum(length(s.log)) > 0
  order by sum(length(s.log)) desc limit 1;")
[ -n "$DEPLOYMENT_ID" ] || fail "no deployment with logs in the database"

META=$(psql_q "select a.slug || '|' || d.version || '|' ||
  to_char((coalesce(d.finished_at, d.created_at) at time zone 'UTC'), 'YYYY-MM-DD')
  from deployments d join applications a on a.id = d.application_id
  where d.id = '$DEPLOYMENT_ID';")
SLUG="${META%%|*}"; REST="${META#*|}"; VERSION="${REST%%|*}"; STAMP="${REST#*|}"

# Reference: what the database contains, line by line, without the empty ones.
DB_LINES=$(psql_q "select count(*) from deployment_steps s,
  unnest(string_to_array(s.log, E'\n')) as l
  where s.deployment_id = '$DEPLOYMENT_ID' and btrim(l) <> '';")

pass "deployment $DEPLOYMENT_ID — $SLUG v$VERSION"
info "the database contains $DB_LINES log line(s)"

step "3. Text export"
code=$(download "/api/deployments/$DEPLOYMENT_ID/logs/export?format=text")
[ "$code" = "200" ] || fail "text export → HTTP $code: $(head -c 300 "$OUT")"
[ -s "$OUT" ] || fail "the exported file is empty"

CT=$(header_of content-type)
[ "$CT" = "text/plain; charset=utf-8" ] || fail "unexpected content-type: \"$CT\""
pass "content-type: $CT"

CD=$(header_of content-disposition)
EXPECTED="attachment; filename=\"$SLUG-v$VERSION-$STAMP.log\""
case "$CD" in
  "$EXPECTED"*) pass "content-disposition: $CD" ;;
  *) fail "unexpected content-disposition: \"$CD\" (expected \"$EXPECTED…\")" ;;
esac
grep -q "filename\*=UTF-8''" <<< "$CD" || fail "the RFC 6266 \"filename*\" form is missing"
pass "\"filename*\" form present (RFC 6266)"

grep -q "^# Deployment log" "$OUT" || fail "file header missing"
grep -q "^# Exported on " "$OUT" || fail "the file does not say when it was exported"
pass "header: $(head -1 "$OUT")"

# A log entry can span several physical lines: a rollback's diagnostic block
# ("$ docker compose ps -a" and its output) is ONE entry in the database.
# Counting the file's lines would compare physical lines to logical entries. So
# we count the entry starts, recognizable by their leading timestamp.
TEXT_LINES=$(grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' "$OUT" || true)
[ "$TEXT_LINES" = "$DB_LINES" ] \
  || fail "text export: $TEXT_LINES line(s) exported for $DB_LINES in the database"
pass "$TEXT_LINES exported line(s) = $DB_LINES line(s) in the database"
info "$(grep -v '^#' "$OUT" | head -1)"

step "4. Export JSONL"
code=$(download "/api/deployments/$DEPLOYMENT_ID/logs/export?format=jsonl")
[ "$code" = "200" ] || fail "export jsonl → HTTP $code: $(head -c 300 "$OUT")"

CT=$(header_of content-type)
[ "$CT" = "application/x-ndjson; charset=utf-8" ] || fail "unexpected content-type: \"$CT\""
pass "content-type: $CT"

CD=$(header_of content-disposition)
case "$CD" in
  "attachment; filename=\"$SLUG-v$VERSION-$STAMP.jsonl\""*) pass "content-disposition: $CD" ;;
  *) fail "unexpected content-disposition: \"$CD\"" ;;
esac

# Each line must be a JSON object on its own: it is the whole contract of the
# format. They are validated one by one, not as a block.
bad=0
while IFS= read -r line; do
  jq -e . >/dev/null 2>&1 <<< "$line" || bad=$((bad + 1))
done < "$OUT"
[ "$bad" = "0" ] || fail "$bad invalid JSONL line(s)"
JSONL_LINES=$(wc -l < "$OUT" | tr -d ' ')
pass "$JSONL_LINES line(s) all pass \"jq -e .\""

[ "$JSONL_LINES" = "$DB_LINES" ] \
  || fail "jsonl export: $JSONL_LINES line(s) exported for $DB_LINES in the database"
pass "$JSONL_LINES exported line(s) = $DB_LINES line(s) in the database"

jq -e 'has("ts") and has("step") and has("stream") and has("line")' >/dev/null <<< "$(head -1 "$OUT")" \
  || fail "a JSONL line does not carry the four expected fields"
pass "fields: $(head -1 "$OUT" | jq -c 'keys')"

step "5. Refused identifiers"
code=$(download "/api/deployments/00000000-0000-4000-8000-000000000000/logs/export")
[ "$code" = "404" ] || fail "unknown uuid: expected 404, got $code"
pass "uuid inconnu → 404"

code=$(download "/api/deployments/pas-un-uuid/logs/export")
[ "$code" = "422" ] || fail "malformed identifier: expected 422, got $code"
pass "malformed identifier → 422"

code=$(download "/api/deployments/$DEPLOYMENT_ID/logs/export?format=csv")
[ "$code" = "422" ] || fail "unknown format: expected 422, got $code"
pass "format inconnu → 422"

step "6. \"deployment:read\" is required"
req DELETE "/api/admin/roles/$ROLE_KEY" >/dev/null 2>&1 || true
code=$(req POST /api/admin/roles \
  "{\"key\":\"$ROLE_KEY\",\"label\":\"Export — sans lecture\",\"permissions\":[\"target:read\"]}")
case "$code" in
  201) pass "role \"$ROLE_KEY\" created, without deployment:read" ;;
  409) pass "role \"$ROLE_KEY\" already present" ;;
  *)   fail "POST /api/admin/roles → HTTP $code: $(cat "$BODY")" ;;
esac

code=$(req POST /api/admin/users \
  "{\"name\":\"Sans lecture\",\"email\":\"$GUEST_EMAIL\",\"password\":\"$GUEST_PASSWORD\",\"role\":\"$ROLE_KEY\"}")
case "$code" in
  201) pass "user $GUEST_EMAIL created" ;;
  409) req PATCH "/api/admin/users/$(psql_q "select id from users where email = '$GUEST_EMAIL';")/role" \
         "{\"role\":\"$ROLE_KEY\"}" >/dev/null
       pass "user $GUEST_EMAIL already present, reassigned to \"$ROLE_KEY\"" ;;
  *)   fail "POST /api/admin/users → HTTP $code: $(cat "$BODY")" ;;
esac
GUEST_ID=$(psql_q "select id from users where email = '$GUEST_EMAIL';")

for _ in 1 2 3 4 5; do
  code=$(curl -s -o "$BODY" -w '%{http_code}' -X POST "$BASE_URL/api/auth/sign-in/email" \
    -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -b "$GUEST_JAR" -c "$GUEST_JAR" \
    --data-binary "{\"email\":\"$GUEST_EMAIL\",\"password\":\"$GUEST_PASSWORD\"}")
  [ "$code" = "429" ] || break
  sleep 6
done
[ "$code" = "200" ] || fail "sign-in of $GUEST_EMAIL failed (HTTP $code): $(cat "$BODY")"
pass "signed in as $GUEST_EMAIL"

code=$(download "/api/deployments/$DEPLOYMENT_ID/logs/export?format=text" "$GUEST_JAR")
[ "$code" = "403" ] || fail "without deployment:read: expected 403, got $code — $(head -c 300 "$OUT")"
jq -e '.error.details.permission == "deployment:read"' >/dev/null < "$OUT" \
  || fail "the refusal does not name the expected permission: $(head -c 200 "$OUT")"
pass "export refused → 403 (deployment:read permission)"

step "7. Traceability"
code=$(req GET "/api/audit-logs?action=deployment.logs.exported&pageSize=20")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
jq -e --arg id "$DEPLOYMENT_ID" \
  '[.items[] | select(.resourceId == $id)] | length >= 2' "$BODY" >/dev/null \
  || fail "the two exports are not in the audit log"
pass "audit: deployment.logs.exported"

jq -e --arg id "$DEPLOYMENT_ID" --argjson n "$DB_LINES" \
  '[.items[] | select(.resourceId == $id and .after.format == "jsonl" and .after.lines == $n)] | length > 0' \
  "$BODY" >/dev/null || fail "the audit entry does not carry the format and the line count"
info "$(jq -c --arg id "$DEPLOYMENT_ID" \
  'first(.items[] | select(.resourceId == $id)) | {action, actorEmail, after}' "$BODY")"
pass "format and number of lines logged"

jq -e '[.items[] | select(.action == "permission.denied")] | length == 0' "$BODY" >/dev/null || true
code=$(req GET "/api/audit-logs?action=permission.denied&pageSize=10")
jq -e '[.items[] | select(.resourceId == "deployment:read")] | length > 0' "$BODY" >/dev/null \
  || fail "the permission refusal is not logged"
pass "audit: permission.denied sur deployment:read"

step "8. Cleanup"
req DELETE "/api/admin/users/$GUEST_ID" >/dev/null
req DELETE "/api/admin/roles/$ROLE_KEY" >/dev/null
pass "test user and role deleted"

printf '\n\033[32m✓ Log export verified.\033[0m\n'
printf '\033[2m  Screen: %s/deployments/%s\033[0m\n\n' "$BASE_URL" "$DEPLOYMENT_ID"
