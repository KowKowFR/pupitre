#!/usr/bin/env bash
#
# Jetons d'API : ce qu'une CI présente à la place d'une session.
#
#   1. Un jeton se crée depuis le panel, n'est montré qu'une fois, et la base
#      n'en garde que l'empreinte
#   2. Il ouvre l'API dans les limites de ses permissions — pas les routes du
#      panel, pas l'interface, pas la fabrique de jetons
#   3. Il ne peut jamais plus que son auteur, aujourd'hui : un rôle retiré le
#      réduit, un compte supprimé l'emporte
#   4. Limité à une application, il est refusé partout ailleurs
#   5. Révoqué ou échu, il est refusé et le dit
#   6. Le journal dit quel jeton a agi, et ne contient jamais le jeton
#
# Aucune cible n'est nécessaire.
#
# Usage :
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

command -v jq >/dev/null || { echo "jq est requis"; exit 1; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }

sha256() {
  if command -v sha256sum >/dev/null; then printf '%s' "$1" | sha256sum | cut -d' ' -f1
  else printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; fi
}

# Requête de navigateur : cookie et `Origin`, comme le panel.
req() {
  local method="$1" path="$2" jar="$3" data="${4:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL" -b "$jar" -c "$jar")
  [ -n "$data" ] && args+=(-d "$data")
  curl "${args[@]}"
}

# Requête de CI : le jeton, rien d'autre — ni cookie, ni `Origin`.
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
  [ "$got" = "$want" ] || fail "$what : attendu $want, reçu $got — $(cat "$BODY")"
  if [ -n "$code_want" ]; then
    jq -e --arg c "$code_want" '.error.code == $c' "$BODY" >/dev/null \
      || fail "$what : code attendu « $code_want », reçu $(jq -c .error "$BODY")"
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

step "0. Connexion administrateur"
code=$(req POST /api/auth/sign-in/email "$ADMIN_JAR" \
  "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
if [ "$code" != "200" ]; then
  code=$(req POST /api/auth/sign-up/email "$ADMIN_JAR" \
    "{\"name\":\"Admin de vérification\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
  [ "$code" = "200" ] || fail "impossible de se connecter ou de créer l'administrateur (HTTP $code)"
fi
pass "connecté en tant que $ADMIN_EMAIL"

step "1. Créer un jeton — montré une fois, gardé en empreinte"
code=$(req POST /api/tokens "$ADMIN_JAR" \
  '{"name":"verif-lecture","permissions":["deployment:read","application:read"],"expiresInDays":30}')
expect "$code" 201 "POST /api/tokens"
READ_TOKEN=$(jq -r .token "$BODY")
READ_ID=$(jq -r .item.id "$BODY")
[[ "$READ_TOKEN" =~ ^pup_[A-Za-z0-9_-]{43}$ ]] || fail "forme inattendue : $READ_TOKEN"
pass "jeton de la forme pup_…, préfixe affiché $(jq -r .item.prefix "$BODY")"
code=$(req GET /api/tokens "$ADMIN_JAR")
grep -qF "$READ_TOKEN" "$BODY" && fail "la liste des jetons contient le jeton en clair"
pass "la liste ne le montre plus"
stored=$(psql_q "select token_hash from api_tokens where id = '$READ_ID';")
[ "$stored" = "$(sha256 "$READ_TOKEN")" ] || fail "la base ne garde pas l'empreinte SHA-256 du jeton"
[ "$(psql_q "select count(*) from api_tokens where token_hash = '$READ_TOKEN';")" = "0" ] \
  || fail "le jeton est en clair en base"
pass "la base n'en garde que l'empreinte SHA-256"

step "2. Ce qu'il ouvre, et ce qu'il n'ouvre pas"
expect "$(api "$READ_TOKEN" GET /api/deployments)" 200 "lecture des déploiements"
expect "$(api "$READ_TOKEN" GET /api/applications)" 200 "lecture des applications"
expect "$(api "$READ_TOKEN" POST /api/deployments '{}')" 403 "déployer sans deployment:create" forbidden
expect "$(api "$READ_TOKEN" POST /api/tokens '{"name":"x","permissions":["deployment:read"]}')" 403 \
  "un jeton qui fabrique un jeton" token_refused
expect "$(api "$READ_TOKEN" GET /api/admin/tokens)" 403 "la liste des jetons de l'instance" token_refused
expect "$(api "$READ_TOKEN" GET /api/chat/messages)" 403 "la discussion" token_refused
page=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $READ_TOKEN" "$BASE_URL/deployments")
[ "$page" != "200" ] || fail "une page de l'interface s'ouvre avec un jeton"
pass "l'interface ne s'ouvre pas avec un jeton → $page"
# Bien formé mais inconnu. Fabriqué ici plutôt qu'écrit en clair : la garde des
# secrets de la CI reconnaît la forme d'un jeton.
UNKNOWN="pup_$(printf 'A%.0s' $(seq 1 43))"
expect "$(api "$UNKNOWN" GET /api/deployments)" 401 "jeton inconnu" token_invalid
expect "$(api "ghp_pas-un-jeton-pupitre" GET /api/deployments)" 401 "jeton mal formé" token_invalid

step "3. Jamais plus que son auteur"
code=$(req POST /api/admin/users "$ADMIN_JAR" \
  "{\"name\":\"Membre jetons\",\"email\":\"$MEMBER_EMAIL\",\"password\":\"$MEMBER_PASSWORD\",\"role\":\"viewer\"}")
case "$code" in 201|409) : ;; *) fail "création du membre → HTTP $code : $(cat "$BODY")" ;; esac
MEMBER_ID=$(psql_q "select id from users where email = '$MEMBER_EMAIL';")
expect "$(req PATCH "/api/admin/users/$MEMBER_ID/role" "$ADMIN_JAR" '{"role":"viewer"}')" 200 "membre en observateur"
# Le corps passe par une variable : coupé sur deux lignes dans un « "$(…)" »,
# un JSON à virgules serait découpé par l'expansion d'accolades de bash.
credentials="{\"email\":\"$MEMBER_EMAIL\",\"password\":\"$MEMBER_PASSWORD\"}"
expect "$(req POST /api/auth/sign-in/email "$MEMBER_JAR" "$credentials")" 200 "connexion du membre"
expect "$(req POST /api/tokens "$MEMBER_JAR" \
  '{"name":"verif-escalade","permissions":["deployment:create"]}')" 403 \
  "demander une permission qu'on n'a pas" forbidden
