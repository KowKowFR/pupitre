#!/usr/bin/env bash
#
# Single sign-on (OpenID Connect), end to end against a real Keycloak.
#
#   1. "Test" says whether the provider answers, and what is wrong otherwise
#   2. A sign-in creates the account with its groups' role
#   3. Creation disabled: an unknown identity is refused, and says so
#   4. A local account is only linked if the provider declares the e-mail verified
#   5. The provider is authoritative: a group changed on its side changes the role
#   6. The client secret never comes out
#
# Prerequisite: the test Keycloak, and the panel reaching it at the same address
# as this script:
#   docker compose --profile test up -d keycloak
#
# What the script touches, and gives back: the settings' "single sign-on"
# section (put back as it found it), the `@keycloak.test` accounts (deleted),
# Alice's groups in the test realm.
#
# Usage:
#   ./scripts/verify-sso.sh
#   BASE_URL=http://localhost:3200 ./scripts/verify-sso.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8180}"
ISSUER="$KEYCLOAK_URL/realms/pupitre"
# The test realm's client secret (`scripts/test-keycloak/`): throwaway.
CLIENT_SECRET="secret-de-test-du-client-pupitre"

WORK="$(mktemp -d)"
ADMIN_JAR="$WORK/admin.jar"
BODY="$WORK/body.json"

command -v jq >/dev/null || { echo "jq is required"; exit 1; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }

req() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -b "$ADMIN_JAR" -c "$ADMIN_JAR")
  [ -n "$data" ] && args+=(-d "$data")
  curl "${args[@]}"
}

role_of() {
  psql_q "select coalesce(string_agg(r.key, ','), '') from users u join user_roles ur on ur.user_id = u.id
          join roles r on r.id = ur.role_id where u.email = '$1';"
}

