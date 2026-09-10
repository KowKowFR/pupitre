#!/usr/bin/env bash
#
# Vérifie la sécurité du compte — mot de passe et double authentification :
#
#   1. changer son mot de passe : l'ancien meurt, le nouveau vit
#   2. un changement sans l'ancien mot de passe est refusé
#   3. les AUTRES sessions tombent, celle qui a changé le mot de passe survit
#   4. activer le TOTP : le second facteur n'est armé qu'après un code valide
#   5. la connexion réclame le code, refuse un mauvais, accepte le bon
#   6. un code de secours fonctionne une seule fois
#   7. le secret TOTP n'apparaît ni en base, ni dans les logs du conteneur
#   8. désactiver le second facteur redonne une connexion simple
#
# Le code TOTP est calculé ici, en RFC 6238 : `oathtool` s'il est installé,
# sinon une quinzaine de lignes de Node (HMAC-SHA1 sur un compteur de 30 s).
#
# Usage :
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

command -v jq >/dev/null || { echo "jq est requis"; exit 1; }
command -v node >/dev/null || { echo "node est requis pour calculer les codes TOTP"; exit 1; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
info() { printf '    \033[2m%s\033[0m\n' "$1"; }

# Better Auth exige l'en-tête `Origin` sur les POST authentifiés (protection
# CSRF) : il est posé sur toutes les requêtes, pas seulement celles qui en ont
# strictement besoin.
req() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -H "x-forwarded-for: $CLIENT_IP" -b "$JAR" -c "$JAR")
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }

# ─── Calcul d'un vrai code TOTP ───────────────────────────────────────────────
cat > "$WORK/totp.mjs" <<'NODE'
import { createHmac } from 'node:crypto';

// RFC 4648 base32 → octets. Le `secret=` de l'URI otpauth:// est encodé ainsi.
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
// Décalage de fenêtres de 30 s : sert à fabriquer un code hors tolérance
// (Better Auth accepte ±1 fenêtre) pour prouver qu'un mauvais code est refusé.
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

session_email() {
  req GET /api/auth/get-session >/dev/null
  jq -r '.user.email // empty' "$BODY"
}

assert_admin() {
  local role
  role=$(jq -r '.user.role // empty' "$BODY")
  [ "$role" = "admin" ] && return 0
  fail "« $ADMIN_EMAIL » a le rôle « ${role:-aucun} », pas « admin » — voir /admin/users"
}

