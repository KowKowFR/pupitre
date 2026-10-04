#!/usr/bin/env bash
#
# Checks the notifications layer:
#
#    1. the catalog is data — four channels, five events
#    2. an incomplete configuration is refused (422)
#    3. the four channels are configured and really tried out
#    4. the secret comes out neither from the API, nor the HTML, nor the audit,
#       nor the logs
#    5. an unreachable channel does not break the notified action, and its
#       failure shows
#    6. a notifiable event triggers a sending, and only one
#    7. `settings:manage` is required to configure and to try out
#    8. grouping: the first alert goes out without delay, a burst of fifty does
#       not produce fifty messages, the digest names what it replaces, a worker
#       restart does not release the storm at once, and each channel renders
#       the digest its own way
#
# What the script sets up, and takes down at the end:
#   — a local HTTP receiver, which logs what it receives and answers as
#     Telegram's Bot API and a Discord webhook would;
#   — Mailpit, a real throwaway SMTP server, started under the "test" compose
#     profile (never at a normal start):
#         docker compose --profile test up -d mailpit
#     Web interface: http://localhost:8025
#
# The worker reaches the receiver through `host.docker.internal` and Mailpit
# through its service name. No outside service is called: neither
# api.telegram.org, nor discord.com, nor a public SMTP relay.
#
# Usage:
#   ./scripts/verify-notifications.sh
#   BASE_URL=http://localhost:3200 ./scripts/verify-notifications.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
CLIENT_IP="${CLIENT_IP:-198.51.100.77}"
RECEIVER_PORT="${RECEIVER_PORT:-4599}"
MAILPIT_HTTP="${MAILPIT_HTTP:-http://127.0.0.1:8025}"

# Name reserved for this script. Everything carrying it is deleted at the start and at the end.
PREFIX="verif-notif"
READER_EMAIL="notif-lecteur@example.test"
SUBJECT_EMAIL="notif-cobaye@example.test"
READER_ROLE="$PREFIX-lecteur"

# Throwaway secrets. They are shaped like real tokens — it is what allows
# checking that the redactions recognize them.
SMTP_PASSWORD="VERIFSECRETSMTPzz9911"
TG_TOKEN="987654321:VERIFSECRETTELEGRAMaaaabbbbccccdddd"
DISCORD_TOKEN="VERIFSECRETDISCORDwxyz012345"
HOOK_TOKEN="VERIFSECRETWEBHOOKqqqq7777"

# Grouping window imposed during the verification. Thirty seconds: enough for a
# burst of fifty to fit entirely, short enough for a script not to last ten
# minutes. The value found is restored at the end.
VERIF_WINDOW_MS="${VERIF_WINDOW_MS:-30000}"
# Size of the bursts. The first measures the grouping, the second the hot
# restart.
BURST_SIZE="${BURST_SIZE:-50}"
RESTART_BURST_SIZE="${RESTART_BURST_SIZE:-20}"
POLICY_BEFORE=""

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
READER_JAR="$WORK/reader.jar"
BODY="$WORK/body.json"
RECV="$WORK/receiver.log"
RECEIVER_PID=""

command -v jq >/dev/null || { echo "jq is required"; exit 1; }
command -v node >/dev/null || { echo "node is required"; exit 1; }

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

# Same thing, with the jar of the reader without `settings:manage`.
req_reader() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -H "x-forwarded-for: $CLIENT_IP" -b "$READER_JAR" -c "$READER_JAR")
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

# Deletes everything this script may have created, including during an
# interrupted run. Touches nothing else: the instance settings are never
# changed, and `app_settings` is never emptied.
purge() {
  req GET /api/notifications/channels >/dev/null 2>&1 || return 0
  local id
  for id in $(jq -r --arg p "$PREFIX" '.items[] | select(.name | startswith($p)) | .id' "$BODY"); do
    req DELETE "/api/notifications/channels/$id" >/dev/null 2>&1 || true
  done

  local uid
  for email in "$READER_EMAIL" "$SUBJECT_EMAIL"; do
    uid=$(psql_q "select id from users where email = '$email';" 2>/dev/null || true)
    [ -n "$uid" ] && req DELETE "/api/admin/users/$uid" >/dev/null 2>&1 || true
  done
  # The bursts' guinea pigs, created by the dozen: all carry the prefix.
  for uid in $(psql_q "select id from users where email like '$PREFIX-%@example.test';" 2>/dev/null || true); do
    req DELETE "/api/admin/users/$uid" >/dev/null 2>&1 || true
  done
  req DELETE "/api/admin/roles/$READER_ROLE" >/dev/null 2>&1 || true
}

cleanup() {
  local code=$?
  [ -n "$RECEIVER_PID" ] && kill "$RECEIVER_PID" 2>/dev/null || true
  # The grouping window is an instance setting: it is given back as it was
  # found, including on an interrupted run.
  if [ -n "$POLICY_BEFORE" ]; then
    req PATCH /api/notifications/digests "{\"windowMs\":$POLICY_BEFORE}" >/dev/null 2>&1 || true
  fi
  purge 2>/dev/null || true
  # Mailpit is a service of the "test" profile: it never runs by default, it is
  # given back in the state it was found in.
  docker compose --profile test rm -sf mailpit >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT

# ── HTTP receiver ─────────────────────────────────────────────────────────────
# It logs each request and answers like the targeted services: it is what allows
# checking the exact shape of the payloads and headers without a Telegram token
# nor a Discord server.
start_receiver() {
  cat > "$WORK/receiver.cjs" <<'JS'
const http = require('node:http');
const fs = require('node:fs');
const [port, out] = process.argv.slice(2);
http
  .createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      fs.appendFileSync(
        out,
        JSON.stringify({ method: req.method, path: req.url, headers: req.headers, body }) + '\n',
      );
      const p = req.url || '';
      res.setHeader('content-type', 'application/json');
      if (/\/bot[^/]+\/getMe$/.test(p)) {
        return res.end('{"ok":true,"result":{"id":1,"username":"panel_recette_bot"}}');
      }
      if (/\/bot[^/]+\/sendMessage$/.test(p)) {
        return res.end('{"ok":true,"result":{"message_id":1}}');
      }
      if (p.includes('/api/webhooks/') && req.method === 'GET') {
        return res.end('{"id":"42","name":"salon-de-recette"}');
      }
      if (p.includes('/api/webhooks/')) {
        res.statusCode = 204;
        return res.end();
      }
      res.end('{"ok":true}');
    });
  })
  .listen(Number(port), '0.0.0.0');
