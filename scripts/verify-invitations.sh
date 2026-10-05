#!/usr/bin/env bash
#
# Vérifie le cycle de vie des comptes — inviter, réinitialiser, expirer :
#
#    1. sans canal SMTP, aucun parcours n'est proposé : le lien « mot de passe
#       oublié » n'est pas dans le HTML, l'écran le dit, et l'API refuse (409)
#    2. inviter exige `user:manage` — un observateur se prend un 403, tracé
#    3. l'invitation part réellement, en texte ET en HTML, et la partie texte
#       ne contient pas une seule balise
#    4. le compte invité n'a AUCUN mot de passe en base tant qu'il n'a pas
#       cliqué : rien à transmettre de la main à la main, rien à voler
#    5. le lien fonctionne une fois, et une seule
#    6. une réinitialisation aboutit et coupe TOUTES les sessions en cours
#    7. un lien expiré est refusé, et il le dit avant qu'on saisisse quoi que
#       ce soit
#    8. une adresse inconnue est indiscernable d'une adresse connue — même
#       code, même corps de réponse, et aucun e-mail
#    9. la limitation de débit de Better Auth mord réellement (3 / 60 s / IP)
#   10. relancer une invitation tue le lien précédent ; l'annuler tue le lien
#       sans supprimer le compte
#   11. aucun jeton nulle part : ni dans `audit_logs`, ni dans les logs du
#       panel, ni dans ceux du worker
#
# Ce que le script met en place, et démonte à la fin :
#   — deux comptes de vérification, supprimés par le `trap` ;
#   — un canal SMTP nommé `verif-invit-smtp`, pointé sur Mailpit, supprimé de
#     même. Aucun autre canal n'est touché.
#   — Mailpit, un vrai serveur SMTP jetable, sous le profil compose « test » :
#         docker compose --profile test up -d mailpit
#     Interface web : http://localhost:8025
#
# Rien n'est simulé : le message part par SMTP vers un vrai serveur, et c'est
# dans sa boîte que le script va relire le lien qu'il clique ensuite.
#
# Chaque phase utilise sa PROPRE adresse IP (en-tête `x-forwarded-for`). Ce
# n'est pas de la décoration : la limitation de débit de Better Auth compte par
# (IP, chemin), et sans cela la phase 9 ferait échouer les suivantes.
#
# Usage :
#   ./scripts/verify-invitations.sh
#   BASE_URL=http://localhost:3200 ./scripts/verify-invitations.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
MAILPIT_HTTP="${MAILPIT_HTTP:-http://127.0.0.1:8025}"

# Tout ce qui porte ce préfixe est à nous, et à nous seuls.
PREFIX="verif-invit"
INVITEE="$PREFIX-alice@example.test"
INVITEE2="$PREFIX-bob@example.test"
VIEWER_EMAIL="$PREFIX-viewer@example.test"
VIEWER_PASSWORD="observateur-motdepasse-long"
UNKNOWN_EMAIL="$PREFIX-personne-nexiste@example.test"
CHANNEL_NAME="$PREFIX-smtp"
SMTP_PASSWORD="VERIFINVITSMTPzz4417"

CHOSEN_PASSWORD="mot-de-passe-choisi-par-alice"
RESET_PASSWORD_VALUE="mot-de-passe-reinitialise-alice"

# Une IP par phase. Voir l'en-tête du fichier.
IP_ADMIN="198.51.100.10"
IP_ALICE="198.51.100.20"
IP_ENUM="198.51.100.30"
IP_THROTTLE="198.51.100.40"
IP_EXPIRY="198.51.100.50"

WORK="$(mktemp -d)"
BODY="$WORK/body.json"
ADMIN_JAR="$WORK/admin.jar"
JAR="$ADMIN_JAR"
CLIENT_IP="$IP_ADMIN"