admin_login() {
  local code
  JAR="$ADMIN_JAR"
  code=$(signin "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
  if [ "$code" = "200" ]; then assert_admin; return 0; fi
  code=$(req POST /api/auth/sign-up/email \
    "{\"name\":\"Admin\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
  [ "$code" = "200" ] || fail "connexion admin impossible (HTTP $code) : $(cat "$BODY")"
  assert_admin
}

# ─── 1. Terrain ───────────────────────────────────────────────────────────────
step "1. Terrain : administrateur et utilisateur de test"
admin_login
pass "connecté en tant que $ADMIN_EMAIL"

# Ménage d'une exécution précédente.
JAR="$ADMIN_JAR"
existing=$(psql_q "select id from users where email = '$TEST_EMAIL';")
if [ -n "$existing" ]; then
  req DELETE "/api/admin/users/$existing" >/dev/null || true
  info "utilisateur de test résiduel supprimé"
fi

code=$(req POST /api/admin/users \
  "{\"name\":\"Compte de vérification\",\"email\":\"$TEST_EMAIL\",\"password\":\"$OLD_PASSWORD\",\"role\":\"viewer\"}")
[ "$code" = "201" ] || fail "création de l'utilisateur de test → HTTP $code : $(cat "$BODY")"
USER_ID=$(psql_q "select id from users where email = '$TEST_EMAIL';")
[ -n "$USER_ID" ] || fail "utilisateur de test introuvable en base"
pass "utilisateur de test créé ($TEST_EMAIL)"

JAR_A="$WORK/a.jar"
JAR_B="$WORK/b.jar"

JAR="$JAR_A"; code=$(signin "$TEST_EMAIL" "$OLD_PASSWORD")
[ "$code" = "200" ] || fail "connexion (session A) → HTTP $code : $(cat "$BODY")"
JAR="$JAR_B"; code=$(signin "$TEST_EMAIL" "$OLD_PASSWORD")
[ "$code" = "200" ] || fail "connexion (session B) → HTTP $code : $(cat "$BODY")"
pass "deux sessions distinctes ouvertes (cookies A et B)"

JAR="$JAR_A"; [ "$(session_email)" = "$TEST_EMAIL" ] || fail "session A invalide"
JAR="$JAR_B"; [ "$(session_email)" = "$TEST_EMAIL" ] || fail "session B invalide"
pass "les deux sessions répondent à /api/auth/get-session"

# ─── 2. Changement de mot de passe ────────────────────────────────────────────
step "2. Changement de mot de passe"
JAR="$JAR_A"

code=$(req POST /api/account/password "{\"newPassword\":\"$NEW_PASSWORD\"}")
[ "$code" = "422" ] || fail "changement sans ancien mot de passe : attendu 422, reçu $code"
jq -e '.error.code == "validation_failed"' "$BODY" >/dev/null \
  || fail "code d'erreur inattendu : $(jq -c .error "$BODY")"
pass "sans l'ancien mot de passe → 422, la requête n'est même pas recevable"

code=$(req POST /api/account/password \
  "{\"currentPassword\":\"pas-du-tout-le-bon-mot-de-passe\",\"newPassword\":\"$NEW_PASSWORD\"}")
[ "$code" = "400" ] || fail "ancien mot de passe faux : attendu 400, reçu $code"
jq -e '.error.code == "invalid_password"' "$BODY" >/dev/null \
  || fail "code d'erreur inattendu : $(jq -c .error "$BODY")"
pass "avec un mauvais ancien mot de passe → 400 invalid_password"

code=$(req POST /api/account/password \
  "{\"currentPassword\":\"$OLD_PASSWORD\",\"newPassword\":\"$NEW_PASSWORD\"}")
[ "$code" = "200" ] || fail "changement → HTTP $code : $(cat "$BODY")"
jq -e '.revokedOtherSessions == true' "$BODY" >/dev/null || fail "révocation non annoncée"
pass "mot de passe changé depuis la session A"

step "3. Le sort des autres sessions"
JAR="$JAR_A"
[ "$(session_email)" = "$TEST_EMAIL" ] \
  || fail "la session qui a changé le mot de passe a été fermée — inutilisable"
pass "session A (celle qui a agi) : toujours ouverte, cookie renouvelé"

JAR="$JAR_B"
b_email="$(session_email)"
[ -z "$b_email" ] \
  || fail "la session B survit au changement de mot de passe (utilisateur « $b_email »)"
pass "session B : fermée — un cookie volé ne survit pas au changement"

step "4. L'ancien mot de passe est mort, le nouveau vit"
JAR="$WORK/old.jar"; code=$(signin "$TEST_EMAIL" "$OLD_PASSWORD")
[ "$code" = "401" ] || fail "l'ancien mot de passe répond HTTP $code au lieu de 401"
pass "connexion avec l'ancien mot de passe → 401"

JAR="$WORK/new.jar"; code=$(signin "$TEST_EMAIL" "$NEW_PASSWORD")
[ "$code" = "200" ] || fail "le nouveau mot de passe répond HTTP $code au lieu de 200"
pass "connexion avec le nouveau mot de passe → 200"

# ─── 5. Activation du TOTP ────────────────────────────────────────────────────
step "5. Activation du second facteur"
JAR="$JAR_A"

code=$(req POST /api/account/two-factor/setup "{\"password\":\"$NEW_PASSWORD\"}")
[ "$code" = "200" ] || fail "setup → HTTP $code : $(cat "$BODY")"
TOTP_URI=$(jq -r '.totpURI' "$BODY")
SECRET=$(printf '%s' "$TOTP_URI" | sed -n 's/.*[?&]secret=\([^&]*\).*/\1/p')
# `mapfile` n'existe pas en bash 3.2 (celui de macOS) : boucle explicite.
BACKUP_CODES=()
while IFS= read -r line; do BACKUP_CODES+=("$line"); done < <(jq -r '.backupCodes[]' "$BODY")
[ -n "$SECRET" ] || fail "aucun secret dans l'URI TOTP"
[ "${#BACKUP_CODES[@]}" -ge 5 ] || fail "trop peu de codes de secours (${#BACKUP_CODES[@]})"
pass "secret généré (${#SECRET} caractères base32) et ${#BACKUP_CODES[@]} codes de secours rendus"

armed=$(psql_q "select coalesce((select verified::text from two_factors where user_id = '$USER_ID'), 'aucune');")
[ "$armed" = "false" ] || fail "la ligne two_factors est déjà verified=$armed avant vérification"
enabled=$(psql_q "select two_factor_enabled from users where id = '$USER_ID';")
[ "$enabled" = "f" ] || fail "users.two_factor_enabled est déjà vrai avant vérification"
pass "second facteur PAS encore armé : two_factors.verified=false, users.two_factor_enabled=false"

code=$(req POST /api/account/two-factor/activate "{\"code\":\"$(totp "$SECRET" 50)\"}")
[ "$code" = "400" ] || fail "code hors fenêtre : attendu 400, reçu $code"
jq -e '.error.code == "invalid_code"' "$BODY" >/dev/null \
  || fail "code d'erreur inattendu : $(jq -c .error "$BODY")"
enabled=$(psql_q "select two_factor_enabled from users where id = '$USER_ID';")
[ "$enabled" = "f" ] || fail "un code invalide a tout de même armé le second facteur"
pass "un code invalide → 400 invalid_code, rien n'est armé"

code=$(req POST /api/account/two-factor/activate "{\"code\":\"$(totp "$SECRET")\"}")
[ "$code" = "200" ] || fail "activation → HTTP $code : $(cat "$BODY")"
enabled=$(psql_q "select two_factor_enabled from users where id = '$USER_ID';")
[ "$enabled" = "t" ] || fail "users.two_factor_enabled reste faux après un code valide"
pass "code valide → second facteur armé (users.two_factor_enabled=true)"

# ─── 6. La connexion réclame le code ──────────────────────────────────────────
step "6. La connexion réclame désormais le code"
JAR_D="$WORK/d.jar"
JAR="$JAR_D"; code=$(signin "$TEST_EMAIL" "$NEW_PASSWORD")
[ "$code" = "200" ] || fail "connexion → HTTP $code : $(cat "$BODY")"
jq -e '.twoFactorRedirect == true' "$BODY" >/dev/null \
  || fail "le mot de passe seul a suffi : $(jq -c . "$BODY")"
jq -e '.twoFactorMethods | index("totp")' "$BODY" >/dev/null || fail "méthode totp non annoncée"
pass "mot de passe seul → twoFactorRedirect, aucune session posée"

[ -z "$(session_email)" ] || fail "une session existe alors que le code n'a pas été fourni"
pass "/api/auth/get-session ne rend rien tant que le code manque"

code=$(req POST /api/auth/two-factor/verify-totp "{\"code\":\"$(totp "$SECRET" 50)\"}")
[ "$code" = "401" ] || fail "code invalide à la connexion : attendu 401, reçu $code"
pass "code invalide → 401"

code=$(req POST /api/auth/two-factor/verify-totp "{\"code\":\"$(totp "$SECRET")\"}")
[ "$code" = "200" ] || fail "code valide → HTTP $code : $(cat "$BODY")"
[ "$(session_email)" = "$TEST_EMAIL" ] || fail "aucune session après un code valide"
pass "code valide → session ouverte"

# ─── 7. Codes de secours ──────────────────────────────────────────────────────
step "7. Un code de secours ne sert qu'une fois"
RESCUE="${BACKUP_CODES[0]}"

JAR_E="$WORK/e.jar"
JAR="$JAR_E"; code=$(signin "$TEST_EMAIL" "$NEW_PASSWORD")
[ "$code" = "200" ] || fail "connexion → HTTP $code"
jq -e '.twoFactorRedirect == true' "$BODY" >/dev/null || fail "second facteur non réclamé"
sleep 4
code=$(req POST /api/auth/two-factor/verify-backup-code "{\"code\":\"$RESCUE\"}")
[ "$code" = "200" ] || fail "code de secours → HTTP $code : $(cat "$BODY")"
[ "$(session_email)" = "$TEST_EMAIL" ] || fail "aucune session après le code de secours"
pass "premier usage du code de secours → session ouverte"

JAR_F="$WORK/f.jar"
JAR="$JAR_F"; code=$(signin "$TEST_EMAIL" "$NEW_PASSWORD")
[ "$code" = "200" ] || fail "connexion → HTTP $code"
sleep 4
code=$(req POST /api/auth/two-factor/verify-backup-code "{\"code\":\"$RESCUE\"}")
[ "$code" != "200" ] || fail "le même code de secours a été accepté une seconde fois"
[ -z "$(session_email)" ] || fail "une session a été ouverte malgré un code de secours consommé"
pass "second usage du même code → HTTP $code, refusé"

# ─── 8. Le secret ne fuit pas ─────────────────────────────────────────────────
step "8. Le secret TOTP ne fuit ni en base, ni dans les logs"
stored=$(psql_q "select secret from two_factors where user_id = '$USER_ID';")
[ "$stored" != "$SECRET" ] || fail "le secret est stocké en clair dans two_factors.secret"
pass "two_factors.secret est chiffré, ce n'est pas le secret rendu"

leaks=$(psql_q "select count(*) from audit_logs
  where coalesce(before::text, '') || coalesce(after::text, '') || coalesce(resource_id, '')
        like '%$SECRET%';")
[ "$leaks" = "0" ] || fail "le secret TOTP apparaît dans $leaks ligne(s) d'audit"
pass "aucune trace du secret dans audit_logs"

leaks=$(psql_q "select count(*) from audit_logs
  where coalesce(after::text, '') like '%$RESCUE%';")
[ "$leaks" = "0" ] || fail "un code de secours apparaît dans $leaks ligne(s) d'audit"
pass "aucune trace des codes de secours dans audit_logs"

hits=$(docker compose logs panel --no-color 2>/dev/null | grep -c -- "$SECRET" || true)
[ "$hits" = "0" ] || fail "le secret TOTP apparaît $hits fois dans les logs du conteneur panel"
pass "aucune trace du secret dans « docker compose logs panel »"

hits=$(docker compose logs panel --no-color 2>/dev/null | grep -c -- "$RESCUE" || true)
[ "$hits" = "0" ] || fail "un code de secours apparaît $hits fois dans les logs du panel"
pass "aucune trace des codes de secours dans les logs du panel"

hits=$(docker compose logs panel --no-color 2>/dev/null | grep -c -- "$NEW_PASSWORD" || true)
[ "$hits" = "0" ] || fail "le mot de passe apparaît $hits fois dans les logs du panel"
pass "aucune trace du mot de passe dans les logs du panel"

step "9. Traçabilité"
JAR="$ADMIN_JAR"
code=$(req GET "/api/audit-logs?actorId=$USER_ID&pageSize=50")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
for action in account.password.changed account.password.change_failed account.2fa.setup_started account.2fa.enabled; do
  jq -e --arg a "$action" '[.items[] | select(.action == $a)] | length > 0' "$BODY" >/dev/null \
    || fail "action « $action » absente du journal d'audit"
  pass "audit : $action"
done
jq -e '[.items[] | select(.action == "account.password.changed")][0].after
       | has("password") or has("newPassword") or has("currentPassword") | not' "$BODY" >/dev/null \
  || fail "le journal d'audit porte un mot de passe"
pass "la ligne de changement de mot de passe ne porte aucun mot de passe"

# ─── 10. Désactivation ────────────────────────────────────────────────────────
step "10. Désactivation du second facteur"
JAR="$JAR_A"
code=$(req POST /api/account/two-factor/disable '{"password":"pas-le-bon"}')
[ "$code" = "400" ] || fail "désactivation sans le bon mot de passe : attendu 400, reçu $code"
pass "désactivation refusée sans le mot de passe → 400"

code=$(req POST /api/account/two-factor/disable "{\"password\":\"$NEW_PASSWORD\"}")
[ "$code" = "200" ] || fail "désactivation → HTTP $code : $(cat "$BODY")"
enabled=$(psql_q "select two_factor_enabled from users where id = '$USER_ID';")
[ "$enabled" = "f" ] || fail "users.two_factor_enabled reste vrai après désactivation"
rows=$(psql_q "select count(*) from two_factors where user_id = '$USER_ID';")
[ "$rows" = "0" ] || fail "la ligne two_factors survit à la désactivation"
pass "second facteur retiré, ligne two_factors supprimée"

JAR_G="$WORK/g.jar"
JAR="$JAR_G"; code=$(signin "$TEST_EMAIL" "$NEW_PASSWORD")
[ "$code" = "200" ] || fail "connexion → HTTP $code"
jq -e '.twoFactorRedirect // false | not' "$BODY" >/dev/null \
  || fail "le second facteur est encore réclamé après désactivation"
[ "$(session_email)" = "$TEST_EMAIL" ] || fail "aucune session après la connexion simple"
pass "connexion à nouveau simple : mot de passe seul, session posée"

# ─── 11. Ménage ───────────────────────────────────────────────────────────────
step "11. Ménage"
JAR="$ADMIN_JAR"
code=$(req DELETE "/api/admin/users/$USER_ID")
[ "$code" = "200" ] || fail "suppression de l'utilisateur de test → HTTP $code : $(cat "$BODY")"
left=$(psql_q "select count(*) from users where email = '$TEST_EMAIL';")
[ "$left" = "0" ] || fail "l'utilisateur de test est encore en base"
pass "utilisateur de test supprimé"

step "12. L'administrateur reste utilisable"
JAR="$WORK/admin-check.jar"
code=$(signin "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
[ "$code" = "200" ] || fail "l'administrateur ne peut plus se connecter (HTTP $code)"
jq -e '.twoFactorRedirect // false | not' "$BODY" >/dev/null \
  || fail "un second facteur a été armé sur l'administrateur"
assert_admin
pass "$ADMIN_EMAIL se connecte toujours avec son mot de passe, sans second facteur"

printf '\n\033[32m✓ Sécurité du compte vérifiée.\033[0m\n'
printf '\033[2m  Écran : %s/account\033[0m\n\n' "$BASE_URL"