# A sign-in through the provider, like a browser: the panel gives Keycloak's
# address, we fill the form there, Keycloak sends back to the panel. Writes the
# final destination into $LANDED and the session into $1.jar.
sso_login() {
  local user="$1" password="$2" jar="$WORK/$1.jar" kjar="$WORK/$1.kc.jar"
  rm -f "$jar" "$kjar"
  local url page action back
  # `/sign-in/*` is limited to three requests per ten seconds and per address:
  # chained sign-ins wait their turn, as someone would.
  for _ in 1 2 3 4 5 6 7 8; do
    url=$(curl -s -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" \
          -X POST "$BASE_URL/api/auth/sign-in/social" \
          -d '{"provider":"oidc","callbackURL":"/","errorCallbackURL":"/login"}' | jq -r '.url // empty')
    [ -n "$url" ] && break
    sleep 4
  done
  [ -n "$url" ] || fail "the panel offers no departure to the provider"
  page=$(curl -s -c "$kjar" -b "$kjar" "$url")
  action=$(printf '%s' "$page" | grep -o 'action="[^"]*"' | head -1 | sed 's/action="//; s/"$//; s/&amp;/\&/g')
  [ -n "$action" ] || fail "Keycloak's sign-in form not found"
  back=$(curl -s -o /dev/null -w '%{redirect_url}' -c "$kjar" -b "$kjar" -X POST "$action" \
         --data-urlencode "username=$user" --data-urlencode "password=$password")
  case "$back" in "$BASE_URL"/*) ;; *) fail "Keycloak did not send back to the panel: ${back:-?}" ;; esac
  LANDED=$(curl -s -o /dev/null -w '%{redirect_url}' -c "$jar" -b "$jar" "$back")
}

session_email() {
  curl -s -b "$WORK/$1.jar" "$BASE_URL/api/auth/get-session" | jq -r '.user.email // empty'
}

kc_token() {
  curl -s -X POST "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=admin-cli -d username=admin -d password=admin | jq -r .access_token
}
kc() {
  local method="$1" path="$2"; shift 2
  curl -s -X "$method" -H "Authorization: Bearer $(kc_token)" -H 'content-type: application/json' \
    "$KEYCLOAK_URL/admin/realms/pupitre$path" "$@"
}
kc_user() { kc GET "/users?username=$1&exact=true" | jq -r '.[0].id'; }
kc_group() { kc GET "/groups?search=$1&exact=true" | jq -r --arg n "$1" '.[] | select(.name == $n) | .id'; }
kc_move() {
  local user; user=$(kc_user "$1")
  kc DELETE "/users/$user/groups/$(kc_group "$2")" -o /dev/null
  kc PUT "/users/$user/groups/$(kc_group "$3")" -o /dev/null
}

PREVIOUS_SSO=""
cleanup() {
  local code=$?
  kc_move alice pupitre-admins pupitre-ops >/dev/null 2>&1 || true
  psql_q "delete from users where email like '%@keycloak.test';" >/dev/null 2>&1 || true
  if [ -n "$PREVIOUS_SSO" ]; then
    req PATCH /api/settings "{\"sso\":$PREVIOUS_SSO,\"ssoClientSecret\":null}" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT

step "0. Prerequisites"
code=$(curl -s -o /dev/null -w '%{http_code}' "$ISSUER/.well-known/openid-configuration")
[ "$code" = "200" ] || fail "test Keycloak unreachable at $ISSUER — docker compose --profile test up -d keycloak"
pass "Keycloak answers at $ISSUER"
code=$(req POST /api/auth/sign-in/email "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
if [ "$code" != "200" ]; then
  code=$(req POST /api/auth/sign-up/email \
    "{\"name\":\"Admin de vérification\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
  [ "$code" = "200" ] || fail "could not sign in or create the administrator (HTTP $code)"
fi
pass "signed in as $ADMIN_EMAIL"
req GET /api/settings >/dev/null
if jq -e --arg i "$ISSUER" '.ssoClientSecretConfigured and .settings.sso.issuer != $i' "$BODY" >/dev/null; then
  fail "a real single sign-on is set up on this instance: this script would replace it"
fi
PREVIOUS_SSO=$(jq -c '.settings.sso' "$BODY")
psql_q "delete from users where email like '%@keycloak.test';" >/dev/null
# The log outlives the deleted accounts: we only read this pass.
START=$(psql_q "select now();")

step "1. \"Test\""
req POST /api/settings/sso/check "{\"issuer\":\"$ISSUER\"}" >/dev/null
jq -e --arg i "$ISSUER" '.ok and .issuer == $i' "$BODY" >/dev/null || fail "the right issuer is not recognized: $(cat "$BODY")"
pass "the right issuer answers"
req POST /api/settings/sso/check "{\"issuer\":\"$KEYCLOAK_URL/realms/inexistant\"}" >/dev/null
jq -e '.ok == false and (.error | length > 0)' "$BODY" >/dev/null || fail "a non-existent realm passes: $(cat "$BODY")"
pass "a non-existent realm is refused: $(jq -r .error "$BODY")"

step "2. Configuration"
mapping='[{"group":"pupitre-admins","role":"admin"},{"group":"pupitre-ops","role":"operator"},{"group":"pupitre-lecture","role":"viewer"}]'
code=$(req PATCH /api/settings "{\"sso\":{\"roleMappings\":[{\"group\":\"x\",\"role\":\"role-inexistant\"}]}}")
[ "$code" = "422" ] || fail "a non-existent role is accepted (HTTP $code)"
pass "a non-existent role is refused → 422"
code=$(req PATCH /api/settings "{\"sso\":{\"enabled\":true,\"label\":\"Keycloak\",\"issuer\":\"$ISSUER\",\"clientId\":\"pupitre\",\"autoCreate\":true,\"linkByEmail\":true,\"groupsClaim\":\"groups\",\"roleMappings\":$mapping,\"defaultRole\":\"no-access\",\"syncRoles\":true},\"ssoClientSecret\":\"$CLIENT_SECRET\"}")
[ "$code" = "200" ] || fail "configuration refused (HTTP $code): $(cat "$BODY")"
jq -e '.ssoStatus.active and .ssoClientSecretConfigured' "$BODY" >/dev/null || fail "single sign-on not active: $(jq -c .ssoStatus "$BODY")"
pass "single sign-on active, return to $(jq -r .ssoStatus.callbackUrl "$BODY")"
grep -qF "$CLIENT_SECRET" "$BODY" && fail "the client secret comes out of the API"
req GET /api/settings >/dev/null
grep -qF "$CLIENT_SECRET" "$BODY" && fail "the client secret comes out of the settings read"
[ "$(psql_q "select count(*) from app_settings where sso_client_secret_encrypted like '%$CLIENT_SECRET%';")" = "0" ] \
  || fail "the secret is in clear in the database"
pass "the secret never comes out, and it is encrypted in the database"
curl -s "$BASE_URL/login" | grep -qE 'Se connecter avec Keycloak|Sign in with Keycloak' || fail "the button is not on the sign-in screen"
pass "the sign-in screen offers \"Sign in with Keycloak\""

step "3. A sign-in creates the account, with its groups' role"
sso_login alice Alice-Keycloak-2026
[ "$LANDED" = "$BASE_URL/" ] || fail "unexpected return: $LANDED"
[ "$(session_email alice)" = "alice@keycloak.test" ] || fail "no session for Alice"
[ "$(role_of alice@keycloak.test)" = "operator" ] || fail "Alice has the role \"$(role_of alice@keycloak.test)\""
pass "Alice (pupitre-ops) comes in, Operator right away"
[ "$(psql_q "select count(*) from audit_logs where action = 'user.role.changed' and after->>'email' = 'alice@keycloak.test' and created_at > '$START';")" = "0" ] \
  || fail "the creation went through a role change"
psql_q "select after->>'origin' from audit_logs where action = 'user.created' and after->>'email' = 'alice@keycloak.test' and created_at > '$START';" | grep -q '^sso$' \
  || fail "the creation does not say it comes from single sign-on"
psql_q "select after->>'groups' from audit_logs where action = 'auth.sso.login.succeeded' and after->>'email' = 'alice@keycloak.test' and created_at > '$START';" | grep -q 'pupitre-ops' \
  || fail "the sign-in is not in the log with its groups"
pass "the log says where the account comes from, and with which groups it came in"

step "4. Creation disabled"
req PATCH /api/settings '{"sso":{"autoCreate":false}}' >/dev/null
sso_login chloe Chloe-Keycloak-2026
case "$LANDED" in *error=signup_disabled*) ;; *) fail "Chloé is not refused: $LANDED" ;; esac
[ "$(psql_q "select count(*) from users where email = 'chloe@keycloak.test';")" = "0" ] || fail "an account was created"
pass "an unknown identity is refused (signup_disabled), with no account created"
req PATCH /api/settings '{"sso":{"autoCreate":true}}' >/dev/null
sso_login chloe Chloe-Keycloak-2026
[ "$(role_of chloe@keycloak.test)" = "no-access" ] || fail "Chloé (without a group) has \"$(role_of chloe@keycloak.test)\""
pass "re-enabled: Chloé, without a group, comes in \"No access\""

step "5. Linking a local account"
code=$(req POST /api/admin/users '{"name":"Damien local","email":"damien@keycloak.test","password":"motdepasse-tres-long","role":"viewer"}')
[ "$code" = "201" ] || fail "Damien's local account → HTTP $code"
sso_login damien Damien-Keycloak-2026
case "$LANDED" in *error=account_not_linked*) ;; *) fail "Damien (unverified e-mail) is linked: $LANDED" ;; esac
[ "$(psql_q "select count(*) from accounts a join users u on u.id = a.user_id where u.email = 'damien@keycloak.test' and a.provider_id = 'oidc';")" = "0" ] \
  || fail "an OIDC account was linked to Damien"
[ "$(role_of damien@keycloak.test)" = "viewer" ] || fail "Damien's local account changed"
pass "e-mail not verified at the provider: no linking, the local account is intact"

step "6. The provider is authoritative"
kc_move alice pupitre-ops pupitre-admins
sso_login alice Alice-Keycloak-2026
[ "$(role_of alice@keycloak.test)" = "admin" ] || fail "Alice in pupitre-admins has \"$(role_of alice@keycloak.test)\""
pass "Alice moves to pupitre-admins at Keycloak → Administrator at the next sign-in"
kc_move alice pupitre-admins pupitre-ops
sso_login alice Alice-Keycloak-2026
[ "$(role_of alice@keycloak.test)" = "operator" ] || fail "Alice back in pupitre-ops has \"$(role_of alice@keycloak.test)\""
pass "back in pupitre-ops → Operator"
psql_q "select after->>'source' from audit_logs where action = 'user.role.changed' and after->>'email' = 'alice@keycloak.test' and created_at > '$START' order by created_at desc limit 1;" | grep -q '^sso$' \
  || fail "the role change does not say it comes from the provider"
pass "each change is in the log, attributed to the provider"

printf '\n\033[32m✓ Single sign-on verified.\033[0m\n\n'
