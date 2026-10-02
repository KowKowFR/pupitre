#!/usr/bin/env bash
#
# Vérifie « Comptes et sessions » : le second facteur exigé, la durée des
# sessions.
#
#   1. terrain : un administrateur AVEC second facteur (pour régler), un
#      opérateur et un observateur sans, et un jeton d'API de l'opérateur
#   2. exiger le second facteur sans l'avoir soi-même est refusé (409)
#   3. politique « droits sensibles » : l'opérateur n'a plus que l'écran
#      d'activation — 403 `two_factor_required` sur l'API, la discussion, son
#      jeton ; ses pages renvoient vers /two-factor-setup ; l'observateur, lui,
#      n'est pas concerné, ni un compte sans mot de passe (connexion unique)
#   4. les routes directes du plugin twoFactor de Better Auth sont fermées
#   5. l'opérateur active son second facteur : tout se rouvre, jeton compris,
#      et il ne peut plus le retirer (409 `two_factor_locked`)
#   6. politique « tous les comptes » : l'observateur y passe aussi
#   7. durée sans activité raccourcie : les sessions ouvertes sont ramenées,
#      les nouvelles naissent avec la nouvelle durée
#   8. plafond absolu : une session trop vieille est fermée, et retirée de la base
#   9. l'audit retient les refus, sans aucun secret
#  10. ménage : réglages remis comme avant, comptes de test supprimés
#
# Le code TOTP est calculé ici, en RFC 6238, par quelques lignes de Node.
#
# Usage :
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

command -v jq >/dev/null || { echo "jq est requis"; exit 1; }
command -v node >/dev/null || { echo "node est requis pour calculer les codes TOTP"; exit 1; }

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

# Une page : le code et, pour une redirection, sa destination.
page() {
  curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE_URL$1" -b "$JAR"
}

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }

error_code() { jq -r '.error.code // empty' "$BODY"; }

# ─── Calcul d'un vrai code TOTP (RFC 6238) ────────────────────────────────────
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

const [secret] = process.argv.slice(2);
const block = Buffer.alloc(8);
block.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
const digest = createHmac('sha1', base32Decode(secret)).update(block).digest();
const offset = digest[digest.length - 1] & 0x0f;
const truncated = digest.readUInt32BE(offset) & 0x7fffffff;
process.stdout.write(String(truncated % 1000000).padStart(6, '0'));
NODE

totp() { node "$WORK/totp.mjs" "$1"; }

# ─── Connexion, avec patience sur le rate limit de Better Auth ────────────────
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

# Arme un second facteur sur la session du `JAR` courant ; rend le secret.
enroll() {
  local code secret
  code=$(req POST /api/account/two-factor/setup "{\"password\":\"$PASSWORD\"}")
  [ "$code" = "200" ] || fail "setup → HTTP $code : $(cat "$BODY")"
  secret=$(jq -r '.totpURI' "$BODY" | sed -n 's/.*[?&]secret=\([^&]*\).*/\1/p')
  [ -n "$secret" ] || fail "aucun secret dans l'URI TOTP"
  code=$(req POST /api/account/two-factor/activate "{\"code\":\"$(totp "$secret")\"}")
  [ "$code" = "200" ] || fail "activation → HTTP $code : $(cat "$BODY")"
  printf '%s' "$secret"
}

drop_user() {
  local email="$1" id
  id=$(psql_q "select id from users where email = '$email';")
  [ -n "$id" ] || return 0
  JAR="$ADMIN_JAR"
  req DELETE "/api/admin/users/$id" >/dev/null || true
}

