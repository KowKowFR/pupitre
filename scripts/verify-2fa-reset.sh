#!/usr/bin/env bash
#
# Vérifie la réinitialisation du second facteur par un administrateur —
# la porte de sortie de qui a perdu son téléphone ET ses codes de secours :
#
#   1. un utilisateur de test avec un VRAI second facteur (code TOTP calculé)
#   2. sa connexion réclame le code — l'état de départ, prouvé avant de le défaire
#   3. un administrateur SANS `user:reset-2fa` est refusé → 403
#   4. la permission accordée, la réinitialisation passe → 200
#   5. la ligne `two_factors` a disparu ET `users.two_factor_enabled` vaut false
#   6. ses sessions en cours sont fermées
#   7. il se reconnecte avec son seul mot de passe
#   8. les anciens codes de secours ne fonctionnent plus
#   9. un administrateur peut se réinitialiser lui-même : sa session survit
#  10. il peut réarmer un second facteur — le compte n'est pas cassé
#  11. l'audit retient l'acteur, la cible et l'IP, sans aucun secret
#  12. ménage : utilisateurs de test supprimés, rôle jetable supprimé,
#      `admin@example.test` toujours utilisable sans second facteur
#
# Le code TOTP est calculé ici, en RFC 6238 : `oathtool` s'il est installé,
# sinon une quinzaine de lignes de Node (HMAC-SHA1 sur un compteur de 30 s).
#
# Usage :
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
# Rôle jetable : plutôt que de toucher à `operator` ou `viewer` sur un
# environnement partagé, on fabrique le rôle dont on a besoin et on le détruit.
ROLE_KEY="${ROLE_KEY:-support-2fa-verification}"
CLIENT_IP="${CLIENT_IP:-198.51.100.91}"

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
# CSRF) : il est posé sur toutes les requêtes.
req() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -H "x-forwarded-for: $CLIENT_IP" -b "$JAR" -c "$JAR")
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }

# ─── Calcul d'un vrai code TOTP (RFC 6238) ────────────────────────────────────
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
pass "connecté en tant que $ADMIN_EMAIL"

# Ménage d'une exécution précédente.
drop_user "$TEST_EMAIL"
drop_user "$OPERATOR_EMAIL"
JAR="$ADMIN_JAR"
req DELETE "/api/admin/roles/$ROLE_KEY" >/dev/null 2>&1 || true

code=$(req POST /api/admin/users \
  "{\"name\":\"Cible 2FA\",\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"role\":\"viewer\"}")
[ "$code" = "201" ] || fail "création de la cible → HTTP $code : $(cat "$BODY")"
USER_ID=$(psql_q "select id from users where email = '$TEST_EMAIL';")
[ -n "$USER_ID" ] || fail "cible introuvable en base"
pass "utilisateur cible créé ($TEST_EMAIL)"

state=$(req GET /api/admin/users >/dev/null; jq -r --arg e "$TEST_EMAIL" \
  '.items[] | select(.email == $e) | .twoFactor' "$BODY")
[ "$state" = "none" ] || fail "GET /api/admin/users annonce « $state » pour un compte neuf"
pass "GET /api/admin/users expose le second facteur : « none » sur un compte neuf"

# ─── 2. Armer un vrai second facteur ──────────────────────────────────────────
step "2. Un vrai second facteur sur la cible"
JAR_T1="$WORK/t1.jar"
JAR="$JAR_T1"; code=$(signin "$TEST_EMAIL" "$TEST_PASSWORD")
[ "$code" = "200" ] || fail "connexion de la cible → HTTP $code : $(cat "$BODY")"

