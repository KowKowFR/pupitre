#!/usr/bin/env bash
#
# Vérifie la gestion des rôles :
#
#   1. créer un rôle
#   2. modifier ses permissions
#   3. le rôle « admin » est verrouillé — ni modification, ni suppression
#   4. un rôle porté par un utilisateur ne peut pas être supprimé
#   5. un rôle libre se supprime
#   6. le seed ne réécrit PAS une personnalisation au redémarrage
#
# Usage :
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

step "2. Les rôles viennent de la base, pas du code"
code=$(req GET /api/admin/roles)
[ "$code" = "200" ] || fail "GET /api/admin/roles → HTTP $code"
cp "$BODY" "$WORK/roles.json"
jq -e '.items | length >= 3' "$BODY" >/dev/null || fail "moins de trois rôles"
# Le nombre de permissions bouge à chaque fonctionnalité : on le lit plutôt que
# de le figer.
PERM_TOTAL=$(jq -r '.vocabulary.permissions | length' "$BODY")
[ "$PERM_TOTAL" -ge 20 ] || fail "vocabulaire suspect : $PERM_TOTAL permission(s)"
jq -e '[.items[] | select(.key == "admin")] | .[0].locked == true' "$BODY" >/dev/null \
  || fail "le rôle admin n'est pas marqué verrouillé"
pass "$(jq -r '[.items[].key] | join(", ")' "$BODY") — vocabulaire de $PERM_TOTAL permissions"

step "3. Créer un rôle"
code=$(req POST /api/admin/roles \
  "{\"key\":\"$ROLE_KEY\",\"label\":\"Support de vérification\",\"description\":\"Rôle jetable\",\"permissions\":[]}")
[ "$code" = "201" ] || fail "POST /api/admin/roles → HTTP $code : $(cat "$BODY")"
jq -e '.permissions | length == 0' "$BODY" >/dev/null \
  || fail "un rôle neuf ne doit porter aucune permission"
pass "« $ROLE_KEY » créé, sans aucune permission"

code=$(req POST /api/admin/roles \
  "{\"key\":\"$ROLE_KEY\",\"label\":\"Doublon\",\"permissions\":[]}")
[ "$code" = "409" ] || fail "clé dupliquée : attendu 409, reçu $code"
pass "clé déjà prise → 409"

step "4. Modifier ses permissions"
code=$(req PATCH "/api/admin/roles/$ROLE_KEY" \
  '{"permissions":["deployment:read","scan:read","target:read"]}')
[ "$code" = "200" ] || fail "PATCH → HTTP $code : $(cat "$BODY")"
jq -e '.permissions | length == 3' "$BODY" >/dev/null \
  || fail "3 permissions attendues, $(jq -c .permissions "$BODY")"
pass "3 permissions accordées : $(jq -r '.permissions | join(", ")' "$BODY")"

# Une permission inventée ne doit pas passer.
code=$(req PATCH "/api/admin/roles/$ROLE_KEY" \
  '{"permissions":["deployment:read","monde:dominer"]}')
[ "$code" = "200" ] || fail "PATCH → HTTP $code"
jq -e '.permissions == ["deployment:read"]' "$BODY" >/dev/null \
  || fail "une permission hors vocabulaire a été retenue : $(jq -c .permissions "$BODY")"
pass "permission hors vocabulaire ignorée, pas accordée"

step "5. Le rôle admin est verrouillé"
code=$(req PATCH /api/admin/roles/admin '{"permissions":["deployment:read"]}')
[ "$code" = "409" ] || fail "modification d'admin : attendu 409, reçu $code"
jq -e '.error.code == "role_locked"' "$BODY" >/dev/null || fail "code d'erreur inattendu"
pass "modification refusée → 409 role_locked"

code=$(req DELETE /api/admin/roles/admin)
[ "$code" = "409" ] || fail "suppression d'admin : attendu 409, reçu $code"
pass "suppression refusée → 409"

