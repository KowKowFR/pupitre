#!/usr/bin/env bash
#
# Vérifie la couche de notifications :
#
#    1. le catalogue est une donnée — quatre canaux, cinq événements
#    2. une configuration incomplète est refusée (422)
#    3. les quatre canaux se configurent et s'essaient réellement
#    4. le secret ne ressort ni de l'API, ni du HTML, ni de l'audit, ni des logs
#    5. un canal injoignable ne casse pas l'action notifiée, et son échec se voit
#    6. un événement notifiable déclenche un envoi, et un seul
#    7. `settings:manage` est requis pour configurer et pour essayer
#
# Ce que le script met en place, et démonte à la fin :
#   — un récepteur HTTP local, qui journalise ce qu'il reçoit et répond comme
#     le feraient l'API Bot de Telegram et un webhook Discord ;
#   — Mailpit, un vrai serveur SMTP jetable, démarré sous le profil compose
#     « test » (jamais au démarrage normal) :
#         docker compose --profile test up -d mailpit
#     Interface web : http://localhost:8025
#
# Le worker joint le récepteur par `host.docker.internal` et Mailpit par son
# nom de service. Aucun service extérieur n'est appelé : ni api.telegram.org,
# ni discord.com, ni un relais SMTP public.
#
# Usage :
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

# Nom réservé à ce script. Tout ce qui le porte est supprimé au début et à la fin.
PREFIX="verif-notif"
READER_EMAIL="notif-lecteur@example.test"
SUBJECT_EMAIL="notif-cobaye@example.test"
READER_ROLE="$PREFIX-lecteur"

# Secrets jetables. Ils ont la forme de vrais jetons — c'est ce qui permet de
# vérifier que les expurgations les reconnaissent.
SMTP_PASSWORD="VERIFSECRETSMTPzz9911"
TG_TOKEN="987654321:VERIFSECRETTELEGRAMaaaabbbbccccdddd"
DISCORD_TOKEN="VERIFSECRETDISCORDwxyz012345"
HOOK_TOKEN="VERIFSECRETWEBHOOKqqqq7777"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
READER_JAR="$WORK/reader.jar"
BODY="$WORK/body.json"
RECV="$WORK/receiver.log"
RECEIVER_PID=""

command -v jq >/dev/null || { echo "jq est requis"; exit 1; }
command -v node >/dev/null || { echo "node est requis"; exit 1; }

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

# Même chose, avec le bocal du lecteur sans `settings:manage`.
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
  [ "$code" = "200" ] || fail "connexion impossible (HTTP $code) : $(cat "$BODY")"
  assert_admin
}

assert_admin() {
  local role
  role=$(jq -r '.user.role // empty' "$BODY")
  [ "$role" = "admin" ] && return 0
  fail "« $ADMIN_EMAIL » a le rôle « ${role:-aucun} », pas « admin » — voir /admin/users"
}

# Supprime tout ce que ce script a pu créer, y compris lors d'une exécution
# interrompue. Ne touche à rien d'autre : les paramètres d'instance ne sont
# jamais modifiés, et `app_settings` n'est jamais vidée.
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
  req DELETE "/api/admin/roles/$READER_ROLE" >/dev/null 2>&1 || true
}

cleanup() {
  local code=$?
  [ -n "$RECEIVER_PID" ] && kill "$RECEIVER_PID" 2>/dev/null || true
  purge 2>/dev/null || true
  # Mailpit est un service du profil « test » : il ne tourne jamais par défaut,
  # on le rend dans l'état où on l'a trouvé.
  docker compose --profile test rm -sf mailpit >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT

# ── Récepteur HTTP ────────────────────────────────────────────────────────────
# Il journalise chaque requête et répond comme les services visés : c'est ce qui
# permet de vérifier la forme exacte des charges utiles et des en-têtes sans
# jeton Telegram ni salon Discord.
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
  fail "le récepteur HTTP n'a pas démarré sur le port $RECEIVER_PORT"
}

