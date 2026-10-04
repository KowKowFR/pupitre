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
#    8. le regroupement : la première alerte part sans délai, une rafale de
#       cinquante ne produit pas cinquante messages, le résumé nomme ce qu'il
#       remplace, un redémarrage du worker ne relâche pas l'orage d'un coup,
#       et chaque canal rend le résumé à sa façon
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

# Fenêtre de regroupement imposée pendant la vérification. Trente secondes :
# assez pour qu'une rafale de cinquante y tienne entièrement, assez court pour
# qu'un script ne dure pas dix minutes. La valeur trouvée est restaurée à la fin.
VERIF_WINDOW_MS="${VERIF_WINDOW_MS:-30000}"
# Taille des rafales. La première mesure le regroupement, la seconde le
# redémarrage à chaud.
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
  [ "$code" = "200" ] || fail "sign-in failed (HTTP $code): $(cat "$BODY")"
  assert_admin
}

assert_admin() {
  local role
  role=$(jq -r '.user.role // empty' "$BODY")
  [ "$role" = "admin" ] && return 0
  fail "\"$ADMIN_EMAIL\" has the role \"${role:-none}\", not \"admin\" — see /admin/users"
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
  # Les cobayes des rafales, créés par dizaines : tous portent le préfixe.
  for uid in $(psql_q "select id from users where email like '$PREFIX-%@example.test';" 2>/dev/null || true); do
    req DELETE "/api/admin/users/$uid" >/dev/null 2>&1 || true
  done
  req DELETE "/api/admin/roles/$READER_ROLE" >/dev/null 2>&1 || true
}

cleanup() {
  local code=$?
  [ -n "$RECEIVER_PID" ] && kill "$RECEIVER_PID" 2>/dev/null || true
  # La fenêtre de regroupement est un réglage d'instance : on la rend telle
  # qu'on l'a trouvée, y compris sur une exécution interrompue.
  if [ -n "$POLICY_BEFORE" ]; then
    req PATCH /api/notifications/digests "{\"windowMs\":$POLICY_BEFORE}" >/dev/null 2>&1 || true
  fi
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

# ── Lecture de l'état de regroupement ─────────────────────────────────────────
# En base et non par l'API : c'est la source de vérité, et c'est justement ce
# qu'on veut voir survivre à un redémarrage du worker.
GROUP="security.role_changed"

digest_open()  { psql_q "select count(*) from notification_digest_groups where group_key = '$GROUP' and window_ends_at is not null;"; }
digest_held()  { psql_q "select coalesce((select held_count from notification_digest_groups where group_key = '$GROUP'), 0);"; }
digest_items() { psql_q "select count(*) from notification_digest_items where group_key = '$GROUP';"; }

# Attend que le groupe redevienne silencieux — c'est-à-dire qu'une fenêtre se
# soit refermée **sans rien avoir retenu**. C'est la moitié de l'arbitrage : sans
# elle, un incident isolé coûterait éternellement la latence d'une fenêtre.
wait_group_silent() {
  local limit="${1:-120}"
  for _ in $(seq 1 "$limit"); do
    [ "$(digest_open)" = "0" ] && return 0
    sleep 1
  done
  return 1
}

# Ce que le récepteur a vu sur /hook, par nature de charge utile.
hook_all()     { jq -s '[.[] | select(.path == "/hook")] | length' "$RECV"; }
hook_events()  { jq -s '[.[] | select(.path == "/hook") | (.body | fromjson) | select(.type == "event")] | length' "$RECV"; }
hook_digests() { jq -s '[.[] | select(.path == "/hook") | (.body | fromjson) | select(.type == "digest")] | length' "$RECV"; }

# Attend qu'un résumé arrive sur le webhook, ou rend la main au bout du délai.
wait_for_digest() {
  local want="${1:-1}" limit="${2:-90}"
  for _ in $(seq 1 "$limit"); do
    [ "$(hook_digests)" -ge "$want" ] && return 0
    sleep 1
  done
  return 1
}

# Crée `count` cobayes en rôle `viewer` et écrit leurs identifiants dans un
# fichier. Ils ne notifient rien à la création — seul le changement de rôle le
# fait, et c'est lui qu'on tirera en rafale.
make_burst_users() {
  local tag="$1" count="$2" i code
  for i in $(seq 1 "$count"); do
    code=$(req POST /api/admin/users \
      "{\"name\":\"Rafale $tag $i\",\"email\":\"$PREFIX-$tag-$i@example.test\",
        \"password\":\"motdepasse-tres-long\",\"role\":\"viewer\"}")
    case "$code" in 201|409) : ;; *) fail "création du cobaye $tag-$i → HTTP $code : $(cat "$BODY")" ;; esac
  done
  psql_q "select id from users where email like '$PREFIX-$tag-%@example.test' order by email;" \
    > "$WORK/$tag.ids"
  [ "$(grep -c . "$WORK/$tag.ids")" = "$count" ] || fail "$count cobayes attendus pour « $tag »"
}

