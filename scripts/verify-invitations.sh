#!/usr/bin/env bash
#
# Checks the accounts' life cycle — inviting, resetting, expiring:
#
#    1. without an SMTP channel, no journey is offered: the "forgotten password"
#       link is not in the HTML, the screen says so, and the API refuses (409)
#    2. inviting requires `user:manage` — a viewer gets a 403, traced
#    3. the invitation really goes out, as text AND HTML, and the text part
#       contains not a single tag
#    4. the invited account has NO password in the database as long as it has
#       not clicked: nothing to hand over from hand to hand, nothing to steal
#    5. the link works once, and only once
#    6. a reset succeeds and cuts ALL the current sessions
#    7. an expired link is refused, and it says so before anything is typed
#    8. an unknown address is indistinguishable from a known address — same
#       code, same response body, and no e-mail
#    9. Better Auth's rate limiting really bites (3 / 60 s / IP)
#   10. resending an invitation kills the previous link; cancelling it kills
#       the link without deleting the account
#   11. no token anywhere: neither in `audit_logs`, nor in the panel's logs,
#       nor in the worker's
#
# What the script sets up, and takes down at the end:
#   — two verification accounts, deleted by the `trap`;
#   — an SMTP channel named `verif-invit-smtp`, pointed at Mailpit, deleted
#     likewise. No other channel is touched.
#   — Mailpit, a real throwaway SMTP server, under the "test" compose profile:
#         docker compose --profile test up -d mailpit
#     Web interface: http://localhost:8025
#
# Nothing is simulated: the message goes out over SMTP to a real server, and it
# is in its mailbox that the script reads back the link it then clicks.
#
# Each phase uses its OWN IP address (`x-forwarded-for` header). It is not
# decoration: Better Auth's rate limiting counts per (IP, path), and without it
# phase 9 would make the following ones fail.
#
# Usage:
#   ./scripts/verify-invitations.sh
#   BASE_URL=http://localhost:3200 ./scripts/verify-invitations.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
MAILPIT_HTTP="${MAILPIT_HTTP:-http://127.0.0.1:8025}"

# Everything carrying this prefix is ours, and ours alone.
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

# One IP per phase. See the file's header.
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