# Requêtes reçues depuis le dernier `mark_receiver`.
mark_receiver() { : > "$RECV"; }
recv_count() { grep -c . "$RECV" 2>/dev/null || echo 0; }

create_channel() {
  local payload="$1" label="$2"
  local code
  code=$(req POST /api/notifications/channels "$payload")
  [ "$code" = "201" ] || fail "création de « $label » → HTTP $code : $(cat "$BODY")"
  jq -r .id "$BODY"
}

step "1. Connexion"
login
pass "connecté en tant que $ADMIN_EMAIL"

# Empreinte de référence : ce script ne doit modifier aucun paramètre d'instance.
SETTINGS_BEFORE=$(psql_q "select md5(value::text) from app_settings where id = 1;")
purge
info "ménage d'une exécution précédente effectué"

step "2. Récepteur local et serveur SMTP jetable"
start_receiver
pass "récepteur HTTP sur le port $RECEIVER_PORT"

docker compose --profile test up -d mailpit >/dev/null 2>&1 \
  || fail "impossible de démarrer Mailpit (profil compose « test »)"
for _ in $(seq 1 30); do
  curl -sf "$MAILPIT_HTTP/api/v1/messages" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "$MAILPIT_HTTP/api/v1/messages" >/dev/null \
  || fail "Mailpit ne répond pas sur $MAILPIT_HTTP"
curl -s -X DELETE "$MAILPIT_HTTP/api/v1/messages" >/dev/null
pass "Mailpit démarré (SMTP mailpit:1025, interface $MAILPIT_HTTP), boîte vidée"

docker compose exec -T worker sh -c "wget -qO- http://host.docker.internal:$RECEIVER_PORT/from-worker" >/dev/null 2>&1 \
  || fail "le worker ne joint pas le récepteur — host.docker.internal indisponible ?"
pass "le worker joint le récepteur"
mark_receiver

step "3. Le catalogue est une donnée, pas une liste écrite dans l'écran"
code=$(req GET /api/notifications/channels)
[ "$code" = "200" ] || fail "GET /api/notifications/channels → HTTP $code"
KINDS=$(jq -r '[.vocabulary.channels[].kind] | join(", ")' "$BODY")
EVENTS=$(jq -r '[.vocabulary.events[].key] | join(", ")' "$BODY")
jq -e '.vocabulary.channels | length == 4' "$BODY" >/dev/null || fail "quatre canaux attendus"
jq -e '[.vocabulary.channels[].fields[]] | length > 10' "$BODY" >/dev/null \
  || fail "les champs de configuration ne sont pas décrits"
jq -e '[.vocabulary.channels[].fields[] | select(has("schema"))] | length == 0' "$BODY" >/dev/null \
  || fail "un schéma Zod a fuité dans la réponse — il ne survivrait pas à JSON.stringify"
pass "canaux : $KINDS"
pass "événements : $EVENTS"

step "4. Une configuration incomplète est refusée"
code=$(req POST /api/notifications/channels \
  "{\"kind\":\"smtp\",\"name\":\"$PREFIX-invalide\",\"config\":{\"from\":\"a@b.test\",\"to\":\"c@d.test\"},\"secrets\":{},\"events\":[]}")
[ "$code" = "422" ] || fail "SMTP sans serveur : attendu 422, reçu $code"
jq -e '.error.code == "validation_failed"' "$BODY" >/dev/null || fail "code d'erreur inattendu"
pass "SMTP sans « host » → 422 $(jq -r '.error.code' "$BODY")"

code=$(req POST /api/notifications/channels \
  "{\"kind\":\"telegram\",\"name\":\"$PREFIX-invalide\",\"config\":{\"chatId\":\"-100\"},\"secrets\":{},\"events\":[]}")
