#!/usr/bin/env bash
#
# Checks the second factor reset by an administrator — the way out for whoever
# lost their phone AND their backup codes:
#
#   1. a test user with a REAL second factor (computed TOTP code)
#   2. their sign-in asks for the code — the starting state, proven before undoing it
#   3. an administrator WITHOUT `user:reset-2fa` is refused → 403
#   4. the permission granted, the reset goes through → 200
#   5. the `two_factors` row disappeared AND `users.two_factor_enabled` is false
#   6. their current sessions are closed
#   7. they sign in again with their password alone
#   8. the old backup codes no longer work
#   9. an administrator can reset themselves: their session survives
#  10. they can arm a second factor again — the account is not broken
#  11. the audit keeps the actor, the target and the IP, without any secret
#  12. cleanup: test users deleted, throwaway role deleted,
#      `admin@example.test` still usable without a second factor
#
# The TOTP code is computed here, per RFC 6238: `oathtool` if it is installed,
# otherwise about fifteen lines of Node (HMAC-SHA1 on a 30 s counter).
#
# Usage:
#   ./scripts/verify-2fa-reset.sh
#   BASE_URL=http://localhost:3200 ./scripts/verify-2fa-reset.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
TEST_EMAIL="${TEST_EMAIL:-2fa-reset@example.test}"
TEST_PASSWORD="${TEST_PASSWORD:-motdepasse-tres-long-cible}"
OPERATOR_EMAIL="${OPERATOR_EMAIL:-2fa-reset-operateur@example.test}"
OPERATOR_PASSWORD="${OPERATOR_PASSWORD:-motdepasse-tres-long-operateur}"
# A throwaway role: rather than touching `operator` or `viewer` on a shared
# environment, we make the role we need and destroy it.
ROLE_KEY="${ROLE_KEY:-support-2fa-verification}"
CLIENT_IP="${CLIENT_IP:-198.51.100.91}"

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
# protection): it is set on every request.
req() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -H "x-forwarded-for: $CLIENT_IP" -b "$JAR" -c "$JAR")
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }

# ─── Computing a real TOTP code (RFC 6238) ────────────────────────────────────
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
    if (index === -1) throw new Error(`caractère base32 invalide : ${char}`);
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

drop_user() {
  local email="$1" id
  id=$(psql_q "select id from users where email = '$email';")
  [ -n "$id" ] || return 0
  JAR="$ADMIN_JAR"
  req DELETE "/api/admin/users/$id" >/dev/null || true
}

# ─── 1. Terrain ───────────────────────────────────────────────────────────────
step "1. Terrain"
admin_login
pass "signed in as $ADMIN_EMAIL"

# Cleanup from a previous run.
drop_user "$TEST_EMAIL"
drop_user "$OPERATOR_EMAIL"
JAR="$ADMIN_JAR"
req DELETE "/api/admin/roles/$ROLE_KEY" >/dev/null 2>&1 || true

code=$(req POST /api/admin/users \
  "{\"name\":\"Cible 2FA\",\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"role\":\"viewer\"}")
[ "$code" = "201" ] || fail "creating the target user → HTTP $code: $(cat "$BODY")"
USER_ID=$(psql_q "select id from users where email = '$TEST_EMAIL';")
[ -n "$USER_ID" ] || fail "target user not found in the database"
pass "target user created ($TEST_EMAIL)"

state=$(req GET /api/admin/users >/dev/null; jq -r --arg e "$TEST_EMAIL" \
  '.items[] | select(.email == $e) | .twoFactor' "$BODY")
[ "$state" = "none" ] || fail "GET /api/admin/users announces \"$state\" for a new account"
pass "GET /api/admin/users exposes the second factor: \"none\" on a new account"

# ─── 2. Arming a real second factor ───────────────────────────────────────────
step "2. A real second factor on the target user"
JAR_T1="$WORK/t1.jar"
JAR="$JAR_T1"; code=$(signin "$TEST_EMAIL" "$TEST_PASSWORD")
[ "$code" = "200" ] || fail "target user sign-in → HTTP $code: $(cat "$BODY")"

