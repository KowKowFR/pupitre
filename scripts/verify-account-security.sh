#!/usr/bin/env bash
#
# Checks "Accounts and sessions": the required second factor, the session
# durations.
#
#   1. ground: an administrator WITH a second factor (to configure), an
#      operator and a viewer without, and an API token of the operator's
#   2. requiring the second factor without having it yourself is refused (409)
#   3. "sensitive rights" policy: the operator only has the activation screen
#      left — 403 `two_factor_required` on the API, the chat, their token; their
#      pages redirect to /two-factor-setup; the viewer, for their part, is not
#      concerned, nor is an account without a password (single sign-on)
#   4. Better Auth's twoFactor plugin direct routes are closed
#   5. the operator enables their second factor: everything reopens, token
#      included, and they can no longer remove it (409 `two_factor_locked`)
#   6. "all accounts" policy: the viewer goes through it too
#   7. idle duration shortened: the open sessions are brought back, the new
#      ones are born with the new duration
#   8. absolute cap: a session that is too old is closed, and removed from the database
#   9. the audit keeps the refusals, without any secret
#  10. cleanup: settings put back as before, test accounts deleted
#
# The TOTP code is computed here, per RFC 6238, by a few lines of Node.
#
# Usage:
#   ./scripts/verify-account-security.sh
#   BASE_URL=http://localhost:3200 ADMIN_EMAIL=… ADMIN_PASSWORD=… ./scripts/verify-account-security.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
PASSWORD="motdepasse-tres-long-securite"
GUARD_EMAIL="securite-admin@example.test"
OPERATOR_EMAIL="securite-operateur@example.test"
VIEWER_EMAIL="securite-observateur@example.test"
SSO_EMAIL="securite-sso@example.test"
CLIENT_IP="${CLIENT_IP:-198.51.100.92}"

WORK="$(mktemp -d)"
BODY="$WORK/body.json"
ADMIN_JAR="$WORK/admin.jar"
GUARD_JAR="$WORK/guard.jar"
OPERATOR_JAR="$WORK/operator.jar"
VIEWER_JAR="$WORK/viewer.jar"
JAR="$ADMIN_JAR"
SAVED=""

command -v jq >/dev/null || { echo "jq is required"; exit 1; }
command -v node >/dev/null || { echo "node is required to compute the TOTP codes"; exit 1; }

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

api() {
  local token="$1" method="$2" path="$3"
  curl -s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path" \
    -H "authorization: Bearer $token" -H 'user-agent: verify-account-security'
}

# A page: the code and, for a redirect, its destination.
page() {
  curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE_URL$1" -b "$JAR"
}

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }

error_code() { jq -r '.error.code // empty' "$BODY"; }