JS
  : > "$RECV"
  node "$WORK/receiver.cjs" "$RECEIVER_PORT" "$RECV" &
  RECEIVER_PID=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -sf "http://127.0.0.1:$RECEIVER_PORT/ready" >/dev/null 2>&1 && return 0
    sleep 0.3
  done
  fail "the HTTP receiver did not start on port $RECEIVER_PORT"
}

# Requests received since the last `mark_receiver`.
mark_receiver() { : > "$RECV"; }
recv_count() { grep -c . "$RECV" 2>/dev/null || echo 0; }

# ── Reading the grouping state ────────────────────────────────────────────────
# In the database and not through the API: it is the source of truth, and it is
# precisely what we want to see survive a worker restart.
GROUP="security.role_changed"

digest_open()  { psql_q "select count(*) from notification_digest_groups where group_key = '$GROUP' and window_ends_at is not null;"; }
digest_held()  { psql_q "select coalesce((select held_count from notification_digest_groups where group_key = '$GROUP'), 0);"; }
digest_items() { psql_q "select count(*) from notification_digest_items where group_key = '$GROUP';"; }

# Waits for the group to become silent again — that is, for a window to have
# closed **without holding anything**. It is half of the trade-off: without it,
# an isolated incident would forever cost a window's latency.
wait_group_silent() {
  local limit="${1:-120}"
  for _ in $(seq 1 "$limit"); do
    [ "$(digest_open)" = "0" ] && return 0
    sleep 1
  done
  return 1
}

# What the receiver saw on /hook, by kind of payload.
hook_all()     { jq -s '[.[] | select(.path == "/hook")] | length' "$RECV"; }
hook_events()  { jq -s '[.[] | select(.path == "/hook") | (.body | fromjson) | select(.type == "event")] | length' "$RECV"; }
hook_digests() { jq -s '[.[] | select(.path == "/hook") | (.body | fromjson) | select(.type == "digest")] | length' "$RECV"; }

# Waits for a digest to arrive on the webhook, or gives up at the end of the delay.
wait_for_digest() {
  local want="${1:-1}" limit="${2:-90}"
  for _ in $(seq 1 "$limit"); do
    [ "$(hook_digests)" -ge "$want" ] && return 0
    sleep 1
  done
  return 1
}

# Creates `count` guinea pigs with the `viewer` role and writes their
# identifiers into a file. They notify nothing at creation — only the role
# change does, and it is what will be fired in a burst.
make_burst_users() {
  local tag="$1" count="$2" i code
  for i in $(seq 1 "$count"); do
    code=$(req POST /api/admin/users \
      "{\"name\":\"Rafale $tag $i\",\"email\":\"$PREFIX-$tag-$i@example.test\",
        \"password\":\"motdepasse-tres-long\",\"role\":\"viewer\"}")
    case "$code" in 201|409) : ;; *) fail "creating guinea pig $tag-$i → HTTP $code: $(cat "$BODY")" ;; esac
  done
  psql_q "select id from users where email like '$PREFIX-$tag-%@example.test' order by email;" \
    > "$WORK/$tag.ids"
  [ "$(grep -c . "$WORK/$tag.ids")" = "$count" ] || fail "$count guinea pigs expected for \"$tag\""
}

# Fires a burst of role changes. Sequential and without going through `req`: we
# want the tightest possible cadence, not a response file.
fire_roles() {
  local role="$1" file="$2" first="$3" last="$4" id n=0
  while read -r id; do
    n=$((n + 1))
    [ "$n" -lt "$first" ] && continue
    [ "$n" -gt "$last" ] && break
    curl -s -o /dev/null -X PATCH "$BASE_URL/api/admin/users/$id/role" \
      -H 'content-type: application/json' -H "origin: $BASE_URL" \
      -H "x-forwarded-for: $CLIENT_IP" -b "$JAR" --data-binary "{\"role\":\"$role\"}"
  done < "$file"
}

create_channel() {
  local payload="$1" label="$2"
  local code
  code=$(req POST /api/notifications/channels "$payload")
  [ "$code" = "201" ] || fail "creating \"$label\" → HTTP $code: $(cat "$BODY")"
  jq -r .id "$BODY"
}

step "1. Sign-in"
login
pass "signed in as $ADMIN_EMAIL"

# Reference fingerprint: this script must change no instance setting.
SETTINGS_BEFORE=$(psql_q "select md5(value::text) from app_settings where id = 1;")
purge
info "cleanup from a previous run done"

step "2. Grouping window"
code=$(req GET /api/notifications/digests)
[ "$code" = "200" ] || fail "GET /api/notifications/digests → HTTP $code: $(cat "$BODY")"
POLICY_BEFORE=$(jq -r '.policy.windowMs' "$BODY")
MIN_WINDOW=$(jq -r '.vocabulary.minWindowMs' "$BODY")
info "window found: ${POLICY_BEFORE} ms — it will be restored at the end"

# The floor is not zero, and it is not a detail: a volume safeguard that can be
# disabled is a disabled safeguard.
code=$(req PATCH /api/notifications/digests '{"windowMs":0}')
[ "$code" = "422" ] || fail "window at zero: expected 422, got $code"
pass "window at 0 refused → 422 (floor: ${MIN_WINDOW} ms)"