command -v jq >/dev/null || { echo "jq is required"; exit 1; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
skip() { printf '  \033[33m—\033[0m %s\n' "$1"; }
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

user_id_of() { psql_q "select id from users where email = '$1';"; }

# ─── Cleanup, at the start as at the end ──────────────────────────────────────
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

mailpit_reset() { curl -s -X DELETE "$MAILPIT_HTTP/api/v1/messages" >/dev/null; }

# The text part of a message, stripped of SMTP's CRs. Without this `tr`, a link
# extracted by `grep` drags a `\r` and no longer compares to anything.
mail_text() { curl -s "$MAILPIT_HTTP/api/v1/message/$1" | jq -r '.Text' | tr -d '\r'; }
mail_html() { curl -s "$MAILPIT_HTTP/api/v1/message/$1" | jq -r '.HTML' | tr -d '\r'; }

# Waits for a message addressed to $1 to arrive, and returns its Mailpit identifier.
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
[ "$code" = "200" ] || fail "admin sign-in failed (HTTP $code): $(cat "$BODY")"
[ "$(jq -r '.user.role // empty' "$BODY")" = "admin" ] \
  || fail "\"$ADMIN_EMAIL\" is not an administrator"
pass "signed in as $ADMIN_EMAIL"

JAR="$ADMIN_JAR"
for email in "$INVITEE" "$INVITEE2" "$VIEWER_EMAIL"; do
  id=$(user_id_of "$email")
  [ -n "$id" ] && { req DELETE "/api/admin/users/$id" >/dev/null; info "leftover account \"$email\" deleted"; }
done
cid=$(psql_q "select id from notification_channels where name = '$CHANNEL_NAME';")
[ -n "$cid" ] && { req DELETE "/api/notifications/channels/$cid" >/dev/null; info "leftover channel deleted"; }

docker compose --profile test up -d mailpit >/dev/null 2>&1 \
  || fail "could not start Mailpit (compose profile \"test\")"
for _ in $(seq 1 30); do
  curl -sf "$MAILPIT_HTTP/api/v1/messages" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "$MAILPIT_HTTP/api/v1/messages" >/dev/null || fail "Mailpit does not answer on $MAILPIT_HTTP"
mailpit_reset
pass "Mailpit started (SMTP mailpit:1025, interface $MAILPIT_HTTP), mailbox emptied"

# ─── 2. The default instance: no e-mail channel ───────────────────────────────
step "2. Without an SMTP channel, the journey is not offered"

FOREIGN_SMTP=$(psql_q "select count(*) from notification_channels where kind = 'smtp' and enabled;")
if [ "$FOREIGN_SMTP" != "0" ]; then
  skip "a foreign SMTP channel is already active on this instance — phase skipped"
  skip "(the script never touches a channel it did not create)"
else
  html=$(curl -s -H "x-forwarded-for: $IP_ADMIN" "$BASE_URL/login")
  grep -qE 'Mot de passe oubli|Forgotten password' <<< "$html" \
    && fail "the \"Forgotten password\" link is offered although no e-mail can go out"
  pass "the sign-in screen does not offer \"Forgotten password\""

  html=$(curl -s -H "x-forwarded-for: $IP_ADMIN" "$BASE_URL/forgot-password")
  grep -qE 'Réinitialisation indisponible|Reset unavailable' <<< "$html" \
    || fail "/forgot-password does not announce that the reset is unavailable"
  grep -q 'name="email"' <<< "$html" \
    && fail "/forgot-password displays a form that would lead nowhere"
  pass "/forgot-password explains the unavailability instead of accepting an address"

  JAR="$ADMIN_JAR"; CLIENT_IP="$IP_ADMIN"
  code=$(req POST /api/admin/users \
    "{\"name\":\"Alice\",\"email\":\"$INVITEE\",\"role\":\"viewer\"}")
  [ "$code" = "409" ] || fail "invitation without SMTP: expected 409, got $code — $(cat "$BODY")"
  jq -e '.error.code == "mail_channel_missing"' "$BODY" >/dev/null \
    || fail "unexpected error code: $(jq -c .error "$BODY")"
  pass "POST /api/admin/users without a password → 409 mail_channel_missing"

  left=$(psql_q "select count(*) from users where email = '$INVITEE';")
  [ "$left" = "0" ] || fail "an account was created although the invitation could not go out"
  pass "no orphan account created — the capability is checked BEFORE"
fi

# ─── 3. The SMTP channel ──────────────────────────────────────────────────────
step "3. Configuring the e-mail channel"

JAR="$ADMIN_JAR"; CLIENT_IP="$IP_ADMIN"
code=$(req POST /api/notifications/channels \
  "{\"kind\":\"smtp\",\"name\":\"$CHANNEL_NAME\",
    \"config\":{\"host\":\"mailpit\",\"port\":1025,\"security\":\"none\",\"user\":\"panel\",
      \"from\":\"Pupitre <panel@example.test>\",
      \"to\":\"ops@example.test\",\"rejectUnauthorized\":false},
    \"secrets\":{\"password\":\"$SMTP_PASSWORD\"},\"events\":[]}")
[ "$code" = "201" ] || fail "creating the SMTP channel → HTTP $code: $(cat "$BODY")"
CHANNEL_ID=$(jq -r '.id' "$BODY")
pass "channel \"$CHANNEL_NAME\" created ($CHANNEL_ID), subscribed to NO event"
info "so the invitation will borrow its transport, not its subscriptions"

html=$(curl -s -H "x-forwarded-for: $IP_ADMIN" "$BASE_URL/login")
grep -qE 'Mot de passe oubli|Forgotten password' <<< "$html" \
  || fail "the \"Forgotten password\" link stays hidden although a channel exists"
pass "the sign-in screen now offers \"Forgotten password\""

# ─── 4. RBAC ──────────────────────────────────────────────────────────────────
step "4. Inviting requires \"user:manage\""

JAR="$ADMIN_JAR"; CLIENT_IP="$IP_ADMIN"
code=$(req POST /api/admin/users \
  "{\"name\":\"Observateur\",\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\",\"role\":\"viewer\"}")
[ "$code" = "201" ] || fail "creating the viewer → HTTP $code: $(cat "$BODY")"
VIEWER_ID=$(jq -r '.id' "$BODY")
pass "test viewer created ($VIEWER_EMAIL)"

VIEWER_JAR="$WORK/viewer.jar"
JAR="$VIEWER_JAR"; CLIENT_IP="$IP_ADMIN"
code=$(signin "$VIEWER_EMAIL" "$VIEWER_PASSWORD")
[ "$code" = "200" ] || fail "viewer sign-in → HTTP $code"

code=$(req POST /api/admin/users "{\"name\":\"Mallory\",\"email\":\"mallory@example.test\",\"role\":\"admin\"}")
[ "$code" = "403" ] || fail "invitation by a viewer: expected 403, got $code"
jq -e '.error.details.permission == "user:manage"' "$BODY" >/dev/null \
  || fail "the refusal does not name the missing permission: $(jq -c .error "$BODY")"
pass "a viewer who invites → 403, permission \"user:manage\" named"

left=$(psql_q "select count(*) from users where email = 'mallory@example.test';")
[ "$left" = "0" ] || fail "the refused invitation created an account all the same"
pass "no account created by the refused attempt"

JAR="$ADMIN_JAR"; CLIENT_IP="$IP_ADMIN"
code=$(req GET "/api/audit-logs?action=permission.denied&pageSize=20")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
jq -e '[.items[] | select(.resourceId == "user:manage")] | length > 0' "$BODY" >/dev/null \
  || fail "the refusal does not appear in the activity log"
pass "audit: permission.denied on \"user:manage\""

# ─── 5. L'invitation part ─────────────────────────────────────────────────────
step "5. The invitation really goes out"

mailpit_reset
JAR="$ADMIN_JAR"; CLIENT_IP="$IP_ADMIN"
code=$(req POST /api/admin/users "{\"name\":\"Alice\",\"email\":\"$INVITEE\",\"role\":\"operator\"}")
[ "$code" = "201" ] || fail "invitation → HTTP $code: $(cat "$BODY")"
jq -e '.invitation.sent == true' "$BODY" >/dev/null \
  || fail "the route does not assert that the e-mail went out: $(jq -c .invitation "$BODY")"
ALICE_ID=$(jq -r '.id' "$BODY")
pass "POST /api/admin/users without a password → 201, invitation.sent=true"
info "channel borrowed: $(jq -r '.invitation.channel' "$BODY")"

grep -qi 'password' "$BODY" && fail "the response contains the word \"password\": $(cat "$BODY")"
pass "the response carries no password"

# — The account has NO password —
rows=$(psql_q "select count(*) from accounts where user_id = '$ALICE_ID' and provider_id = 'credential';")
[ "$rows" = "0" ] || fail "a \"credential\" account already exists: a password was made up"
pass "no accounts/credential row: the account literally has no password"

roles=$(psql_q "select r.key from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = '$ALICE_ID';")
[ "$roles" = "operator" ] || fail "expected role \"operator\", found \"$roles\""
pass "the requested role is set from the invitation on (operator)"

# — The token row is indeed Better Auth's —
TOK_ROWS=$(psql_q "select count(*) from verifications where value = '$ALICE_ID' and identifier like 'reset-password:%';")
[ "$TOK_ROWS" = "1" ] || fail "expected 1 token row in verifications, found $TOK_ROWS"
HOURS=$(psql_q "select round(extract(epoch from (expires_at - now()))/3600) from verifications where value = '$ALICE_ID';")
[ "$HOURS" = "72" ] || fail "invitation expiry: expected ~72 h, found ${HOURS} h"
pass "a single token, in Better Auth's \"verifications\" table, valid for 72 h"

# — The message —
MID=$(mailpit_wait_for "$INVITEE") || fail "no e-mail received for $INVITEE"
MAIL=$(curl -s "$MAILPIT_HTTP/api/v1/message/$MID")
SUBJECT=$(jq -r '.Subject' <<< "$MAIL")
TEXT=$(mail_text "$MID")
HTML=$(mail_html "$MID")
pass "e-mail received: \"$SUBJECT\""

[ "$(curl -s "$MAILPIT_HTTP/api/v1/messages" | jq -r '.total')" = "1" ] \
  || fail "more than one message went out for a single invitation"
[ "$(jq -r '.To | length' <<< "$MAIL")" = "1" ] \
  || fail "the message has several recipients: $(jq -c '.To' <<< "$MAIL")"
[ "$(jq -r '.To[0].Address' <<< "$MAIL")" = "$INVITEE" ] \
  || fail "unexpected recipient: $(jq -r '.To[0].Address' <<< "$MAIL")"
pass "a single message, a single recipient: the invitee, not the channel's \"ops@example.test\""

[ -n "$TEXT" ] || fail "the message has no text part"
[ -n "$HTML" ] || fail "the message has no HTML part"
pass "two parts: text/plain ($(wc -c <<< "$TEXT" | tr -d ' ') B) and text/html ($(wc -c <<< "$HTML" | tr -d ' ') B)"

grep -qE '<[a-zA-Z/!]' <<< "$TEXT" \
  && fail "the text part contains HTML: $(grep -oE '<[a-zA-Z/!][^>]*>' <<< "$TEXT" | head -3 | tr '\n' ' ')"
pass "the text part contains not a single tag"

grep -qE 'Choisir mon mot de passe|Choose my password' <<< "$TEXT" || fail "the text part does not announce the action"
grep -q '<a href=' <<< "$HTML" || fail "the HTML part has no link"
pass "both parts carry the action; the HTML has a real clickable link"

HEADERS=$(curl -s "$MAILPIT_HTTP/api/v1/message/$MID/headers")
[ "$(jq -r '."X-Control-Plane-Account-Mail"[0] // empty' <<< "$HEADERS")" = "invitation" ] \
  || fail "the service header does not say it is an invitation"
[ "$(jq -r '."Auto-Submitted"[0] // empty' <<< "$HEADERS")" = "auto-generated" ] \
  || fail "the Auto-Submitted header is missing: this message would trigger out-of-office replies"
pass "service headers: X-Control-Plane-Account-Mail=invitation, Auto-Submitted=auto-generated"

INVITE_LINK=$(grep -oE 'https?://[^ ]*reset-password/[A-Za-z0-9_-]+[^ ]*' <<< "$TEXT" | head -1)
[ -n "$INVITE_LINK" ] || fail "no link in the text part"
grep -qF "$INVITE_LINK" <<< "$HTML" || fail "the HTML's link differs from the text's"
INVITE_TOKEN=$(sed -E 's#.*/reset-password/([A-Za-z0-9_-]+).*#\1#' <<< "$INVITE_LINK")
[ ${#INVITE_TOKEN} -ge 16 ] || fail "suspicious token (${#INVITE_TOKEN} characters): $INVITE_TOKEN"
pass "identical link in both parts, token of ${#INVITE_TOKEN} characters"

# ─── 6. The link works once, and only once ────────────────────────────────────
step "6. The link works once, and only once"

CLIENT_IP="$IP_ALICE"
REDIRECT=$(curl -s -o /dev/null -w '%{redirect_url}' -H "x-forwarded-for: $CLIENT_IP" "$INVITE_LINK")
grep -q '/invitation?token=' <<< "$REDIRECT" \
  || fail "the link does not lead to the invitation screen: $REDIRECT"
pass "the link lands on /invitation (and not on /reset-password): the page takes it into account"
info "$(sed -E 's/token=[A-Za-z0-9_-]+/token=…/' <<< "$REDIRECT")"

ALICE_JAR="$WORK/alice.jar"
JAR="$ALICE_JAR"
code=$(req POST /api/auth/reset-password \
  "{\"token\":\"$INVITE_TOKEN\",\"newPassword\":\"$CHOSEN_PASSWORD\"}")
[ "$code" = "200" ] || fail "choosing the password → HTTP $code: $(cat "$BODY")"
pass "POST /api/auth/reset-password → 200, the password is set"

rows=$(psql_q "select count(*) from accounts where user_id = '$ALICE_ID' and provider_id = 'credential' and password is not null;")
[ "$rows" = "1" ] || fail "no credential row after choosing the password"
verified=$(psql_q "select email_verified from users where id = '$ALICE_ID';")
[ "$verified" = "t" ] || fail "users.email_verified stays false: the address proof is not recorded"
pass "account active, and \"email_verified\" set — clicking the link IS the address proof"

JAR="$ALICE_JAR"
code=$(signin "$INVITEE" "$CHOSEN_PASSWORD")
[ "$code" = "200" ] || fail "Alice's sign-in → HTTP $code: $(cat "$BODY")"
[ "$(session_email)" = "$INVITEE" ] || fail "no session after sign-in"
pass "Alice signs in with the password she chose"

# — The same link, a second time —
gone=$(psql_q "select count(*) from verifications where value = '$ALICE_ID' and identifier like 'reset-password:%';")
[ "$gone" = "0" ] || fail "the token survives its use ($gone row(s))"
pass "the token's row disappeared from \"verifications\": consumed, not marked"

REDIRECT=$(curl -s -o /dev/null -w '%{redirect_url}' -H "x-forwarded-for: $IP_ALICE" "$INVITE_LINK")
grep -q 'error=INVALID_TOKEN' <<< "$REDIRECT" \
  || fail "the already used link does not lead to an error: $REDIRECT"
pass "reopening the link → redirect to ?error=INVALID_TOKEN, before anything is typed"

JAR="$WORK/replay.jar"; CLIENT_IP="$IP_ALICE"
code=$(req POST /api/auth/reset-password \
  "{\"token\":\"$INVITE_TOKEN\",\"newPassword\":\"un-autre-mot-de-passe-long\"}")
[ "$code" = "400" ] || fail "token replay: expected 400, got $code"
pass "replaying the token directly on the API → 400"

JAR="$WORK/replay2.jar"
code=$(signin "$INVITEE" "un-autre-mot-de-passe-long")
[ "$code" != "200" ] || fail "the replay's password was accepted"
pass "the replay's password is worth nothing (HTTP $code)"

# ─── 7. Reset, and the fate of the sessions ───────────────────────────────────
step "7. The reset cuts the current sessions"

CLIENT_IP="$IP_ALICE"
JAR_A="$WORK/a.jar"; JAR="$JAR_A"
code=$(signin "$INVITEE" "$CHOSEN_PASSWORD"); [ "$code" = "200" ] || fail "session A → HTTP $code"
JAR_B="$WORK/b.jar"; JAR="$JAR_B"
code=$(signin "$INVITEE" "$CHOSEN_PASSWORD"); [ "$code" = "200" ] || fail "session B → HTTP $code"
JAR="$JAR_A"; [ "$(session_email)" = "$INVITEE" ] || fail "session A invalide"
JAR="$JAR_B"; [ "$(session_email)" = "$INVITEE" ] || fail "session B invalide"
open_sessions=$(psql_q "select count(*) from sessions where user_id = '$ALICE_ID';")
pass "two sessions open for Alice ($open_sessions in the database)"

mailpit_reset
JAR="$WORK/anon.jar"; CLIENT_IP="$IP_ALICE"
code=$(req POST /api/auth/request-password-reset \
  "{\"email\":\"$INVITEE\",\"redirectTo\":\"/reset-password\"}")
[ "$code" = "200" ] || fail "reset request → HTTP $code: $(cat "$BODY")"
pass "POST /api/auth/request-password-reset → 200 (public, without a session)"

MID=$(mailpit_wait_for "$INVITEE") || fail "no reset e-mail"
MAIL=$(curl -s "$MAILPIT_HTTP/api/v1/message/$MID")
SUBJECT=$(jq -r '.Subject' <<< "$MAIL")
grep -qiE 'initialiser|reset your password' <<< "$SUBJECT" \
  || fail "the subject is not a reset's: \"$SUBJECT\""
grep -qiE 'administrateur vous a ouvert|opened an access' <<< "$(mail_text "$MID")" \
  && fail "an active account received the text of an INVITATION"
pass "the message is indeed a reset's: \"$SUBJECT\""
info "the text is chosen on the server side, from the account's state — not from a URL parameter"

RESET_TEXT=$(mail_text "$MID")
grep -qE '<[a-zA-Z/!]' <<< "$RESET_TEXT" && fail "the text part contains HTML"
[ -n "$(jq -r '.HTML' <<< "$MAIL")" ] || fail "no HTML part"
pass "two parts, text without a tag"

HOURS=$(psql_q "select round(extract(epoch from (expires_at - now()))/3600) from verifications where value = '$ALICE_ID';")
[ "$HOURS" = "1" ] || fail "reset expiry: expected ~1 h, found ${HOURS} h"
pass "the reset link is valid for 1 h, not 72 — two situations, two durations"

RESET_LINK=$(grep -oE 'https?://[^ ]*reset-password/[A-Za-z0-9_-]+[^ ]*' <<< "$RESET_TEXT" | head -1)
RESET_TOKEN=$(sed -E 's#.*/reset-password/([A-Za-z0-9_-]+).*#\1#' <<< "$RESET_LINK")
REDIRECT=$(curl -s -o /dev/null -w '%{redirect_url}' -H "x-forwarded-for: $IP_ALICE" "$RESET_LINK")
grep -q '/reset-password?token=' <<< "$REDIRECT" \
  || fail "the reset link does not land on /reset-password: $REDIRECT"
pass "the link lands on /reset-password"

JAR="$WORK/anon2.jar"
code=$(req POST /api/auth/reset-password \
  "{\"token\":\"$RESET_TOKEN\",\"newPassword\":\"$RESET_PASSWORD_VALUE\"}")
[ "$code" = "200" ] || fail "reset → HTTP $code: $(cat "$BODY")"
pass "new password saved"

JAR="$JAR_A"; a_left="$(session_email)"
JAR="$JAR_B"; b_left="$(session_email)"
[ -z "$a_left" ] || fail "session A survives the reset (\"$a_left\")"
[ -z "$b_left" ] || fail "session B survives the reset (\"$b_left\")"
left=$(psql_q "select count(*) from sessions where user_id = '$ALICE_ID';")
[ "$left" = "0" ] || fail "$left session(s) remain in the database"
pass "BOTH sessions are dead, and the \"sessions\" table is empty for this account"

JAR="$WORK/old.jar"; code=$(signin "$INVITEE" "$CHOSEN_PASSWORD")
[ "$code" = "401" ] || fail "the old password answers HTTP $code instead of 401"
JAR="$WORK/new.jar"; code=$(signin "$INVITEE" "$RESET_PASSWORD_VALUE")
[ "$code" = "200" ] || fail "the new password answers HTTP $code instead of 200"
pass "the old password is dead (401), the new one lives (200)"

# ─── 8. An expired link ───────────────────────────────────────────────────────
step "8. An expired link is refused"

mailpit_reset
JAR="$WORK/anon3.jar"; CLIENT_IP="$IP_EXPIRY"
code=$(req POST /api/auth/request-password-reset "{\"email\":\"$INVITEE\"}")
[ "$code" = "200" ] || fail "request → HTTP $code"
MID=$(mailpit_wait_for "$INVITEE") || fail "no e-mail"
EXPIRED_LINK=$(mail_text "$MID" | grep -oE 'https?://[^ ]*reset-password/[A-Za-z0-9_-]+[^ ]*' | head -1)
EXPIRED_TOKEN=$(sed -E 's#.*/reset-password/([A-Za-z0-9_-]+).*#\1#' <<< "$EXPIRED_LINK")

# The row is aged, rather than waiting an hour. It is the script's only
# shortcut, and it only bears on the clock.
psql_q "update verifications set expires_at = now() - interval '1 minute' where identifier = 'reset-password:$EXPIRED_TOKEN';" >/dev/null
pass "the token is aged by one hour and one minute in the database"

REDIRECT=$(curl -s -o /dev/null -w '%{redirect_url}' -H "x-forwarded-for: $IP_EXPIRY" "$EXPIRED_LINK")
grep -q 'error=INVALID_TOKEN' <<< "$REDIRECT" \
  || fail "an expired link does not lead to an error: $REDIRECT"
pass "opening an expired link → ?error=INVALID_TOKEN, before anything is typed"

JAR="$WORK/anon4.jar"
code=$(req POST /api/auth/reset-password \
  "{\"token\":\"$EXPIRED_TOKEN\",\"newPassword\":\"mot-de-passe-vole-tardif\"}")
[ "$code" = "400" ] || fail "expired token on the API: expected 400, got $code"
pass "forcing the API with an expired token → 400"

JAR="$WORK/anon5.jar"; code=$(signin "$INVITEE" "mot-de-passe-vole-tardif")
[ "$code" != "200" ] || fail "the password set through an expired token works"
pass "the expired token's password is worth nothing (HTTP $code)"

# ─── 9. Account enumeration ───────────────────────────────────────────────────
step "9. An unknown address cannot be told apart from a known address"

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
  || fail "different codes: known → $code_known, unknown → $code_unknown"
[ "$code_known" = "200" ] || fail "expected 200 on both sides, got $code_known"
pass "same HTTP code on both sides: $code_known"

[ "$known_body" = "$unknown_body" ] \
  || fail "different bodies:\n    known   : $known_body\n    unknown: $unknown_body"
pass "response body identical down to the character"
info "$known_body"

ms_known=$(( (t1 - t0) / 1000000 ))
ms_unknown=$(( (t3 - t2) / 1000000 ))
delta=$(( ms_known - ms_unknown )); [ $delta -lt 0 ] && delta=$(( -delta ))
[ $delta -lt 400 ] \
  || fail "measurable time gap: known ${ms_known} ms, unknown ${ms_unknown} ms (Δ ${delta} ms)"
pass "comparable response times: ${ms_known} ms vs ${ms_unknown} ms (Δ ${delta} ms)"
info "it is what the background sending guarantees: the route does not wait for the SMTP server"

MID=$(mailpit_wait_for "$INVITEE") || fail "the known address received nothing"
count=$(curl -s "$MAILPIT_HTTP/api/v1/messages?limit=50" \
  | jq -r --arg to "$UNKNOWN_EMAIL" '[.messages[] | select(any(.To[]; .Address == $to))] | length')
[ "$count" = "0" ] || fail "an e-mail went out to an unknown address"
pass "the known address receives, the unknown one receives nothing — and the caller cannot know it"

# ─── 10. Rate limiting ────────────────────────────────────────────────────────
step "10. Rate limiting bites"

CLIENT_IP="$IP_THROTTLE"
throttled=""
for attempt in 1 2 3 4 5; do
  JAR="$WORK/throttle-$attempt.jar"
  code=$(req POST /api/auth/request-password-reset "{\"email\":\"$INVITEE\"}")
  info "tentative $attempt → HTTP $code"
  if [ "$code" = "429" ]; then throttled="$attempt"; break; fi
done
[ -n "$throttled" ] || fail "five requests in a row without ever being limited"
[ "$throttled" -le 4 ] || fail "the limit only bites at attempt $throttled"
pass "request #${throttled} from the same IP → 429 (rule: 3 per 60 s)"

retry=$(jq -r '.message // empty' "$BODY")
[ -n "$retry" ] && info "response: $retry"

JAR="$WORK/other-ip.jar"; CLIENT_IP="$IP_EXPIRY"
code=$(req POST /api/auth/request-password-reset "{\"email\":\"$INVITEE\"}")
[ "$code" != "429" ] || fail "another IP is limited by the first one's counter"
pass "another IP is not affected → HTTP $code: the counter is per (IP, path)"

# ─── 11. Resending, cancelling ────────────────────────────────────────────────
step "11. Resending kills the previous link; cancelling kills the link without the account"

mailpit_reset
JAR="$ADMIN_JAR"; CLIENT_IP="$IP_ADMIN"
code=$(req POST /api/admin/users "{\"name\":\"Bob\",\"email\":\"$INVITEE2\",\"role\":\"viewer\"}")
[ "$code" = "201" ] || fail "Bob's invitation → HTTP $code: $(cat "$BODY")"
BOB_ID=$(jq -r '.id' "$BODY")
MID=$(mailpit_wait_for "$INVITEE2") || fail "no e-mail for Bob"
LINK1=$(mail_text "$MID" | grep -oE 'https?://[^ ]*reset-password/[A-Za-z0-9_-]+[^ ]*' | head -1)
TOKEN1=$(sed -E 's#.*/reset-password/([A-Za-z0-9_-]+).*#\1#' <<< "$LINK1")
pass "Bob invited, first link captured"

mailpit_reset
code=$(req POST "/api/admin/users/$BOB_ID/invitation")
[ "$code" = "200" ] || fail "resend → HTTP $code: $(cat "$BODY")"
jq -e '.revokedLinks >= 1' "$BODY" >/dev/null \
  || fail "the resend does not announce having killed the previous link: $(cat "$BODY")"
jq -e '.invitation.sent == true' "$BODY" >/dev/null || fail "the resend sent nothing"
pass "resend → $(jq -r '.revokedLinks' "$BODY") link(s) revoked, new e-mail sent"

JAR="$WORK/bob1.jar"; CLIENT_IP="$IP_ALICE"
code=$(req POST /api/auth/reset-password \
  "{\"token\":\"$TOKEN1\",\"newPassword\":\"bob-mot-de-passe-tres-long\"}")
[ "$code" = "400" ] || fail "the FIRST link still works after the resend (HTTP $code)"
pass "the first link is dead: two live invitations do not exist"

MID=$(mailpit_wait_for "$INVITEE2") || fail "no second e-mail for Bob"
LINK2=$(mail_text "$MID" | grep -oE 'https?://[^ ]*reset-password/[A-Za-z0-9_-]+[^ ]*' | head -1)
TOKEN2=$(sed -E 's#.*/reset-password/([A-Za-z0-9_-]+).*#\1#' <<< "$LINK2")
[ "$TOKEN1" != "$TOKEN2" ] || fail "the resend sent the same token again"
pass "the second link carries a different token"

JAR="$ADMIN_JAR"; CLIENT_IP="$IP_ADMIN"
code=$(req DELETE "/api/admin/users/$BOB_ID/invitation")
[ "$code" = "200" ] || fail "annulation → HTTP $code: $(cat "$BODY")"
pass "cancellation → $(jq -r '.revokedLinks' "$BODY") link(s) revoked"

JAR="$WORK/bob2.jar"; CLIENT_IP="$IP_ALICE"
code=$(req POST /api/auth/reset-password \
  "{\"token\":\"$TOKEN2\",\"newPassword\":\"bob-mot-de-passe-tres-long\"}")
[ "$code" = "400" ] || fail "the cancelled link still works (HTTP $code)"
pass "the cancelled link is worth nothing any more"

still=$(psql_q "select count(*) from users where id = '$BOB_ID';")
[ "$still" = "1" ] || fail "cancelling the invitation deleted the account"
pass "Bob's account still exists: cancelling a link is not deleting someone"

JAR="$ADMIN_JAR"; CLIENT_IP="$IP_ADMIN"
code=$(req DELETE "/api/admin/users/$BOB_ID/invitation")
[ "$code" = "409" ] || fail "cancelling twice: expected 409, got $code"
pass "cancelling an already cancelled link → 409, rather than a success that does nothing"

# — Deleting the account takes its links away —
code=$(req POST "/api/admin/users/$BOB_ID/invitation")
[ "$code" = "200" ] || fail "Bob's new invitation → HTTP $code"
alive=$(psql_q "select count(*) from verifications where value = '$BOB_ID' and identifier like 'reset-password:%';")
[ "$alive" = "1" ] || fail "expected 1 live link before deletion, found $alive"
code=$(req DELETE "/api/admin/users/$BOB_ID")
[ "$code" = "200" ] || fail "deleting Bob → HTTP $code: $(cat "$BODY")"
jq -e '.revokedLinks >= 1' "$BODY" >/dev/null \
  || fail "the deletion does not announce having killed the links: $(cat "$BODY")"
orphans=$(psql_q "select count(*) from verifications where value = '$BOB_ID';")
[ "$orphans" = "0" ] || fail "$orphans token row(s) survive the deleted account"
pass "deleting the account takes its links away: no orphan row in \"verifications\""
info "the table has no foreign key to users — without this gesture, the link would live 3 more days"

code=$(req GET /api/admin/users)
[ "$code" = "200" ] || fail "GET /api/admin/users → HTTP $code"
alice_state=$(jq -r --arg e "$INVITEE" '.items[] | select(.email == $e) | .state' "$BODY")
[ "$alice_state" = "active" ] || fail "Alice should be \"active\", she is \"$alice_state\""
jq -e --arg e "$INVITEE2" '[.items[] | select(.email == $e)] | length == 0' "$BODY" >/dev/null \
  || fail "Bob still appears in the list after deletion"
pass "the list shows the real state: Alice \"active\", Bob is no longer there"
jq -e --arg e "$INVITEE" '.items[] | select(.email == $e) | .emailVerified == true' "$BODY" >/dev/null \
  || fail "Alice is not marked as a verified address"
pass "Alice is marked \"verified address\" — she clicked a link sent to that address"

# ─── 12. Traceability ─────────────────────────────────────────────────────────
step "12. The audit traces, and carries no token"

JAR="$ADMIN_JAR"; CLIENT_IP="$IP_ADMIN"
for action in user.invited user.invitation.resent user.invitation.revoked \
              account.mail.sent auth.password_reset.requested auth.password_reset.completed; do
  code=$(req GET "/api/audit-logs?action=$action&pageSize=20")
  [ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
  jq -e '.items | length > 0' "$BODY" >/dev/null || fail "action \"$action\" missing from the log"
  pass "audit: $action"
done

code=$(req GET "/api/audit-logs?action=user.created.by_admin&pageSize=20")
jq -e --arg e "$INVITEE" '[.items[] | select(.after.email == $e and .after.method == "invitation")] | length > 0' \
  "$BODY" >/dev/null || fail "the creation through invitation is not told apart in the audit"
pass "audit: the creation through invitation is told apart (method=invitation)"

for token in "$INVITE_TOKEN" "$RESET_TOKEN" "$EXPIRED_TOKEN" "$TOKEN1" "$TOKEN2"; do
  hits=$(psql_q "select count(*) from audit_logs
    where coalesce(before::text, '') || coalesce(after::text, '') || coalesce(resource_id, '')
          like '%$token%';")
  [ "$hits" = "0" ] || fail "a token appears in $hits audit row(s)"
done
pass "none of the 5 tokens appears in audit_logs"

for token in "$INVITE_TOKEN" "$RESET_TOKEN" "$TOKEN1" "$TOKEN2"; do
  hits=$(docker compose logs panel --no-color 2>/dev/null | grep -c -- "$token" || true)
  [ "$hits" = "0" ] || fail "a token appears $hits time(s) in the panel's logs"
  hits=$(docker compose logs worker --no-color 2>/dev/null | grep -c -- "$token" || true)
  [ "$hits" = "0" ] || fail "a token appears $hits time(s) in the worker's logs"
done
pass "no token in \"docker compose logs panel\", nor in the worker's"

for secret in "$CHOSEN_PASSWORD" "$RESET_PASSWORD_VALUE" "$SMTP_PASSWORD"; do
  hits=$(docker compose logs panel worker --no-color 2>/dev/null | grep -c -- "$secret" || true)
  [ "$hits" = "0" ] || fail "a password appears $hits time(s) in the logs"
done
pass "no password, nor the SMTP password, in the logs"

# The BullMQ job's payload goes through Redis: the link must be encrypted there.
redis_hits=$(docker compose exec -T redis redis-cli --scan --pattern 'bull:notifications:*' 2>/dev/null \
  | head -200 | while read -r key; do
      docker compose exec -T redis redis-cli --no-raw dump "$key" 2>/dev/null || true
    done | grep -c -- "$TOKEN2" || true)
[ "${redis_hits:-0}" = "0" ] || fail "a token is readable in clear in Redis ($redis_hits occurrence(s))"
pass "no token readable in clear in Redis's BullMQ keys (the payload is encrypted)"

# ─── 13. The administrator stays usable ───────────────────────────────────────
step "13. Nothing moved for the administrator"

JAR="$WORK/admin-check.jar"; CLIENT_IP="$IP_ADMIN"
code=$(signin "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
[ "$code" = "200" ] || fail "the administrator can no longer sign in (HTTP $code)"
jq -e '.twoFactorRedirect // false | not' "$BODY" >/dev/null \
  || fail "a second factor was armed on the administrator"
[ "$(jq -r '.user.role // empty' "$BODY")" = "admin" ] || fail "the administrator lost their role"
pass "$ADMIN_EMAIL still signs in, without a second factor, still admin"

printf '\n\033[32m✓ Accounts life cycle verified.\033[0m\n'
printf '\033[2m  Screens: %s/admin/users · %s/forgot-password · %s/invitation\033[0m\n' \
  "$BASE_URL" "$BASE_URL" "$BASE_URL"
printf '\033[2m  Throwaway SMTP server: docker compose --profile test up -d mailpit (http://localhost:8025)\033[0m\n'
printf '\033[2m  The verification accounts and channel were deleted.\033[0m\n\n'