# Tire une rafale de changements de rôle. Séquentielle et sans passer par `req` :
# on veut la cadence la plus serrée possible, pas un fichier de réponse.
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
  [ "$code" = "201" ] || fail "création de « $label » → HTTP $code : $(cat "$BODY")"
  jq -r .id "$BODY"
}

step "1. Sign-in"
login
pass "signed in as $ADMIN_EMAIL"

# Empreinte de référence : ce script ne doit modifier aucun paramètre d'instance.
SETTINGS_BEFORE=$(psql_q "select md5(value::text) from app_settings where id = 1;")
purge
info "ménage d'une exécution précédente effectué"

step "2. Fenêtre de regroupement"
code=$(req GET /api/notifications/digests)
[ "$code" = "200" ] || fail "GET /api/notifications/digests → HTTP $code : $(cat "$BODY")"
POLICY_BEFORE=$(jq -r '.policy.windowMs' "$BODY")
MIN_WINDOW=$(jq -r '.vocabulary.minWindowMs' "$BODY")
info "fenêtre trouvée : ${POLICY_BEFORE} ms — elle sera restaurée à la fin"

# Le plancher n'est pas zéro, et ce n'est pas un détail : un garde-fou de volume
# désactivable est un garde-fou désactivé.
code=$(req PATCH /api/notifications/digests '{"windowMs":0}')
[ "$code" = "422" ] || fail "fenêtre à zéro : attendu 422, reçu $code"
pass "fenêtre à 0 refusée → 422 (plancher : ${MIN_WINDOW} ms)"

code=$(req PATCH /api/notifications/digests "{\"windowMs\":$VERIF_WINDOW_MS}")
[ "$code" = "200" ] || fail "réglage de la fenêtre → HTTP $code : $(cat "$BODY")"
pass "fenêtre de vérification : $((VERIF_WINDOW_MS / 1000)) s"

step "3. Récepteur local et serveur SMTP jetable"
start_receiver
pass "récepteur HTTP sur le port $RECEIVER_PORT"

docker compose --profile test up -d mailpit >/dev/null 2>&1 \
  || fail "could not start Mailpit (compose profile \"test\")"
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

step "4. Le catalogue est une donnée, pas une liste écrite dans l'écran"
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

step "5. Une configuration incomplète est refusée"
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

step "6. Les quatre canaux se configurent"
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

step "7. Le secret ne ressort de nulle part"
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
  # `grep -c` et non `grep -q` : sous `set -o pipefail`, `grep -q` sort à la
  # première correspondance, `docker compose logs` reçoit un SIGPIPE, et le tube
  # rapporte l'échec du producteur. Sur une assertion **négative** comme celle-ci,
  # ce faux négatif fait **passer** le contrôle alors qu'un secret a fuité — le
  # silence ressemblerait au succès. `grep -c` lit jusqu'au bout.
    if [ "$(docker compose logs "$service" 2>/dev/null | grep -cF 'VERIFSECRET')" != "0" ]; then
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

step "8. Le message d'essai atteint réellement le destinataire"
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

step "9. Chaque canal a rendu le message dans SA forme"
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

step "10. Un canal injoignable ne casse pas l'action notifiée"
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

# La remise se rejoue trois fois avant d'abandonner (5 s puis 10 s) : l'échec
# n'est enregistré qu'au terme, une fois, et non à chaque tentative — sinon
# `consecutive_failures` compterait des paquets perdus au lieu de répondre à
# « depuis quand ce canal ne marche plus ? ». D'où l'attente, plus longue qu'un
# aller-retour réseau.
for _ in $(seq 1 40); do
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

step "11. L'événement a déclenché un envoi, et un seul"
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

step "12. Configurer exige settings:manage"
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
pass "deletion refused → 403"