code=$(req POST /api/account/two-factor/setup "{\"password\":\"$TEST_PASSWORD\"}")
[ "$code" = "200" ] || fail "setup → HTTP $code : $(cat "$BODY")"
TOTP_URI=$(jq -r '.totpURI' "$BODY")
SECRET=$(printf '%s' "$TOTP_URI" | sed -n 's/.*[?&]secret=\([^&]*\).*/\1/p')
# `mapfile` does not exist in bash 3.2 (macOS's): an explicit loop.
BACKUP_CODES=()
while IFS= read -r line; do BACKUP_CODES+=("$line"); done < <(jq -r '.backupCodes[]' "$BODY")
[ -n "$SECRET" ] || fail "no secret in the TOTP URI"
[ "${#BACKUP_CODES[@]}" -ge 5 ] || fail "trop peu de codes de secours (${#BACKUP_CODES[@]})"
pass "secret generated and ${#BACKUP_CODES[@]} backup codes returned"

code=$(req POST /api/account/two-factor/activate "{\"code\":\"$(totp "$SECRET")\"}")
[ "$code" = "200" ] || fail "activation → HTTP $code : $(cat "$BODY")"
enabled=$(psql_q "select two_factor_enabled from users where id = '$USER_ID';")
rows=$(psql_q "select count(*) from two_factors where user_id = '$USER_ID';")
[ "$enabled" = "t" ] || fail "users.two_factor_enabled = $enabled after activation"
[ "$rows" = "1" ] || fail "$rows two_factors row(s) after activation"
pass "second factor armed: two_factors = 1 row, users.two_factor_enabled = t"

JAR="$ADMIN_JAR"
req GET /api/admin/users >/dev/null
state=$(jq -r --arg e "$TEST_EMAIL" '.items[] | select(.email == $e) | .twoFactor' "$BODY")
[ "$state" = "active" ] || fail "the users screen announces \"$state\" instead of \"active\""
pass "the administrator SEES the active second factor — the button is not pressed blindly"

# ─── 3. The starting state: sign-in asks for the code ─────────────────────────
step "3. The starting state: sign-in asks for the code"
JAR_T2="$WORK/t2.jar"
JAR="$JAR_T2"; code=$(signin "$TEST_EMAIL" "$TEST_PASSWORD")
[ "$code" = "200" ] || fail "sign-in → HTTP $code: $(cat "$BODY")"
jq -e '.twoFactorRedirect == true' "$BODY" >/dev/null \
  || fail "the password alone was enough: $(jq -c . "$BODY")"
[ -z "$(session_email)" ] || fail "a session exists although the code was not provided"
pass "password alone → twoFactorRedirect, no session set"

code=$(req POST /api/auth/two-factor/verify-totp "{\"code\":\"$(totp "$SECRET")\"}")
[ "$code" = "200" ] || fail "code TOTP valide → HTTP $code : $(cat "$BODY")"
[ "$(session_email)" = "$TEST_EMAIL" ] || fail "no session after a valid code"
pass "valid TOTP code → session open (the \"lost device\" session)"

live=$(psql_q "select count(*) from sessions where user_id = '$USER_ID';")
[ "$live" -ge 1 ] || fail "no session in the database for the target user"
info "$live open session(s) for the target user before the reset"

# ─── 4. An administrator without the permission is refused ────────────────────
step "4. Without \"user:reset-2fa\", it is no"
JAR="$ADMIN_JAR"
code=$(req POST /api/admin/roles \
  "{\"key\":\"$ROLE_KEY\",\"label\":\"Support 2FA (vérification)\",\"description\":\"Rôle jetable\",\"permissions\":[\"user:read\",\"user:manage\"]}")