[ "$code" = "422" ] || fail "Telegram sans jeton : attendu 422, reçu $code"
pass "Telegram sans jeton de bot → 422"

code=$(req POST /api/notifications/channels \
  "{\"kind\":\"webhook\",\"name\":\"$PREFIX-invalide\",\"config\":{\"url\":\"pas-une-url\"},\"secrets\":{},\"events\":[]}")
[ "$code" = "422" ] || fail "webhook à URL invalide : attendu 422, reçu $code"
pass "webhook à URL invalide → 422"

code=$(req POST /api/notifications/channels \
  "{\"kind\":\"discord\",\"name\":\"$PREFIX-invalide\",\"config\":{},\"secrets\":{\"webhookUrl\":\"https://example.test/pas-un-webhook\"},\"events\":[]}")
[ "$code" = "422" ] || fail "URL Discord qui n'en est pas une : attendu 422, reçu $code"
pass "URL Discord sans /api/webhooks/ → 422"

step "5. Les quatre canaux se configurent"
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
  || fail "les champs secrets renseignés ne sont pas annoncés"
pass "la réponse annonce quels secrets sont posés, jamais leur valeur"

step "6. Le secret ne ressort de nulle part"
req GET /api/notifications/channels >/dev/null
for secret in "$SMTP_PASSWORD" "$TG_TOKEN" "$DISCORD_TOKEN" "$HOOK_TOKEN"; do
  grep -qF "$secret" "$BODY" && fail "un secret apparaît dans la réponse de l'API"
done
pass "absent de GET /api/notifications/channels"

curl -s -b "$JAR" "$BASE_URL/admin/settings/notifications" -o "$WORK/page.html"
for secret in "$SMTP_PASSWORD" "$TG_TOKEN" "$DISCORD_TOKEN" "$HOOK_TOKEN"; do
  grep -qF "$secret" "$WORK/page.html" && fail "un secret apparaît dans le HTML de l'écran"
done
pass "absent du HTML de /admin/settings/notifications"

LEAKS=$(psql_q "select count(*) from audit_logs
  where before::text like '%VERIFSECRET%' or after::text like '%VERIFSECRET%';")
[ "$LEAKS" = "0" ] || fail "$LEAKS entrée(s) d'audit contiennent un secret"
pass "absent d'audit_logs"

for service in panel worker; do
  if docker compose logs "$service" 2>/dev/null | grep -qF 'VERIFSECRET'; then
    fail "un secret apparaît dans docker compose logs $service"
  fi
done
pass "absent de docker compose logs panel et worker"

STORED=$(psql_q "select encrypted_secrets from notification_channels where id = '$HOOK_ID';")
case "$STORED" in
  v1:*) pass "en base, le secret est chiffré (AES-256-GCM, préfixe « v1 »)" ;;
  *)    fail "encrypted_secrets n'a pas la forme attendue : ${STORED:0:20}" ;;
esac
grep -qF "$HOOK_TOKEN" <<< "$STORED" && fail "le secret est lisible en base"

step "7. Le message d'essai atteint réellement le destinataire"
mark_receiver
curl -s -X DELETE "$MAILPIT_HTTP/api/v1/messages" >/dev/null

code=$(req POST "/api/notifications/channels/$SMTP_ID/test")
[ "$code" = "200" ] || fail "essai SMTP → HTTP $code : $(cat "$BODY")"
jq -e '.probe.ok == true and .delivered == true' "$BODY" >/dev/null \
  || fail "essai SMTP : $(jq -c '{probe,error}' "$BODY")"
pass "SMTP — $(jq -r '.probe.detail' "$BODY")"

MSG=$(curl -s "$MAILPIT_HTTP/api/v1/messages")
[ "$(jq -r .total <<< "$MSG")" = "1" ] || fail "Mailpit n'a reçu que $(jq -r .total <<< "$MSG") message(s)"
MID=$(jq -r '.messages[0].ID' <<< "$MSG")
FULL=$(curl -s "$MAILPIT_HTTP/api/v1/message/$MID")
jq -e '(.Text | length) > 0 and (.HTML | length) > 0' <<< "$FULL" >/dev/null \
  || fail "l'e-mail n'a pas ses deux parties (texte et HTML)"