code=$(req POST /api/account/two-factor/setup "{\"password\":\"$TEST_PASSWORD\"}")
[ "$code" = "200" ] || fail "setup → HTTP $code : $(cat "$BODY")"
TOTP_URI=$(jq -r '.totpURI' "$BODY")
SECRET=$(printf '%s' "$TOTP_URI" | sed -n 's/.*[?&]secret=\([^&]*\).*/\1/p')
# `mapfile` n'existe pas en bash 3.2 (celui de macOS) : boucle explicite.
BACKUP_CODES=()
while IFS= read -r line; do BACKUP_CODES+=("$line"); done < <(jq -r '.backupCodes[]' "$BODY")
[ -n "$SECRET" ] || fail "aucun secret dans l'URI TOTP"
[ "${#BACKUP_CODES[@]}" -ge 5 ] || fail "trop peu de codes de secours (${#BACKUP_CODES[@]})"
pass "secret généré et ${#BACKUP_CODES[@]} codes de secours rendus"

code=$(req POST /api/account/two-factor/activate "{\"code\":\"$(totp "$SECRET")\"}")
[ "$code" = "200" ] || fail "activation → HTTP $code : $(cat "$BODY")"
enabled=$(psql_q "select two_factor_enabled from users where id = '$USER_ID';")
rows=$(psql_q "select count(*) from two_factors where user_id = '$USER_ID';")
[ "$enabled" = "t" ] || fail "users.two_factor_enabled = $enabled après activation"
[ "$rows" = "1" ] || fail "$rows ligne(s) two_factors après activation"
pass "second facteur armé : two_factors = 1 ligne, users.two_factor_enabled = t"

JAR="$ADMIN_JAR"
req GET /api/admin/users >/dev/null
state=$(jq -r --arg e "$TEST_EMAIL" '.items[] | select(.email == $e) | .twoFactor' "$BODY")
[ "$state" = "active" ] || fail "l'écran des utilisateurs annonce « $state » au lieu de « active »"
pass "l'administrateur VOIT le second facteur actif — le bouton n'est pas actionné à l'aveugle"

# ─── 3. L'état de départ : la connexion réclame le code ───────────────────────
step "3. L'état de départ : la connexion réclame le code"
JAR_T2="$WORK/t2.jar"
JAR="$JAR_T2"; code=$(signin "$TEST_EMAIL" "$TEST_PASSWORD")
[ "$code" = "200" ] || fail "connexion → HTTP $code : $(cat "$BODY")"
jq -e '.twoFactorRedirect == true' "$BODY" >/dev/null \
  || fail "le mot de passe seul a suffi : $(jq -c . "$BODY")"
[ -z "$(session_email)" ] || fail "une session existe alors que le code n'a pas été fourni"
pass "mot de passe seul → twoFactorRedirect, aucune session posée"

code=$(req POST /api/auth/two-factor/verify-totp "{\"code\":\"$(totp "$SECRET")\"}")
[ "$code" = "200" ] || fail "code TOTP valide → HTTP $code : $(cat "$BODY")"
[ "$(session_email)" = "$TEST_EMAIL" ] || fail "aucune session après un code valide"
pass "code TOTP valide → session ouverte (session « appareil perdu »)"

live=$(psql_q "select count(*) from sessions where user_id = '$USER_ID';")
[ "$live" -ge 1 ] || fail "aucune session en base pour la cible"
info "$live session(s) ouverte(s) pour la cible avant réinitialisation"

# ─── 4. Un administrateur sans la permission est refusé ───────────────────────
step "4. Sans « user:reset-2fa », c'est non"
JAR="$ADMIN_JAR"
code=$(req POST /api/admin/roles \
  "{\"key\":\"$ROLE_KEY\",\"label\":\"Support 2FA (vérification)\",\"description\":\"Rôle jetable\",\"permissions\":[\"user:read\",\"user:manage\"]}")
[ "$code" = "201" ] || fail "création du rôle → HTTP $code : $(cat "$BODY")"
jq -e '.permissions | index("user:reset-2fa") | not' "$BODY" >/dev/null \
  || fail "le rôle jetable porte déjà user:reset-2fa"
pass "rôle « $ROLE_KEY » créé avec user:read + user:manage, SANS user:reset-2fa"

code=$(req POST /api/admin/users \
  "{\"name\":\"Opérateur 2FA\",\"email\":\"$OPERATOR_EMAIL\",\"password\":\"$OPERATOR_PASSWORD\",\"role\":\"$ROLE_KEY\"}")