# ─── Computing a real TOTP code (RFC 6238) ────────────────────────────────────
cat > "$WORK/totp.mjs" <<'NODE'
import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(input) {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

const [secret] = process.argv.slice(2);
const block = Buffer.alloc(8);
block.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
const digest = createHmac('sha1', base32Decode(secret)).update(block).digest();
const offset = digest[digest.length - 1] & 0x0f;
const truncated = digest.readUInt32BE(offset) & 0x7fffffff;
process.stdout.write(String(truncated % 1000000).padStart(6, '0'));
NODE

totp() { node "$WORK/totp.mjs" "$1"; }

# ─── Signing in, patient with Better Auth's rate limit ────────────────────────
signin() {
  local email="$1" password="$2" code
  for _ in 1 2 3 4 5 6; do
    code=$(req POST /api/auth/sign-in/email \
      "{\"email\":\"$email\",\"password\":\"$password\"}")
    [ "$code" = "429" ] || { printf '%s' "$code"; return 0; }
    sleep 6
  done
  printf '%s' "$code"
}

# Arms a second factor on the current `JAR`'s session; returns the secret.
enroll() {
  local code secret
  code=$(req POST /api/account/two-factor/setup "{\"password\":\"$PASSWORD\"}")
  [ "$code" = "200" ] || fail "setup → HTTP $code: $(cat "$BODY")"
  secret=$(jq -r '.totpURI' "$BODY" | sed -n 's/.*[?&]secret=\([^&]*\).*/\1/p')
  [ -n "$secret" ] || fail "no secret in the TOTP URI"
  code=$(req POST /api/account/two-factor/activate "{\"code\":\"$(totp "$secret")\"}")
  [ "$code" = "200" ] || fail "activation → HTTP $code: $(cat "$BODY")"
  printf '%s' "$secret"
}

drop_user() {
  local email="$1" id
  id=$(psql_q "select id from users where email = '$email';")
  [ -n "$id" ] || return 0
  JAR="$ADMIN_JAR"
  req DELETE "/api/admin/users/$id" >/dev/null || true
}

# The settings come back as they were, even if the script fails on the way:
# through the API if the test administrator can, otherwise through the
# database — the panel will read the session duration again at its next start.
restore() {
  [ -n "$SAVED" ] || return 0
  local code
  JAR="$GUARD_JAR"
  code=$(req PATCH /api/settings "{\"accounts\":$SAVED}" 2>/dev/null || true)
  if [ "$code" != "200" ]; then
    psql_q "update app_settings set value = jsonb_set(value, '{accounts}', '$SAVED'::jsonb) where id = 1;" >/dev/null || true
    info "settings put back through the database (HTTP $code through the API)"
  fi
  SAVED=""
}

cleanup() {
  restore
  drop_user "$GUARD_EMAIL"
  drop_user "$OPERATOR_EMAIL"
  drop_user "$VIEWER_EMAIL"
  drop_user "$SSO_EMAIL"
  rm -rf "$WORK"
}
trap cleanup EXIT

# ─── 1. Terrain ───────────────────────────────────────────────────────────────
step "1. Terrain"
JAR="$ADMIN_JAR"
code=$(signin "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
[ "$code" = "200" ] || fail "admin sign-in → HTTP $code: $(cat "$BODY")"
[ "$(jq -r '.user.role // empty' "$BODY")" = "admin" ] || fail "\"$ADMIN_EMAIL\" is not an administrator"
pass "signed in as $ADMIN_EMAIL"

drop_user "$GUARD_EMAIL"
drop_user "$OPERATOR_EMAIL"
drop_user "$VIEWER_EMAIL"
drop_user "$SSO_EMAIL"

JAR="$ADMIN_JAR"
req GET /api/settings >/dev/null
SAVED=$(jq -c '.settings.accounts' "$BODY")
[ "$SAVED" != "null" ] || fail "GET /api/settings returns no \"accounts\" section"
info "starting settings: $SAVED"

# The starting state must have no requirement: otherwise the administrator
# themselves could be held, and nothing that follows would be readable.
code=$(req PATCH /api/settings '{"accounts":{"twoFactorPolicy":"off","sessionIdleHours":168,"sessionMaxHours":null}}')
[ "$code" = "200" ] || fail "resetting the settings → HTTP $code: $(cat "$BODY")"

for spec in "Garde|$GUARD_EMAIL|admin" "Opérateur|$OPERATOR_EMAIL|operator" "Observateur|$VIEWER_EMAIL|viewer" "Connexion unique|$SSO_EMAIL|operator"; do
  IFS='|' read -r name email role <<<"$spec"
  JAR="$ADMIN_JAR"
  code=$(req POST /api/admin/users \
    "{\"name\":\"$name sécurité\",\"email\":\"$email\",\"password\":\"$PASSWORD\",\"role\":\"$role\"}")
  [ "$code" = "201" ] || fail "creating $email → HTTP $code: $(cat "$BODY")"
done
OPERATOR_ID=$(psql_q "select id from users where email = '$OPERATOR_EMAIL';")
VIEWER_ID=$(psql_q "select id from users where email = '$VIEWER_EMAIL';")
pass "accounts created: guard administrator, operator, viewer"

JAR="$GUARD_JAR"
code=$(signin "$GUARD_EMAIL" "$PASSWORD")
[ "$code" = "200" ] || fail "guard sign-in → HTTP $code"
GUARD_SECRET=$(enroll)
[ -n "$GUARD_SECRET" ] || fail "the guard's second factor"
pass "the guard administrator has an armed second factor"

JAR="$OPERATOR_JAR"
code=$(signin "$OPERATOR_EMAIL" "$PASSWORD")
[ "$code" = "200" ] || fail "operator sign-in → HTTP $code"
code=$(req POST /api/tokens '{"name":"verif-securite","permissions":["target:read"],"expiresInDays":30}')
[ "$code" = "201" ] || fail "operator token → HTTP $code: $(cat "$BODY")"
OPERATOR_TOKEN=$(jq -r .token "$BODY")
[ "$(api "$OPERATOR_TOKEN" GET /api/targets)" = "200" ] || fail "the operator's token does not read the targets"
pass "the operator has a session and an API token that work"

JAR="$VIEWER_JAR"
code=$(signin "$VIEWER_EMAIL" "$PASSWORD")
[ "$code" = "200" ] || fail "viewer sign-in → HTTP $code"
pass "the viewer has a session"

# An account that only comes in through single sign-on has no password: we make
# one by removing an operator's `credential` row, after having it create a
# token — it is through this token that we will see it act.
SSO_JAR="$WORK/sso.jar"
JAR="$SSO_JAR"
code=$(signin "$SSO_EMAIL" "$PASSWORD")
[ "$code" = "200" ] || fail "sign-in of the \"single sign-on\" account → HTTP $code"
code=$(req POST /api/tokens '{"name":"verif-sso","permissions":["target:read"],"expiresInDays":30}')
[ "$code" = "201" ] || fail "token of the \"single sign-on\" account → HTTP $code: $(cat "$BODY")"
SSO_TOKEN=$(jq -r .token "$BODY")
psql_q "delete from accounts where provider_id = 'credential' and user_id = (select id from users where email = '$SSO_EMAIL');" >/dev/null
pass "an operator without a password, like a single sign-on account, with a token"

# ─── 2. One does not require what one does not have ───────────────────────────
step "2. Requiring the second factor without having it yourself"
ADMIN_2FA=$(psql_q "select two_factor_enabled from users where email = '$ADMIN_EMAIL';")
if [ "$ADMIN_2FA" = "f" ]; then
  JAR="$ADMIN_JAR"
  code=$(req PATCH /api/settings '{"accounts":{"twoFactorPolicy":"sensitive"}}')
  [ "$code" = "409" ] || fail "expected 409, got HTTP $code: $(cat "$BODY")"
  [ "$(error_code)" = "two_factor_self" ] || fail "code d'erreur: $(error_code)"
  pass "$ADMIN_EMAIL, without a second factor → 409 two_factor_self, nothing saved"
else
  info "$ADMIN_EMAIL has a second factor: refusal not tried"
fi

# ─── 3. Sensitive rights ──────────────────────────────────────────────────────
step "3. \"Sensitive rights\" policy"
JAR="$GUARD_JAR"
code=$(req PATCH /api/settings '{"accounts":{"twoFactorPolicy":"sensitive"}}')
[ "$code" = "200" ] || fail "PATCH by the guard → HTTP $code: $(cat "$BODY")"
[ "$(jq -r '.settings.accounts.twoFactorPolicy' "$BODY")" = "sensitive" ] || fail "policy not saved"
pass "the guard, who has a second factor, saves it"

JAR="$OPERATOR_JAR"
code=$(req GET /api/targets)
[ "$code" = "403" ] || fail "operator on /api/targets: HTTP $code instead of 403"
[ "$(error_code)" = "two_factor_required" ] || fail "code d'erreur: $(error_code)"
pass "operator without a second factor → 403 two_factor_required on the API"

code=$(req GET /api/chat/messages)
[ "$code" = "403" ] && [ "$(error_code)" = "two_factor_required" ] \
  || fail "discussion: HTTP $code ($(error_code))"
pass "the chat is closed to them too"

code=$(api "$OPERATOR_TOKEN" GET /api/targets)
[ "$code" = "403" ] && [ "$(error_code)" = "two_factor_required" ] \
  || fail "operator token: HTTP $code ($(error_code))"
pass "their API token is no better than they are → 403 two_factor_required"

code=$(req GET /api/account/sessions)
[ "$code" = "200" ] || fail "\"My account\" closed to the operator: HTTP $code"
pass "the account routes stay open, long enough to enable it"

for target in /targets /account /onboarding; do
  read -r status location <<<"$(page "$target")"
  [ "$status" = "307" ] && [[ "$location" == *"/two-factor-setup" ]] \
    || fail "$target: $status → $location"
done
read -r status _ <<<"$(page /two-factor-setup)"
[ "$status" = "200" ] || fail "/two-factor-setup: HTTP $status"
pass "their pages, \"My account\" included, redirect to /two-factor-setup, which displays"

JAR="$VIEWER_JAR"
code=$(req GET /api/targets)
[ "$code" = "200" ] || fail "viewer on /api/targets: HTTP $code ($(error_code))"
pass "the viewer, who only reads, is not concerned"

code=$(api "$SSO_TOKEN" GET /api/targets)
[ "$code" = "200" ] || fail "operator without a password: HTTP $code ($(error_code))"
pass "nor is the operator without a password: their second factor is the provider's business"

JAR="$ADMIN_JAR"
if [ "$ADMIN_2FA" = "f" ]; then
  code=$(req GET /api/targets)
  [ "$code" = "403" ] && [ "$(error_code)" = "two_factor_required" ] \
    || fail "administrator without a second factor: HTTP $code ($(error_code))"
  pass "$ADMIN_EMAIL, administrator without a second factor, is held too"
fi

# ─── 4. Better Auth's direct routes ───────────────────────────────────────────
step "4. Better Auth's twoFactor plugin routes are closed"
JAR="$GUARD_JAR"
code=$(req POST /api/auth/two-factor/disable "{\"password\":\"$PASSWORD\"}")
[ "$code" = "404" ] || fail "/api/auth/two-factor/disable: HTTP $code"
[ "$(psql_q "select two_factor_enabled from users where email = '$GUARD_EMAIL';")" = "t" ] \
  || fail "the guard's second factor was removed through the direct route"
code=$(req POST /api/auth/two-factor/enable "{\"password\":\"$PASSWORD\"}")
[ "$code" = "404" ] || fail "/api/auth/two-factor/enable: HTTP $code"
pass "disable and enable → 404, the guard's second factor is intact"

# ─── 5. The operator enables theirs ───────────────────────────────────────────
step "5. The operator enables their second factor"
JAR="$OPERATOR_JAR"
OPERATOR_SECRET=$(enroll)
[ -n "$OPERATOR_SECRET" ] || fail "the operator's second factor"
code=$(req GET /api/targets)
[ "$code" = "200" ] || fail "after activation, /api/targets: HTTP $code ($(error_code))"
read -r status _ <<<"$(page /targets)"
[ "$status" = "200" ] || fail "after activation, /targets: HTTP $status"
read -r status location <<<"$(page /two-factor-setup)"
[ "$status" = "307" ] && [ "${location%/}" = "$BASE_URL" ] \
  || fail "after activation, /two-factor-setup: $status → $location"
pass "everything reopens, in the same session — API and pages; the activation screen sends back to the panel"

[ "$(api "$OPERATOR_TOKEN" GET /api/targets)" = "200" ] || fail "token still refused: $(error_code)"
pass "their API token too"

code=$(req POST /api/account/two-factor/disable "{\"password\":\"$PASSWORD\"}")
[ "$code" = "409" ] && [ "$(error_code)" = "two_factor_locked" ] \
  || fail "deactivation: HTTP $code ($(error_code))"
[ "$(psql_q "select two_factor_enabled from users where id = '$OPERATOR_ID';")" = "t" ] \
  || fail "the second factor was removed despite the refusal"
pass "they can no longer remove it → 409 two_factor_locked"

# ─── 6. All accounts ──────────────────────────────────────────────────────────
step "6. \"All accounts\" policy"
JAR="$GUARD_JAR"
code=$(req PATCH /api/settings '{"accounts":{"twoFactorPolicy":"all"}}')
[ "$code" = "200" ] || fail "PATCH all → HTTP $code"
JAR="$VIEWER_JAR"
code=$(req GET /api/targets)
[ "$code" = "403" ] && [ "$(error_code)" = "two_factor_required" ] \
  || fail "viewer under \"all\": HTTP $code ($(error_code))"
pass "the viewer goes through it in turn → 403 two_factor_required"

JAR="$GUARD_JAR"
code=$(req PATCH /api/settings '{"accounts":{"twoFactorPolicy":"off"}}')
[ "$code" = "200" ] || fail "PATCH off → HTTP $code"
JAR="$VIEWER_JAR"
[ "$(req GET /api/targets)" = "200" ] || fail "viewer still refused after \"off\""
pass "policy removed: the viewer reads the targets again"

# ─── 7. Idle duration ─────────────────────────────────────────────────────────
step "7. Idle duration shortened to one hour"
before=$(psql_q "select max(extract(epoch from expires_at - now()))::int from sessions where user_id = '$VIEWER_ID';")
info "viewer's session: expires in ${before} s"
[ "$before" -gt 7200 ] || fail "the starting session already expires in less than two hours"

JAR="$GUARD_JAR"
code=$(req PATCH /api/settings '{"accounts":{"sessionIdleHours":1}}')
[ "$code" = "200" ] || fail "PATCH sessionIdleHours → HTTP $code: $(cat "$BODY")"
after=$(psql_q "select max(extract(epoch from expires_at - now()))::int from sessions where user_id = '$VIEWER_ID';")
[ "$after" -le 3600 ] && [ "$after" -gt 3500 ] || fail "open session: expires in ${after} s"
pass "the session already open is brought back to one hour (${after} s)"

JAR="$VIEWER_JAR"
[ "$(req GET /api/targets)" = "200" ] || fail "the session brought back no longer works"
pass "and it still works"

VIEWER2_JAR="$WORK/viewer2.jar"
JAR="$VIEWER2_JAR"
code=$(signin "$VIEWER_EMAIL" "$PASSWORD")
[ "$code" = "200" ] || fail "new sign-in → HTTP $code"
fresh=$(psql_q "select extract(epoch from expires_at - now())::int from sessions where user_id = '$VIEWER_ID' order by created_at desc limit 1;")
[ "$fresh" -le 3600 ] && [ "$fresh" -gt 3500 ] || fail "new session: expires in ${fresh} s"
pass "a new session is born with the new duration (${fresh} s)"

# ─── 8. Absolute cap ──────────────────────────────────────────────────────────
step "8. Absolute cap of 24 hours"
JAR="$GUARD_JAR"
code=$(req PATCH /api/settings '{"accounts":{"sessionIdleHours":168,"sessionMaxHours":24}}')
[ "$code" = "200" ] || fail "PATCH sessionMaxHours → HTTP $code"
# The viewer's most recent session "was opened" 25 hours ago.
OLD_SESSION=$(psql_q "select id from sessions where user_id = '$VIEWER_ID' order by created_at desc limit 1;")
psql_q "update sessions set created_at = now() - interval '25 hours' where id = '$OLD_SESSION';" >/dev/null
JAR="$VIEWER2_JAR"
code=$(req GET /api/targets)
[ "$code" = "401" ] || fail "session de 25 h: HTTP $code au lieu de 401"
[ "$(psql_q "select count(*) from sessions where id = '$OLD_SESSION';")" = "0" ] \
  || fail "the session that is too old stayed in the database"
pass "a 25-hour-old session → 401, and removed from the database"

JAR="$VIEWER_JAR"
[ "$(req GET /api/targets)" = "200" ] || fail "the other, recent session was refused"
pass "the other, recent session still works"

# ─── 9. Audit ─────────────────────────────────────────────────────────────────
step "9. The log"
denied=$(psql_q "select count(*) from audit_logs where action = 'permission.denied' and actor_id = '$OPERATOR_ID' and after->>'reason' = 'two_factor_required';")
[ "$denied" -ge 3 ] || fail "$denied two_factor_required refusals in the log for the operator"
pass "$denied \"two_factor_required\" refusals in the log for the operator"
[ "$(psql_q "select count(*) from audit_logs where action = 'account.2fa.disable_failed' and actor_id = '$OPERATOR_ID' and after->>'reason' = 'two_factor_locked';")" -ge 1 ] \
  || fail "the deactivation refusal is not in the log"
pass "the deactivation refusal is in the log"
[ "$(psql_q "select count(*) from audit_logs where action = 'auth.two_factor_route.refused' and created_at > now() - interval '10 minutes';")" -ge 2 ] \
  || fail "the refused direct routes are not in the log"
pass "the refused direct routes too (auth.two_factor_route.refused)"
[ "$(psql_q "select count(*) from audit_logs where action = 'auth.session.expired' and resource_id = '$OLD_SESSION' and after->>'reason' = 'max_age';")" = "1" ] \
  || fail "the session closed by the cap is not in the log"
pass "the session closed by the cap too (auth.session.expired, max_age)"
leak=$(psql_q "select count(*) from audit_logs where created_at > now() - interval '10 minutes' and (coalesce(after::text, '') like '%$GUARD_SECRET%' or coalesce(after::text, '') like '%$OPERATOR_SECRET%' or coalesce(after::text, '') like '%$PASSWORD%');")
[ "$leak" = "0" ] || fail "$leak audit entry(ies) carry a TOTP secret or a password"
pass "no TOTP secret nor password in the log"

# ─── 10. Cleanup ──────────────────────────────────────────────────────────────
step "10. Cleanup"
restore
JAR="$ADMIN_JAR"
req GET /api/settings >/dev/null
info "settings put back: $(jq -c '.settings.accounts' "$BODY")"
code=$(req GET /api/targets)
[ "$code" = "200" ] || fail "$ADMIN_EMAIL does not read the targets again after the cleanup: HTTP $code ($(error_code))"
pass "$ADMIN_EMAIL reads the targets again — settings put back"

printf '\n\033[32mAccounts and sessions: everything complies.\033[0m\n'