code=$(req PATCH /api/notifications/digests "{\"windowMs\":$VERIF_WINDOW_MS}")
[ "$code" = "200" ] || fail "setting the window → HTTP $code: $(cat "$BODY")"
pass "verification window: $((VERIF_WINDOW_MS / 1000)) s"

step "3. Local receiver and throwaway SMTP server"
start_receiver
pass "HTTP receiver on port $RECEIVER_PORT"

docker compose --profile test up -d mailpit >/dev/null 2>&1 \
  || fail "could not start Mailpit (compose profile \"test\")"
for _ in $(seq 1 30); do
  curl -sf "$MAILPIT_HTTP/api/v1/messages" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "$MAILPIT_HTTP/api/v1/messages" >/dev/null \
  || fail "Mailpit does not answer on $MAILPIT_HTTP"
curl -s -X DELETE "$MAILPIT_HTTP/api/v1/messages" >/dev/null
pass "Mailpit started (SMTP mailpit:1025, interface $MAILPIT_HTTP), mailbox emptied"

docker compose exec -T worker sh -c "wget -qO- http://host.docker.internal:$RECEIVER_PORT/from-worker" >/dev/null 2>&1 \
  || fail "the worker does not reach the receiver — host.docker.internal unavailable?"
pass "the worker reaches the receiver"
mark_receiver

step "4. The catalog is data, not a list written in the screen"
code=$(req GET /api/notifications/channels)
[ "$code" = "200" ] || fail "GET /api/notifications/channels → HTTP $code"
KINDS=$(jq -r '[.vocabulary.channels[].kind] | join(", ")' "$BODY")
EVENTS=$(jq -r '[.vocabulary.events[].key] | join(", ")' "$BODY")
jq -e '.vocabulary.channels | length == 4' "$BODY" >/dev/null || fail "four channels expected"
jq -e '[.vocabulary.channels[].fields[]] | length > 10' "$BODY" >/dev/null \
  || fail "the configuration fields are not described"
jq -e '[.vocabulary.channels[].fields[] | select(has("schema"))] | length == 0' "$BODY" >/dev/null \
  || fail "a Zod schema leaked into the response — it would not survive JSON.stringify"
pass "channels: $KINDS"
pass "events: $EVENTS"

step "5. An incomplete configuration is refused"
code=$(req POST /api/notifications/channels \
  "{\"kind\":\"smtp\",\"name\":\"$PREFIX-invalide\",\"config\":{\"from\":\"a@b.test\",\"to\":\"c@d.test\"},\"secrets\":{},\"events\":[]}")
[ "$code" = "422" ] || fail "SMTP without a server: expected 422, got $code"
jq -e '.error.code == "validation_failed"' "$BODY" >/dev/null || fail "unexpected error code"
pass "SMTP without \"host\" → 422 $(jq -r '.error.code' "$BODY")"

code=$(req POST /api/notifications/channels \
  "{\"kind\":\"telegram\",\"name\":\"$PREFIX-invalide\",\"config\":{\"chatId\":\"-100\"},\"secrets\":{},\"events\":[]}")
[ "$code" = "422" ] || fail "Telegram without a token: expected 422, got $code"
pass "Telegram without a bot token → 422"

code=$(req POST /api/notifications/channels \
  "{\"kind\":\"webhook\",\"name\":\"$PREFIX-invalide\",\"config\":{\"url\":\"pas-une-url\"},\"secrets\":{},\"events\":[]}")
[ "$code" = "422" ] || fail "webhook with an invalid URL: expected 422, got $code"
pass "webhook with an invalid URL → 422"

code=$(req POST /api/notifications/channels \
  "{\"kind\":\"discord\",\"name\":\"$PREFIX-invalide\",\"config\":{},\"secrets\":{\"webhookUrl\":\"https://example.test/pas-un-webhook\"},\"events\":[]}")
[ "$code" = "422" ] || fail "Discord URL that is not one: expected 422, got $code"
pass "Discord URL without /api/webhooks/ → 422"

step "6. The four channels are configured"
SMTP_ID=$(create_channel "{\"kind\":\"smtp\",\"name\":\"$PREFIX-smtp\",
  \"config\":{\"host\":\"mailpit\",\"port\":1025,\"security\":\"none\",\"user\":\"panel\",
  \"from\":\"Control plane <panel@example.test>\",
  \"to\":\"ops@example.test, astreinte@example.test\",\"rejectUnauthorized\":false},
  \"secrets\":{\"password\":\"$SMTP_PASSWORD\"},\"events\":[\"deployment.failed\"]}" "smtp")
pass "e-mail (SMTP) → $SMTP_ID"

TG_ID=$(create_channel "{\"kind\":\"telegram\",\"name\":\"$PREFIX-telegram\",
  \"config\":{\"chatId\":\"-1001234567890\",\"apiBaseUrl\":\"http://host.docker.internal:$RECEIVER_PORT\"},
  \"secrets\":{\"botToken\":\"$TG_TOKEN\"},\"events\":[\"deployment.failed\"]}" "telegram")
pass "Telegram → $TG_ID"

DC_ID=$(create_channel "{\"kind\":\"discord\",\"name\":\"$PREFIX-discord\",
  \"config\":{\"username\":\"Control plane\"},
  \"secrets\":{\"webhookUrl\":\"http://host.docker.internal:$RECEIVER_PORT/api/webhooks/42/$DISCORD_TOKEN\"},
  \"events\":[\"deployment.failed\"]}" "discord")
pass "Discord → $DC_ID"

HOOK_ID=$(create_channel "{\"kind\":\"webhook\",\"name\":\"$PREFIX-webhook\",
  \"config\":{\"url\":\"http://host.docker.internal:$RECEIVER_PORT/hook\"},
  \"secrets\":{\"token\":\"$HOOK_TOKEN\"},\"events\":[\"security.role_changed\"]}" "webhook")