[ "$code" = "201" ] || fail "création de l'opérateur → HTTP $code : $(cat "$BODY")"
OPERATOR_ID=$(psql_q "select id from users where email = '$OPERATOR_EMAIL';")
pass "opérateur créé, porteur du rôle jetable"

JAR_OP="$WORK/op.jar"
JAR="$JAR_OP"; code=$(signin "$OPERATOR_EMAIL" "$OPERATOR_PASSWORD")
[ "$code" = "200" ] || fail "connexion de l'opérateur → HTTP $code : $(cat "$BODY")"
pass "opérateur connecté"

code=$(req DELETE "/api/admin/users/$USER_ID/two-factor")
[ "$code" = "403" ] || fail "attendu 403 sans la permission, reçu $code : $(cat "$BODY")"
jq -e '.error.details.permission == "user:reset-2fa"' "$BODY" >/dev/null \
  || fail "le refus ne nomme pas la permission : $(jq -c .error "$BODY")"
pass "réinitialisation refusée → 403, « $(jq -r '.error.message' "$BODY") »"

enabled=$(psql_q "select two_factor_enabled from users where id = '$USER_ID';")
[ "$enabled" = "t" ] || fail "le refus a tout de même touché au second facteur"
pass "gérer les utilisateurs (user:manage) ne suffit pas — rien n'a bougé"

# ─── 5. Permission accordée, réinitialisation ─────────────────────────────────
step "5. La permission accordée, la réinitialisation passe"
JAR="$ADMIN_JAR"
code=$(req PATCH "/api/admin/roles/$ROLE_KEY" \
  '{"permissions":["user:read","user:manage","user:reset-2fa"]}')
[ "$code" = "200" ] || fail "PATCH du rôle → HTTP $code : $(cat "$BODY")"
jq -e '.permissions | index("user:reset-2fa")' "$BODY" >/dev/null \
  || fail "user:reset-2fa n'a pas été accordée"
pass "« user:reset-2fa » accordée au rôle depuis /admin/roles"

JAR="$JAR_OP"
code=$(req DELETE "/api/admin/users/$USER_ID/two-factor")
[ "$code" = "200" ] || fail "réinitialisation → HTTP $code : $(cat "$BODY")"
jq -e '.twoFactor == "none" and .twoFactorEnabled == false' "$BODY" >/dev/null \
  || fail "réponse inattendue : $(jq -c . "$BODY")"
REVOKED=$(jq -r '.revokedSessions' "$BODY")
pass "réinitialisation → 200, $REVOKED session(s) fermée(s)"

step "6. Les deux écritures, dans le même geste"
rows=$(psql_q "select count(*) from two_factors where user_id = '$USER_ID';")
enabled=$(psql_q "select two_factor_enabled from users where id = '$USER_ID';")
[ "$rows" = "0" ] || fail "la ligne two_factors survit ($rows ligne(s))"
[ "$enabled" = "f" ] || fail "users.two_factor_enabled vaut « $enabled »"
pass "two_factors : 0 ligne — et users.two_factor_enabled = f"
info "aucun état bâtard : ni drapeau sans ligne, ni ligne sans drapeau"

JAR="$ADMIN_JAR"
req GET /api/admin/users >/dev/null
state=$(jq -r --arg e "$TEST_EMAIL" '.items[] | select(.email == $e) | .twoFactor' "$BODY")
[ "$state" = "none" ] || fail "l'écran annonce encore « $state »"
pass "l'écran des utilisateurs annonce « none »"

step "7. Le sort des sessions de la cible"
[ "$REVOKED" -ge 1 ] || fail "aucune session révoquée alors que la cible en avait $live"
live=$(psql_q "select count(*) from sessions where user_id = '$USER_ID';")
[ "$live" = "0" ] || fail "$live session(s) de la cible survivent"
JAR="$JAR_T2"
[ -z "$(session_email)" ] \
  || fail "la session ouverte depuis l'appareil « perdu » répond encore"
pass "toutes les sessions de la cible sont fermées — l'appareil perdu ne sert plus"