# Les réglages reviennent comme ils étaient, même si le script échoue en route :
# par l'API si l'administrateur de test le peut, sinon par la base — le panel
# relira la durée des sessions à son prochain démarrage.
restore() {
  [ -n "$SAVED" ] || return 0
  local code
  JAR="$GUARD_JAR"
  code=$(req PATCH /api/settings "{\"accounts\":$SAVED}" 2>/dev/null || true)
  if [ "$code" != "200" ]; then
    psql_q "update app_settings set value = jsonb_set(value, '{accounts}', '$SAVED'::jsonb) where id = 1;" >/dev/null || true
    info "réglages remis par la base (HTTP $code par l'API)"
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
[ "$code" = "200" ] || fail "connexion admin → HTTP $code : $(cat "$BODY")"
[ "$(jq -r '.user.role // empty' "$BODY")" = "admin" ] || fail "« $ADMIN_EMAIL » n'est pas administrateur"
pass "connecté en tant que $ADMIN_EMAIL"

drop_user "$GUARD_EMAIL"
drop_user "$OPERATOR_EMAIL"
drop_user "$VIEWER_EMAIL"
drop_user "$SSO_EMAIL"

JAR="$ADMIN_JAR"
req GET /api/settings >/dev/null
SAVED=$(jq -c '.settings.accounts' "$BODY")
[ "$SAVED" != "null" ] || fail "GET /api/settings ne rend pas de section « accounts »"
info "réglages de départ : $SAVED"

# L'état de départ doit être sans exigence : sinon l'administrateur lui-même
# pourrait être tenu, et rien de ce qui suit ne serait lisible.
code=$(req PATCH /api/settings '{"accounts":{"twoFactorPolicy":"off","sessionIdleHours":168,"sessionMaxHours":null}}')
[ "$code" = "200" ] || fail "remise à zéro des réglages → HTTP $code : $(cat "$BODY")"

for spec in "Garde|$GUARD_EMAIL|admin" "Opérateur|$OPERATOR_EMAIL|operator" "Observateur|$VIEWER_EMAIL|viewer" "Connexion unique|$SSO_EMAIL|operator"; do
  IFS='|' read -r name email role <<<"$spec"
  JAR="$ADMIN_JAR"
  code=$(req POST /api/admin/users \
    "{\"name\":\"$name sécurité\",\"email\":\"$email\",\"password\":\"$PASSWORD\",\"role\":\"$role\"}")
  [ "$code" = "201" ] || fail "création de $email → HTTP $code : $(cat "$BODY")"
done
OPERATOR_ID=$(psql_q "select id from users where email = '$OPERATOR_EMAIL';")
VIEWER_ID=$(psql_q "select id from users where email = '$VIEWER_EMAIL';")
pass "comptes créés : administrateur de garde, opérateur, observateur"

JAR="$GUARD_JAR"
code=$(signin "$GUARD_EMAIL" "$PASSWORD")
[ "$code" = "200" ] || fail "connexion de la garde → HTTP $code"
GUARD_SECRET=$(enroll)
[ -n "$GUARD_SECRET" ] || fail "second facteur de la garde"
pass "l'administrateur de garde a un second facteur armé"

JAR="$OPERATOR_JAR"
code=$(signin "$OPERATOR_EMAIL" "$PASSWORD")
[ "$code" = "200" ] || fail "connexion de l'opérateur → HTTP $code"
code=$(req POST /api/tokens '{"name":"verif-securite","permissions":["target:read"],"expiresInDays":30}')
[ "$code" = "201" ] || fail "jeton de l'opérateur → HTTP $code : $(cat "$BODY")"
OPERATOR_TOKEN=$(jq -r .token "$BODY")
[ "$(api "$OPERATOR_TOKEN" GET /api/targets)" = "200" ] || fail "le jeton de l'opérateur ne lit pas les cibles"
pass "l'opérateur a une session et un jeton d'API qui fonctionnent"

JAR="$VIEWER_JAR"
code=$(signin "$VIEWER_EMAIL" "$PASSWORD")
[ "$code" = "200" ] || fail "connexion de l'observateur → HTTP $code"
pass "l'observateur a une session"

# Un compte qui n'entre que par la connexion unique n'a pas de mot de passe :
# on en fabrique un en retirant la ligne `credential` d'un opérateur, après lui
# avoir fait créer un jeton — c'est par ce jeton qu'on le verra agir.
SSO_JAR="$WORK/sso.jar"
JAR="$SSO_JAR"
code=$(signin "$SSO_EMAIL" "$PASSWORD")
[ "$code" = "200" ] || fail "connexion du compte « connexion unique » → HTTP $code"
code=$(req POST /api/tokens '{"name":"verif-sso","permissions":["target:read"],"expiresInDays":30}')
[ "$code" = "201" ] || fail "jeton du compte « connexion unique » → HTTP $code : $(cat "$BODY")"
SSO_TOKEN=$(jq -r .token "$BODY")
psql_q "delete from accounts where provider_id = 'credential' and user_id = (select id from users where email = '$SSO_EMAIL');" >/dev/null
pass "un opérateur sans mot de passe, comme un compte de connexion unique, avec un jeton"

# ─── 2. On n'exige pas ce qu'on n'a pas ───────────────────────────────────────
step "2. Exiger le second facteur sans l'avoir soi-même"
ADMIN_2FA=$(psql_q "select two_factor_enabled from users where email = '$ADMIN_EMAIL';")
if [ "$ADMIN_2FA" = "f" ]; then
  JAR="$ADMIN_JAR"
  code=$(req PATCH /api/settings '{"accounts":{"twoFactorPolicy":"sensitive"}}')
  [ "$code" = "409" ] || fail "attendu 409, reçu HTTP $code : $(cat "$BODY")"
  [ "$(error_code)" = "two_factor_self" ] || fail "code d'erreur : $(error_code)"
  pass "$ADMIN_EMAIL, sans second facteur → 409 two_factor_self, rien d'enregistré"
else
  info "$ADMIN_EMAIL a un second facteur : refus non éprouvé"
fi

# ─── 3. Droits sensibles ──────────────────────────────────────────────────────
step "3. Politique « droits sensibles »"
JAR="$GUARD_JAR"
code=$(req PATCH /api/settings '{"accounts":{"twoFactorPolicy":"sensitive"}}')
[ "$code" = "200" ] || fail "PATCH par la garde → HTTP $code : $(cat "$BODY")"
[ "$(jq -r '.settings.accounts.twoFactorPolicy' "$BODY")" = "sensitive" ] || fail "politique non enregistrée"
pass "la garde, qui a un second facteur, l'enregistre"

JAR="$OPERATOR_JAR"
code=$(req GET /api/targets)
[ "$code" = "403" ] || fail "opérateur sur /api/targets : HTTP $code au lieu de 403"
[ "$(error_code)" = "two_factor_required" ] || fail "code d'erreur : $(error_code)"
pass "opérateur sans second facteur → 403 two_factor_required sur l'API"

code=$(req GET /api/chat/messages)
[ "$code" = "403" ] && [ "$(error_code)" = "two_factor_required" ] \
  || fail "discussion : HTTP $code ($(error_code))"
pass "la discussion lui est fermée aussi"

code=$(api "$OPERATOR_TOKEN" GET /api/targets)
[ "$code" = "403" ] && [ "$(error_code)" = "two_factor_required" ] \
  || fail "jeton de l'opérateur : HTTP $code ($(error_code))"
pass "son jeton d'API ne vaut pas mieux que lui → 403 two_factor_required"

code=$(req GET /api/account/sessions)
[ "$code" = "200" ] || fail "« Mon compte » fermé à l'opérateur : HTTP $code"
pass "les routes du compte restent ouvertes, le temps de l'activer"

for target in /targets /account /onboarding; do
  read -r status location <<<"$(page "$target")"
  [ "$status" = "307" ] && [[ "$location" == *"/two-factor-setup" ]] \
    || fail "$target : $status → $location"
done
read -r status _ <<<"$(page /two-factor-setup)"
[ "$status" = "200" ] || fail "/two-factor-setup : HTTP $status"
pass "ses pages, « Mon compte » compris, renvoient vers /two-factor-setup, qui s'affiche"

JAR="$VIEWER_JAR"
code=$(req GET /api/targets)
[ "$code" = "200" ] || fail "observateur sur /api/targets : HTTP $code ($(error_code))"
pass "l'observateur, qui ne fait que lire, n'est pas concerné"

code=$(api "$SSO_TOKEN" GET /api/targets)
[ "$code" = "200" ] || fail "opérateur sans mot de passe : HTTP $code ($(error_code))"
pass "l'opérateur sans mot de passe non plus : son second facteur est l'affaire du fournisseur"

JAR="$ADMIN_JAR"
if [ "$ADMIN_2FA" = "f" ]; then
  code=$(req GET /api/targets)
  [ "$code" = "403" ] && [ "$(error_code)" = "two_factor_required" ] \
    || fail "administrateur sans second facteur : HTTP $code ($(error_code))"
  pass "$ADMIN_EMAIL, administrateur sans second facteur, est tenu lui aussi"
fi

# ─── 4. Les routes directes de Better Auth ────────────────────────────────────
step "4. Les routes du plugin twoFactor de Better Auth sont fermées"
JAR="$GUARD_JAR"
code=$(req POST /api/auth/two-factor/disable "{\"password\":\"$PASSWORD\"}")
[ "$code" = "404" ] || fail "/api/auth/two-factor/disable : HTTP $code"
[ "$(psql_q "select two_factor_enabled from users where email = '$GUARD_EMAIL';")" = "t" ] \
  || fail "le second facteur de la garde a été retiré par la route directe"
code=$(req POST /api/auth/two-factor/enable "{\"password\":\"$PASSWORD\"}")
[ "$code" = "404" ] || fail "/api/auth/two-factor/enable : HTTP $code"
pass "disable et enable → 404, le second facteur de la garde est intact"

# ─── 5. L'opérateur active le sien ────────────────────────────────────────────
step "5. L'opérateur active son second facteur"
JAR="$OPERATOR_JAR"
OPERATOR_SECRET=$(enroll)
[ -n "$OPERATOR_SECRET" ] || fail "second facteur de l'opérateur"
code=$(req GET /api/targets)
[ "$code" = "200" ] || fail "après activation, /api/targets : HTTP $code ($(error_code))"
read -r status _ <<<"$(page /targets)"
[ "$status" = "200" ] || fail "après activation, /targets : HTTP $status"
read -r status location <<<"$(page /two-factor-setup)"
[ "$status" = "307" ] && [ "${location%/}" = "$BASE_URL" ] \
  || fail "après activation, /two-factor-setup : $status → $location"
pass "tout se rouvre, dans la même session — API et pages ; l'écran d'activation renvoie au panel"

[ "$(api "$OPERATOR_TOKEN" GET /api/targets)" = "200" ] || fail "jeton toujours refusé : $(error_code)"
pass "son jeton d'API aussi"

code=$(req POST /api/account/two-factor/disable "{\"password\":\"$PASSWORD\"}")
[ "$code" = "409" ] && [ "$(error_code)" = "two_factor_locked" ] \
  || fail "désactivation : HTTP $code ($(error_code))"
[ "$(psql_q "select two_factor_enabled from users where id = '$OPERATOR_ID';")" = "t" ] \
  || fail "le second facteur a été retiré malgré le refus"
pass "il ne peut plus le retirer → 409 two_factor_locked"

# ─── 6. Tous les comptes ──────────────────────────────────────────────────────
step "6. Politique « tous les comptes »"
JAR="$GUARD_JAR"
code=$(req PATCH /api/settings '{"accounts":{"twoFactorPolicy":"all"}}')
[ "$code" = "200" ] || fail "PATCH all → HTTP $code"
JAR="$VIEWER_JAR"
code=$(req GET /api/targets)
[ "$code" = "403" ] && [ "$(error_code)" = "two_factor_required" ] \
  || fail "observateur sous « tous » : HTTP $code ($(error_code))"
pass "l'observateur y passe à son tour → 403 two_factor_required"

JAR="$GUARD_JAR"
code=$(req PATCH /api/settings '{"accounts":{"twoFactorPolicy":"off"}}')
[ "$code" = "200" ] || fail "PATCH off → HTTP $code"
JAR="$VIEWER_JAR"
[ "$(req GET /api/targets)" = "200" ] || fail "observateur toujours refusé après « off »"
pass "politique retirée : l'observateur relit les cibles"

# ─── 7. Durée sans activité ───────────────────────────────────────────────────
step "7. Durée sans activité raccourcie à une heure"
before=$(psql_q "select max(extract(epoch from expires_at - now()))::int from sessions where user_id = '$VIEWER_ID';")
info "session de l'observateur : expire dans ${before} s"
[ "$before" -gt 7200 ] || fail "la session de départ expire déjà dans moins de deux heures"

JAR="$GUARD_JAR"
code=$(req PATCH /api/settings '{"accounts":{"sessionIdleHours":1}}')
[ "$code" = "200" ] || fail "PATCH sessionIdleHours → HTTP $code : $(cat "$BODY")"
after=$(psql_q "select max(extract(epoch from expires_at - now()))::int from sessions where user_id = '$VIEWER_ID';")
[ "$after" -le 3600 ] && [ "$after" -gt 3500 ] || fail "session ouverte : expire dans ${after} s"
pass "la session déjà ouverte est ramenée à une heure (${after} s)"

JAR="$VIEWER_JAR"
[ "$(req GET /api/targets)" = "200" ] || fail "la session ramenée ne sert plus"
pass "et elle sert toujours"

VIEWER2_JAR="$WORK/viewer2.jar"
JAR="$VIEWER2_JAR"
code=$(signin "$VIEWER_EMAIL" "$PASSWORD")
[ "$code" = "200" ] || fail "nouvelle connexion → HTTP $code"
fresh=$(psql_q "select extract(epoch from expires_at - now())::int from sessions where user_id = '$VIEWER_ID' order by created_at desc limit 1;")
[ "$fresh" -le 3600 ] && [ "$fresh" -gt 3500 ] || fail "nouvelle session : expire dans ${fresh} s"
pass "une nouvelle session naît avec la nouvelle durée (${fresh} s)"

# ─── 8. Plafond absolu ────────────────────────────────────────────────────────
step "8. Plafond absolu de 24 heures"
JAR="$GUARD_JAR"
code=$(req PATCH /api/settings '{"accounts":{"sessionIdleHours":168,"sessionMaxHours":24}}')
[ "$code" = "200" ] || fail "PATCH sessionMaxHours → HTTP $code"
# La session la plus récente de l'observateur a « été ouverte » il y a 25 heures.
OLD_SESSION=$(psql_q "select id from sessions where user_id = '$VIEWER_ID' order by created_at desc limit 1;")
psql_q "update sessions set created_at = now() - interval '25 hours' where id = '$OLD_SESSION';" >/dev/null
JAR="$VIEWER2_JAR"
code=$(req GET /api/targets)
[ "$code" = "401" ] || fail "session de 25 h : HTTP $code au lieu de 401"
[ "$(psql_q "select count(*) from sessions where id = '$OLD_SESSION';")" = "0" ] \
  || fail "la session trop vieille est restée en base"
pass "une session de 25 heures → 401, et retirée de la base"

JAR="$VIEWER_JAR"
[ "$(req GET /api/targets)" = "200" ] || fail "l'autre session, récente, a été refusée"
pass "l'autre session, récente, sert toujours"

# ─── 9. Audit ─────────────────────────────────────────────────────────────────
step "9. Le journal"
denied=$(psql_q "select count(*) from audit_logs where action = 'permission.denied' and actor_id = '$OPERATOR_ID' and after->>'reason' = 'two_factor_required';")
[ "$denied" -ge 3 ] || fail "$denied refus two_factor_required au journal pour l'opérateur"
pass "$denied refus « two_factor_required » au journal pour l'opérateur"
[ "$(psql_q "select count(*) from audit_logs where action = 'account.2fa.disable_failed' and actor_id = '$OPERATOR_ID' and after->>'reason' = 'two_factor_locked';")" -ge 1 ] \
  || fail "le refus de désactivation n'est pas au journal"
pass "le refus de désactivation est au journal"
[ "$(psql_q "select count(*) from audit_logs where action = 'auth.two_factor_route.refused' and created_at > now() - interval '10 minutes';")" -ge 2 ] \
  || fail "les routes directes refusées ne sont pas au journal"
pass "les routes directes refusées aussi (auth.two_factor_route.refused)"
[ "$(psql_q "select count(*) from audit_logs where action = 'auth.session.expired' and resource_id = '$OLD_SESSION' and after->>'reason' = 'max_age';")" = "1" ] \
  || fail "la session fermée par le plafond n'est pas au journal"
pass "la session fermée par le plafond aussi (auth.session.expired, max_age)"
leak=$(psql_q "select count(*) from audit_logs where created_at > now() - interval '10 minutes' and (coalesce(after::text, '') like '%$GUARD_SECRET%' or coalesce(after::text, '') like '%$OPERATOR_SECRET%' or coalesce(after::text, '') like '%$PASSWORD%');")
[ "$leak" = "0" ] || fail "$leak entrée(s) d'audit portent un secret TOTP ou un mot de passe"
pass "aucun secret TOTP ni mot de passe au journal"

# ─── 10. Ménage ───────────────────────────────────────────────────────────────
step "10. Ménage"
restore
JAR="$ADMIN_JAR"
req GET /api/settings >/dev/null
info "réglages remis : $(jq -c '.settings.accounts' "$BODY")"
code=$(req GET /api/targets)
[ "$code" = "200" ] || fail "$ADMIN_EMAIL ne relit pas les cibles après le ménage : HTTP $code ($(error_code))"
pass "$ADMIN_EMAIL relit les cibles — réglages remis"

printf '\n\033[32mComptes et sessions : tout est conforme.\033[0m\n'