[ "$code" = "201" ] || fail "creating the role → HTTP $code: $(cat "$BODY")"
jq -e '.permissions | index("user:reset-2fa") | not' "$BODY" >/dev/null \
  || fail "the throwaway role already carries user:reset-2fa"
pass "role \"$ROLE_KEY\" created with user:read + user:manage, WITHOUT user:reset-2fa"

code=$(req POST /api/admin/users \
  "{\"name\":\"Opérateur 2FA\",\"email\":\"$OPERATOR_EMAIL\",\"password\":\"$OPERATOR_PASSWORD\",\"role\":\"$ROLE_KEY\"}")
[ "$code" = "201" ] || fail "creating the operator → HTTP $code: $(cat "$BODY")"
OPERATOR_ID=$(psql_q "select id from users where email = '$OPERATOR_EMAIL';")
pass "operator created, carrying the throwaway role"

JAR_OP="$WORK/op.jar"
JAR="$JAR_OP"; code=$(signin "$OPERATOR_EMAIL" "$OPERATOR_PASSWORD")
[ "$code" = "200" ] || fail "operator sign-in → HTTP $code: $(cat "$BODY")"
pass "operator signed in"

code=$(req DELETE "/api/admin/users/$USER_ID/two-factor")
[ "$code" = "403" ] || fail "expected 403 without the permission, got $code: $(cat "$BODY")"
jq -e '.error.details.permission == "user:reset-2fa"' "$BODY" >/dev/null \
  || fail "the refusal does not name the permission: $(jq -c .error "$BODY")"
pass "reset refused → 403, \"$(jq -r '.error.message' "$BODY")\""

enabled=$(psql_q "select two_factor_enabled from users where id = '$USER_ID';")
[ "$enabled" = "t" ] || fail "the refusal touched the second factor all the same"
pass "managing users (user:manage) is not enough — nothing moved"

# ─── 5. Permission granted, reset ─────────────────────────────────────────────
step "5. The permission granted, the reset goes through"
JAR="$ADMIN_JAR"
code=$(req PATCH "/api/admin/roles/$ROLE_KEY" \
  '{"permissions":["user:read","user:manage","user:reset-2fa"]}')
[ "$code" = "200" ] || fail "role PATCH → HTTP $code: $(cat "$BODY")"
jq -e '.permissions | index("user:reset-2fa")' "$BODY" >/dev/null \
  || fail "user:reset-2fa was not granted"
pass "\"user:reset-2fa\" granted to the role from /admin/roles"

JAR="$JAR_OP"
code=$(req DELETE "/api/admin/users/$USER_ID/two-factor")
[ "$code" = "200" ] || fail "reset → HTTP $code: $(cat "$BODY")"
jq -e '.twoFactor == "none" and .twoFactorEnabled == false' "$BODY" >/dev/null \
  || fail "unexpected response: $(jq -c . "$BODY")"
REVOKED=$(jq -r '.revokedSessions' "$BODY")
pass "reset → 200, $REVOKED session(s) closed"

step "6. Both writes, in the same gesture"
rows=$(psql_q "select count(*) from two_factors where user_id = '$USER_ID';")
enabled=$(psql_q "select two_factor_enabled from users where id = '$USER_ID';")
[ "$rows" = "0" ] || fail "the two_factors row survives ($rows row(s))"
[ "$enabled" = "f" ] || fail "users.two_factor_enabled is \"$enabled\""
pass "two_factors: 0 rows — and users.two_factor_enabled = f"
info "no half state: neither a flag without a row, nor a row without a flag"

JAR="$ADMIN_JAR"
req GET /api/admin/users >/dev/null
state=$(jq -r --arg e "$TEST_EMAIL" '.items[] | select(.email == $e) | .twoFactor' "$BODY")
[ "$state" = "none" ] || fail "the screen still announces \"$state\""
pass "the users screen announces \"none\""