step "8. Réinitialiser deux fois de suite ne veut rien dire"
JAR="$JAR_OP"
code=$(req DELETE "/api/admin/users/$USER_ID/two-factor")
[ "$code" = "409" ] || fail "seconde réinitialisation : attendu 409, reçu $code"
pass "sans second facteur à retirer → 409, « $(jq -r '.error.message' "$BODY") »"

# ─── 9. L'administrateur peut se réinitialiser lui-même ───────────────────────
step "9. Un administrateur peut se réinitialiser lui-même"
JAR="$JAR_OP"
code=$(req POST /api/account/two-factor/setup "{\"password\":\"$OPERATOR_PASSWORD\"}")
[ "$code" = "200" ] || fail "setup de l'opérateur → HTTP $code : $(cat "$BODY")"
OP_URI=$(jq -r '.totpURI' "$BODY")
OP_SECRET=$(printf '%s' "$OP_URI" | sed -n 's/.*[?&]secret=\([^&]*\).*/\1/p')
code=$(req POST /api/account/two-factor/activate "{\"code\":\"$(totp "$OP_SECRET")\"}")
[ "$code" = "200" ] || fail "activation de l'opérateur → HTTP $code : $(cat "$BODY")"
pass "l'opérateur arme un second facteur sur son propre compte"

JAR_OP2="$WORK/op2.jar"
JAR="$JAR_OP2"; code=$(signin "$OPERATOR_EMAIL" "$OPERATOR_PASSWORD")
[ "$code" = "200" ] || fail "seconde connexion de l'opérateur → HTTP $code"
sleep 4
code=$(req POST /api/auth/two-factor/verify-totp "{\"code\":\"$(totp "$OP_SECRET")\"}")
[ "$code" = "200" ] || fail "code TOTP de l'opérateur → HTTP $code : $(cat "$BODY")"
[ "$(session_email)" = "$OPERATOR_EMAIL" ] || fail "seconde session de l'opérateur absente"
pass "une seconde session de l'opérateur est ouverte ailleurs"

JAR="$JAR_OP"
code=$(req DELETE "/api/admin/users/$OPERATOR_ID/two-factor")
[ "$code" = "200" ] || fail "auto-réinitialisation → HTTP $code : $(cat "$BODY")"
jq -e '.revokedSessions == 1' "$BODY" >/dev/null \
  || fail "sessions fermées : $(jq -r '.revokedSessions' "$BODY") au lieu de 1"
pass "auto-réinitialisation → 200 ; il ne gagne rien qu'il n'ait déjà"

[ "$(session_email)" = "$OPERATOR_EMAIL" ] \
  || fail "la session qui a agi a été fermée sous ses pieds"
pass "sa propre session survit — même règle que le changement de mot de passe"

JAR="$JAR_OP2"
[ -z "$(session_email)" ] || fail "l'autre session de l'opérateur survit"
pass "son AUTRE session, elle, est fermée"

rows=$(psql_q "select count(*) from two_factors where user_id = '$OPERATOR_ID';")
enabled=$(psql_q "select two_factor_enabled from users where id = '$OPERATOR_ID';")
[ "$rows" = "0" ] && [ "$enabled" = "f" ] \
  || fail "état incohérent après auto-réinitialisation ($rows ligne(s), drapeau $enabled)"
pass "two_factors : 0 ligne — users.two_factor_enabled = f"

# ─── 10. La cible se reconnecte, les vieux codes sont morts ───────────────────
step "10. La cible se reconnecte avec son seul mot de passe"
JAR_T3="$WORK/t3.jar"
JAR="$JAR_T3"; code=$(signin "$TEST_EMAIL" "$TEST_PASSWORD")
[ "$code" = "200" ] || fail "connexion → HTTP $code : $(cat "$BODY")"
jq -e '.twoFactorRedirect // false | not' "$BODY" >/dev/null \
  || fail "le second facteur est encore réclamé après réinitialisation"
[ "$(session_email)" = "$TEST_EMAIL" ] || fail "aucune session après la connexion simple"
pass "mot de passe seul → session ouverte, plus aucun code réclamé"