expect "$(req POST /api/tokens "$MEMBER_JAR" \
  '{"name":"verif-membre","permissions":["deployment:read"]}')" 201 "un jeton dans ses permissions"
MEMBER_TOKEN=$(jq -r .token "$BODY")
expect "$(api "$MEMBER_TOKEN" GET /api/deployments)" 200 "le jeton du membre lit"
expect "$(req PATCH "/api/admin/users/$MEMBER_ID/role" "$ADMIN_JAR" '{"role":"no-access"}')" 200 \
  "le membre perd ses permissions"
expect "$(api "$MEMBER_TOKEN" GET /api/deployments)" 403 "son jeton les perd avec lui" forbidden
expect "$(req DELETE "/api/admin/users/$MEMBER_ID" "$ADMIN_JAR")" 200 "le membre est supprimé"
MEMBER_ID=""
expect "$(api "$MEMBER_TOKEN" GET /api/deployments)" 401 "son jeton disparaît avec lui" token_invalid

step "4. Limité à une application"
spec="{\"appSpec\":{\"name\":\"$APP_SLUG\",\"version\":\"1.0.0\",\"services\":[{\"name\":\"web\",\"source\":{\"type\":\"image\",\"ref\":\"nginx:alpine\"},\"port\":80,\"exposed\":true}]}}"
code=$(req POST /api/applications "$ADMIN_JAR" "$spec")
[ "$code" = "201" ] || fail "création de l'application → HTTP $code : $(cat "$BODY")"
APP_ID=$(jq -r .id "$BODY")
pass "application « $APP_SLUG » créée"
code=$(req POST /api/tokens "$ADMIN_JAR" \
  "{\"name\":\"verif-ci\",\"permissions\":[\"deployment:create\",\"deployment:read\",\"application:read\"],\"applicationIds\":[\"$APP_ID\"]}")
expect "$code" 201 "jeton limité à « $APP_SLUG »"
CI_TOKEN=$(jq -r .token "$BODY")
CI_ID=$(jq -r .item.id "$BODY")
expect "$(api "$CI_TOKEN" GET "/api/applications/$APP_ID")" 200 "lire son application"
OTHER="00000000-0000-4000-8000-000000000000"
expect "$(api "$CI_TOKEN" GET "/api/applications/$OTHER")" 403 "lire une autre application" token_scope
elsewhere="{\"applicationId\":\"$OTHER\",\"targetId\":\"$OTHER\",\"runtime\":\"docker\"}"
expect "$(api "$CI_TOKEN" POST /api/deployments "$elsewhere")" 403 \
  "déployer une autre application" token_scope
expect "$(api "$CI_TOKEN" GET /api/deployments)" 403 "une route qui ne vérifie pas l'application" token_scope
# Même sur sa propre application : une route qui ne vérifie pas la portée refuse.
expect "$(api "$CI_TOKEN" GET "/api/applications/$APP_ID/versions")" 403 \
  "son application, par une route qui ne vérifie pas la portée" token_scope

step "5. Révoqué, échu"
expect "$(req DELETE "/api/tokens/$CI_ID" "$ADMIN_JAR")" 200 "révocation"
jq -e '.item.status == "revoked"' "$BODY" >/dev/null || fail "le jeton n'apparaît pas révoqué"
expect "$(api "$CI_TOKEN" GET "/api/applications/$APP_ID")" 401 "jeton révoqué" token_revoked
psql_q "update api_tokens set expires_at = now() - interval '1 minute' where id = '$READ_ID';" >/dev/null
expect "$(api "$READ_TOKEN" GET /api/deployments)" 401 "jeton échu" token_expired

step "6. Le journal"
code=$(req GET "/api/audit-logs?action=permission.denied&pageSize=50" "$ADMIN_JAR")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
jq -e '[.items[] | select(.apiTokenName == "verif-ci" and .after.reason == "token_scope")] | length > 0' \
  "$BODY" >/dev/null || fail "les refus du jeton limité ne portent pas son nom"
pass "les refus portent le nom du jeton"
created=$(psql_q "select count(*) from audit_logs where action = 'api_token.created' and after->>'name' like 'verif-%';")
[ "$created" -ge 3 ] || fail "créations de jetons au journal : $created"
pass "chaque création est au journal ($created)"
for token in "$READ_TOKEN" "$CI_TOKEN" "$MEMBER_TOKEN"; do
  leaked=$(psql_q "select count(*) from audit_logs where coalesce(after::text,'') || coalesce(before::text,'') like '%$token%';")
  [ "$leaked" = "0" ] || fail "un jeton figure en clair dans le journal"
done
pass "aucun jeton en clair dans le journal"

printf '\n\033[32m✓ Jetons d'"'"'API vérifiés.\033[0m\n\n'