admin_perms=$(psql_q "select count(*) from role_permissions rp
  join roles r on r.id = rp.role_id where r.key = 'admin';")
[ "$admin_perms" = "$PERM_TOTAL" ] \
  || fail "admin porte $admin_perms permissions au lieu de $PERM_TOTAL"
pass "admin détient toujours les $PERM_TOTAL permissions"

step "6. Un rôle porté par un utilisateur ne se supprime pas"
code=$(req POST /api/admin/users \
  "{\"name\":\"Testeur rôle\",\"email\":\"role-test@example.test\",\"password\":\"motdepasse-tres-long\",\"role\":\"$ROLE_KEY\"}")
case "$code" in
  201) pass "utilisateur créé avec le rôle personnalisé" ;;
  409) pass "utilisateur déjà présent" ;;
  *)   fail "POST /api/admin/users → HTTP $code : $(cat "$BODY")" ;;
esac

holder=$(psql_q "select r.key from users u
  join user_roles ur on ur.user_id = u.id
  join roles r on r.id = ur.role_id
  where u.email = 'role-test@example.test';")
[ "$holder" = "$ROLE_KEY" ] || fail "l'utilisateur porte « $holder », pas « $ROLE_KEY »"
pass "le rôle personnalisé est bien attribué en base"

code=$(req DELETE "/api/admin/roles/$ROLE_KEY")
[ "$code" = "409" ] || fail "rôle porté : attendu 409, reçu $code"
jq -e '.error.code == "role_in_use"' "$BODY" >/dev/null || fail "code d'erreur inattendu"
pass "suppression refusée → $(jq -r '.error.message' "$BODY")"

step "7. Libérer le rôle, puis le supprimer"
user_id=$(psql_q "select id from users where email = 'role-test@example.test';")
code=$(req PATCH "/api/admin/users/$user_id/role" '{"role":"viewer"}')
[ "$code" = "200" ] || fail "réattribution → HTTP $code : $(cat "$BODY")"
pass "utilisateur réattribué à viewer"

code=$(req DELETE "/api/admin/roles/$ROLE_KEY")
[ "$code" = "200" ] || fail "suppression → HTTP $code : $(cat "$BODY")"
pass "rôle supprimé"

req GET /api/admin/roles >/dev/null
jq -e --arg k "$ROLE_KEY" '[.items[] | select(.key == $k)] | length == 0' "$BODY" >/dev/null \
  || fail "le rôle apparaît encore dans la liste"
pass "il a disparu de la liste"

step "8. Le seed ne réécrit pas une personnalisation"
# Ses permissions d'avant, pour les lui rendre telles quelles à la fin.
ORIGINAL=$(psql_q "select coalesce(json_agg(p.key order by p.key), '[]') from role_permissions rp
  join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
  where r.key = 'viewer';")
info "viewer porte $(jq -r 'length' <<< "$ORIGINAL") permission(s) avant modification"

code=$(req PATCH /api/admin/roles/viewer '{"permissions":["deployment:read"]}')
[ "$code" = "200" ] || fail "PATCH viewer → HTTP $code : $(cat "$BODY")"
pass "viewer réduit à 1 permission"

pnpm db:seed >/dev/null 2>&1 || fail "le seed a échoué"
after=$(psql_q "select count(*) from role_permissions rp
  join roles r on r.id = rp.role_id where r.key = 'viewer';")

[ "$after" = "1" ] || fail "le seed a réécrit viewer : $after permission(s) au lieu de 1"
pass "après un seed, viewer porte toujours 1 permission — la personnalisation survit"

code=$(req PATCH /api/admin/roles/viewer "{\"permissions\":$ORIGINAL}")
[ "$code" = "200" ] || fail "restauration de viewer → HTTP $code"
pass "viewer restauré à ses $(jq -r 'length' <<< "$ORIGINAL") permission(s) d'avant"

step "9. Traceability"
code=$(req GET "/api/audit-logs?resourceType=role&pageSize=20")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
for action in role.created role.updated role.deleted; do
  jq -e --arg a "$action" '[.items[] | select(.action == $a)] | length > 0' "$BODY" >/dev/null \
    || fail "action \"$action\" missing from the audit log"
  pass "audit : $action"
done

step "10. Cleanup"
req DELETE "/api/admin/users/$user_id" >/dev/null
pass "test user deleted"

printf '\n\033[32m✓ Gestion des rôles vérifiée.\033[0m\n'
printf '\033[2m  Écran : %s/admin/roles\033[0m\n\n' "$BASE_URL"
