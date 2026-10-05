#!/usr/bin/env bash
#
# Checks the account's security — password and two-factor authentication:
#
#   1. changing one's password: the old one dies, the new one lives
#   2. a change without the old password is refused
#   3. the OTHER sessions fall, the one that changed the password survives
#   4. enabling TOTP: the second factor is only armed after a valid code
#   5. sign-in asks for the code, refuses a wrong one, accepts the right one
#   6. a backup code works only once
#   7. the TOTP secret appears neither in the database nor in the container's logs
#   8. disabling the second factor gives back a plain sign-in
#
# The TOTP code is computed here, per RFC 6238: `oathtool` if it is installed,
# otherwise about fifteen lines of Node (HMAC-SHA1 on a 30 s counter).
#
# Usage:
#   ./scripts/verify-account.sh
#   BASE_URL=http://localhost:3200 ./scripts/verify-account.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
TEST_EMAIL="${TEST_EMAIL:-account-verification@example.test}"
OLD_PASSWORD="ancien-motdepasse-tres-long"
NEW_PASSWORD="nouveau-motdepasse-tres-long"
CLIENT_IP="${CLIENT_IP:-198.51.100.77}"

WORK="$(mktemp -d)"
BODY="$WORK/body.json"
ADMIN_JAR="$WORK/admin.jar"
JAR="$ADMIN_JAR"
trap 'rm -rf "$WORK"' EXIT

command -v jq >/dev/null || { echo "jq is required"; exit 1; }
command -v node >/dev/null || { echo "node is required to compute the TOTP codes"; exit 1; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
info() { printf '    \033[2m%s\033[0m\n' "$1"; }

# Better Auth requires the `Origin` header on authenticated POSTs (CSRF
# protection): it is set on every request, not only those that strictly need
# it.
req() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -H "x-forwarded-for: $CLIENT_IP" -b "$JAR" -c "$JAR")
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }

# ─── Computing a real TOTP code ───────────────────────────────────────────────
cat > "$WORK/totp.mjs" <<'NODE'
import { createHmac } from 'node:crypto';

// RFC 4648 base32 → bytes. The otpauth:// URI's `secret=` is encoded that way.
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

const [secret, offsetArg] = process.argv.slice(2);
// A shift of 30 s windows: used to make a code outside the tolerance (Better
// Auth accepts ±1 window) to prove that a wrong code is refused.
const counter = Math.floor(Date.now() / 30000) + Number(offsetArg ?? 0);

const block = Buffer.alloc(8);
block.writeBigUInt64BE(BigInt(counter));
const digest = createHmac('sha1', base32Decode(secret)).update(block).digest();
const offset = digest[digest.length - 1] & 0x0f;
const truncated = digest.readUInt32BE(offset) & 0x7fffffff;
process.stdout.write(String(truncated % 1000000).padStart(6, '0'));
NODE

totp() {
  local secret="$1" offset="${2:-0}"
  if [ "$offset" = "0" ] && command -v oathtool >/dev/null; then
    oathtool --base32 --totp "$secret"
  else
    node "$WORK/totp.mjs" "$secret" "$offset"
  fi
}

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

session_email() {
  req GET /api/auth/get-session >/dev/null
  jq -r '.user.email // empty' "$BODY"
}

assert_admin() {
  local role
  role=$(jq -r '.user.role // empty' "$BODY")
  [ "$role" = "admin" ] && return 0
  fail "\"$ADMIN_EMAIL\" has the role \"${role:-none}\", not \"admin\" — see /admin/users"
}