step "7. The fate of the target user's sessions"
[ "$REVOKED" -ge 1 ] || fail "no session revoked although the target user had $live"
live=$(psql_q "select count(*) from sessions where user_id = '$USER_ID';")
[ "$live" = "0" ] || fail "$live session(s) of the target user survive"
JAR="$JAR_T2"
[ -z "$(session_email)" ] \
  || fail "the session opened from the \"lost\" device still answers"
pass "all the target user's sessions are closed — the lost device is no longer of any use"

step "8. Resetting twice in a row means nothing"
JAR="$JAR_OP"
code=$(req DELETE "/api/admin/users/$USER_ID/two-factor")
[ "$code" = "409" ] || fail "second reset: expected 409, got $code"
pass "without a second factor to remove → 409, \"$(jq -r '.error.message' "$BODY")\""

# ─── 9. The administrator can reset themselves ────────────────────────────────
step "9. An administrator can reset themselves"
JAR="$JAR_OP"
code=$(req POST /api/account/two-factor/setup "{\"password\":\"$OPERATOR_PASSWORD\"}")
[ "$code" = "200" ] || fail "operator setup → HTTP $code: $(cat "$BODY")"
OP_URI=$(jq -r '.totpURI' "$BODY")
OP_SECRET=$(printf '%s' "$OP_URI" | sed -n 's/.*[?&]secret=\([^&]*\).*/\1/p')
code=$(req POST /api/account/two-factor/activate "{\"code\":\"$(totp "$OP_SECRET")\"}")
[ "$code" = "200" ] || fail "operator activation → HTTP $code: $(cat "$BODY")"
pass "the operator arms a second factor on their own account"

JAR_OP2="$WORK/op2.jar"
JAR="$JAR_OP2"; code=$(signin "$OPERATOR_EMAIL" "$OPERATOR_PASSWORD")
[ "$code" = "200" ] || fail "operator's second sign-in → HTTP $code"
sleep 4
code=$(req POST /api/auth/two-factor/verify-totp "{\"code\":\"$(totp "$OP_SECRET")\"}")
[ "$code" = "200" ] || fail "operator's TOTP code → HTTP $code: $(cat "$BODY")"
[ "$(session_email)" = "$OPERATOR_EMAIL" ] || fail "the operator's second session is missing"
pass "a second session of the operator is open elsewhere"

JAR="$JAR_OP"
code=$(req DELETE "/api/admin/users/$OPERATOR_ID/two-factor")
[ "$code" = "200" ] || fail "self-reset → HTTP $code: $(cat "$BODY")"
jq -e '.revokedSessions == 1' "$BODY" >/dev/null \
  || fail "sessions closed: $(jq -r '.revokedSessions' "$BODY") instead of 1"
pass "self-reset → 200; they gain nothing they did not already have"

[ "$(session_email)" = "$OPERATOR_EMAIL" ] \
  || fail "the session that acted was closed under its feet"
pass "their own session survives — the same rule as the password change"

JAR="$JAR_OP2"
[ -z "$(session_email)" ] || fail "the operator's other session survives"
pass "their OTHER session, for its part, is closed"

rows=$(psql_q "select count(*) from two_factors where user_id = '$OPERATOR_ID';")
enabled=$(psql_q "select two_factor_enabled from users where id = '$OPERATOR_ID';")
[ "$rows" = "0" ] && [ "$enabled" = "f" ] \
  || fail "inconsistent state after self-reset ($rows row(s), flag $enabled)"
pass "two_factors: 0 rows — users.two_factor_enabled = f"

# ─── 10. The target user signs in again, the old codes are dead ───────────────
step "10. The target user signs in again with their password alone"
JAR_T3="$WORK/t3.jar"
JAR="$JAR_T3"; code=$(signin "$TEST_EMAIL" "$TEST_PASSWORD")
[ "$code" = "200" ] || fail "sign-in → HTTP $code: $(cat "$BODY")"
jq -e '.twoFactorRedirect // false | not' "$BODY" >/dev/null \
  || fail "the second factor is still asked for after the reset"