step "13. Traçabilité"
code=$(req GET "/api/audit-logs?resourceType=notification_channel&pageSize=50")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
for action in notification.channel.created notification.channel.tested notification.delivery.failed; do
  jq -e --arg a "$action" '[.items[] | select(.action == $a)] | length > 0' "$BODY" >/dev/null \
    || fail "action \"$action\" missing from the audit log"
  pass "audit : $action"
done

step "14. Le regroupement : la première alerte part sans délai"
# Les quatre canaux s'abonnent au même événement, celui qu'on sait déclencher à
# volonté. Le canal injoignable est retiré : ses trois tentatives espacées
# retarderaient les remises sans rien prouver de plus.
req DELETE "/api/notifications/channels/$DEAD_ID" >/dev/null
for id in "$SMTP_ID" "$TG_ID" "$DC_ID"; do
  code=$(req PATCH "/api/notifications/channels/$id" '{"events":["security.role_changed"]}')
  [ "$code" = "200" ] || fail "abonnement du canal $id → HTTP $code : $(cat "$BODY")"
done
pass "les quatre canaux sont abonnés à « security.role_changed »"

# Le groupe doit être **silencieux** avant de mesurer. Il ne l'est pas : le
# changement de rôle de l'étape 10 a ouvert une fenêtre. On attend qu'elle se
# referme d'elle-même — et cette attente est déjà une preuve : une fenêtre qui
# se ferme sans rien avoir retenu remet le groupe au silence.
wait_group_silent 120 || fail "the group \"$GROUP\" does not become silent again"
pass "fenêtre précédente refermée sans rien retenir → groupe silencieux"

make_burst_users rafale "$BURST_SIZE"
make_burst_users seul 1
pass "$((BURST_SIZE + 1)) cobayes créés (la création ne notifie rien)"

mark_receiver
curl -s -X DELETE "$MAILPIT_HTTP/api/v1/messages" >/dev/null

STARTED=$(date +%s)
fire_roles operator "$WORK/seul.ids" 1 1
for _ in $(seq 1 40); do
  [ "$(hook_events)" -ge 1 ] && break
  sleep 0.25
done
ELAPSED=$(( $(date +%s) - STARTED ))
[ "$(hook_events)" -ge 1 ] || fail "la première alerte n'est jamais partie"
[ "$ELAPSED" -le 10 ] \
  || fail "la première alerte a mis ${ELAPSED} s — elle a attendu la fenêtre de $((VERIF_WINDOW_MS / 1000)) s"
pass "panne isolée → message reçu en ${ELAPSED} s, sans attendre la fenêtre de $((VERIF_WINDOW_MS / 1000)) s"

jq -s -e '[.[] | select(.path == "/hook") | (.body | fromjson)][0]
          | .type == "event" and .event == "security.role_changed" and (has("items") | not)' \
  "$RECV" >/dev/null || fail "la première alerte n'est pas une alerte unitaire"
pass "c'est bien une alerte unitaire, pas un résumé"

[ "$(digest_open)" = "1" ] || fail "la première alerte n'a pas ouvert de fenêtre"
pass "et elle a ouvert la fenêtre de regroupement"

step "15. $BURST_SIZE événements en rafale ne produisent pas $BURST_SIZE messages"
fire_roles operator "$WORK/rafale.ids" 1 "$BURST_SIZE"

for _ in $(seq 1 30); do
  [ "$(digest_held)" -ge "$BURST_SIZE" ] && break
  sleep 1
done
HELD=$(digest_held)
[ "$HELD" = "$BURST_SIZE" ] || fail "$HELD événement(s) retenu(s) sur $BURST_SIZE attendus"
[ "$(digest_items)" = "$BURST_SIZE" ] || fail "les lignes nommées ne suivent pas le compteur"
pass "$HELD événements retenus en base, chacun avec sa ligne nommée"

[ "$(hook_events)" = "1" ] \
  || fail "$(hook_events) alertes unitaires reçues — la rafale n'a pas été retenue"
pass "aucune des $BURST_SIZE n'est partie séparément : seule la première l'avait été"

wait_for_digest 1 90 || fail "aucun résumé n'est arrivé après la fermeture de la fenêtre"
TOTAL=$(hook_all)
[ "$TOTAL" -le 4 ] || fail "$TOTAL messages pour $((BURST_SIZE + 1)) événements — le regroupement ne tient pas"
pass "$((BURST_SIZE + 1)) événements → $TOTAL message(s) sur le canal : 1 immédiat, $(hook_digests) résumé(s)"