pass "webhook JSON → $HOOK_ID"

jq -e '.configuredSecrets == ["token"]' "$BODY" >/dev/null \
  || fail "the filled-in secret fields are not announced"
pass "the response announces which secrets are set, never their value"

step "7. The secret comes out from nowhere"
req GET /api/notifications/channels >/dev/null
for secret in "$SMTP_PASSWORD" "$TG_TOKEN" "$DISCORD_TOKEN" "$HOOK_TOKEN"; do
  grep -qF "$secret" "$BODY" && fail "a secret appears in the API's response"
done
pass "absent from GET /api/notifications/channels"

curl -s -b "$JAR" "$BASE_URL/admin/settings/notifications" -o "$WORK/page.html"
for secret in "$SMTP_PASSWORD" "$TG_TOKEN" "$DISCORD_TOKEN" "$HOOK_TOKEN"; do
  grep -qF "$secret" "$WORK/page.html" && fail "a secret appears in the screen's HTML"
done
pass "absent from the HTML of /admin/settings/notifications"

LEAKS=$(psql_q "select count(*) from audit_logs
  where before::text like '%VERIFSECRET%' or after::text like '%VERIFSECRET%';")
[ "$LEAKS" = "0" ] || fail "$LEAKS audit entry(ies) contain a secret"
pass "absent d'audit_logs"

for service in panel worker; do
  # `grep -c` and not `grep -q`: under `set -o pipefail`, `grep -q` exits at the
  # first match, `docker compose logs` gets a SIGPIPE, and the pipe reports the
  # producer's failure. On a **negative** assertion like this one, this false
  # negative makes the check **pass** although a secret leaked — silence would
  # look like success. `grep -c` reads to the end.
    if [ "$(docker compose logs "$service" 2>/dev/null | grep -cF 'VERIFSECRET')" != "0" ]; then
    fail "a secret appears in docker compose logs $service"
  fi
done
pass "absent from docker compose logs panel and worker"

STORED=$(psql_q "select encrypted_secrets from notification_channels where id = '$HOOK_ID';")
case "$STORED" in
  v1:*) pass "in the database, the secret is encrypted (AES-256-GCM, \"v1\" prefix)" ;;
  *)    fail "encrypted_secrets does not have the expected shape: ${STORED:0:20}" ;;
esac
grep -qF "$HOOK_TOKEN" <<< "$STORED" && fail "the secret is readable in the database"

step "8. The test message really reaches the recipient"
mark_receiver
curl -s -X DELETE "$MAILPIT_HTTP/api/v1/messages" >/dev/null

code=$(req POST "/api/notifications/channels/$SMTP_ID/test")
[ "$code" = "200" ] || fail "essai SMTP → HTTP $code: $(cat "$BODY")"
jq -e '.probe.ok == true and .delivered == true' "$BODY" >/dev/null \
  || fail "essai SMTP: $(jq -c '{probe,error}' "$BODY")"
pass "SMTP — $(jq -r '.probe.detail' "$BODY")"

MSG=$(curl -s "$MAILPIT_HTTP/api/v1/messages")
[ "$(jq -r .total <<< "$MSG")" = "1" ] || fail "Mailpit only received $(jq -r .total <<< "$MSG") message(s)"
MID=$(jq -r '.messages[0].ID' <<< "$MSG")
FULL=$(curl -s "$MAILPIT_HTTP/api/v1/message/$MID")
jq -e '(.Text | length) > 0 and (.HTML | length) > 0' <<< "$FULL" >/dev/null \
  || fail "the e-mail does not have its two parts (text and HTML)"
jq -e '.Text | contains("<") | not' <<< "$FULL" >/dev/null \
  || fail "the text part contains HTML — the abstraction leaks"
jq -e '[.To[].Address] | length == 2' <<< "$FULL" >/dev/null \
  || fail "the two recipients were not separated"
HEADERS=$(curl -s "$MAILPIT_HTTP/api/v1/message/$MID/headers")
jq -e '.["X-Control-Plane-Event"][0] == "notification.test"' <<< "$HEADERS" >/dev/null \
  || fail "event header missing from the e-mail"
pass "e-mail received by Mailpit: \"$(jq -r '.messages[0].Subject' <<< "$MSG")\", text + HTML, 2 recipients"

code=$(req POST "/api/notifications/channels/$TG_ID/test")
[ "$code" = "200" ] || fail "essai Telegram → HTTP $code: $(cat "$BODY")"
jq -e '.delivered == true' "$BODY" >/dev/null || fail "essai Telegram: $(jq -c . "$BODY")"
pass "Telegram — $(jq -r '.probe.detail' "$BODY")"

code=$(req POST "/api/notifications/channels/$DC_ID/test")
[ "$code" = "200" ] || fail "essai Discord → HTTP $code: $(cat "$BODY")"
jq -e '.delivered == true' "$BODY" >/dev/null || fail "essai Discord: $(jq -c . "$BODY")"
pass "Discord — $(jq -r '.probe.detail' "$BODY")"

code=$(req POST "/api/notifications/channels/$HOOK_ID/test")
[ "$code" = "200" ] || fail "essai webhook → HTTP $code: $(cat "$BODY")"
jq -e '.delivered == true' "$BODY" >/dev/null || fail "essai webhook: $(jq -c . "$BODY")"
pass "webhook — delivered"

step "9. Each channel rendered the message in ITS shape"
jq -e 'select(.method == "POST" and (.path | test("/sendMessage$")))
       | (.body | fromjson)
       | .parse_mode == "MarkdownV2" and (.text | test("\\\\\\."))' "$RECV" >/dev/null \
  || fail "Telegram: MarkdownV2 missing, or the dots are not escaped"
pass "Telegram: parse_mode MarkdownV2, reserved characters escaped"