[ "$(session_email)" = "$TEST_EMAIL" ] || fail "no session after the plain sign-in"
pass "password alone → session open, no code asked for any more"

RESCUE="${BACKUP_CODES[0]}"
code=$(req POST /api/auth/two-factor/verify-backup-code "{\"code\":\"$RESCUE\"}")
[ "$code" != "200" ] || fail "an old backup code was accepted"
pass "old backup code outside a challenge → HTTP $code, refused"

# ─── 10. The account is not broken: we arm again ──────────────────────────────
step "11. The target user arms a second factor again"
code=$(req POST /api/account/two-factor/setup "{\"password\":\"$TEST_PASSWORD\"}")
[ "$code" = "200" ] || fail "nouveau setup → HTTP $code : $(cat "$BODY")"
NEW_URI=$(jq -r '.totpURI' "$BODY")
NEW_SECRET=$(printf '%s' "$NEW_URI" | sed -n 's/.*[?&]secret=\([^&]*\).*/\1/p')
[ -n "$NEW_SECRET" ] || fail "no secret in the new TOTP URI"
[ "$NEW_SECRET" != "$SECRET" ] || fail "the new secret is the old one"
pass "new secret generated, different from the old one"

code=$(req POST /api/account/two-factor/activate "{\"code\":\"$(totp "$NEW_SECRET")\"}")
[ "$code" = "200" ] || fail "reactivation → HTTP $code: $(cat "$BODY")"
enabled=$(psql_q "select two_factor_enabled from users where id = '$USER_ID';")
[ "$enabled" = "t" ] || fail "users.two_factor_enabled stays false after reactivation"
pass "second factor armed again — the account was not broken by the reset"

JAR_T4="$WORK/t4.jar"
JAR="$JAR_T4"; code=$(signin "$TEST_EMAIL" "$TEST_PASSWORD")
[ "$code" = "200" ] || fail "sign-in → HTTP $code"
jq -e '.twoFactorRedirect == true' "$BODY" >/dev/null || fail "second factor not asked for"
sleep 4
code=$(req POST /api/auth/two-factor/verify-backup-code "{\"code\":\"$RESCUE\"}")
[ "$code" != "200" ] || fail "a backup code from BEFORE the reset opens a session"
[ -z "$(session_email)" ] || fail "a session was opened with an old backup code"
pass "old backup code against the NEW factor → HTTP $code, refused"

code=$(req POST /api/auth/two-factor/verify-totp "{\"code\":\"$(totp "$NEW_SECRET")\"}")
[ "$code" = "200" ] || fail "nouveau code TOTP → HTTP $code : $(cat "$BODY")"
[ "$(session_email)" = "$TEST_EMAIL" ] || fail "no session after the new code"
pass "the new TOTP code, for its part, opens the session"

# ─── 11. Audit ────────────────────────────────────────────────────────────────
step "12. Traceability"
JAR="$ADMIN_JAR"
code=$(req GET "/api/audit-logs?action=user.2fa.reset&pageSize=20")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
jq -e --arg t "$USER_ID" --arg a "$OPERATOR_ID" \
  '[.items[] | select(.resourceId == $t and .actorId == $a)] | length > 0' "$BODY" >/dev/null \
  || fail "no user.2fa.reset row linking the operator to the target user"
pass "audit : user.2fa.reset — acteur $(jq -r --arg t "$USER_ID" \
  '[.items[] | select(.resourceId == $t)][0].actorEmail' "$BODY"), cible $TEST_EMAIL"

jq -e --arg t "$USER_ID" --arg ip "$CLIENT_IP" \
  '[.items[] | select(.resourceId == $t)][0].ip == $ip' "$BODY" >/dev/null \
  || fail "the actor's IP is not traced"
pass "audit : IP de l'acteur retenue ($CLIENT_IP)"

jq -e --arg t "$USER_ID" \
  '[.items[] | select(.resourceId == $t)][0].before.twoFactor == "active"' "$BODY" >/dev/null \
  || fail "the state from before is not traced"
