#!/usr/bin/env bash
#
# RBAC and activity log: a refusal is refused, and it leaves a trace.
#
#   1. Create a viewer user
#   2. Sign in as the viewer
#   3. POST /api/deployments  →  403
#   4. The refused attempt appears in audit_logs with the actor and the IP
#
# Usage:
#   ./scripts/verify-rbac-audit.sh
#   BASE_URL=http://localhost:3100 ./scripts/verify-rbac-audit.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
VIEWER_EMAIL="${VIEWER_EMAIL:-viewer@example.test}"
VIEWER_PASSWORD="${VIEWER_PASSWORD:-motdepasse-tres-long}"
# IP simulated behind a reverse proxy: it is the one we must find in the database.
CLIENT_IP="${CLIENT_IP:-198.51.100.42}"

JAR_DIR="$(mktemp -d)"
ADMIN_JAR="$JAR_DIR/admin.jar"
VIEWER_JAR="$JAR_DIR/viewer.jar"
trap 'rm -rf "$JAR_DIR"' EXIT

command -v jq >/dev/null || { echo "jq is required"; exit 1; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# curl → writes the body into $BODY, returns the HTTP code on stdout
BODY="$JAR_DIR/body.json"
req() {
  local method="$1" path="$2" jar="${3:-}" data="${4:-}"
  # `Origin` is sent as a browser would: Better Auth uses it as CSRF
  # protection on authenticated requests.
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -H "x-forwarded-for: $CLIENT_IP")
  [ -n "$jar" ] && args+=(-b "$jar" -c "$jar")
  [ -n "$data" ] && args+=(-d "$data")
  curl "${args[@]}"
}

step "0. The panel answers"
code=$(req GET /api/health)
[ "$code" = "200" ] || fail "GET /api/health → HTTP $code"
jq -e '.status == "ok" and .db == "ok" and .redis == "ok"' "$BODY" >/dev/null \
  || fail "/api/health: $(cat "$BODY")"
pass "/api/health → $(jq -c '{status,db,redis}' "$BODY")"

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }

step "1. An administrator exists (bootstrap if needed)"
code=$(req POST /api/auth/sign-in/email "$ADMIN_JAR" \
  "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
if [ "$code" != "200" ]; then
  code=$(req POST /api/auth/sign-up/email "$ADMIN_JAR" \
    "{\"name\":\"Admin de vérification\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
  [ "$code" = "200" ] || fail "could not create the administrator (HTTP $code): $(cat "$BODY")
     → if accounts already exist, rerun with the ADMIN_EMAIL/ADMIN_PASSWORD of an admin account"
  pass "administrator created — the first account gets the admin role"
else
  pass "signed in as $ADMIN_EMAIL"
fi
ADMIN_ROLE=$(jq -r '.user.role // "?"' "$BODY")
[ "$ADMIN_ROLE" = "admin" ] || fail "the $ADMIN_EMAIL account has the role \"$ADMIN_ROLE\", not \"admin\""

step "2. Creating a viewer user"
code=$(req POST /api/admin/users "$ADMIN_JAR" \
  "{\"name\":\"Vera Viewer\",\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\",\"role\":\"viewer\"}")
case "$code" in
  201) pass "viewer created: $(jq -c '{email,roles}' "$BODY")" ;;
  409) pass "the viewer already existed" ;;
  *)   fail "POST /api/admin/users → HTTP $code: $(cat "$BODY")" ;;
esac

# An account that already exists keeps the role another script gave it: the
# creation answers 409 without correcting anything. Without this realignment,
# step 4 tested a "viewer" turned operator — so holder of deployment:create —
# and got a validation 422 where it expected a 403. A test that depends on the
# run order of its neighbors proves nothing.
VIEWER_ACCOUNT_ID=$(psql_q "select id from users where email = '$VIEWER_EMAIL';")
[ -n "$VIEWER_ACCOUNT_ID" ] || fail "account \"$VIEWER_EMAIL\" not found after creation"
code=$(req PATCH "/api/admin/users/$VIEWER_ACCOUNT_ID/role" "$ADMIN_JAR" '{"role":"viewer"}')
[ "$code" = "200" ] || fail "realigning the role → HTTP $code: $(cat "$BODY")"
pass "role realigned on \"viewer\", whatever its state before"

step "3. Signing in as the viewer"
code=$(req POST /api/auth/sign-in/email "$VIEWER_JAR" \
  "{\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\"}")