jq -e '.Text | contains("<") | not' <<< "$FULL" >/dev/null \
  || fail "la partie texte contient du HTML — l'abstraction fuit"
jq -e '[.To[].Address] | length == 2' <<< "$FULL" >/dev/null \
  || fail "les deux destinataires n'ont pas été séparés"
HEADERS=$(curl -s "$MAILPIT_HTTP/api/v1/message/$MID/headers")
jq -e '.["X-Control-Plane-Event"][0] == "notification.test"' <<< "$HEADERS" >/dev/null \
  || fail "en-tête d'événement absent de l'e-mail"
pass "e-mail reçu par Mailpit : « $(jq -r '.messages[0].Subject' <<< "$MSG") », texte + HTML, 2 destinataires"

code=$(req POST "/api/notifications/channels/$TG_ID/test")
[ "$code" = "200" ] || fail "essai Telegram → HTTP $code : $(cat "$BODY")"
jq -e '.delivered == true' "$BODY" >/dev/null || fail "essai Telegram : $(jq -c . "$BODY")"
pass "Telegram — $(jq -r '.probe.detail' "$BODY")"

code=$(req POST "/api/notifications/channels/$DC_ID/test")
[ "$code" = "200" ] || fail "essai Discord → HTTP $code : $(cat "$BODY")"
jq -e '.delivered == true' "$BODY" >/dev/null || fail "essai Discord : $(jq -c . "$BODY")"
pass "Discord — $(jq -r '.probe.detail' "$BODY")"

code=$(req POST "/api/notifications/channels/$HOOK_ID/test")
[ "$code" = "200" ] || fail "essai webhook → HTTP $code : $(cat "$BODY")"
jq -e '.delivered == true' "$BODY" >/dev/null || fail "essai webhook : $(jq -c . "$BODY")"
pass "webhook — délivré"

step "8. Chaque canal a rendu le message dans SA forme"
jq -e 'select(.method == "POST" and (.path | test("/sendMessage$")))
       | (.body | fromjson)
       | .parse_mode == "MarkdownV2" and (.text | test("\\\\\\."))' "$RECV" >/dev/null \
  || fail "Telegram : MarkdownV2 absent, ou les points ne sont pas échappés"
pass "Telegram : parse_mode MarkdownV2, caractères réservés échappés"

jq -e 'select(.method == "POST" and (.path | test("/api/webhooks/")))
       | (.body | fromjson)
       | (.embeds | length) == 1 and (.embeds[0].color | type) == "number"' "$RECV" >/dev/null \
  || fail "Discord : pas d'embed coloré"
pass "Discord : un embed, couleur de gravité, champs alignés"

jq -e 'select(.path == "/hook")
       | (.body | fromjson | .version == 1 and .event == "notification.test")
         and (.headers["x-control-plane-severity"] | length) > 0
         and (.headers.authorization | startswith("Bearer "))' "$RECV" >/dev/null \
  || fail "webhook : charge utile ou en-têtes inattendus"
pass "webhook : JSON brut versionné, en-têtes de routage, jeton en Authorization"

jq -e 'select(.method == "GET" and (.path | test("/getMe$"))) | true' "$RECV" >/dev/null \
  || fail "Telegram : la sonde getMe n'a pas été appelée"
pass "les sondes ne déposent rien : getMe pour Telegram, GET du webhook pour Discord"

step "9. Un canal injoignable ne casse pas l'action notifiée"
# Port fermé sur la boucle locale du worker : la connexion est refusée aussitôt.
DEAD_ID=$(create_channel "{\"kind\":\"webhook\",\"name\":\"$PREFIX-injoignable\",
  \"config\":{\"url\":\"http://127.0.0.1:45999/hook\"},\"secrets\":{},
  \"events\":[\"security.role_changed\"]}" "injoignable")