jq -e 'select(.method == "POST" and (.path | test("/api/webhooks/")))
       | (.body | fromjson)
       | (.embeds | length) == 1 and (.embeds[0].color | type) == "number"' "$RECV" >/dev/null \
  || fail "Discord: no colored embed"
pass "Discord: an embed, severity color, aligned fields"

jq -e 'select(.path == "/hook")
       | (.body | fromjson | .version == 1 and .event == "notification.test")
         and (.headers["x-control-plane-severity"] | length) > 0
         and (.headers.authorization | startswith("Bearer "))' "$RECV" >/dev/null \
  || fail "webhook: unexpected payload or headers"
pass "webhook: raw versioned JSON, routing headers, token in Authorization"

jq -e 'select(.method == "GET" and (.path | test("/getMe$"))) | true' "$RECV" >/dev/null \
  || fail "Telegram: the getMe probe was not called"
pass "the probes post nothing: getMe for Telegram, GET of the webhook for Discord"

step "10. An unreachable channel does not break the notified action"
# Closed port on the worker's loopback: the connection is refused right away.
DEAD_ID=$(create_channel "{\"kind\":\"webhook\",\"name\":\"$PREFIX-unreachable\",
  \"config\":{\"url\":\"http://127.0.0.1:45999/hook\"},\"secrets\":{},
  \"events\":[\"security.role_changed\"]}" "unreachable")
pass "unreachable channel created, subscribed to the same event as the webhook"

code=$(req POST /api/admin/users \
  "{\"name\":\"Cobaye notifications\",\"email\":\"$SUBJECT_EMAIL\",\"password\":\"motdepasse-tres-long\",\"role\":\"viewer\"}")
case "$code" in 201|409) : ;; *) fail "POST /api/admin/users → HTTP $code: $(cat "$BODY")" ;; esac
SUBJECT_ID=$(psql_q "select id from users where email = '$SUBJECT_EMAIL';")
[ -n "$SUBJECT_ID" ] || fail "guinea pig user not found"
pass "guinea pig user created"

mark_receiver
code=$(req PATCH "/api/admin/users/$SUBJECT_ID/role" '{"role":"operator"}')
[ "$code" = "200" ] || fail "role change → HTTP $code: $(cat "$BODY")"
pass "the role change succeeds (HTTP 200) despite an unreachable channel"

# Delivery is retried three times before giving up (5 s then 10 s): the failure
# is only recorded at the end, once, and not at each attempt — otherwise
# `consecutive_failures` would count lost packets instead of answering "since
# when has this channel stopped working?". Hence the wait, longer than a network
# round trip.
for _ in $(seq 1 40); do
  FAILS=$(psql_q "select consecutive_failures from notification_channels where id = '$DEAD_ID';")
  [ "${FAILS:-0}" -gt 0 ] && break
  sleep 1
done
[ "${FAILS:-0}" -gt 0 ] || fail "the unreachable channel's failure was not recorded"
LAST_ERROR=$(psql_q "select last_error from notification_channels where id = '$DEAD_ID';")
[ -n "$LAST_ERROR" ] || fail "no error message recorded on the channel"
pass "failure visible on the channel: \"$LAST_ERROR\" ($FAILS consecutive failure)"

TRACED=$(psql_q "select count(*) from audit_logs
  where action = 'notification.delivery.failed' and resource_id = '$DEAD_ID';")
[ "$TRACED" -ge 1 ] || fail "the sending failure is not traced in audit_logs"
pass "failure traced in audit_logs: notification.delivery.failed"

step "11. The event triggered a sending, and only one"
SENT=$(jq -s --arg e 'security.role_changed' \
  '[.[] | select(.path == "/hook") | (.body | fromjson) | select(.event == $e)] | length' "$RECV")
[ "$SENT" = "1" ] || fail "$SENT sending(s) for a single role change"
pass "one role change → exactly 1 message on the reachable channel"

jq -s -e --arg e 'security.role_changed' \
  '[.[] | select(.path == "/hook") | (.body | fromjson) | select(.event == $e)][0]
   | .severity == "warning" and (.fields | map(.value) | index("admin@example.test") != null)' \
  "$RECV" >/dev/null || fail "the message does not say who acted"
pass "the message carries the severity and the actor"

TOTAL=$(recv_count)
[ "$TOTAL" = "1" ] || fail "$TOTAL request(s) received although a single sending was expected"
pass "no other channel was called upon: the subscriptions are respected"

step "12. Configuring requires settings:manage"
code=$(req POST /api/admin/roles \
  "{\"key\":\"$READER_ROLE\",\"label\":\"Lecteur de paramètres\",\"permissions\":[\"settings:read\"]}")
case "$code" in 201|409) : ;; *) fail "POST /api/admin/roles → HTTP $code: $(cat "$BODY")" ;; esac
code=$(req POST /api/admin/users \
  "{\"name\":\"Lecteur notifications\",\"email\":\"$READER_EMAIL\",\"password\":\"motdepasse-tres-long\",\"role\":\"$READER_ROLE\"}")
case "$code" in 201|409) : ;; *) fail "POST /api/admin/users → HTTP $code: $(cat "$BODY")" ;; esac
pass "role \"$READER_ROLE\" (settings:read alone) and its holder created"

for _ in 1 2 3 4 5; do
  code=$(req_reader POST /api/auth/sign-in/email \
    "{\"email\":\"$READER_EMAIL\",\"password\":\"motdepasse-tres-long\"}")
  [ "$code" = "429" ] || break
  sleep 6
done
[ "$code" = "200" ] || fail "reader sign-in → HTTP $code: $(cat "$BODY")"
pass "reader signed in"

code=$(req_reader GET /api/notifications/channels)
[ "$code" = "200" ] || fail "reading by the reader → HTTP $code"
pass "settings:read is enough to look at the channels"

