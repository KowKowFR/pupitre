#!/usr/bin/env bash
#
# API tokens: what a CI presents instead of a session.
#
#   1. A token is created from the panel, is shown only once, and the database
#      keeps only its fingerprint
#   2. It opens the API within the limits of its permissions — not the panel's
#      routes, not the interface, not the token factory
#   3. It can never do more than its author, today: a removed role reduces it,
#      a deleted account takes it away
#   4. Limited to one application, it is refused everywhere else
#   5. Revoked or expired, it is refused and says so
#   6. The log says which token acted, and never contains the token
#
# No target is needed.
#
# Usage:
#   ./scripts/verify-api-tokens.sh
#   BASE_URL=http://localhost:3100 ./scripts/verify-api-tokens.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
MEMBER_EMAIL="${MEMBER_EMAIL:-jetons-membre@example.test}"
MEMBER_PASSWORD="${MEMBER_PASSWORD:-motdepasse-tres-long}"
APP_SLUG="jetons-verif"

WORK="$(mktemp -d)"
ADMIN_JAR="$WORK/admin.jar"
MEMBER_JAR="$WORK/member.jar"
BODY="$WORK/body.json"

command -v jq >/dev/null || { echo "jq is required"; exit 1; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }

sha256() {
  if command -v sha256sum >/dev/null; then printf '%s' "$1" | sha256sum | cut -d' ' -f1
  else printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; fi
}

# Browser request: cookie and `Origin`, like the panel.
req() {
  local method="$1" path="$2" jar="$3" data="${4:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL" -b "$jar" -c "$jar")
  [ -n "$data" ] && args+=(-d "$data")
  curl "${args[@]}"
}

# CI request: the token, nothing else — neither cookie nor `Origin`.
api() {
  local token="$1" method="$2" path="$3" data="${4:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H "authorization: Bearer $token" -H 'content-type: application/json'
              -H 'user-agent: verify-api-tokens')
  [ -n "$data" ] && args+=(-d "$data")
  curl "${args[@]}"
}

expect() {
  local got="$1" want="$2" what="$3" code_want="${4:-}"
  [ "$got" = "$want" ] || fail "$what: expected $want, got $got — $(cat "$BODY")"
  if [ -n "$code_want" ]; then
    jq -e --arg c "$code_want" '.error.code == $c' "$BODY" >/dev/null \
      || fail "$what: expected code \"$code_want\", got $(jq -c .error "$BODY")"
  fi
  pass "$what → $got${code_want:+ $code_want}"
}

