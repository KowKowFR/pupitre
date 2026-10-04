#!/usr/bin/env bash
#
# Checks role management:
#
#   1. creating a role
#   2. changing its permissions
#   3. the "admin" role is locked — neither changes nor deletion
#   4. a role held by a user cannot be deleted
#   5. a free role is deleted
#   6. the seed does NOT rewrite a customization at restart
#
# Usage:
#   ./scripts/verify-roles.sh
#   BASE_URL=http://localhost:3200 ./scripts/verify-roles.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
ROLE_KEY="${ROLE_KEY:-support-verification}"
CLIENT_IP="${CLIENT_IP:-198.51.100.42}"

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
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -H "x-forwarded-for: $CLIENT_IP" -b "$JAR" -c "$JAR")
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}

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

# Cleanup from a previous run.
req DELETE "/api/admin/roles/$ROLE_KEY" >/dev/null 2>&1 || true

step "2. The roles come from the database, not from the code"
code=$(req GET /api/admin/roles)
[ "$code" = "200" ] || fail "GET /api/admin/roles → HTTP $code"
cp "$BODY" "$WORK/roles.json"
jq -e '.items | length >= 3' "$BODY" >/dev/null || fail "fewer than three roles"
# The number of permissions moves with each feature: it is read rather than
# frozen.
PERM_TOTAL=$(jq -r '.vocabulary.permissions | length' "$BODY")
[ "$PERM_TOTAL" -ge 20 ] || fail "vocabulaire suspect: $PERM_TOTAL permission(s)"
jq -e '[.items[] | select(.key == "admin")] | .[0].locked == true' "$BODY" >/dev/null \
  || fail "the admin role is not marked locked"
pass "$(jq -r '[.items[].key] | join(", ")' "$BODY") — vocabulary of $PERM_TOTAL permissions"

step "3. Creating a role"
code=$(req POST /api/admin/roles \
  "{\"key\":\"$ROLE_KEY\",\"label\":\"Support de vérification\",\"description\":\"Rôle jetable\",\"permissions\":[]}")
[ "$code" = "201" ] || fail "POST /api/admin/roles → HTTP $code: $(cat "$BODY")"
jq -e '.permissions | length == 0' "$BODY" >/dev/null \
  || fail "a new role must carry no permission"
pass "\"$ROLE_KEY\" created, without any permission"

code=$(req POST /api/admin/roles \
  "{\"key\":\"$ROLE_KEY\",\"label\":\"Doublon\",\"permissions\":[]}")
[ "$code" = "409" ] || fail "duplicate key: expected 409, got $code"
pass "key already taken → 409"

step "4. Changing its permissions"
code=$(req PATCH "/api/admin/roles/$ROLE_KEY" \
  '{"permissions":["deployment:read","scan:read","target:read"]}')
[ "$code" = "200" ] || fail "PATCH → HTTP $code: $(cat "$BODY")"
jq -e '.permissions | length == 3' "$BODY" >/dev/null \
  || fail "3 permissions expected, $(jq -c .permissions "$BODY")"
pass "3 permissions granted: $(jq -r '.permissions | join(", ")' "$BODY")"

# A made-up permission must not get through.
code=$(req PATCH "/api/admin/roles/$ROLE_KEY" \
  '{"permissions":["deployment:read","monde:dominer"]}')
[ "$code" = "200" ] || fail "PATCH → HTTP $code"
jq -e '.permissions == ["deployment:read"]' "$BODY" >/dev/null \
  || fail "a permission outside the vocabulary was kept: $(jq -c .permissions "$BODY")"
pass "permission outside the vocabulary ignored, not granted"

step "5. The admin role is locked"
code=$(req PATCH /api/admin/roles/admin '{"permissions":["deployment:read"]}')
[ "$code" = "409" ] || fail "changing admin: expected 409, got $code"
jq -e '.error.code == "role_locked"' "$BODY" >/dev/null || fail "unexpected error code"
pass "change refused → 409 role_locked"

code=$(req DELETE /api/admin/roles/admin)
[ "$code" = "409" ] || fail "deleting admin: expected 409, got $code"
pass "deletion refused → 409"