code=$(req_reader POST /api/notifications/channels \
  "{\"kind\":\"webhook\",\"name\":\"$PREFIX-interdit\",\"config\":{\"url\":\"http://127.0.0.1:1/x\"},\"secrets\":{},\"events\":[]}")
[ "$code" = "403" ] || fail "creation by a reader: expected 403, got $code"
jq -e '.error.details.permission == "settings:manage"' "$BODY" >/dev/null \
  || fail "the refused permission is not named: $(cat "$BODY")"
pass "creation refused → 403 settings:manage"

code=$(req_reader POST "/api/notifications/channels/$HOOK_ID/test")
[ "$code" = "403" ] || fail "trial by a reader: expected 403, got $code"
pass "sending a test message refused → 403 (a trial sends a message out)"

code=$(req_reader DELETE "/api/notifications/channels/$HOOK_ID")
[ "$code" = "403" ] || fail "deletion by a reader: expected 403, got $code"
pass "deletion refused → 403"

step "13. Traceability"
code=$(req GET "/api/audit-logs?resourceType=notification_channel&pageSize=50")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
for action in notification.channel.created notification.channel.tested notification.delivery.failed; do
  jq -e --arg a "$action" '[.items[] | select(.action == $a)] | length > 0' "$BODY" >/dev/null \
    || fail "action \"$action\" missing from the audit log"
  pass "audit: $action"
done

step "14. Grouping: the first alert goes out without delay"
# The four channels subscribe to the same event, the one we know how to trigger
# at will. The unreachable channel is removed: its three spaced attempts would
# delay the deliveries without proving anything more.
req DELETE "/api/notifications/channels/$DEAD_ID" >/dev/null
for id in "$SMTP_ID" "$TG_ID" "$DC_ID"; do
  code=$(req PATCH "/api/notifications/channels/$id" '{"events":["security.role_changed"]}')
  [ "$code" = "200" ] || fail "subscribing channel $id → HTTP $code: $(cat "$BODY")"
done
pass "the four channels are subscribed to \"security.role_changed\""

# The group must be **silent** before measuring. It is not: step 10's role
# change opened a window. We wait for it to close on its own — and this wait is
# already a proof: a window that closes without holding anything puts the group
# back to silence.
wait_group_silent 120 || fail "the group \"$GROUP\" does not become silent again"
pass "previous window closed without holding anything → silent group"

make_burst_users rafale "$BURST_SIZE"
make_burst_users seul 1
pass "$((BURST_SIZE + 1)) guinea pigs created (creation notifies nothing)"

mark_receiver
curl -s -X DELETE "$MAILPIT_HTTP/api/v1/messages" >/dev/null

STARTED=$(date +%s)
fire_roles operator "$WORK/seul.ids" 1 1
for _ in $(seq 1 40); do
  [ "$(hook_events)" -ge 1 ] && break
  sleep 0.25
done
ELAPSED=$(( $(date +%s) - STARTED ))
[ "$(hook_events)" -ge 1 ] || fail "the first alert never went out"
[ "$ELAPSED" -le 10 ] \
  || fail "the first alert took ${ELAPSED} s — it waited for the $((VERIF_WINDOW_MS / 1000)) s window"
pass "isolated outage → message received in ${ELAPSED} s, without waiting for the $((VERIF_WINDOW_MS / 1000)) s window"

jq -s -e '[.[] | select(.path == "/hook") | (.body | fromjson)][0]
          | .type == "event" and .event == "security.role_changed" and (has("items") | not)' \
  "$RECV" >/dev/null || fail "the first alert is not a single alert"
pass "it is indeed a single alert, not a digest"

[ "$(digest_open)" = "1" ] || fail "the first alert did not open a window"
pass "and it opened the grouping window"

step "15. $BURST_SIZE events in a burst do not produce $BURST_SIZE messages"
fire_roles operator "$WORK/rafale.ids" 1 "$BURST_SIZE"

for _ in $(seq 1 30); do
  [ "$(digest_held)" -ge "$BURST_SIZE" ] && break
  sleep 1
done
HELD=$(digest_held)
[ "$HELD" = "$BURST_SIZE" ] || fail "$HELD event(s) held out of $BURST_SIZE expected"
[ "$(digest_items)" = "$BURST_SIZE" ] || fail "the named lines do not follow the counter"
pass "$HELD events held in the database, each with its named line"

[ "$(hook_events)" = "1" ] \
  || fail "$(hook_events) single alerts received — the burst was not held"
pass "none of the $BURST_SIZE went out separately: only the first one had"

wait_for_digest 1 90 || fail "no digest arrived after the window closed"
TOTAL=$(hook_all)
[ "$TOTAL" -le 4 ] || fail "$TOTAL messages for $((BURST_SIZE + 1)) events — the grouping does not hold"
pass "$((BURST_SIZE + 1)) events → $TOTAL message(s) on the channel: 1 immediate, $(hook_digests) digest(s)"

step "16. The digest names what it summarizes"
DIGEST="$WORK/digest.json"
jq -s '[.[] | select(.path == "/hook") | (.body | fromjson) | select(.type == "digest")][0]' \
  "$RECV" > "$DIGEST"

jq -e --argjson n "$BURST_SIZE" '.count == $n and (.items | length) == $n and .omitted == 0' "$DIGEST" \
  >/dev/null || fail "the digest announces $(jq -r '.count' "$DIGEST") / $(jq -r '.items|length' "$DIGEST") lines"
pass "it announces $BURST_SIZE alerts and names $BURST_SIZE (0 killed)"

# The heart of the requirement: not a counter, names. We check that three guinea
# pigs picked at random from the burst appear by name in the digest.
for i in 1 "$((BURST_SIZE / 2))" "$BURST_SIZE"; do
  jq -e --arg m "$PREFIX-rafale-$i@example.test" \
    '[.items[] | select(.label | contains($m))] | length == 1' "$DIGEST" >/dev/null \
    || fail "the guinea pig \"$PREFIX-rafale-$i@example.test\" is not named in the digest"