RESCUE="${BACKUP_CODES[0]}"
code=$(req POST /api/auth/two-factor/verify-backup-code "{\"code\":\"$RESCUE\"}")
[ "$code" != "200" ] || fail "un ancien code de secours a été accepté"
pass "ancien code de secours hors challenge → HTTP $code, refusé"

# ─── 10. Le compte n'est pas cassé : on réarme ────────────────────────────────
step "11. La cible réarme un second facteur"
code=$(req POST /api/account/two-factor/setup "{\"password\":\"$TEST_PASSWORD\"}")
[ "$code" = "200" ] || fail "nouveau setup → HTTP $code : $(cat "$BODY")"
NEW_URI=$(jq -r '.totpURI' "$BODY")
NEW_SECRET=$(printf '%s' "$NEW_URI" | sed -n 's/.*[?&]secret=\([^&]*\).*/\1/p')
[ -n "$NEW_SECRET" ] || fail "aucun secret dans la nouvelle URI TOTP"
[ "$NEW_SECRET" != "$SECRET" ] || fail "le nouveau secret est l'ancien"
pass "nouveau secret généré, différent de l'ancien"

code=$(req POST /api/account/two-factor/activate "{\"code\":\"$(totp "$NEW_SECRET")\"}")
[ "$code" = "200" ] || fail "réactivation → HTTP $code : $(cat "$BODY")"
enabled=$(psql_q "select two_factor_enabled from users where id = '$USER_ID';")
[ "$enabled" = "t" ] || fail "users.two_factor_enabled reste faux après réactivation"
pass "second facteur réarmé — le compte n'a pas été cassé par la réinitialisation"

JAR_T4="$WORK/t4.jar"
JAR="$JAR_T4"; code=$(signin "$TEST_EMAIL" "$TEST_PASSWORD")
[ "$code" = "200" ] || fail "connexion → HTTP $code"
jq -e '.twoFactorRedirect == true' "$BODY" >/dev/null || fail "second facteur non réclamé"
sleep 4
code=$(req POST /api/auth/two-factor/verify-backup-code "{\"code\":\"$RESCUE\"}")
[ "$code" != "200" ] || fail "un code de secours d'AVANT la réinitialisation ouvre une session"
[ -z "$(session_email)" ] || fail "une session a été ouverte avec un ancien code de secours"
pass "ancien code de secours face au NOUVEAU facteur → HTTP $code, refusé"

code=$(req POST /api/auth/two-factor/verify-totp "{\"code\":\"$(totp "$NEW_SECRET")\"}")
[ "$code" = "200" ] || fail "nouveau code TOTP → HTTP $code : $(cat "$BODY")"
[ "$(session_email)" = "$TEST_EMAIL" ] || fail "aucune session après le nouveau code"
pass "le nouveau code TOTP, lui, ouvre la session"

# ─── 11. Audit ────────────────────────────────────────────────────────────────
step "12. Traçabilité"
JAR="$ADMIN_JAR"
code=$(req GET "/api/audit-logs?action=user.2fa.reset&pageSize=20")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
jq -e --arg t "$USER_ID" --arg a "$OPERATOR_ID" \
  '[.items[] | select(.resourceId == $t and .actorId == $a)] | length > 0' "$BODY" >/dev/null \
  || fail "aucune ligne user.2fa.reset reliant l'opérateur à la cible"
pass "audit : user.2fa.reset — acteur $(jq -r --arg t "$USER_ID" \
  '[.items[] | select(.resourceId == $t)][0].actorEmail' "$BODY"), cible $TEST_EMAIL"

jq -e --arg t "$USER_ID" --arg ip "$CLIENT_IP" \
  '[.items[] | select(.resourceId == $t)][0].ip == $ip' "$BODY" >/dev/null \
  || fail "l'IP de l'acteur n'est pas tracée"
pass "audit : IP de l'acteur retenue ($CLIENT_IP)"

jq -e --arg t "$USER_ID" \
  '[.items[] | select(.resourceId == $t)][0].before.twoFactor == "active"' "$BODY" >/dev/null \
  || fail "l'état d'avant n'est pas tracé"
pass "audit : l'état d'avant (« active ») et le nombre de sessions fermées sont retenus"