pass "canal injoignable créé, abonné au même événement que le webhook"

code=$(req POST /api/admin/users \
  "{\"name\":\"Cobaye notifications\",\"email\":\"$SUBJECT_EMAIL\",\"password\":\"motdepasse-tres-long\",\"role\":\"viewer\"}")
case "$code" in 201|409) : ;; *) fail "POST /api/admin/users → HTTP $code : $(cat "$BODY")" ;; esac
SUBJECT_ID=$(psql_q "select id from users where email = '$SUBJECT_EMAIL';")
[ -n "$SUBJECT_ID" ] || fail "utilisateur cobaye introuvable"
pass "utilisateur cobaye créé"

mark_receiver
code=$(req PATCH "/api/admin/users/$SUBJECT_ID/role" '{"role":"operator"}')
[ "$code" = "200" ] || fail "changement de rôle → HTTP $code : $(cat "$BODY")"
pass "le changement de rôle aboutit (HTTP 200) malgré un canal injoignable"

for _ in $(seq 1 20); do
  FAILS=$(psql_q "select consecutive_failures from notification_channels where id = '$DEAD_ID';")
  [ "${FAILS:-0}" -gt 0 ] && break
  sleep 1
done
[ "${FAILS:-0}" -gt 0 ] || fail "l'échec du canal injoignable n'a pas été enregistré"
LAST_ERROR=$(psql_q "select last_error from notification_channels where id = '$DEAD_ID';")
[ -n "$LAST_ERROR" ] || fail "aucun message d'erreur enregistré sur le canal"
pass "échec visible sur le canal : « $LAST_ERROR » ($FAILS échec consécutif)"

TRACED=$(psql_q "select count(*) from audit_logs
  where action = 'notification.delivery.failed' and resource_id = '$DEAD_ID';")
[ "$TRACED" -ge 1 ] || fail "l'échec d'envoi n'est pas tracé dans audit_logs"
pass "échec tracé dans audit_logs : notification.delivery.failed"

step "10. L'événement a déclenché un envoi, et un seul"
SENT=$(jq -s --arg e 'security.role_changed' \
  '[.[] | select(.path == "/hook") | (.body | fromjson) | select(.event == $e)] | length' "$RECV")
[ "$SENT" = "1" ] || fail "$SENT envoi(s) pour un seul changement de rôle"
pass "un changement de rôle → exactement 1 message sur le canal joignable"

jq -s -e --arg e 'security.role_changed' \
  '[.[] | select(.path == "/hook") | (.body | fromjson) | select(.event == $e)][0]
   | .severity == "warning" and (.fields | map(.value) | index("admin@example.test") != null)' \
  "$RECV" >/dev/null || fail "le message ne dit pas qui a agi"
pass "le message porte la gravité et l'acteur"

TOTAL=$(recv_count)
[ "$TOTAL" = "1" ] || fail "$TOTAL requête(s) reçues alors qu'un seul envoi était attendu"
pass "aucun autre canal n'a été sollicité : les abonnements sont respectés"

step "11. Configurer exige settings:manage"
code=$(req POST /api/admin/roles \
  "{\"key\":\"$READER_ROLE\",\"label\":\"Lecteur de paramètres\",\"permissions\":[\"settings:read\"]}")
case "$code" in 201|409) : ;; *) fail "POST /api/admin/roles → HTTP $code : $(cat "$BODY")" ;; esac
code=$(req POST /api/admin/users \
  "{\"name\":\"Lecteur notifications\",\"email\":\"$READER_EMAIL\",\"password\":\"motdepasse-tres-long\",\"role\":\"$READER_ROLE\"}")