step "16. Le résumé nomme ce qu'il résume"
DIGEST="$WORK/digest.json"
jq -s '[.[] | select(.path == "/hook") | (.body | fromjson) | select(.type == "digest")][0]' \
  "$RECV" > "$DIGEST"

jq -e --argjson n "$BURST_SIZE" '.count == $n and (.items | length) == $n and .omitted == 0' "$DIGEST" \
  >/dev/null || fail "le résumé annonce $(jq -r '.count' "$DIGEST") / $(jq -r '.items|length' "$DIGEST") lignes"
pass "il annonce $BURST_SIZE alertes et en nomme $BURST_SIZE (0 tue)"

# Le cœur de l'exigence : pas un compteur, des noms. On vérifie que trois cobayes
# tirés au hasard de la rafale figurent nommément dans le résumé.
for i in 1 "$((BURST_SIZE / 2))" "$BURST_SIZE"; do
  jq -e --arg m "$PREFIX-rafale-$i@example.test" \
    '[.items[] | select(.label | contains($m))] | length == 1' "$DIGEST" >/dev/null \
    || fail "le cobaye « $PREFIX-rafale-$i@example.test » n'est pas nommé dans le résumé"
done
pass "chaque ligne nomme son compte — cobayes 1, $((BURST_SIZE / 2)) et $BURST_SIZE retrouvés nommément"

jq -e '(.items[0].detail | length) > 0 and (.items[0].occurredAt | length) > 0' "$DIGEST" >/dev/null \
  || fail "les lignes n'ont ni horodatage ni précision"
pass "chaque ligne porte son heure et sa transition : $(jq -r '.items[0].label + " — " + .items[0].detail' "$DIGEST")"

jq -e '(.windowStartedAt | length) > 0 and (.windowEndedAt | length) > 0 and .nextWindowMs > .windowMs' \
  "$DIGEST" >/dev/null || fail "le résumé ne dit pas sur quelle fenêtre il porte"
pass "il dit sa fenêtre ($(jq -r '.windowMs' "$DIGEST") ms) et annonce la suivante, élargie ($(jq -r '.nextWindowMs' "$DIGEST") ms)"

jq -e '(.body | test("partie seule|went out on its own")) and (.body | test("regroupement|grouping"))' "$DIGEST" >/dev/null \
  || fail "le corps du résumé n'explique pas pourquoi il existe"
pass "et il explique l'arbitrage en toutes lettres, pas seulement le nombre"

step "17. Un redémarrage du worker au milieu d'une rafale ne relâche rien"
make_burst_users reprise "$RESTART_BURST_SIZE"
HALF=$((RESTART_BURST_SIZE / 2))
BEFORE_EVENTS=$(hook_events)
BEFORE_DIGESTS=$(hook_digests)

fire_roles operator "$WORK/reprise.ids" 1 "$HALF"
for _ in $(seq 1 20); do
  [ "$(digest_held)" -ge "$HALF" ] && break
  sleep 1
done
[ "$(digest_held)" -ge "$HALF" ] || fail "la première moitié n'a pas été retenue"
pass "$HALF événements retenus, fenêtre ouverte"

docker compose restart worker >/dev/null 2>&1 || fail "redémarrage du worker impossible"
for _ in $(seq 1 60); do
  docker compose logs worker --since 2m 2>/dev/null | grep -q 'digest windows sweep installed' && break
  sleep 1
done
pass "worker redémarré au milieu de la rafale"

# L'état est en base, pas en mémoire : le worker qui revient doit retrouver sa
# fenêtre ouverte et ses retenus, pas repartir de zéro.
[ "$(digest_open)" = "1" ] || fail "la fenêtre a disparu au redémarrage"
[ "$(digest_held)" -ge "$HALF" ] || fail "les événements retenus ont disparu au redémarrage"
pass "au retour : fenêtre toujours ouverte, $(digest_held) événements toujours retenus"

fire_roles operator "$WORK/reprise.ids" "$((HALF + 1))" "$RESTART_BURST_SIZE"
for _ in $(seq 1 30); do
  [ "$(digest_held)" -ge "$RESTART_BURST_SIZE" ] && break
  sleep 1
done
[ "$(digest_held)" -ge "$RESTART_BURST_SIZE" ] \
  || fail "$(digest_held) retenus sur $RESTART_BURST_SIZE après reprise de la rafale"