admin_login() {
  local code
  JAR="$ADMIN_JAR"
  code=$(signin "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
  if [ "$code" = "200" ]; then assert_admin; return 0; fi
  code=$(req POST /api/auth/sign-up/email \
    "{\"name\":\"Admin\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
  [ "$code" = "200" ] || fail "admin sign-in failed (HTTP $code): $(cat "$BODY")"
  assert_admin
}

# ─── 1. Terrain ───────────────────────────────────────────────────────────────
step "1. Ground: administrator and test user"
admin_login
pass "signed in as $ADMIN_EMAIL"

# Cleanup from a previous run.
JAR="$ADMIN_JAR"
existing=$(psql_q "select id from users where email = '$TEST_EMAIL';")
if [ -n "$existing" ]; then
  req DELETE "/api/admin/users/$existing" >/dev/null || true
  info "leftover test user deleted"
fi

code=$(req POST /api/admin/users \
  "{\"name\":\"Compte de vérification\",\"email\":\"$TEST_EMAIL\",\"password\":\"$OLD_PASSWORD\",\"role\":\"viewer\"}")
[ "$code" = "201" ] || fail "creating the test user → HTTP $code: $(cat "$BODY")"
USER_ID=$(psql_q "select id from users where email = '$TEST_EMAIL';")
[ -n "$USER_ID" ] || fail "test user not found in the database"
pass "test user created ($TEST_EMAIL)"

JAR_A="$WORK/a.jar"
JAR_B="$WORK/b.jar"

JAR="$JAR_A"; code=$(signin "$TEST_EMAIL" "$OLD_PASSWORD")
[ "$code" = "200" ] || fail "sign-in (session A) → HTTP $code: $(cat "$BODY")"
JAR="$JAR_B"; code=$(signin "$TEST_EMAIL" "$OLD_PASSWORD")
[ "$code" = "200" ] || fail "sign-in (session B) → HTTP $code: $(cat "$BODY")"
pass "two distinct sessions open (cookies A and B)"

JAR="$JAR_A"; [ "$(session_email)" = "$TEST_EMAIL" ] || fail "session A invalide"
JAR="$JAR_B"; [ "$(session_email)" = "$TEST_EMAIL" ] || fail "session B invalide"
pass "both sessions answer /api/auth/get-session"

# ─── 2. Changement de mot de passe ────────────────────────────────────────────
step "2. Changement de mot de passe"
JAR="$JAR_A"

code=$(req POST /api/account/password "{\"newPassword\":\"$NEW_PASSWORD\"}")
[ "$code" = "422" ] || fail "change without the old password: expected 422, got $code"
jq -e '.error.code == "validation_failed"' "$BODY" >/dev/null \
  || fail "unexpected error code: $(jq -c .error "$BODY")"
pass "without the old password → 422, the request is not even admissible"

code=$(req POST /api/account/password \
  "{\"currentPassword\":\"pas-du-tout-le-bon-mot-de-passe\",\"newPassword\":\"$NEW_PASSWORD\"}")
[ "$code" = "400" ] || fail "wrong old password: expected 400, got $code"
jq -e '.error.code == "invalid_password"' "$BODY" >/dev/null \
  || fail "unexpected error code: $(jq -c .error "$BODY")"
pass "with a wrong old password → 400 invalid_password"

code=$(req POST /api/account/password \
  "{\"currentPassword\":\"$OLD_PASSWORD\",\"newPassword\":\"$NEW_PASSWORD\"}")
[ "$code" = "200" ] || fail "changement → HTTP $code: $(cat "$BODY")"
jq -e '.revokedOtherSessions == true' "$BODY" >/dev/null || fail "revocation not announced"
pass "password changed from session A"

step "3. The fate of the other sessions"
JAR="$JAR_A"
[ "$(session_email)" = "$TEST_EMAIL" ] \
  || fail "the session that changed the password was closed — unusable"
pass "session A (the one that acted): still open, cookie renewed"

JAR="$JAR_B"
b_email="$(session_email)"
[ -z "$b_email" ] \
  || fail "session B survives the password change (user \"$b_email\")"
pass "session B: closed — a stolen cookie does not survive the change"

step "4. The old password is dead, the new one lives"
JAR="$WORK/old.jar"; code=$(signin "$TEST_EMAIL" "$OLD_PASSWORD")
[ "$code" = "401" ] || fail "the old password answers HTTP $code instead of 401"
pass "sign-in with the old password → 401"

JAR="$WORK/new.jar"; code=$(signin "$TEST_EMAIL" "$NEW_PASSWORD")
[ "$code" = "200" ] || fail "the new password answers HTTP $code instead of 200"
pass "sign-in with the new password → 200"

# ─── 5. Enabling TOTP ─────────────────────────────────────────────────────────
step "5. Enabling the second factor"
JAR="$JAR_A"

code=$(req POST /api/account/two-factor/setup "{\"password\":\"$NEW_PASSWORD\"}")
[ "$code" = "200" ] || fail "setup → HTTP $code: $(cat "$BODY")"
TOTP_URI=$(jq -r '.totpURI' "$BODY")
SECRET=$(printf '%s' "$TOTP_URI" | sed -n 's/.*[?&]secret=\([^&]*\).*/\1/p')
# `mapfile` does not exist in bash 3.2 (macOS's): an explicit loop.
BACKUP_CODES=()
while IFS= read -r line; do BACKUP_CODES+=("$line"); done < <(jq -r '.backupCodes[]' "$BODY")
[ -n "$SECRET" ] || fail "no secret in the TOTP URI"
[ "${#BACKUP_CODES[@]}" -ge 5 ] || fail "too few backup codes (${#BACKUP_CODES[@]})"
pass "secret generated (${#SECRET} base32 characters) and ${#BACKUP_CODES[@]} backup codes returned"

armed=$(psql_q "select coalesce((select verified::text from two_factors where user_id = '$USER_ID'), 'aucune');")
[ "$armed" = "false" ] || fail "the two_factors row is already verified=$armed before verification"
enabled=$(psql_q "select two_factor_enabled from users where id = '$USER_ID';")
[ "$enabled" = "f" ] || fail "users.two_factor_enabled is already true before verification"
pass "second factor NOT armed yet: two_factors.verified=false, users.two_factor_enabled=false"

code=$(req POST /api/account/two-factor/activate "{\"code\":\"$(totp "$SECRET" 50)\"}")
[ "$code" = "400" ] || fail "code outside the window: expected 400, got $code"
jq -e '.error.code == "invalid_code"' "$BODY" >/dev/null \
  || fail "unexpected error code: $(jq -c .error "$BODY")"
enabled=$(psql_q "select two_factor_enabled from users where id = '$USER_ID';")
[ "$enabled" = "f" ] || fail "an invalid code armed the second factor all the same"
pass "an invalid code → 400 invalid_code, nothing is armed"

code=$(req POST /api/account/two-factor/activate "{\"code\":\"$(totp "$SECRET")\"}")
[ "$code" = "200" ] || fail "activation → HTTP $code: $(cat "$BODY")"
enabled=$(psql_q "select two_factor_enabled from users where id = '$USER_ID';")
[ "$enabled" = "t" ] || fail "users.two_factor_enabled stays false after a valid code"
pass "valid code → second factor armed (users.two_factor_enabled=true)"

# ─── 6. Sign-in asks for the code ─────────────────────────────────────────────
step "6. Sign-in now asks for the code"
JAR_D="$WORK/d.jar"
JAR="$JAR_D"; code=$(signin "$TEST_EMAIL" "$NEW_PASSWORD")
[ "$code" = "200" ] || fail "sign-in → HTTP $code: $(cat "$BODY")"
jq -e '.twoFactorRedirect == true' "$BODY" >/dev/null \
  || fail "the password alone was enough: $(jq -c . "$BODY")"
jq -e '.twoFactorMethods | index("totp")' "$BODY" >/dev/null || fail "totp method not announced"
pass "password alone → twoFactorRedirect, no session set"

[ -z "$(session_email)" ] || fail "a session exists although the code was not provided"
pass "/api/auth/get-session returns nothing as long as the code is missing"

code=$(req POST /api/auth/two-factor/verify-totp "{\"code\":\"$(totp "$SECRET" 50)\"}")
[ "$code" = "401" ] || fail "invalid code at sign-in: expected 401, got $code"
pass "code invalide → 401"

code=$(req POST /api/auth/two-factor/verify-totp "{\"code\":\"$(totp "$SECRET")\"}")
[ "$code" = "200" ] || fail "code valide → HTTP $code: $(cat "$BODY")"
[ "$(session_email)" = "$TEST_EMAIL" ] || fail "no session after a valid code"
pass "code valide → session ouverte"

# ─── 7. Backup codes ──────────────────────────────────────────────────────────
step "7. A backup code is only used once"
RESCUE="${BACKUP_CODES[0]}"

JAR_E="$WORK/e.jar"
JAR="$JAR_E"; code=$(signin "$TEST_EMAIL" "$NEW_PASSWORD")
[ "$code" = "200" ] || fail "sign-in → HTTP $code"
jq -e '.twoFactorRedirect == true' "$BODY" >/dev/null || fail "second factor not asked for"
sleep 4
code=$(req POST /api/auth/two-factor/verify-backup-code "{\"code\":\"$RESCUE\"}")
[ "$code" = "200" ] || fail "backup code → HTTP $code: $(cat "$BODY")"
[ "$(session_email)" = "$TEST_EMAIL" ] || fail "no session after the backup code"
pass "first use of the backup code → session open"

JAR_F="$WORK/f.jar"
JAR="$JAR_F"; code=$(signin "$TEST_EMAIL" "$NEW_PASSWORD")
[ "$code" = "200" ] || fail "sign-in → HTTP $code"
sleep 4
code=$(req POST /api/auth/two-factor/verify-backup-code "{\"code\":\"$RESCUE\"}")
[ "$code" != "200" ] || fail "the same backup code was accepted a second time"
[ -z "$(session_email)" ] || fail "a session was opened despite a consumed backup code"
pass "second use of the same code → HTTP $code, refused"

# ─── 8. The secret does not leak ──────────────────────────────────────────────
step "8. The TOTP secret leaks neither into the database nor into the logs"
stored=$(psql_q "select secret from two_factors where user_id = '$USER_ID';")
[ "$stored" != "$SECRET" ] || fail "the secret is stored in clear in two_factors.secret"
pass "two_factors.secret is encrypted, it is not the returned secret"

leaks=$(psql_q "select count(*) from audit_logs
  where coalesce(before::text, '') || coalesce(after::text, '') || coalesce(resource_id, '')
        like '%$SECRET%';")
[ "$leaks" = "0" ] || fail "the TOTP secret appears in $leaks audit row(s)"
pass "no trace of the secret in audit_logs"

leaks=$(psql_q "select count(*) from audit_logs
  where coalesce(after::text, '') like '%$RESCUE%';")
[ "$leaks" = "0" ] || fail "a backup code appears in $leaks audit row(s)"
pass "no trace of the backup codes in audit_logs"

hits=$(docker compose logs panel --no-color 2>/dev/null | grep -c -- "$SECRET" || true)
[ "$hits" = "0" ] || fail "the TOTP secret appears $hits time(s) in the panel container's logs"
pass "no trace of the secret in \"docker compose logs panel\""

hits=$(docker compose logs panel --no-color 2>/dev/null | grep -c -- "$RESCUE" || true)
[ "$hits" = "0" ] || fail "a backup code appears $hits time(s) in the panel's logs"
pass "no trace of the backup codes in the panel's logs"

hits=$(docker compose logs panel --no-color 2>/dev/null | grep -c -- "$NEW_PASSWORD" || true)
[ "$hits" = "0" ] || fail "the password appears $hits time(s) in the panel's logs"
pass "no trace of the password in the panel's logs"

step "9. Traceability"
JAR="$ADMIN_JAR"
code=$(req GET "/api/audit-logs?actorId=$USER_ID&pageSize=50")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
for action in account.password.changed account.password.change_failed account.2fa.setup_started account.2fa.enabled; do
  jq -e --arg a "$action" '[.items[] | select(.action == $a)] | length > 0' "$BODY" >/dev/null \
    || fail "action \"$action\" missing from the audit log"
  pass "audit: $action"
done
jq -e '[.items[] | select(.action == "account.password.changed")][0].after
       | has("password") or has("newPassword") or has("currentPassword") | not' "$BODY" >/dev/null \
  || fail "the audit log carries a password"
pass "the password change row carries no password"

# ─── 10. Deactivation ─────────────────────────────────────────────────────────
step "10. Disabling the second factor"
JAR="$JAR_A"
code=$(req POST /api/account/two-factor/disable '{"password":"pas-le-bon"}')
[ "$code" = "400" ] || fail "deactivation without the right password: expected 400, got $code"
pass "deactivation refused without the password → 400"

code=$(req POST /api/account/two-factor/disable "{\"password\":\"$NEW_PASSWORD\"}")
[ "$code" = "200" ] || fail "deactivation → HTTP $code: $(cat "$BODY")"
enabled=$(psql_q "select two_factor_enabled from users where id = '$USER_ID';")
[ "$enabled" = "f" ] || fail "users.two_factor_enabled stays true after deactivation"
rows=$(psql_q "select count(*) from two_factors where user_id = '$USER_ID';")
[ "$rows" = "0" ] || fail "the two_factors row survives the deactivation"
pass "second factor removed, two_factors row deleted"

JAR_G="$WORK/g.jar"
JAR="$JAR_G"; code=$(signin "$TEST_EMAIL" "$NEW_PASSWORD")
[ "$code" = "200" ] || fail "sign-in → HTTP $code"
jq -e '.twoFactorRedirect // false | not' "$BODY" >/dev/null \
  || fail "the second factor is still asked for after deactivation"
[ "$(session_email)" = "$TEST_EMAIL" ] || fail "no session after the plain sign-in"
pass "sign-in plain again: password alone, session set"

# ─── 11. Cleanup ──────────────────────────────────────────────────────────────
step "11. Cleanup"
JAR="$ADMIN_JAR"
code=$(req DELETE "/api/admin/users/$USER_ID")
[ "$code" = "200" ] || fail "deleting the test user → HTTP $code: $(cat "$BODY")"
left=$(psql_q "select count(*) from users where email = '$TEST_EMAIL';")
[ "$left" = "0" ] || fail "the test user is still in the database"
pass "test user deleted"

step "12. The administrator stays usable"
JAR="$WORK/admin-check.jar"
code=$(signin "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
[ "$code" = "200" ] || fail "the administrator can no longer sign in (HTTP $code)"
jq -e '.twoFactorRedirect // false | not' "$BODY" >/dev/null \
  || fail "a second factor was armed on the administrator"
assert_admin
pass "$ADMIN_EMAIL still signs in with their password, without a second factor"

printf '\n\033[32m✓ Account security verified.\033[0m\n'
printf '\033[2m  Screen: %s/account\033[0m\n\n' "$BASE_URL"
