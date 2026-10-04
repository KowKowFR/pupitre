#!/usr/bin/env bash
#
# Connexion unique (OpenID Connect), de bout en bout contre un vrai Keycloak.
#
#   1. « Tester » dit si le fournisseur répond, et ce qui ne va pas sinon
#   2. Une connexion crée le compte avec le rôle de ses groupes
#   3. Création désactivée : une identité inconnue est refusée, et le dit
#   4. Un compte local n'est lié que si le fournisseur déclare l'e-mail vérifié
#   5. Le fournisseur fait foi : un groupe changé chez lui change le rôle
#   6. Le secret du client ne ressort jamais
#
# Prérequis : le Keycloak de test, et le panel qui le joint à la même adresse
# que ce script :
#   docker compose --profile test up -d keycloak
#
# Ce que le script touche, et qu'il rend : la section « connexion unique » des
# paramètres (remise comme il l'a trouvée), les comptes `@keycloak.test`
# (supprimés), les groupes d'Alice dans le realm de test.
#
# Usage :
#   ./scripts/verify-sso.sh
#   BASE_URL=http://localhost:3200 ./scripts/verify-sso.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8180}"
ISSUER="$KEYCLOAK_URL/realms/pupitre"
# Le secret du client du realm de test (`scripts/test-keycloak/`) : jetable.
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