admin_perms=$(psql_q "select count(*) from role_permissions rp
  join roles r on r.id = rp.role_id where r.key = 'admin';")
[ "$admin_perms" = "$PERM_TOTAL" ] \
  || fail "admin carries $admin_perms permissions instead of $PERM_TOTAL"
pass "admin still holds the $PERM_TOTAL permissions"

step "6. A role held by a user is not deleted"
code=$(req POST /api/admin/users \
  "{\"name\":\"Testeur rôle\",\"email\":\"role-test@example.test\",\"password\":\"motdepasse-tres-long\",\"role\":\"$ROLE_KEY\"}")
case "$code" in
  201) pass "user created with the custom role" ;;
  409) pass "user already present" ;;
  *)   fail "POST /api/admin/users → HTTP $code: $(cat "$BODY")" ;;
esac

holder=$(psql_q "select r.key from users u
  join user_roles ur on ur.user_id = u.id
  join roles r on r.id = ur.role_id
  where u.email = 'role-test@example.test';")
[ "$holder" = "$ROLE_KEY" ] || fail "the user carries \"$holder\", not \"$ROLE_KEY\""
pass "the custom role is indeed assigned in the database"

code=$(req DELETE "/api/admin/roles/$ROLE_KEY")
[ "$code" = "409" ] || fail "held role: expected 409, got $code"
jq -e '.error.code == "role_in_use"' "$BODY" >/dev/null || fail "unexpected error code"
pass "deletion refused → $(jq -r '.error.message' "$BODY")"

step "7. Freeing the role, then deleting it"
user_id=$(psql_q "select id from users where email = 'role-test@example.test';")
code=$(req PATCH "/api/admin/users/$user_id/role" '{"role":"viewer"}')
[ "$code" = "200" ] || fail "reassignment → HTTP $code: $(cat "$BODY")"
pass "user reassigned to viewer"

code=$(req DELETE "/api/admin/roles/$ROLE_KEY")
[ "$code" = "200" ] || fail "suppression → HTTP $code: $(cat "$BODY")"
pass "role deleted"

req GET /api/admin/roles >/dev/null
jq -e --arg k "$ROLE_KEY" '[.items[] | select(.key == $k)] | length == 0' "$BODY" >/dev/null \
  || fail "the role still appears in the list"
pass "it disappeared from the list"

step "8. The seed does not rewrite a customization"
# Its permissions from before, to give them back as they were at the end.
ORIGINAL=$(psql_q "select coalesce(json_agg(p.key order by p.key), '[]') from role_permissions rp
  join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
  where r.key = 'viewer';")
info "viewer carries $(jq -r 'length' <<< "$ORIGINAL") permission(s) before the change"

code=$(req PATCH /api/admin/roles/viewer '{"permissions":["deployment:read"]}')
[ "$code" = "200" ] || fail "PATCH viewer → HTTP $code: $(cat "$BODY")"
pass "viewer reduced to 1 permission"

pnpm db:seed >/dev/null 2>&1 || fail "the seed failed"
after=$(psql_q "select count(*) from role_permissions rp
  join roles r on r.id = rp.role_id where r.key = 'viewer';")

[ "$after" = "1" ] || fail "the seed rewrote viewer: $after permission(s) instead of 1"
pass "after a seed, viewer still carries 1 permission — the customization survives"

code=$(req PATCH /api/admin/roles/viewer "{\"permissions\":$ORIGINAL}")
[ "$code" = "200" ] || fail "restoring viewer → HTTP $code"
pass "viewer restored to its $(jq -r 'length' <<< "$ORIGINAL") permission(s) from before"

step "9. Traceability"
code=$(req GET "/api/audit-logs?resourceType=role&pageSize=20")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
for action in role.created role.updated role.deleted; do
  jq -e --arg a "$action" '[.items[] | select(.action == $a)] | length > 0' "$BODY" >/dev/null \
    || fail "action \"$action\" missing from the audit log"
  pass "audit: $action"
done

step "10. Cleanup"
req DELETE "/api/admin/users/$user_id" >/dev/null
pass "test user deleted"

printf '\n\033[32m✓ Role management verified.\033[0m\n'
printf '\033[2m  Screen: %s/admin/roles\033[0m\n\n' "$BASE_URL"