[ "$(hook_events)" = "$BEFORE_EVENTS" ] \
  || fail "$(( $(hook_events) - BEFORE_EVENTS )) alerte(s) unitaire(s) relâchée(s) par le redémarrage"
pass "aucune alerte relâchée par le redémarrage : 0 message unitaire, tout est toujours retenu"

wait_for_digest "$((BEFORE_DIGESTS + 1))" 150 || fail "le résumé de la rafale interrompue n'est jamais arrivé"
RESUME="$WORK/reprise.json"
jq -s --argjson skip "$BEFORE_DIGESTS" \
  '[.[] | select(.path == "/hook") | (.body | fromjson) | select(.type == "digest")][$skip]' \
  "$RECV" > "$RESUME"
jq -e --argjson n "$RESTART_BURST_SIZE" '.count == $n' "$RESUME" >/dev/null \
  || fail "le résumé annonce $(jq -r '.count' "$RESUME") alertes au lieu de $RESTART_BURST_SIZE"
# Un cobaye d'avant le redémarrage et un d'après, dans le même résumé : c'est la
# preuve que la fenêtre a traversé l'arrêt sans se rompre.
for i in 1 "$RESTART_BURST_SIZE"; do
  jq -e --arg m "$PREFIX-reprise-$i@example.test" \
    '[.items[] | select(.label | contains($m))] | length == 1' "$RESUME" >/dev/null \
    || fail "« $PREFIX-reprise-$i@example.test » manque au résumé"
done
pass "un seul résumé de $RESTART_BURST_SIZE alertes, dont celles d'avant *et* d'après l'arrêt"

step "18. Chaque canal rend le résumé à sa façon"
# E-mail : il liste tout. C'est le seul canal qui le peut, et c'est sa valeur —
# quand Telegram dit « et 44 autres », c'est ici qu'on va lire lesquelles.
MSGS=$(curl -s "$MAILPIT_HTTP/api/v1/messages?limit=50")
MID=$(jq -r --arg n "$BURST_SIZE" \
  '[.messages[] | select(.Subject | contains($n + " × ") and test("résumé|digest"))][0].ID // empty' <<< "$MSGS")
[ -n "$MID" ] || fail "aucun e-mail de résumé dans Mailpit : $(jq -r '[.messages[].Subject] | join(" | ")' <<< "$MSGS")"
MAIL=$(curl -s "$MAILPIT_HTTP/api/v1/message/$MID")
LINES=$(jq -r '.Text' <<< "$MAIL" | grep -c '^• ' || true)
[ "$LINES" = "$BURST_SIZE" ] || fail "l'e-mail liste $LINES lignes sur $BURST_SIZE"
jq -e '.Text | test("autres, non détaillés|more, not detailed") | not' <<< "$MAIL" >/dev/null \
  || fail "l'e-mail tronque alors qu'il n'a pas à le faire"
jq -e '(.HTML | contains("<ol")) and (.Text | contains("<") | not)' <<< "$MAIL" >/dev/null \
  || fail "l'e-mail n'a pas ses deux parties, ou la partie texte contient du HTML"
MHEAD=$(curl -s "$MAILPIT_HTTP/api/v1/message/$MID/headers")
jq -e '.["X-Control-Plane-Digest"][0] == "true"' <<< "$MHEAD" >/dev/null \
  || fail "l'e-mail de résumé ne se déclare pas comme tel dans ses en-têtes"
pass "e-mail : « $(jq -r --arg n "$BURST_SIZE" '[.messages[] | select(.Subject | contains($n + " × "))][0].Subject' <<< "$MSGS") » — les $BURST_SIZE lignes listées, texte + HTML"

# Telegram : court, et il **dit** ce qu'il tait.
TG="$WORK/tg.json"
jq -s '[.[] | select(.method == "POST" and (.path | test("/sendMessage$")))
       | (.body | fromjson) | select(.text | test("résumé|digest"))][0]' "$RECV" > "$TG"
jq -e '.text != null' "$TG" >/dev/null || fail "Telegram n'a reçu aucun résumé"
TG_LINES=$(jq -r '.text' "$TG" | grep -c '^• ' || true)
TG_LEN=$(jq -r '.text | length' "$TG")
[ "$TG_LINES" -le 6 ] || fail "Telegram affiche $TG_LINES lignes : ce n'est plus court"
[ "$TG_LEN" -le 1200 ] || fail "le message Telegram fait $TG_LEN caractères"
jq -e --argjson n "$((BURST_SIZE - 6))" '.text | test("et " + ($n | tostring) + " autres|and " + ($n | tostring) + " more")' "$TG" \
  >/dev/null || fail "Telegram tronque sans dire combien de lignes il tait"