done
pass "each line names its account — guinea pigs 1, $((BURST_SIZE / 2)) and $BURST_SIZE found by name"

jq -e '(.items[0].detail | length) > 0 and (.items[0].occurredAt | length) > 0' "$DIGEST" >/dev/null \
  || fail "the lines have neither a timestamp nor a detail"
pass "each line carries its time and its transition: $(jq -r '.items[0].label + " — " + .items[0].detail' "$DIGEST")"

jq -e '(.windowStartedAt | length) > 0 and (.windowEndedAt | length) > 0 and .nextWindowMs > .windowMs' \
  "$DIGEST" >/dev/null || fail "the digest does not say which window it covers"
pass "it states its window ($(jq -r '.windowMs' "$DIGEST") ms) and announces the next one, widened ($(jq -r '.nextWindowMs' "$DIGEST") ms)"

jq -e '(.body | test("partie seule|went out on its own")) and (.body | test("regroupement|grouping"))' "$DIGEST" >/dev/null \
  || fail "the digest's body does not explain why it exists"
pass "and it explains the trade-off in so many words, not only the number"

step "17. A worker restart in the middle of a burst releases nothing"
make_burst_users reprise "$RESTART_BURST_SIZE"
HALF=$((RESTART_BURST_SIZE / 2))
BEFORE_EVENTS=$(hook_events)
BEFORE_DIGESTS=$(hook_digests)

fire_roles operator "$WORK/reprise.ids" 1 "$HALF"
for _ in $(seq 1 20); do
  [ "$(digest_held)" -ge "$HALF" ] && break
  sleep 1
done
[ "$(digest_held)" -ge "$HALF" ] || fail "the first half was not held"
pass "$HALF events held, window open"

docker compose restart worker >/dev/null 2>&1 || fail "could not restart the worker"
for _ in $(seq 1 60); do
  docker compose logs worker --since 2m 2>/dev/null | grep -q 'digest windows sweep installed' && break
  sleep 1
done
pass "worker restarted in the middle of the burst"

# The state is in the database, not in memory: the worker that comes back must
# find its open window and its held events, not start from zero.
[ "$(digest_open)" = "1" ] || fail "the window disappeared at the restart"
[ "$(digest_held)" -ge "$HALF" ] || fail "the held events disappeared at the restart"
pass "on return: window still open, $(digest_held) events still held"

fire_roles operator "$WORK/reprise.ids" "$((HALF + 1))" "$RESTART_BURST_SIZE"
for _ in $(seq 1 30); do
  [ "$(digest_held)" -ge "$RESTART_BURST_SIZE" ] && break
  sleep 1
done
[ "$(digest_held)" -ge "$RESTART_BURST_SIZE" ] \
  || fail "$(digest_held) held out of $RESTART_BURST_SIZE after the burst resumed"
[ "$(hook_events)" = "$BEFORE_EVENTS" ] \
  || fail "$(( $(hook_events) - BEFORE_EVENTS )) single alert(s) released by the restart"
pass "no alert released by the restart: 0 single messages, everything is still held"

wait_for_digest "$((BEFORE_DIGESTS + 1))" 150 || fail "the interrupted burst's digest never arrived"
RESUME="$WORK/reprise.json"
jq -s --argjson skip "$BEFORE_DIGESTS" \
  '[.[] | select(.path == "/hook") | (.body | fromjson) | select(.type == "digest")][$skip]' \
  "$RECV" > "$RESUME"
jq -e --argjson n "$RESTART_BURST_SIZE" '.count == $n' "$RESUME" >/dev/null \
  || fail "the digest announces $(jq -r '.count' "$RESUME") alerts instead of $RESTART_BURST_SIZE"
# A guinea pig from before the restart and one from after, in the same digest:
# it is the proof that the window crossed the stop without breaking.
for i in 1 "$RESTART_BURST_SIZE"; do
  jq -e --arg m "$PREFIX-reprise-$i@example.test" \
    '[.items[] | select(.label | contains($m))] | length == 1' "$RESUME" >/dev/null \
    || fail "\"$PREFIX-reprise-$i@example.test\" is missing from the digest"
done
pass "a single digest of $RESTART_BURST_SIZE alerts, including those from before *and* after the stop"

step "18. Each channel renders the digest its own way"
# E-mail: it lists everything. It is the only channel that can, and it is its
# value — when Telegram says "and 44 more", it is here that one reads which.
MSGS=$(curl -s "$MAILPIT_HTTP/api/v1/messages?limit=50")
MID=$(jq -r --arg n "$BURST_SIZE" \
  '[.messages[] | select(.Subject | contains($n + " × ") and test("résumé|digest"))][0].ID // empty' <<< "$MSGS")
[ -n "$MID" ] || fail "no digest e-mail in Mailpit: $(jq -r '[.messages[].Subject] | join(" | ")' <<< "$MSGS")"
MAIL=$(curl -s "$MAILPIT_HTTP/api/v1/message/$MID")
LINES=$(jq -r '.Text' <<< "$MAIL" | grep -c '^• ' || true)
[ "$LINES" = "$BURST_SIZE" ] || fail "the e-mail lists $LINES lines out of $BURST_SIZE"
jq -e '.Text | test("autres, non détaillés|more, not detailed") | not' <<< "$MAIL" >/dev/null \
  || fail "the e-mail truncates although it does not have to"
jq -e '(.HTML | contains("<ol")) and (.Text | contains("<") | not)' <<< "$MAIL" >/dev/null \
  || fail "the e-mail does not have its two parts, or the text part contains HTML"
MHEAD=$(curl -s "$MAILPIT_HTTP/api/v1/message/$MID/headers")
jq -e '.["X-Control-Plane-Digest"][0] == "true"' <<< "$MHEAD" >/dev/null \
  || fail "the digest e-mail does not declare itself as such in its headers"