case "$code" in 201|409) : ;; *) fail "POST /api/admin/users → HTTP $code : $(cat "$BODY")" ;; esac
pass "rôle « $READER_ROLE » (settings:read seul) et son porteur créés"

for _ in 1 2 3 4 5; do
  code=$(req_reader POST /api/auth/sign-in/email \
    "{\"email\":\"$READER_EMAIL\",\"password\":\"motdepasse-tres-long\"}")
  [ "$code" = "429" ] || break
  sleep 6
done
[ "$code" = "200" ] || fail "connexion du lecteur → HTTP $code : $(cat "$BODY")"
pass "lecteur connecté"

code=$(req_reader GET /api/notifications/channels)
[ "$code" = "200" ] || fail "lecture par le lecteur → HTTP $code"
pass "settings:read suffit pour consulter les canaux"

code=$(req_reader POST /api/notifications/channels \
  "{\"kind\":\"webhook\",\"name\":\"$PREFIX-interdit\",\"config\":{\"url\":\"http://127.0.0.1:1/x\"},\"secrets\":{},\"events\":[]}")
[ "$code" = "403" ] || fail "création par un lecteur : attendu 403, reçu $code"
jq -e '.error.details.permission == "settings:manage"' "$BODY" >/dev/null \
  || fail "la permission refusée n'est pas nommée : $(cat "$BODY")"
pass "création refusée → 403 settings:manage"

code=$(req_reader POST "/api/notifications/channels/$HOOK_ID/test")
[ "$code" = "403" ] || fail "essai par un lecteur : attendu 403, reçu $code"
pass "envoi d'un message d'essai refusé → 403 (un essai fait partir un message)"

code=$(req_reader DELETE "/api/notifications/channels/$HOOK_ID")
[ "$code" = "403" ] || fail "suppression par un lecteur : attendu 403, reçu $code"
pass "suppression refusée → 403"

step "12. Traçabilité"
code=$(req GET "/api/audit-logs?resourceType=notification_channel&pageSize=50")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
for action in notification.channel.created notification.channel.tested notification.delivery.failed; do
  jq -e --arg a "$action" '[.items[] | select(.action == $a)] | length > 0' "$BODY" >/dev/null \
    || fail "action « $action » absente du journal d'audit"
  pass "audit : $action"
done

step "13. Ménage"
purge
req GET /api/notifications/channels >/dev/null
REMAINING=$(jq -r --arg p "$PREFIX" '[.items[] | select(.name | startswith($p))] | length' "$BODY")
[ "$REMAINING" = "0" ] || fail "$REMAINING canal(aux) de vérification subsistent"
pass "canaux, utilisateurs et rôle de vérification supprimés"

# On compare l'empreinte des paramètres, pas le journal d'audit : une fenêtre
# de dix minutes sur `settings.updated` attrape le travail des scripts lancés
# juste avant (verify-settings, verify-onboarding en écrivent légitimement).
# Un test qui échoue à cause d'un voisin ne mesure pas ce qu'il prétend.
SETTINGS_AFTER=$(psql_q "select md5(value::text) from app_settings where id = 1;")
[ "$SETTINGS_AFTER" = "$SETTINGS_BEFORE" ] \
  || fail "les paramètres d'instance ont été modifiés par ce script"
pass "les paramètres d'instance n'ont pas été touchés"

printf '\n\033[32m✓ Couche de notifications vérifiée.\033[0m\n'
printf '\033[2m  Écran : %s/admin/settings/notifications\033[0m\n' "$BASE_URL"
printf '\033[2m  Serveur SMTP jetable : docker compose --profile test up -d mailpit (http://localhost:8025)\033[0m\n'
printf '\033[2m  Non exercé contre un vrai service : api.telegram.org et discord.com ont été\033[0m\n'
printf '\033[2m  remplacés par un récepteur local. SMTP, lui, a parlé à un vrai serveur (Mailpit).\033[0m\n\n'