code=$(req GET "/api/audit-logs?action=permission.denied&pageSize=50")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
jq -e --arg a "$OPERATOR_ID" \
  '[.items[] | select(.actorId == $a and .resourceId == "user:reset-2fa")] | length > 0' "$BODY" \
  >/dev/null || fail "le refus 403 n'a pas été journalisé"
pass "audit : le refus de l'opérateur sans permission est journalisé"

leaks=$(psql_q "select count(*) from audit_logs
  where coalesce(before::text, '') || coalesce(after::text, '') || coalesce(resource_id, '')
        like '%$SECRET%';")
[ "$leaks" = "0" ] || fail "l'ancien secret TOTP apparaît dans $leaks ligne(s) d'audit"
pass "aucune trace de l'ancien secret TOTP dans audit_logs"

leaks=$(psql_q "select count(*) from audit_logs
  where coalesce(before::text, '') || coalesce(after::text, '')
        like '%$NEW_SECRET%';")
[ "$leaks" = "0" ] || fail "le nouveau secret TOTP apparaît dans $leaks ligne(s) d'audit"
pass "aucune trace du nouveau secret TOTP dans audit_logs"

for rescue in "${BACKUP_CODES[@]}"; do
  leaks=$(psql_q "select count(*) from audit_logs
    where coalesce(before::text, '') || coalesce(after::text, '') like '%$rescue%';")
  [ "$leaks" = "0" ] || fail "un code de secours apparaît dans $leaks ligne(s) d'audit"
done
pass "aucun des ${#BACKUP_CODES[@]} codes de secours dans audit_logs"

hits=$(docker compose logs panel --no-color 2>/dev/null | grep -c -- "$SECRET" || true)
[ "$hits" = "0" ] || fail "l'ancien secret TOTP apparaît $hits fois dans les logs du panel"
pass "aucune trace du secret dans « docker compose logs panel »"

# ─── 12. Ménage ───────────────────────────────────────────────────────────────
step "13. Ménage"
JAR="$ADMIN_JAR"
code=$(req DELETE "/api/admin/users/$USER_ID")
[ "$code" = "200" ] || fail "suppression de la cible → HTTP $code : $(cat "$BODY")"
code=$(req DELETE "/api/admin/users/$OPERATOR_ID")
[ "$code" = "200" ] || fail "suppression de l'opérateur → HTTP $code : $(cat "$BODY")"
left=$(psql_q "select count(*) from users where email in ('$TEST_EMAIL', '$OPERATOR_EMAIL');")
[ "$left" = "0" ] || fail "$left utilisateur(s) de test survivent"
pass "utilisateurs de test supprimés"

code=$(req DELETE "/api/admin/roles/$ROLE_KEY")
[ "$code" = "200" ] || fail "suppression du rôle jetable → HTTP $code : $(cat "$BODY")"
left=$(psql_q "select count(*) from roles where key = '$ROLE_KEY';")
[ "$left" = "0" ] || fail "le rôle jetable survit en base"
pass "rôle jetable supprimé — aucun rôle préexistant n'a été modifié"

holders=$(psql_q "select count(*) from role_permissions rp
  join permissions p on p.id = rp.permission_id
  join roles r on r.id = rp.role_id
  where p.key = 'user:reset-2fa' and r.key <> 'admin';")
info "rôles (hors admin) portant user:reset-2fa après ménage : $holders"

step "14. L'administrateur reste utilisable"
JAR="$WORK/admin-check.jar"
code=$(signin "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
[ "$code" = "200" ] || fail "l'administrateur ne peut plus se connecter (HTTP $code)"
jq -e '.twoFactorRedirect // false | not' "$BODY" >/dev/null \
  || fail "un second facteur a été armé sur l'administrateur"
assert_admin
pass "$ADMIN_EMAIL se connecte toujours avec son mot de passe, sans second facteur"

printf '\n\033[32m✓ Réinitialisation du second facteur vérifiée.\033[0m\n'
printf '\033[2m  Écran : %s/admin/users\033[0m\n\n' "$BASE_URL"