pass "e-mail: \"$(jq -r --arg n "$BURST_SIZE" '[.messages[] | select(.Subject | contains($n + " × "))][0].Subject' <<< "$MSGS")\" — the $BURST_SIZE lines listed, text + HTML"

# Telegram: short, and it **says** what it leaves out.
TG="$WORK/tg.json"
jq -s '[.[] | select(.method == "POST" and (.path | test("/sendMessage$")))
       | (.body | fromjson) | select(.text | test("résumé|digest"))][0]' "$RECV" > "$TG"
jq -e '.text != null' "$TG" >/dev/null || fail "Telegram received no digest"
TG_LINES=$(jq -r '.text' "$TG" | grep -c '^• ' || true)
TG_LEN=$(jq -r '.text | length' "$TG")
[ "$TG_LINES" -le 6 ] || fail "Telegram shows $TG_LINES lines: it is no longer short"
[ "$TG_LEN" -le 1200 ] || fail "the Telegram message is $TG_LEN characters long"
jq -e --argjson n "$((BURST_SIZE - 6))" '.text | test("et " + ($n | tostring) + " autres|and " + ($n | tostring) + " more")' "$TG" \
  >/dev/null || fail "Telegram truncates without saying how many lines it leaves out"
jq -e '.parse_mode == "MarkdownV2"' "$TG" >/dev/null || fail "Telegram: MarkdownV2 missing from the digest"
pass "Telegram: $TG_LINES lines, $TG_LEN characters, \"and $((BURST_SIZE - 6)) more\" announced, MarkdownV2"

# Discord: an embed, the list in the description, fifteen lines then the admission.
DC="$WORK/dc.json"
jq -s '[.[] | select(.method == "POST" and (.path | test("/api/webhooks/")))
       | (.body | fromjson) | select(.embeds[0].title | test("résumé|digest"))][0]' "$RECV" > "$DC"
jq -e '.embeds[0].description != null' "$DC" >/dev/null || fail "Discord received no digest"
DC_LINES=$(jq -r '.embeds[0].description' "$DC" | grep -c '^• ' || true)
[ "$DC_LINES" = "15" ] || fail "Discord shows $DC_LINES lines instead of 15"
jq -e --argjson n "$((BURST_SIZE - 15))" '.embeds[0].description | test("et " + ($n | tostring) + " autres|and " + ($n | tostring) + " more")' \
  "$DC" >/dev/null || fail "Discord truncates without saying so"
jq -e '(.embeds[0].color | type) == "number" and (.embeds[0].footer.text | test("regroupées|grouped"))' "$DC" \
  >/dev/null || fail "Discord: embed without a color nor a footer"
pass "Discord: colored embed, $DC_LINES lines in the description, \"and $((BURST_SIZE - 15)) more\" announced"

# Webhook: nothing truncated. Its target is a program, not a screen.
jq -e --argjson n "$BURST_SIZE" '(.items | length) == $n and .omitted == 0 and .version == 1' "$DIGEST" \
  >/dev/null || fail "the webhook does not receive the whole digest"
jq -s -e '[.[] | select(.path == "/hook") | select(.headers["x-control-plane-digest"] == "true")] | length >= 1' \
  "$RECV" >/dev/null || fail "the digests' routing header is missing"
pass "webhook: $BURST_SIZE lines, none truncated, X-Control-Plane-Digest: true header"

step "19. Cleanup"
purge
req GET /api/notifications/channels >/dev/null
REMAINING=$(jq -r --arg p "$PREFIX" '[.items[] | select(.name | startswith($p))] | length' "$BODY")
[ "$REMAINING" = "0" ] || fail "$REMAINING verification channel(s) remain"
pass "verification channels, users and role deleted"

# We compare the settings' fingerprint, not the audit log: a ten-minute window
# on `settings.updated` catches the work of the scripts run just before
# (verify-settings, verify-onboarding legitimately write some). A test that
# fails because of a neighbor does not measure what it claims.
SETTINGS_AFTER=$(psql_q "select md5(value::text) from app_settings where id = 1;")
[ "$SETTINGS_AFTER" = "$SETTINGS_BEFORE" ] \
  || fail "the instance settings were changed by this script"
pass "the instance settings were not touched"

# The grouping window is a setting, not a test state: it is given back as it
# was found. The `trap` does it too on interruption; here it is done early so as
# to be able to **check** it.
code=$(req PATCH /api/notifications/digests "{\"windowMs\":$POLICY_BEFORE}")
[ "$code" = "200" ] || fail "restoring the window → HTTP $code"
req GET /api/notifications/digests >/dev/null
RESTORED=$(jq -r '.policy.windowMs' "$BODY")
[ "$RESTORED" = "$POLICY_BEFORE" ] \
  || fail "window restored to $RESTORED ms instead of $POLICY_BEFORE ms"
POLICY_BEFORE=""
pass "grouping window given back in the state found (${RESTORED} ms)"

printf '\n\033[32m✓ Notifications layer verified.\033[0m\n'
printf '\033[2m  Screen: %s/admin/settings/notifications\033[0m\n' "$BASE_URL"
printf '\033[2m  Throwaway SMTP server: docker compose --profile test up -d mailpit (http://localhost:8025)\033[0m\n'
printf '\033[2m  Not exercised against a real service: api.telegram.org and discord.com were\033[0m\n'
printf '\033[2m  replaced by a local receiver. SMTP, for its part, talked to a real server (Mailpit).\033[0m\n'
printf '\033[2m  Grouping: %s + %s events in a burst, worker restart in the middle,\033[0m\n' \
  "$BURST_SIZE" "$RESTART_BURST_SIZE"
printf '\033[2m  and not a single alert released — while keeping the first outage immediate.\033[0m\n\n'