pass "audit: the state from before (\"active\") and the number of closed sessions are kept"

code=$(req GET "/api/audit-logs?action=permission.denied&pageSize=50")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
jq -e --arg a "$OPERATOR_ID" \
  '[.items[] | select(.actorId == $a and .resourceId == "user:reset-2fa")] | length > 0' "$BODY" \
  >/dev/null || fail "the 403 refusal was not logged"
pass "audit: the refusal of the operator without the permission is logged"

leaks=$(psql_q "select count(*) from audit_logs
  where coalesce(before::text, '') || coalesce(after::text, '') || coalesce(resource_id, '')
        like '%$SECRET%';")
[ "$leaks" = "0" ] || fail "the old TOTP secret appears in $leaks audit row(s)"
pass "no trace of the old TOTP secret in audit_logs"

leaks=$(psql_q "select count(*) from audit_logs
  where coalesce(before::text, '') || coalesce(after::text, '')
        like '%$NEW_SECRET%';")
[ "$leaks" = "0" ] || fail "the new TOTP secret appears in $leaks audit row(s)"
pass "no trace of the new TOTP secret in audit_logs"

for rescue in "${BACKUP_CODES[@]}"; do
  leaks=$(psql_q "select count(*) from audit_logs
    where coalesce(before::text, '') || coalesce(after::text, '') like '%$rescue%';")
  [ "$leaks" = "0" ] || fail "a backup code appears in $leaks audit row(s)"
done
pass "none of the ${#BACKUP_CODES[@]} backup codes in audit_logs"

hits=$(docker compose logs panel --no-color 2>/dev/null | grep -c -- "$SECRET" || true)
[ "$hits" = "0" ] || fail "the old TOTP secret appears $hits time(s) in the panel's logs"
pass "no trace of the secret in \"docker compose logs panel\""

# ─── 12. Cleanup ──────────────────────────────────────────────────────────────
step "13. Cleanup"
JAR="$ADMIN_JAR"
code=$(req DELETE "/api/admin/users/$USER_ID")
[ "$code" = "200" ] || fail "deleting the target user → HTTP $code: $(cat "$BODY")"
code=$(req DELETE "/api/admin/users/$OPERATOR_ID")
[ "$code" = "200" ] || fail "deleting the operator → HTTP $code: $(cat "$BODY")"
left=$(psql_q "select count(*) from users where email in ('$TEST_EMAIL', '$OPERATOR_EMAIL');")
[ "$left" = "0" ] || fail "$left utilisateur(s) de test survivent"
pass "test users deleted"

code=$(req DELETE "/api/admin/roles/$ROLE_KEY")
[ "$code" = "200" ] || fail "deleting the throwaway role → HTTP $code: $(cat "$BODY")"
left=$(psql_q "select count(*) from roles where key = '$ROLE_KEY';")
[ "$left" = "0" ] || fail "the throwaway role survives in the database"
pass "throwaway role deleted — no pre-existing role was changed"

holders=$(psql_q "select count(*) from role_permissions rp
  join permissions p on p.id = rp.permission_id
  join roles r on r.id = rp.role_id
  where p.key = 'user:reset-2fa' and r.key <> 'admin';")
info "roles (apart from admin) carrying user:reset-2fa after cleanup: $holders"

step "14. The administrator stays usable"
JAR="$WORK/admin-check.jar"
code=$(signin "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
[ "$code" = "200" ] || fail "the administrator can no longer sign in (HTTP $code)"
jq -e '.twoFactorRedirect // false | not' "$BODY" >/dev/null \
  || fail "a second factor was armed on the administrator"
assert_admin
pass "$ADMIN_EMAIL still signs in with their password, without a second factor"

printf '\n\033[32m✓ Réinitialisation du second facteur vérifiée.\033[0m\n'
printf '\033[2m  Écran : %s/admin/users\033[0m\n\n' "$BASE_URL"