# Une connexion par le fournisseur, comme un navigateur : le panel donne
# l'adresse de Keycloak, on y remplit le formulaire, Keycloak renvoie au
# panel. Écrit la destination finale dans $LANDED et la session dans $1.jar.
sso_login() {
  local user="$1" password="$2" jar="$WORK/$1.jar" kjar="$WORK/$1.kc.jar"
  rm -f "$jar" "$kjar"
  local url page action back
  # `/sign-in/*` est limité à trois demandes par dix secondes et par adresse :
  # des connexions enchaînées attendent leur tour, comme le ferait quelqu'un.
  for _ in 1 2 3 4 5 6 7 8; do
    url=$(curl -s -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" \
          -X POST "$BASE_URL/api/auth/sign-in/social" \
          -d '{"provider":"oidc","callbackURL":"/","errorCallbackURL":"/login"}' | jq -r '.url // empty')
    [ -n "$url" ] && break
    sleep 4
  done
  [ -n "$url" ] || fail "le panel ne propose pas de départ vers le fournisseur"
  page=$(curl -s -c "$kjar" -b "$kjar" "$url")
  action=$(printf '%s' "$page" | grep -o 'action="[^"]*"' | head -1 | sed 's/action="//; s/"$//; s/&amp;/\&/g')
  [ -n "$action" ] || fail "formulaire de connexion de Keycloak introuvable"
  back=$(curl -s -o /dev/null -w '%{redirect_url}' -c "$kjar" -b "$kjar" -X POST "$action" \
         --data-urlencode "username=$user" --data-urlencode "password=$password")
  case "$back" in "$BASE_URL"/*) ;; *) fail "Keycloak n'a pas renvoyé vers le panel : ${back:-?}" ;; esac
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

step "0. Prérequis"
code=$(curl -s -o /dev/null -w '%{http_code}' "$ISSUER/.well-known/openid-configuration")
[ "$code" = "200" ] || fail "Keycloak de test injoignable à $ISSUER — docker compose --profile test up -d keycloak"
pass "Keycloak répond à $ISSUER"
code=$(req POST /api/auth/sign-in/email "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
if [ "$code" != "200" ]; then
  code=$(req POST /api/auth/sign-up/email \
    "{\"name\":\"Admin de vérification\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
  [ "$code" = "200" ] || fail "impossible de se connecter ou de créer l'administrateur (HTTP $code)"
fi
pass "signed in as $ADMIN_EMAIL"
req GET /api/settings >/dev/null
if jq -e --arg i "$ISSUER" '.ssoClientSecretConfigured and .settings.sso.issuer != $i' "$BODY" >/dev/null; then
  fail "une connexion unique réelle est réglée sur cette instance : ce script la remplacerait"
fi
PREVIOUS_SSO=$(jq -c '.settings.sso' "$BODY")
psql_q "delete from users where email like '%@keycloak.test';" >/dev/null
# Le journal survit aux comptes supprimés : on ne lit que ce passage-ci.
START=$(psql_q "select now();")

step "1. « Tester »"
req POST /api/settings/sso/check "{\"issuer\":\"$ISSUER\"}" >/dev/null
jq -e --arg i "$ISSUER" '.ok and .issuer == $i' "$BODY" >/dev/null || fail "le bon émetteur n'est pas reconnu : $(cat "$BODY")"
pass "le bon émetteur répond"
req POST /api/settings/sso/check "{\"issuer\":\"$KEYCLOAK_URL/realms/inexistant\"}" >/dev/null
jq -e '.ok == false and (.error | length > 0)' "$BODY" >/dev/null || fail "un realm inexistant passe : $(cat "$BODY")"
pass "un realm inexistant est refusé : $(jq -r .error "$BODY")"

step "2. Réglage"
mapping='[{"group":"pupitre-admins","role":"admin"},{"group":"pupitre-ops","role":"operator"},{"group":"pupitre-lecture","role":"viewer"}]'
code=$(req PATCH /api/settings "{\"sso\":{\"roleMappings\":[{\"group\":\"x\",\"role\":\"role-inexistant\"}]}}")
[ "$code" = "422" ] || fail "un rôle inexistant est accepté (HTTP $code)"
pass "un rôle inexistant est refusé → 422"
code=$(req PATCH /api/settings "{\"sso\":{\"enabled\":true,\"label\":\"Keycloak\",\"issuer\":\"$ISSUER\",\"clientId\":\"pupitre\",\"autoCreate\":true,\"linkByEmail\":true,\"groupsClaim\":\"groups\",\"roleMappings\":$mapping,\"defaultRole\":\"no-access\",\"syncRoles\":true},\"ssoClientSecret\":\"$CLIENT_SECRET\"}")
[ "$code" = "200" ] || fail "réglage refusé (HTTP $code) : $(cat "$BODY")"
jq -e '.ssoStatus.active and .ssoClientSecretConfigured' "$BODY" >/dev/null || fail "connexion unique pas active : $(jq -c .ssoStatus "$BODY")"
pass "connexion unique active, retour à $(jq -r .ssoStatus.callbackUrl "$BODY")"
grep -qF "$CLIENT_SECRET" "$BODY" && fail "le secret du client ressort de l'API"
req GET /api/settings >/dev/null
grep -qF "$CLIENT_SECRET" "$BODY" && fail "le secret du client ressort de la lecture des paramètres"
[ "$(psql_q "select count(*) from app_settings where sso_client_secret_encrypted like '%$CLIENT_SECRET%';")" = "0" ] \
  || fail "le secret est en clair en base"
pass "le secret ne ressort jamais, et il est chiffré en base"
curl -s "$BASE_URL/login" | grep -q 'Se connecter avec Keycloak' || fail "le bouton n'est pas sur l'écran de connexion"
pass "l'écran de connexion propose « Se connecter avec Keycloak »"

step "3. Une connexion crée le compte, avec le rôle de ses groupes"
sso_login alice Alice-Keycloak-2026
[ "$LANDED" = "$BASE_URL/" ] || fail "retour inattendu : $LANDED"
[ "$(session_email alice)" = "alice@keycloak.test" ] || fail "pas de session pour Alice"
[ "$(role_of alice@keycloak.test)" = "operator" ] || fail "Alice a le rôle « $(role_of alice@keycloak.test) »"
pass "Alice (pupitre-ops) entre, Opérateur d'emblée"
[ "$(psql_q "select count(*) from audit_logs where action = 'user.role.changed' and after->>'email' = 'alice@keycloak.test' and created_at > '$START';")" = "0" ] \
  || fail "la création est passée par un changement de rôle"
psql_q "select after->>'origin' from audit_logs where action = 'user.created' and after->>'email' = 'alice@keycloak.test' and created_at > '$START';" | grep -q '^sso$' \
  || fail "la création ne dit pas qu'elle vient de la connexion unique"
psql_q "select after->>'groups' from audit_logs where action = 'auth.sso.login.succeeded' and after->>'email' = 'alice@keycloak.test' and created_at > '$START';" | grep -q 'pupitre-ops' \
  || fail "la connexion n'est pas au journal avec ses groupes"
pass "le journal dit d'où vient le compte, et avec quels groupes il est entré"

step "4. Création désactivée"
req PATCH /api/settings '{"sso":{"autoCreate":false}}' >/dev/null
sso_login chloe Chloe-Keycloak-2026
case "$LANDED" in *error=signup_disabled*) ;; *) fail "Chloé n'est pas refusée : $LANDED" ;; esac
[ "$(psql_q "select count(*) from users where email = 'chloe@keycloak.test';")" = "0" ] || fail "un compte a été créé"
pass "une identité inconnue est refusée (signup_disabled), sans compte créé"
req PATCH /api/settings '{"sso":{"autoCreate":true}}' >/dev/null
sso_login chloe Chloe-Keycloak-2026
[ "$(role_of chloe@keycloak.test)" = "no-access" ] || fail "Chloé (sans groupe) a « $(role_of chloe@keycloak.test) »"
pass "réactivée : Chloé, sans groupe, entre « Sans accès »"

step "5. La liaison d'un compte local"
code=$(req POST /api/admin/users '{"name":"Damien local","email":"damien@keycloak.test","password":"motdepasse-tres-long","role":"viewer"}')
[ "$code" = "201" ] || fail "compte local de Damien → HTTP $code"
sso_login damien Damien-Keycloak-2026
case "$LANDED" in *error=account_not_linked*) ;; *) fail "Damien (e-mail non vérifié) est lié : $LANDED" ;; esac
[ "$(psql_q "select count(*) from accounts a join users u on u.id = a.user_id where u.email = 'damien@keycloak.test' and a.provider_id = 'oidc';")" = "0" ] \
  || fail "un compte OIDC a été lié à Damien"
[ "$(role_of damien@keycloak.test)" = "viewer" ] || fail "le compte local de Damien a changé"
pass "e-mail non vérifié chez le fournisseur : pas de liaison, le compte local est intact"

step "6. Le fournisseur fait foi"
kc_move alice pupitre-ops pupitre-admins
sso_login alice Alice-Keycloak-2026
[ "$(role_of alice@keycloak.test)" = "admin" ] || fail "Alice dans pupitre-admins a « $(role_of alice@keycloak.test) »"
pass "Alice passe dans pupitre-admins chez Keycloak → Administratrice à la connexion suivante"
kc_move alice pupitre-admins pupitre-ops
sso_login alice Alice-Keycloak-2026
[ "$(role_of alice@keycloak.test)" = "operator" ] || fail "Alice revenue dans pupitre-ops a « $(role_of alice@keycloak.test) »"
pass "revenue dans pupitre-ops → Opératrice"
psql_q "select after->>'source' from audit_logs where action = 'user.role.changed' and after->>'email' = 'alice@keycloak.test' and created_at > '$START' order by created_at desc limit 1;" | grep -q '^sso$' \
  || fail "le changement de rôle ne dit pas qu'il vient du fournisseur"
pass "chaque changement est au journal, attribué au fournisseur"

printf '\n\033[32m✓ Connexion unique vérifiée.\033[0m\n\n'