[ "$code" = "200" ] || fail "viewer sign-in → HTTP $code: $(cat "$BODY")"
VIEWER_ID=$(jq -r '.user.id' "$BODY")
pass "signed in — id $VIEWER_ID"

step "4. POST /api/deployments as the viewer → 403"
code=$(req POST /api/deployments "$VIEWER_JAR" '{}')
[ "$code" = "403" ] || fail "expected 403, got HTTP $code: $(cat "$BODY")"
jq -e '.error.code == "forbidden" and .error.details.permission == "deployment:create"' "$BODY" >/dev/null \
  || fail "unexpected body: $(cat "$BODY")"
pass "403 — $(jq -r '.error.message' "$BODY")"

step "5. The refusal is in audit_logs, with the actor and the IP"
code=$(req GET "/api/audit-logs?action=permission.denied&actorId=$VIEWER_ID&pageSize=1" "$ADMIN_JAR")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code: $(cat "$BODY")"

jq -e '.total > 0' "$BODY" >/dev/null || fail "no permission.denied entry for the viewer"
entry=$(jq -c '.items[0]' "$BODY")
jq -e --arg ip "$CLIENT_IP" --arg id "$VIEWER_ID" --arg mail "$VIEWER_EMAIL" '
  .items[0]
  | .actorId == $id
    and .actorEmail == $mail
    and .ip == $ip
    and .resourceId == "deployment:create"
    and .after.reason == "missing_permission"
' "$BODY" >/dev/null || fail "incomplete entry: $entry"

pass "actor    : $(jq -r '.items[0].actorEmail' "$BODY") ($(jq -r '.items[0].actorId' "$BODY"))"
pass "IP       : $(jq -r '.items[0].ip' "$BODY")"
pass "action   : $(jq -r '.items[0].action' "$BODY") → $(jq -r '.items[0].resourceId' "$BODY")"
pass "request  : $(jq -r '.items[0].after.method + " " + .items[0].after.path' "$BODY")"

step "6. Additional checks"
code=$(req POST /api/deployments "" '{}')
[ "$code" = "401" ] || fail "without a session, expected 401, got $code"
pass "without a session → 401 (and not 403)"

code=$(req POST /api/admin/users "$VIEWER_JAR" \
  '{"name":"X","email":"x@example.test","password":"motdepasse-tres-long","role":"admin"}')
[ "$code" = "403" ] || fail "viewer on POST /api/admin/users: expected 403, got $code"
pass "a viewer cannot create a user → 403"

code=$(req GET /api/deployments "$VIEWER_JAR")
[ "$code" = "200" ] || fail "viewer on GET /api/deployments: expected 200, got $code"
pass "a viewer keeps reading → GET /api/deployments 200"

# The log carries IP addresses and e-mails: it belongs to the auditor, not to
# the viewer, who only reads operations.
code=$(req GET /api/audit-logs "$VIEWER_JAR")
[ "$code" = "403" ] || fail "viewer on GET /api/audit-logs: expected 403 (no audit:read), got $code"
pass "a viewer does not have audit:read → GET /api/audit-logs 403"

# What matters here is that the administrator GETS PAST the permission guard,
# not what they get afterwards. The route was first a stub that answered 501;
# since the pipeline exists, it is real and answers 404 on unknown identifiers.
# Both prove the same thing.
code=$(req POST /api/deployments "$ADMIN_JAR" \
  '{"applicationId":"00000000-0000-4000-8000-000000000000","targetId":"00000000-0000-4000-8000-000000000001","runtime":"docker"}')
case "$code" in
  401|403) fail "admin blocked by the permission guard (HTTP $code)" ;;
  404|501) pass "admin gets past the guard → $code (and not 403)" ;;
  *)       fail "admin on POST /api/deployments: got $code, expected 404 or 501" ;;
esac

code=$(req POST /api/auth/sign-out "$VIEWER_JAR" '{}')
[ "$code" = "200" ] || fail "sign-out → HTTP $code"
code=$(req GET /api/audit-logs "$ADMIN_JAR")
jq -e --arg id "$VIEWER_ID" '[.items[] | select(.action == "auth.logout" and .actorId == $id)] | length > 0' "$BODY" >/dev/null \
  || fail "the sign-out does not appear in audit_logs"
pass "sign-out traced in audit_logs"

printf '\n\033[32m✓ RBAC and refusals log verified.\033[0m\n\n'