command -v jq >/dev/null || { echo "jq est requis"; exit 1; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
skip() { printf '  \033[33m—\033[0m %s\n' "$1"; }
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

user_id_of() { psql_q "select id from users where email = '$1';"; }

# ─── Ménage, au début comme à la fin ──────────────────────────────────────────
cleanup() {
  JAR="$ADMIN_JAR"; CLIENT_IP="$IP_ADMIN"
  for email in "$INVITEE" "$INVITEE2" "$VIEWER_EMAIL"; do
    local id
    id=$(user_id_of "$email" 2>/dev/null || true)
    [ -n "$id" ] && req DELETE "/api/admin/users/$id" >/dev/null 2>&1 || true
  done
  local cid
  cid=$(psql_q "select id from notification_channels where name = '$CHANNEL_NAME';" 2>/dev/null || true)
  [ -n "$cid" ] && req DELETE "/api/notifications/channels/$cid" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

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

mailpit_reset() { curl -s -X DELETE "$MAILPIT_HTTP/api/v1/messages" >/dev/null; }

# La partie texte d'un message, débarrassée des CR de SMTP. Sans ce `tr`, un
# lien extrait par `grep` traîne un `\r` et ne se compare plus à rien.
mail_text() { curl -s "$MAILPIT_HTTP/api/v1/message/$1" | jq -r '.Text' | tr -d '\r'; }
mail_html() { curl -s "$MAILPIT_HTTP/api/v1/message/$1" | jq -r '.HTML' | tr -d '\r'; }

# Attend qu'un message adressé à $1 arrive, et rend son identifiant Mailpit.
mailpit_wait_for() {
  local recipient="$1" id
  for _ in $(seq 1 40); do
    id=$(curl -s "$MAILPIT_HTTP/api/v1/messages?limit=50" \
      | jq -r --arg to "$recipient" \
        '[.messages[] | select(any(.To[]; .Address == $to))] | sort_by(.Created) | last | .ID // empty')
    [ -n "$id" ] && { printf '%s' "$id"; return 0; }
    sleep 0.5
  done
  return 1
}

# ─── 1. Terrain ───────────────────────────────────────────────────────────────
step "1. Terrain"

JAR="$ADMIN_JAR"
code=$(signin "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
[ "$code" = "200" ] || fail "connexion admin impossible (HTTP $code) : $(cat "$BODY")"
[ "$(jq -r '.user.role // empty' "$BODY")" = "admin" ] \
  || fail "« $ADMIN_EMAIL » n'est pas administrateur"
pass "connecté en tant que $ADMIN_EMAIL"

JAR="$ADMIN_JAR"
for email in "$INVITEE" "$INVITEE2" "$VIEWER_EMAIL"; do
  id=$(user_id_of "$email")
  [ -n "$id" ] && { req DELETE "/api/admin/users/$id" >/dev/null; info "compte résiduel « $email » supprimé"; }
done
cid=$(psql_q "select id from notification_channels where name = '$CHANNEL_NAME';")
[ -n "$cid" ] && { req DELETE "/api/notifications/channels/$cid" >/dev/null; info "canal résiduel supprimé"; }

docker compose --profile test up -d mailpit >/dev/null 2>&1 \
  || fail "impossible de démarrer Mailpit (profil compose « test »)"
for _ in $(seq 1 30); do
  curl -sf "$MAILPIT_HTTP/api/v1/messages" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "$MAILPIT_HTTP/api/v1/messages" >/dev/null || fail "Mailpit ne répond pas sur $MAILPIT_HTTP"
mailpit_reset
pass "Mailpit démarré (SMTP mailpit:1025, interface $MAILPIT_HTTP), boîte vidée"

# ─── 2. L'instance par défaut : aucun canal e-mail ────────────────────────────
step "2. Sans canal SMTP, le parcours n'est pas proposé"

FOREIGN_SMTP=$(psql_q "select count(*) from notification_channels where kind = 'smtp' and enabled;")
if [ "$FOREIGN_SMTP" != "0" ]; then
  skip "un canal SMTP étranger est déjà actif sur cette instance — phase sautée"
  skip "(le script ne touche jamais à un canal qu'il n'a pas créé)"
else
  html=$(curl -s -H "x-forwarded-for: $IP_ADMIN" "$BASE_URL/login")
  grep -qE 'Mot de passe oubli|Forgotten password' <<< "$html" \
    && fail "le lien « Mot de passe oublié » est proposé alors qu'aucun e-mail ne peut partir"
  pass "l'écran de connexion ne propose pas « Mot de passe oublié »"

  html=$(curl -s -H "x-forwarded-for: $IP_ADMIN" "$BASE_URL/forgot-password")
  grep -qE 'Réinitialisation indisponible|Reset unavailable' <<< "$html" \
    || fail "/forgot-password n'annonce pas que la réinitialisation est indisponible"
  grep -q 'name="email"' <<< "$html" \
    && fail "/forgot-password affiche un formulaire qui ne mènerait nulle part"
  pass "/forgot-password explique l'indisponibilité au lieu d'accepter une adresse"

  JAR="$ADMIN_JAR"; CLIENT_IP="$IP_ADMIN"
  code=$(req POST /api/admin/users \
    "{\"name\":\"Alice\",\"email\":\"$INVITEE\",\"role\":\"viewer\"}")
  [ "$code" = "409" ] || fail "invitation sans SMTP : attendu 409, reçu $code — $(cat "$BODY")"
  jq -e '.error.code == "mail_channel_missing"' "$BODY" >/dev/null \
    || fail "code d'erreur inattendu : $(jq -c .error "$BODY")"
  pass "POST /api/admin/users sans mot de passe → 409 mail_channel_missing"

  left=$(psql_q "select count(*) from users where email = '$INVITEE';")
  [ "$left" = "0" ] || fail "un compte a été créé alors que l'invitation ne pouvait pas partir"
  pass "aucun compte orphelin créé — la capacité est vérifiée AVANT"
fi

# ─── 3. Le canal SMTP ─────────────────────────────────────────────────────────
step "3. Configuration du canal e-mail"

JAR="$ADMIN_JAR"; CLIENT_IP="$IP_ADMIN"
code=$(req POST /api/notifications/channels \
  "{\"kind\":\"smtp\",\"name\":\"$CHANNEL_NAME\",
    \"config\":{\"host\":\"mailpit\",\"port\":1025,\"security\":\"none\",\"user\":\"panel\",
      \"from\":\"Pupitre <panel@example.test>\",
      \"to\":\"ops@example.test\",\"rejectUnauthorized\":false},
    \"secrets\":{\"password\":\"$SMTP_PASSWORD\"},\"events\":[]}")
[ "$code" = "201" ] || fail "création du canal SMTP → HTTP $code : $(cat "$BODY")"
CHANNEL_ID=$(jq -r '.id' "$BODY")
pass "canal « $CHANNEL_NAME » créé ($CHANNEL_ID), abonné à AUCUN événement"
info "l'invitation empruntera donc son transport, pas ses abonnements"

html=$(curl -s -H "x-forwarded-for: $IP_ADMIN" "$BASE_URL/login")
grep -qE 'Mot de passe oubli|Forgotten password' <<< "$html" \
  || fail "le lien « Mot de passe oublié » reste masqué alors qu'un canal existe"
pass "l'écran de connexion propose maintenant « Mot de passe oublié »"

# ─── 4. RBAC ──────────────────────────────────────────────────────────────────
step "4. Inviter exige « user:manage »"

JAR="$ADMIN_JAR"; CLIENT_IP="$IP_ADMIN"
code=$(req POST /api/admin/users \
  "{\"name\":\"Observateur\",\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\",\"role\":\"viewer\"}")
[ "$code" = "201" ] || fail "création de l'observateur → HTTP $code : $(cat "$BODY")"
VIEWER_ID=$(jq -r '.id' "$BODY")
pass "observateur de test créé ($VIEWER_EMAIL)"

VIEWER_JAR="$WORK/viewer.jar"
JAR="$VIEWER_JAR"; CLIENT_IP="$IP_ADMIN"
code=$(signin "$VIEWER_EMAIL" "$VIEWER_PASSWORD")
[ "$code" = "200" ] || fail "connexion de l'observateur → HTTP $code"

code=$(req POST /api/admin/users "{\"name\":\"Mallory\",\"email\":\"mallory@example.test\",\"role\":\"admin\"}")
[ "$code" = "403" ] || fail "invitation par un observateur : attendu 403, reçu $code"
jq -e '.error.details.permission == "user:manage"' "$BODY" >/dev/null \
  || fail "le refus ne nomme pas la permission manquante : $(jq -c .error "$BODY")"
pass "un observateur qui invite → 403, permission « user:manage » nommée"

left=$(psql_q "select count(*) from users where email = 'mallory@example.test';")
[ "$left" = "0" ] || fail "l'invitation refusée a tout de même créé un compte"
pass "aucun compte créé par la tentative refusée"

JAR="$ADMIN_JAR"; CLIENT_IP="$IP_ADMIN"
code=$(req GET "/api/audit-logs?action=permission.denied&pageSize=20")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
jq -e '[.items[] | select(.resourceId == "user:manage")] | length > 0' "$BODY" >/dev/null \
  || fail "le refus n'apparaît pas dans le journal d'activité"
pass "audit : permission.denied sur « user:manage »"

# ─── 5. L'invitation part ─────────────────────────────────────────────────────
step "5. L'invitation part réellement"

mailpit_reset
JAR="$ADMIN_JAR"; CLIENT_IP="$IP_ADMIN"
code=$(req POST /api/admin/users "{\"name\":\"Alice\",\"email\":\"$INVITEE\",\"role\":\"operator\"}")
[ "$code" = "201" ] || fail "invitation → HTTP $code : $(cat "$BODY")"
jq -e '.invitation.sent == true' "$BODY" >/dev/null \
  || fail "la route n'affirme pas que l'e-mail est parti : $(jq -c .invitation "$BODY")"
ALICE_ID=$(jq -r '.id' "$BODY")
pass "POST /api/admin/users sans mot de passe → 201, invitation.sent=true"
info "canal emprunté : $(jq -r '.invitation.channel' "$BODY")"

grep -qi 'password' "$BODY" && fail "la réponse contient le mot « password » : $(cat "$BODY")"
pass "la réponse ne porte aucun mot de passe"

# — Le compte n'a AUCUN mot de passe —
rows=$(psql_q "select count(*) from accounts where user_id = '$ALICE_ID' and provider_id = 'credential';")
[ "$rows" = "0" ] || fail "un compte « credential » existe déjà : un mot de passe a été fabriqué"
pass "aucune ligne accounts/credential : le compte n'a littéralement pas de mot de passe"

roles=$(psql_q "select r.key from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = '$ALICE_ID';")
[ "$roles" = "operator" ] || fail "rôle attendu « operator », trouvé « $roles »"
pass "le rôle demandé est posé dès l'invitation (operator)"

# — La ligne de jeton est bien celle de Better Auth —
TOK_ROWS=$(psql_q "select count(*) from verifications where value = '$ALICE_ID' and identifier like 'reset-password:%';")
[ "$TOK_ROWS" = "1" ] || fail "attendu 1 ligne de jeton dans verifications, trouvé $TOK_ROWS"
HOURS=$(psql_q "select round(extract(epoch from (expires_at - now()))/3600) from verifications where value = '$ALICE_ID';")
[ "$HOURS" = "72" ] || fail "échéance de l'invitation : attendu ~72 h, trouvé ${HOURS} h"
pass "un seul jeton, dans la table « verifications » de Better Auth, valable 72 h"

# — Le message —
MID=$(mailpit_wait_for "$INVITEE") || fail "aucun e-mail reçu pour $INVITEE"
MAIL=$(curl -s "$MAILPIT_HTTP/api/v1/message/$MID")
SUBJECT=$(jq -r '.Subject' <<< "$MAIL")
TEXT=$(mail_text "$MID")
HTML=$(mail_html "$MID")
pass "e-mail reçu : « $SUBJECT »"

[ "$(curl -s "$MAILPIT_HTTP/api/v1/messages" | jq -r '.total')" = "1" ] \
  || fail "plus d'un message est parti pour une seule invitation"
[ "$(jq -r '.To | length' <<< "$MAIL")" = "1" ] \
  || fail "le message a plusieurs destinataires : $(jq -c '.To' <<< "$MAIL")"
[ "$(jq -r '.To[0].Address' <<< "$MAIL")" = "$INVITEE" ] \
  || fail "destinataire inattendu : $(jq -r '.To[0].Address' <<< "$MAIL")"
pass "un seul message, un seul destinataire : l'invitée, pas « ops@example.test » du canal"

[ -n "$TEXT" ] || fail "le message n'a pas de partie texte"
[ -n "$HTML" ] || fail "le message n'a pas de partie HTML"
pass "deux parties : text/plain ($(wc -c <<< "$TEXT" | tr -d ' ') o) et text/html ($(wc -c <<< "$HTML" | tr -d ' ') o)"

grep -qE '<[a-zA-Z/!]' <<< "$TEXT" \
  && fail "la partie texte contient du HTML : $(grep -oE '<[a-zA-Z/!][^>]*>' <<< "$TEXT" | head -3 | tr '\n' ' ')"
pass "la partie texte ne contient pas une seule balise"

grep -qE 'Choisir mon mot de passe|Choose my password' <<< "$TEXT" || fail "la partie texte n'annonce pas l'action"
grep -q '<a href=' <<< "$HTML" || fail "la partie HTML n'a pas de lien"
pass "les deux parties portent l'action ; le HTML a un vrai lien cliquable"

HEADERS=$(curl -s "$MAILPIT_HTTP/api/v1/message/$MID/headers")
[ "$(jq -r '."X-Control-Plane-Account-Mail"[0] // empty' <<< "$HEADERS")" = "invitation" ] \
  || fail "l'en-tête de service ne dit pas qu'il s'agit d'une invitation"
[ "$(jq -r '."Auto-Submitted"[0] // empty' <<< "$HEADERS")" = "auto-generated" ] \
  || fail "l'en-tête Auto-Submitted manque : ce message déclencherait des réponses d'absence"
pass "en-têtes de service : X-Control-Plane-Account-Mail=invitation, Auto-Submitted=auto-generated"

INVITE_LINK=$(grep -oE 'https?://[^ ]*reset-password/[A-Za-z0-9_-]+[^ ]*' <<< "$TEXT" | head -1)
[ -n "$INVITE_LINK" ] || fail "aucun lien dans la partie texte"
grep -qF "$INVITE_LINK" <<< "$HTML" || fail "le lien du HTML diffère de celui du texte"
INVITE_TOKEN=$(sed -E 's#.*/reset-password/([A-Za-z0-9_-]+).*#\1#' <<< "$INVITE_LINK")
[ ${#INVITE_TOKEN} -ge 16 ] || fail "jeton suspect (${#INVITE_TOKEN} caractères) : $INVITE_TOKEN"
pass "lien identique dans les deux parties, jeton de ${#INVITE_TOKEN} caractères"

# ─── 6. Le lien fonctionne une fois, et une seule ─────────────────────────────
step "6. Le lien fonctionne une fois, et une seule"

CLIENT_IP="$IP_ALICE"
REDIRECT=$(curl -s -o /dev/null -w '%{redirect_url}' -H "x-forwarded-for: $CLIENT_IP" "$INVITE_LINK")
grep -q '/invitation?token=' <<< "$REDIRECT" \
  || fail "le lien ne mène pas à l'écran d'invitation : $REDIRECT"
pass "le lien atterrit sur /invitation (et non sur /reset-password) : la page tient compte du fait"
info "$(sed -E 's/token=[A-Za-z0-9_-]+/token=…/' <<< "$REDIRECT")"

ALICE_JAR="$WORK/alice.jar"
JAR="$ALICE_JAR"
code=$(req POST /api/auth/reset-password \
  "{\"token\":\"$INVITE_TOKEN\",\"newPassword\":\"$CHOSEN_PASSWORD\"}")
[ "$code" = "200" ] || fail "choix du mot de passe → HTTP $code : $(cat "$BODY")"
pass "POST /api/auth/reset-password → 200, le mot de passe est posé"

rows=$(psql_q "select count(*) from accounts where user_id = '$ALICE_ID' and provider_id = 'credential' and password is not null;")
[ "$rows" = "1" ] || fail "aucune ligne credential après le choix du mot de passe"
verified=$(psql_q "select email_verified from users where id = '$ALICE_ID';")
[ "$verified" = "t" ] || fail "users.email_verified reste faux : la preuve d'adresse n'est pas enregistrée"
pass "compte actif, et « email_verified » posé — cliquer le lien EST la preuve d'adresse"

JAR="$ALICE_JAR"
code=$(signin "$INVITEE" "$CHOSEN_PASSWORD")
[ "$code" = "200" ] || fail "connexion d'Alice → HTTP $code : $(cat "$BODY")"
[ "$(session_email)" = "$INVITEE" ] || fail "aucune session après connexion"
pass "Alice se connecte avec le mot de passe qu'elle a choisi"

# — Le même lien, une seconde fois —
gone=$(psql_q "select count(*) from verifications where value = '$ALICE_ID' and identifier like 'reset-password:%';")
[ "$gone" = "0" ] || fail "le jeton survit à son usage ($gone ligne(s))"
pass "la ligne du jeton a disparu de « verifications » : consommée, pas marquée"

REDIRECT=$(curl -s -o /dev/null -w '%{redirect_url}' -H "x-forwarded-for: $IP_ALICE" "$INVITE_LINK")
grep -q 'error=INVALID_TOKEN' <<< "$REDIRECT" \
  || fail "le lien déjà utilisé ne mène pas à une erreur : $REDIRECT"
pass "réouvrir le lien → redirection vers ?error=INVALID_TOKEN, avant toute saisie"

JAR="$WORK/replay.jar"; CLIENT_IP="$IP_ALICE"
code=$(req POST /api/auth/reset-password \
  "{\"token\":\"$INVITE_TOKEN\",\"newPassword\":\"un-autre-mot-de-passe-long\"}")
[ "$code" = "400" ] || fail "rejeu du jeton : attendu 400, reçu $code"
pass "rejouer le jeton directement sur l'API → 400"

JAR="$WORK/replay2.jar"
code=$(signin "$INVITEE" "un-autre-mot-de-passe-long")
[ "$code" != "200" ] || fail "le mot de passe du rejeu a été accepté"
pass "le mot de passe du rejeu ne vaut rien (HTTP $code)"

# ─── 7. Réinitialisation, et le sort des sessions ─────────────────────────────
step "7. La réinitialisation coupe les sessions en cours"

CLIENT_IP="$IP_ALICE"
JAR_A="$WORK/a.jar"; JAR="$JAR_A"
code=$(signin "$INVITEE" "$CHOSEN_PASSWORD"); [ "$code" = "200" ] || fail "session A → HTTP $code"
JAR_B="$WORK/b.jar"; JAR="$JAR_B"
code=$(signin "$INVITEE" "$CHOSEN_PASSWORD"); [ "$code" = "200" ] || fail "session B → HTTP $code"
JAR="$JAR_A"; [ "$(session_email)" = "$INVITEE" ] || fail "session A invalide"
JAR="$JAR_B"; [ "$(session_email)" = "$INVITEE" ] || fail "session B invalide"
open_sessions=$(psql_q "select count(*) from sessions where user_id = '$ALICE_ID';")
pass "deux sessions ouvertes pour Alice ($open_sessions en base)"

mailpit_reset
JAR="$WORK/anon.jar"; CLIENT_IP="$IP_ALICE"
code=$(req POST /api/auth/request-password-reset \
  "{\"email\":\"$INVITEE\",\"redirectTo\":\"/reset-password\"}")
[ "$code" = "200" ] || fail "demande de réinitialisation → HTTP $code : $(cat "$BODY")"
pass "POST /api/auth/request-password-reset → 200 (public, sans session)"

MID=$(mailpit_wait_for "$INVITEE") || fail "aucun e-mail de réinitialisation"
MAIL=$(curl -s "$MAILPIT_HTTP/api/v1/message/$MID")
SUBJECT=$(jq -r '.Subject' <<< "$MAIL")
grep -qiE 'initialiser|reset your password' <<< "$SUBJECT" \
  || fail "le sujet n'est pas celui d'une réinitialisation : « $SUBJECT »"
grep -qiE 'administrateur vous a ouvert|opened an access' <<< "$(mail_text "$MID")" \
  && fail "un compte actif a reçu le texte d'une INVITATION"
pass "le message est bien celui d'une réinitialisation : « $SUBJECT »"
info "le texte est choisi côté serveur, à partir de l'état du compte — pas d'un paramètre d'URL"

RESET_TEXT=$(mail_text "$MID")
grep -qE '<[a-zA-Z/!]' <<< "$RESET_TEXT" && fail "la partie texte contient du HTML"
[ -n "$(jq -r '.HTML' <<< "$MAIL")" ] || fail "pas de partie HTML"
pass "deux parties, texte sans balise"

HOURS=$(psql_q "select round(extract(epoch from (expires_at - now()))/3600) from verifications where value = '$ALICE_ID';")
[ "$HOURS" = "1" ] || fail "échéance d'une réinitialisation : attendu ~1 h, trouvé ${HOURS} h"
pass "le lien de réinitialisation vaut 1 h, pas 72 — deux situations, deux durées"

RESET_LINK=$(grep -oE 'https?://[^ ]*reset-password/[A-Za-z0-9_-]+[^ ]*' <<< "$RESET_TEXT" | head -1)
RESET_TOKEN=$(sed -E 's#.*/reset-password/([A-Za-z0-9_-]+).*#\1#' <<< "$RESET_LINK")
REDIRECT=$(curl -s -o /dev/null -w '%{redirect_url}' -H "x-forwarded-for: $IP_ALICE" "$RESET_LINK")
grep -q '/reset-password?token=' <<< "$REDIRECT" \
  || fail "le lien de réinitialisation n'atterrit pas sur /reset-password : $REDIRECT"
pass "le lien atterrit sur /reset-password"

JAR="$WORK/anon2.jar"
code=$(req POST /api/auth/reset-password \
  "{\"token\":\"$RESET_TOKEN\",\"newPassword\":\"$RESET_PASSWORD_VALUE\"}")
[ "$code" = "200" ] || fail "réinitialisation → HTTP $code : $(cat "$BODY")"
pass "nouveau mot de passe enregistré"

JAR="$JAR_A"; a_left="$(session_email)"
JAR="$JAR_B"; b_left="$(session_email)"
[ -z "$a_left" ] || fail "la session A survit à la réinitialisation (« $a_left »)"
[ -z "$b_left" ] || fail "la session B survit à la réinitialisation (« $b_left »)"
left=$(psql_q "select count(*) from sessions where user_id = '$ALICE_ID';")
[ "$left" = "0" ] || fail "$left session(s) subsistent en base"
pass "les DEUX sessions sont mortes, et la table « sessions » est vide pour ce compte"

JAR="$WORK/old.jar"; code=$(signin "$INVITEE" "$CHOSEN_PASSWORD")
[ "$code" = "401" ] || fail "l'ancien mot de passe répond HTTP $code au lieu de 401"
JAR="$WORK/new.jar"; code=$(signin "$INVITEE" "$RESET_PASSWORD_VALUE")
[ "$code" = "200" ] || fail "le nouveau mot de passe répond HTTP $code au lieu de 200"
pass "l'ancien mot de passe est mort (401), le nouveau vit (200)"

# ─── 8. Un lien expiré ────────────────────────────────────────────────────────
step "8. Un lien expiré est refusé"

mailpit_reset
JAR="$WORK/anon3.jar"; CLIENT_IP="$IP_EXPIRY"
code=$(req POST /api/auth/request-password-reset "{\"email\":\"$INVITEE\"}")
[ "$code" = "200" ] || fail "demande → HTTP $code"
MID=$(mailpit_wait_for "$INVITEE") || fail "aucun e-mail"
EXPIRED_LINK=$(mail_text "$MID" | grep -oE 'https?://[^ ]*reset-password/[A-Za-z0-9_-]+[^ ]*' | head -1)
EXPIRED_TOKEN=$(sed -E 's#.*/reset-password/([A-Za-z0-9_-]+).*#\1#' <<< "$EXPIRED_LINK")

# On fait vieillir la ligne, plutôt que d'attendre une heure. C'est le seul
# raccourci du script, et il ne porte que sur l'horloge.
psql_q "update verifications set expires_at = now() - interval '1 minute' where identifier = 'reset-password:$EXPIRED_TOKEN';" >/dev/null
pass "le jeton est vieilli d'une heure et une minute en base"

REDIRECT=$(curl -s -o /dev/null -w '%{redirect_url}' -H "x-forwarded-for: $IP_EXPIRY" "$EXPIRED_LINK")
grep -q 'error=INVALID_TOKEN' <<< "$REDIRECT" \
  || fail "un lien expiré ne mène pas à une erreur : $REDIRECT"
pass "ouvrir un lien expiré → ?error=INVALID_TOKEN, avant toute saisie"

JAR="$WORK/anon4.jar"
code=$(req POST /api/auth/reset-password \
  "{\"token\":\"$EXPIRED_TOKEN\",\"newPassword\":\"mot-de-passe-vole-tardif\"}")
[ "$code" = "400" ] || fail "jeton expiré sur l'API : attendu 400, reçu $code"
pass "forcer l'API avec un jeton expiré → 400"

JAR="$WORK/anon5.jar"; code=$(signin "$INVITEE" "mot-de-passe-vole-tardif")
[ "$code" != "200" ] || fail "le mot de passe posé par un jeton expiré fonctionne"
pass "le mot de passe du jeton expiré ne vaut rien (HTTP $code)"

# ─── 9. Énumération de comptes ────────────────────────────────────────────────
step "9. Une adresse inconnue ne se distingue pas d'une adresse connue"

mailpit_reset
JAR="$WORK/enum1.jar"; CLIENT_IP="$IP_ENUM"
t0=$(date +%s%N)
code_known=$(req POST /api/auth/request-password-reset "{\"email\":\"$INVITEE\"}")
t1=$(date +%s%N)
known_body=$(cat "$BODY")

JAR="$WORK/enum2.jar"
t2=$(date +%s%N)
code_unknown=$(req POST /api/auth/request-password-reset "{\"email\":\"$UNKNOWN_EMAIL\"}")
t3=$(date +%s%N)
unknown_body=$(cat "$BODY")

[ "$code_known" = "$code_unknown" ] \
  || fail "codes différents : connue → $code_known, inconnue → $code_unknown"
[ "$code_known" = "200" ] || fail "attendu 200 des deux côtés, reçu $code_known"
pass "même code HTTP des deux côtés : $code_known"

[ "$known_body" = "$unknown_body" ] \
  || fail "corps différents :\n    connue   : $known_body\n    inconnue : $unknown_body"
pass "corps de réponse identique au caractère près"
info "$known_body"

ms_known=$(( (t1 - t0) / 1000000 ))
ms_unknown=$(( (t3 - t2) / 1000000 ))
delta=$(( ms_known - ms_unknown )); [ $delta -lt 0 ] && delta=$(( -delta ))
[ $delta -lt 400 ] \
  || fail "écart de temps mesurable : connue ${ms_known} ms, inconnue ${ms_unknown} ms (Δ ${delta} ms)"
pass "temps de réponse comparables : ${ms_known} ms vs ${ms_unknown} ms (Δ ${delta} ms)"
info "c'est ce que garantit l'envoi en arrière-plan : la route n'attend pas le serveur SMTP"

MID=$(mailpit_wait_for "$INVITEE") || fail "l'adresse connue n'a rien reçu"
count=$(curl -s "$MAILPIT_HTTP/api/v1/messages?limit=50" \
  | jq -r --arg to "$UNKNOWN_EMAIL" '[.messages[] | select(any(.To[]; .Address == $to))] | length')
[ "$count" = "0" ] || fail "un e-mail est parti vers une adresse inconnue"
pass "l'adresse connue reçoit, l'inconnue ne reçoit rien — et l'appelant ne peut pas le savoir"

# ─── 10. Limitation de débit ──────────────────────────────────────────────────
step "10. La limitation de débit mord"

CLIENT_IP="$IP_THROTTLE"
throttled=""
for attempt in 1 2 3 4 5; do
  JAR="$WORK/throttle-$attempt.jar"
  code=$(req POST /api/auth/request-password-reset "{\"email\":\"$INVITEE\"}")
  info "tentative $attempt → HTTP $code"
  if [ "$code" = "429" ]; then throttled="$attempt"; break; fi
done
[ -n "$throttled" ] || fail "cinq demandes de suite sans jamais être limité"
[ "$throttled" -le 4 ] || fail "la limite ne mord qu'à la tentative $throttled"
pass "la ${throttled}ᵉ demande depuis la même IP → 429 (règle : 3 par 60 s)"

retry=$(jq -r '.message // empty' "$BODY")
[ -n "$retry" ] && info "réponse : $retry"

JAR="$WORK/other-ip.jar"; CLIENT_IP="$IP_EXPIRY"
code=$(req POST /api/auth/request-password-reset "{\"email\":\"$INVITEE\"}")
[ "$code" != "429" ] || fail "une autre IP est limitée par le compteur de la première"
pass "une autre IP n'est pas affectée → HTTP $code : le compteur est par (IP, chemin)"

# ─── 11. Relancer, annuler ────────────────────────────────────────────────────
step "11. Relancer tue le lien précédent ; annuler tue le lien sans le compte"

mailpit_reset
JAR="$ADMIN_JAR"; CLIENT_IP="$IP_ADMIN"
code=$(req POST /api/admin/users "{\"name\":\"Bob\",\"email\":\"$INVITEE2\",\"role\":\"viewer\"}")
[ "$code" = "201" ] || fail "invitation de Bob → HTTP $code : $(cat "$BODY")"
BOB_ID=$(jq -r '.id' "$BODY")
MID=$(mailpit_wait_for "$INVITEE2") || fail "aucun e-mail pour Bob"
LINK1=$(mail_text "$MID" | grep -oE 'https?://[^ ]*reset-password/[A-Za-z0-9_-]+[^ ]*' | head -1)
TOKEN1=$(sed -E 's#.*/reset-password/([A-Za-z0-9_-]+).*#\1#' <<< "$LINK1")
pass "Bob invité, premier lien capturé"

mailpit_reset
code=$(req POST "/api/admin/users/$BOB_ID/invitation")
[ "$code" = "200" ] || fail "relance → HTTP $code : $(cat "$BODY")"
jq -e '.revokedLinks >= 1' "$BODY" >/dev/null \
  || fail "la relance n'annonce pas avoir tué le lien précédent : $(cat "$BODY")"
jq -e '.invitation.sent == true' "$BODY" >/dev/null || fail "la relance n'a rien envoyé"
pass "relance → $(jq -r '.revokedLinks' "$BODY") lien(s) révoqué(s), nouvel e-mail parti"

JAR="$WORK/bob1.jar"; CLIENT_IP="$IP_ALICE"
code=$(req POST /api/auth/reset-password \
  "{\"token\":\"$TOKEN1\",\"newPassword\":\"bob-mot-de-passe-tres-long\"}")
[ "$code" = "400" ] || fail "le PREMIER lien fonctionne encore après relance (HTTP $code)"
pass "le premier lien est mort : deux invitations vivantes, ça n'existe pas"

MID=$(mailpit_wait_for "$INVITEE2") || fail "aucun second e-mail pour Bob"
LINK2=$(mail_text "$MID" | grep -oE 'https?://[^ ]*reset-password/[A-Za-z0-9_-]+[^ ]*' | head -1)
TOKEN2=$(sed -E 's#.*/reset-password/([A-Za-z0-9_-]+).*#\1#' <<< "$LINK2")
[ "$TOKEN1" != "$TOKEN2" ] || fail "la relance a renvoyé le même jeton"
pass "le second lien porte un jeton différent"

JAR="$ADMIN_JAR"; CLIENT_IP="$IP_ADMIN"
code=$(req DELETE "/api/admin/users/$BOB_ID/invitation")
[ "$code" = "200" ] || fail "annulation → HTTP $code : $(cat "$BODY")"
pass "annulation → $(jq -r '.revokedLinks' "$BODY") lien(s) révoqué(s)"

JAR="$WORK/bob2.jar"; CLIENT_IP="$IP_ALICE"
code=$(req POST /api/auth/reset-password \
  "{\"token\":\"$TOKEN2\",\"newPassword\":\"bob-mot-de-passe-tres-long\"}")
[ "$code" = "400" ] || fail "le lien annulé fonctionne encore (HTTP $code)"
pass "le lien annulé ne vaut plus rien"

still=$(psql_q "select count(*) from users where id = '$BOB_ID';")
[ "$still" = "1" ] || fail "annuler l'invitation a supprimé le compte"
pass "le compte de Bob existe toujours : annuler un lien n'est pas supprimer quelqu'un"

JAR="$ADMIN_JAR"; CLIENT_IP="$IP_ADMIN"
code=$(req DELETE "/api/admin/users/$BOB_ID/invitation")
[ "$code" = "409" ] || fail "annuler deux fois : attendu 409, reçu $code"
pass "annuler un lien déjà annulé → 409, plutôt qu'un succès qui ne fait rien"

# — Supprimer le compte emporte ses liens —
code=$(req POST "/api/admin/users/$BOB_ID/invitation")
[ "$code" = "200" ] || fail "nouvelle invitation de Bob → HTTP $code"
alive=$(psql_q "select count(*) from verifications where value = '$BOB_ID' and identifier like 'reset-password:%';")
[ "$alive" = "1" ] || fail "attendu 1 lien vivant avant suppression, trouvé $alive"
code=$(req DELETE "/api/admin/users/$BOB_ID")
[ "$code" = "200" ] || fail "suppression de Bob → HTTP $code : $(cat "$BODY")"
jq -e '.revokedLinks >= 1' "$BODY" >/dev/null \
  || fail "la suppression n'annonce pas avoir tué les liens : $(cat "$BODY")"
orphans=$(psql_q "select count(*) from verifications where value = '$BOB_ID';")
[ "$orphans" = "0" ] || fail "$orphans ligne(s) de jeton survivent au compte supprimé"
pass "supprimer le compte emporte ses liens : aucune ligne orpheline dans « verifications »"
info "la table n'a aucune clé étrangère vers users — sans ce geste, le lien vivrait 3 jours de plus"

code=$(req GET /api/admin/users)
[ "$code" = "200" ] || fail "GET /api/admin/users → HTTP $code"
alice_state=$(jq -r --arg e "$INVITEE" '.items[] | select(.email == $e) | .state' "$BODY")
[ "$alice_state" = "active" ] || fail "Alice devrait être « active », elle est « $alice_state »"
jq -e --arg e "$INVITEE2" '[.items[] | select(.email == $e)] | length == 0' "$BODY" >/dev/null \
  || fail "Bob apparaît encore dans la liste après suppression"
pass "la liste montre l'état réel : Alice « active », Bob n'y est plus"
jq -e --arg e "$INVITEE" '.items[] | select(.email == $e) | .emailVerified == true' "$BODY" >/dev/null \
  || fail "Alice n'est pas marquée comme adresse vérifiée"
pass "Alice est marquée « adresse vérifiée » — elle a cliqué sur un lien envoyé à cette adresse"

# ─── 12. Traçabilité ──────────────────────────────────────────────────────────
step "12. L'audit trace, et ne porte aucun jeton"

JAR="$ADMIN_JAR"; CLIENT_IP="$IP_ADMIN"
for action in user.invited user.invitation.resent user.invitation.revoked \
              account.mail.sent auth.password_reset.requested auth.password_reset.completed; do
  code=$(req GET "/api/audit-logs?action=$action&pageSize=20")
  [ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
  jq -e '.items | length > 0' "$BODY" >/dev/null || fail "action « $action » absente du journal"
  pass "audit : $action"
done

code=$(req GET "/api/audit-logs?action=user.created.by_admin&pageSize=20")
jq -e --arg e "$INVITEE" '[.items[] | select(.after.email == $e and .after.method == "invitation")] | length > 0' \
  "$BODY" >/dev/null || fail "la création par invitation n'est pas distinguée dans l'audit"
pass "audit : la création par invitation est distinguée (method=invitation)"

for token in "$INVITE_TOKEN" "$RESET_TOKEN" "$EXPIRED_TOKEN" "$TOKEN1" "$TOKEN2"; do
  hits=$(psql_q "select count(*) from audit_logs
    where coalesce(before::text, '') || coalesce(after::text, '') || coalesce(resource_id, '')
          like '%$token%';")
  [ "$hits" = "0" ] || fail "un jeton apparaît dans $hits ligne(s) d'audit"
done
pass "aucun des 5 jetons n'apparaît dans audit_logs"

for token in "$INVITE_TOKEN" "$RESET_TOKEN" "$TOKEN1" "$TOKEN2"; do
  hits=$(docker compose logs panel --no-color 2>/dev/null | grep -c -- "$token" || true)
  [ "$hits" = "0" ] || fail "un jeton apparaît $hits fois dans les logs du panel"
  hits=$(docker compose logs worker --no-color 2>/dev/null | grep -c -- "$token" || true)
  [ "$hits" = "0" ] || fail "un jeton apparaît $hits fois dans les logs du worker"
done
pass "aucun jeton dans « docker compose logs panel », ni dans ceux du worker"

for secret in "$CHOSEN_PASSWORD" "$RESET_PASSWORD_VALUE" "$SMTP_PASSWORD"; do
  hits=$(docker compose logs panel worker --no-color 2>/dev/null | grep -c -- "$secret" || true)
  [ "$hits" = "0" ] || fail "un mot de passe apparaît $hits fois dans les logs"
done
pass "aucun mot de passe, ni le mot de passe SMTP, dans les logs"

# La charge de la tâche BullMQ traverse Redis : le lien doit y être chiffré.
redis_hits=$(docker compose exec -T redis redis-cli --scan --pattern 'bull:notifications:*' 2>/dev/null \
  | head -200 | while read -r key; do
      docker compose exec -T redis redis-cli --no-raw dump "$key" 2>/dev/null || true
    done | grep -c -- "$TOKEN2" || true)
[ "${redis_hits:-0}" = "0" ] || fail "un jeton est lisible en clair dans Redis ($redis_hits occurrence(s))"
pass "aucun jeton lisible en clair dans les clés BullMQ de Redis (la charge est chiffrée)"

# ─── 13. L'administrateur reste utilisable ────────────────────────────────────
step "13. Rien n'a bougé pour l'administrateur"

JAR="$WORK/admin-check.jar"; CLIENT_IP="$IP_ADMIN"
code=$(signin "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
[ "$code" = "200" ] || fail "l'administrateur ne peut plus se connecter (HTTP $code)"
jq -e '.twoFactorRedirect // false | not' "$BODY" >/dev/null \
  || fail "un second facteur a été armé sur l'administrateur"
[ "$(jq -r '.user.role // empty' "$BODY")" = "admin" ] || fail "l'administrateur a perdu son rôle"
pass "$ADMIN_EMAIL se connecte toujours, sans second facteur, toujours admin"

printf '\n\033[32m✓ Cycle de vie des comptes vérifié.\033[0m\n'
printf '\033[2m  Écrans : %s/admin/users · %s/forgot-password · %s/invitation\033[0m\n' \
  "$BASE_URL" "$BASE_URL" "$BASE_URL"
printf '\033[2m  Serveur SMTP jetable : docker compose --profile test up -d mailpit (http://localhost:8025)\033[0m\n'
printf '\033[2m  Les comptes et le canal de vérification ont été supprimés.\033[0m\n\n'