APP_ID=""
MEMBER_ID=""
cleanup() {
  local code=$?
  [ -n "$APP_ID" ] && req DELETE "/api/applications/$APP_ID" "$ADMIN_JAR" >/dev/null 2>&1 || true
  [ -n "$MEMBER_ID" ] && req DELETE "/api/admin/users/$MEMBER_ID" "$ADMIN_JAR" >/dev/null 2>&1 || true
  psql_q "delete from api_tokens where name like 'verif-%';" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT

step "0. Administrator sign-in"
code=$(req POST /api/auth/sign-in/email "$ADMIN_JAR" \
  "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
if [ "$code" != "200" ]; then
  code=$(req POST /api/auth/sign-up/email "$ADMIN_JAR" \
    "{\"name\":\"Admin de vérification\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
  [ "$code" = "200" ] || fail "could not sign in or create the administrator (HTTP $code)"
fi
pass "signed in as $ADMIN_EMAIL"

step "1. Creating a token — shown once, kept as a fingerprint"
code=$(req POST /api/tokens "$ADMIN_JAR" \
  '{"name":"verif-lecture","permissions":["deployment:read","application:read"],"expiresInDays":30}')
expect "$code" 201 "POST /api/tokens"
READ_TOKEN=$(jq -r .token "$BODY")
READ_ID=$(jq -r .item.id "$BODY")
[[ "$READ_TOKEN" =~ ^pup_[A-Za-z0-9_-]{43}$ ]] || fail "unexpected shape: $READ_TOKEN"
pass "token of the form pup_…, displayed prefix $(jq -r .item.prefix "$BODY")"
code=$(req GET /api/tokens "$ADMIN_JAR")
grep -qF "$READ_TOKEN" "$BODY" && fail "the token list contains the token in clear"
pass "the list no longer shows it"
stored=$(psql_q "select token_hash from api_tokens where id = '$READ_ID';")
[ "$stored" = "$(sha256 "$READ_TOKEN")" ] || fail "the database does not keep the token's SHA-256 fingerprint"
[ "$(psql_q "select count(*) from api_tokens where token_hash = '$READ_TOKEN';")" = "0" ] \
  || fail "the token is in clear in the database"
pass "the database keeps only its SHA-256 fingerprint"

step "2. What it opens, and what it does not"
expect "$(api "$READ_TOKEN" GET /api/deployments)" 200 "reading the deployments"
expect "$(api "$READ_TOKEN" GET /api/applications)" 200 "reading the applications"
expect "$(api "$READ_TOKEN" POST /api/deployments '{}')" 403 "deploying without deployment:create" forbidden
expect "$(api "$READ_TOKEN" POST /api/tokens '{"name":"x","permissions":["deployment:read"]}')" 403 \
  "a token that makes a token" token_refused
expect "$(api "$READ_TOKEN" GET /api/admin/tokens)" 403 "the instance's token list" token_refused
expect "$(api "$READ_TOKEN" GET /api/chat/messages)" 403 "the chat" token_refused
page=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $READ_TOKEN" "$BASE_URL/deployments")
[ "$page" != "200" ] || fail "an interface page opens with a token"
pass "the interface does not open with a token → $page"
# Well formed but unknown. Made here rather than written in clear: the CI's
# secrets guard recognizes the shape of a token.
UNKNOWN="pup_$(printf 'A%.0s' $(seq 1 43))"
expect "$(api "$UNKNOWN" GET /api/deployments)" 401 "unknown token" token_invalid
expect "$(api "ghp_pas-un-jeton-pupitre" GET /api/deployments)" 401 "malformed token" token_invalid

step "3. Never more than its author"
code=$(req POST /api/admin/users "$ADMIN_JAR" \
  "{\"name\":\"Membre jetons\",\"email\":\"$MEMBER_EMAIL\",\"password\":\"$MEMBER_PASSWORD\",\"role\":\"viewer\"}")
case "$code" in 201|409) : ;; *) fail "creating the member → HTTP $code: $(cat "$BODY")" ;; esac
MEMBER_ID=$(psql_q "select id from users where email = '$MEMBER_EMAIL';")
expect "$(req PATCH "/api/admin/users/$MEMBER_ID/role" "$ADMIN_JAR" '{"role":"viewer"}')" 200 "member as viewer"
# The body goes through a variable: split over two lines inside a "$(…)", a
# JSON with commas would be cut up by bash's brace expansion.
credentials="{\"email\":\"$MEMBER_EMAIL\",\"password\":\"$MEMBER_PASSWORD\"}"
expect "$(req POST /api/auth/sign-in/email "$MEMBER_JAR" "$credentials")" 200 "member sign-in"
expect "$(req POST /api/tokens "$MEMBER_JAR" \
  '{"name":"verif-escalade","permissions":["deployment:create"]}')" 403 \
  "asking for a permission one does not have" forbidden
expect "$(req POST /api/tokens "$MEMBER_JAR" \
  '{"name":"verif-membre","permissions":["deployment:read"]}')" 201 "a token within its permissions"
MEMBER_TOKEN=$(jq -r .token "$BODY")
expect "$(api "$MEMBER_TOKEN" GET /api/deployments)" 200 "the member's token reads"
expect "$(req PATCH "/api/admin/users/$MEMBER_ID/role" "$ADMIN_JAR" '{"role":"no-access"}')" 200 \
  "the member loses their permissions"
expect "$(api "$MEMBER_TOKEN" GET /api/deployments)" 403 "their token loses them with them" forbidden
expect "$(req DELETE "/api/admin/users/$MEMBER_ID" "$ADMIN_JAR")" 200 "the member is deleted"
MEMBER_ID=""
expect "$(api "$MEMBER_TOKEN" GET /api/deployments)" 401 "their token disappears with them" token_invalid

step "4. Limited to one application"
spec="{\"appSpec\":{\"name\":\"$APP_SLUG\",\"version\":\"1.0.0\",\"services\":[{\"name\":\"web\",\"source\":{\"type\":\"image\",\"ref\":\"nginx:alpine\"},\"port\":80,\"exposed\":true}]}}"
code=$(req POST /api/applications "$ADMIN_JAR" "$spec")
[ "$code" = "201" ] || fail "creating the application → HTTP $code: $(cat "$BODY")"
APP_ID=$(jq -r .id "$BODY")
pass "application \"$APP_SLUG\" created"
code=$(req POST /api/tokens "$ADMIN_JAR" \
  "{\"name\":\"verif-ci\",\"permissions\":[\"deployment:create\",\"deployment:read\",\"application:read\"],\"applicationIds\":[\"$APP_ID\"]}")
expect "$code" 201 "token limited to \"$APP_SLUG\""
CI_TOKEN=$(jq -r .token "$BODY")
CI_ID=$(jq -r .item.id "$BODY")
expect "$(api "$CI_TOKEN" GET "/api/applications/$APP_ID")" 200 "reading its application"
OTHER="00000000-0000-4000-8000-000000000000"
expect "$(api "$CI_TOKEN" GET "/api/applications/$OTHER")" 403 "reading another application" token_scope
elsewhere="{\"applicationId\":\"$OTHER\",\"targetId\":\"$OTHER\",\"runtime\":\"docker\"}"
expect "$(api "$CI_TOKEN" POST /api/deployments "$elsewhere")" 403 \
  "deploying another application" token_scope
expect "$(api "$CI_TOKEN" GET /api/deployments)" 403 "a route that does not check the application" token_scope
# Even on its own application: a route that does not check the scope refuses.
expect "$(api "$CI_TOKEN" GET "/api/applications/$APP_ID/versions")" 403 \
  "its application, through a route that does not check the scope" token_scope

step "5. Revoked, expired"
expect "$(req DELETE "/api/tokens/$CI_ID" "$ADMIN_JAR")" 200 "revocation"
jq -e '.item.status == "revoked"' "$BODY" >/dev/null || fail "the token does not appear revoked"
expect "$(api "$CI_TOKEN" GET "/api/applications/$APP_ID")" 401 "revoked token" token_revoked
psql_q "update api_tokens set expires_at = now() - interval '1 minute' where id = '$READ_ID';" >/dev/null
expect "$(api "$READ_TOKEN" GET /api/deployments)" 401 "expired token" token_expired

step "6. The log"
code=$(req GET "/api/audit-logs?action=permission.denied&pageSize=50" "$ADMIN_JAR")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
jq -e '[.items[] | select(.apiTokenName == "verif-ci" and .after.reason == "token_scope")] | length > 0' \
  "$BODY" >/dev/null || fail "the limited token's refusals do not carry its name"
pass "the refusals carry the token's name"
created=$(psql_q "select count(*) from audit_logs where action = 'api_token.created' and after->>'name' like 'verif-%';")
[ "$created" -ge 3 ] || fail "token creations in the log: $created"
pass "each creation is in the log ($created)"
for token in "$READ_TOKEN" "$CI_TOKEN" "$MEMBER_TOKEN"; do
  leaked=$(psql_q "select count(*) from audit_logs where coalesce(after::text,'') || coalesce(before::text,'') like '%$token%';")
  [ "$leaked" = "0" ] || fail "a token appears in clear in the log"
done
pass "no token in clear in the log"

printf '\n\033[32m✓ API tokens verified.\033[0m\n\n'