jq -e '.parse_mode == "MarkdownV2"' "$TG" >/dev/null || fail "Telegram : MarkdownV2 absent du résumé"
pass "Telegram : $TG_LINES lignes, $TG_LEN caractères, « et $((BURST_SIZE - 6)) autres » annoncé, MarkdownV2"

# Discord : un embed, la liste dans la description, quinze lignes puis l'aveu.
DC="$WORK/dc.json"
jq -s '[.[] | select(.method == "POST" and (.path | test("/api/webhooks/")))
       | (.body | fromjson) | select(.embeds[0].title | test("résumé|digest"))][0]' "$RECV" > "$DC"
jq -e '.embeds[0].description != null' "$DC" >/dev/null || fail "Discord n'a reçu aucun résumé"
DC_LINES=$(jq -r '.embeds[0].description' "$DC" | grep -c '^• ' || true)
[ "$DC_LINES" = "15" ] || fail "Discord affiche $DC_LINES lignes au lieu de 15"
jq -e --argjson n "$((BURST_SIZE - 15))" '.embeds[0].description | test("et " + ($n | tostring) + " autres|and " + ($n | tostring) + " more")' \
  "$DC" >/dev/null || fail "Discord tronque sans le dire"
jq -e '(.embeds[0].color | type) == "number" and (.embeds[0].footer.text | test("regroupées|grouped"))' "$DC" \
  >/dev/null || fail "Discord : embed sans couleur ni pied de page"
pass "Discord : embed coloré, $DC_LINES lignes en description, « et $((BURST_SIZE - 15)) autres » annoncé"

# Webhook : rien de tronqué. Sa cible est un programme, pas un écran.
jq -e --argjson n "$BURST_SIZE" '(.items | length) == $n and .omitted == 0 and .version == 1' "$DIGEST" \
  >/dev/null || fail "le webhook ne reçoit pas le résumé entier"
jq -s -e '[.[] | select(.path == "/hook") | select(.headers["x-control-plane-digest"] == "true")] | length >= 1' \
  "$RECV" >/dev/null || fail "l'en-tête de routage des résumés manque"
pass "webhook : $BURST_SIZE lignes, aucune tronquée, en-tête X-Control-Plane-Digest: true"

step "19. Ménage"
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

# La fenêtre de regroupement est un réglage, pas un état de test : elle est
# rendue telle qu'on l'a trouvée. Le `trap` le fait aussi sur interruption ; ici
# on le fait tôt pour pouvoir le **vérifier**.
code=$(req PATCH /api/notifications/digests "{\"windowMs\":$POLICY_BEFORE}")
[ "$code" = "200" ] || fail "restauration de la fenêtre → HTTP $code"
req GET /api/notifications/digests >/dev/null
RESTORED=$(jq -r '.policy.windowMs' "$BODY")
[ "$RESTORED" = "$POLICY_BEFORE" ] \
  || fail "fenêtre restaurée à $RESTORED ms au lieu de $POLICY_BEFORE ms"
POLICY_BEFORE=""
pass "fenêtre de regroupement rendue dans l'état trouvé (${RESTORED} ms)"

printf '\n\033[32m✓ Couche de notifications vérifiée.\033[0m\n'
printf '\033[2m  Écran : %s/admin/settings/notifications\033[0m\n' "$BASE_URL"
printf '\033[2m  Serveur SMTP jetable : docker compose --profile test up -d mailpit (http://localhost:8025)\033[0m\n'
printf '\033[2m  Non exercé contre un vrai service : api.telegram.org et discord.com ont été\033[0m\n'
printf '\033[2m  remplacés par un récepteur local. SMTP, lui, a parlé à un vrai serveur (Mailpit).\033[0m\n'
printf '\033[2m  Regroupement : %s + %s événements en rafale, redémarrage du worker au milieu,\033[0m\n' \
  "$BURST_SIZE" "$RESTART_BURST_SIZE"
printf '\033[2m  et pas une alerte relâchée — tout en gardant la première panne immédiate.\033[0m\n\n'
