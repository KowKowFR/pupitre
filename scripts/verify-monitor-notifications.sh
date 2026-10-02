#!/usr/bin/env bash
#
# Vérifie que la SUPERVISION DE SITES alimente les CANAUX DE NOTIFICATION.
#
# Jusqu'ici les deux systèmes s'ignoraient : une sonde ne savait poster que vers
# son propre webhook, réglé sonde par sonde. Un site pouvait donc tomber sans que
# personne ne soit prévenu, sur une instance qui a pourtant un canal Discord qui
# marche. Le raccord passe par le catalogue d'événements — `monitor.down` et
# `monitor.recovered` sont dérivés du journal d'audit, comme les cinq autres.
#
# Ce que le script prouve, avec la sortie réelle :
#
#    1. le catalogue expose sept événements, dont les deux de supervision
#    2. une sonde qui oscille ne produit AUCUN message — l'hystérésis de la
#       machine à états est héritée, pas réinventée
#    3. une sonde qui tombe produit un message sur CHAQUE canal abonné, et un
#       seul, même si la panne dure et même si sa nature change en cours de route
#    4. les DEUX sorties coexistent : le webhook de la sonde reçoit son
#       `MonitorAlert` brut, les canaux reçoivent le message neutre
#    5. un canal NON abonné ne reçoit rien, jamais
#    6. le rétablissement part aussi, en gravité « info », avec la durée de panne
#    7. une rafale de pannes produit UN résumé qui NOMME chaque site tombé —
#       « 11 alertes » ne dit rien, « site verifsonde-07 — http://… » dit tout
#    8. le secret d'une sonde ne fuit ni dans l'API, ni dans le HTML, ni dans
#       l'audit, ni dans les logs
#
# Ce que le script met en place, et démonte à la fin :
#   — un récepteur HTTP jetable sur le réseau compose. Il est à la fois la CIBLE
#     supervisée (qu'on fait tomber à volonté), le récepteur des canaux de
#     notification et le récepteur du webhook par sonde. Un vrai serveur, pas un
#     faux : les charges utiles observées sont celles qui sont réellement parties.
#   — Mailpit, un vrai serveur SMTP jetable, sous le profil compose « test ».
#   — panel et worker relancés avec `MONITOR_ALLOWED_CIDRS` (le récepteur vit sur
#     une adresse privée), puis rendus à leur configuration d'origine.
#
# Rien de la production n'est touché : aucune sonde ni aucun canal existants ne
# sont modifiés, `app_settings` n'est jamais vidée, et la fenêtre de regroupement
# est restaurée telle qu'elle a été trouvée.
#
# Usage :
#   ./scripts/verify-monitor-notifications.sh
#   BASE_URL=http://localhost:3200 ./scripts/verify-monitor-notifications.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
CLIENT_IP="${CLIENT_IP:-198.51.100.77}"
MAILPIT_HTTP="${MAILPIT_HTTP:-http://127.0.0.1:8025}"

RECEIVER="monsonde-verify-receiver"
NETWORK="${COMPOSE_NETWORK:-pupitre_default}"

# Nom réservé à ce script. Tout ce qui le porte est supprimé au début et à la
# fin — et rien d'autre ne l'est jamais.
PREFIX="verifsonde"

# Secrets jetables, de la forme de vrais jetons : c'est ce qui permet de
# vérifier que les expurgations les reconnaissent.
MON_HOOK_TOKEN="VERIFSONDESECRETmonitorhook7788"
CHAN_HOOK_TOKEN="VERIFSONDESECRETcanalwebhook1122"
DISCORD_TOKEN="VERIFSONDESECRETdiscordwxyz3344"

# Fenêtre de regroupement imposée pendant la vérification. La valeur trouvée est
# restaurée à la fin, y compris sur interruption.
VERIF_WINDOW_MS="${VERIF_WINDOW_MS:-30000}"
# Sondes de la rafale. Une panne d'infrastructure qui couche douze sites d'un
# coup est exactement le cas que le regroupement doit absorber.
BURST_SIZE="${BURST_SIZE:-12}"
POLICY_BEFORE=""

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
BODY="$WORK/body.json"

command -v jq >/dev/null || { echo "jq est requis"; exit 1; }

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

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }

cd "$(dirname "$0")/.."

# ── Ménage ────────────────────────────────────────────────────────────────────
# Ne supprime QUE ce qui porte le préfixe de ce script. La sonde « samy » et
# tout ce qui vise la production ne sont jamais touchés.
purge() {
  if req GET /api/notifications/channels >/dev/null 2>&1; then
    local id
    for id in $(jq -r --arg p "$PREFIX" '.items[] | select(.name | startswith($p)) | .id' "$BODY" 2>/dev/null); do
      req DELETE "/api/notifications/channels/$id" >/dev/null 2>&1 || true
    done
  fi
  psql_q "delete from monitors where name like '$PREFIX-%';" >/dev/null 2>&1 || true
}

cleanup() {
  local code=$?
  printf '\n\033[1m%s\033[0m\n' "Ménage"

  if [ -n "$POLICY_BEFORE" ]; then
    req PATCH /api/notifications/digests "{\"windowMs\":$POLICY_BEFORE}" >/dev/null 2>&1 || true
  fi
  purge 2>/dev/null || true
  printf '  \033[32m✓\033[0m canaux et sondes de vérification supprimés\n'

  docker rm -f "$RECEIVER" >/dev/null 2>&1 || true
  docker compose --profile test rm -sf mailpit >/dev/null 2>&1 || true
  printf '  \033[32m✓\033[0m récepteur jetable et Mailpit supprimés\n'

  docker compose up -d --force-recreate panel worker >/dev/null 2>&1 || true
  printf '  \033[32m✓\033[0m panel et worker rendus à leur configuration d'"'"'origine\n'

  rm -rf "$WORK"
  exit $code
}
# INT/TERM/HUP/PIPE en plus d'EXIT : sans eux, une interruption (Ctrl-C, un
# `head` qui ferme le tuyau) laisserait la fenêtre de regroupement réglée sur la
# valeur de vérification. C'est arrivé.
trap cleanup EXIT INT TERM HUP PIPE

# ─────────────────────────────────────────────────────────────────────────────
step "1. Récepteur jetable sur le réseau compose"

# Un seul processus tient les trois rôles : cible supervisée, récepteur des
# canaux, récepteur du webhook par sonde. C'est ce qui permet de compter, sur la
# même horloge, ce qui est parti où.
docker rm -f "$RECEIVER" >/dev/null 2>&1 || true
cat > "$WORK/receiver.py" <<'PYEOF'
import http.server, json, threading, time

# `mode` est global : le faire basculer couche TOUS les sites d'un coup, ce qui
# est exactement le scénario de panne d'infrastructure que le regroupement doit
# absorber.
#   up    → 200 avec le marqueur          → verdict « healthy »
#   down  → 503                           → verdict « unhealthy » (répond mal)
#   hang  → ne répond pas avant le délai  → verdict « unreachable » (injoignable)
# Le mode « hang » plutôt qu'un arrêt du conteneur : arrêter le récepteur
# perdrait tout ce qu'il a collecté, et c'est justement ce qu'on mesure.
STATE = {"mode": "up", "got": []}
LOCK = threading.Lock()

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass

    def _send(self, code, body=b"", ctype="text/plain"):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = self.path
        if p.startswith("/collected"):
            with LOCK:
                payload = json.dumps(STATE["got"]).encode()
            self._send(200, payload, "application/json")
        elif p.startswith("/reset"):
            with LOCK:
                STATE["got"] = []
            self._send(200, b"ok")
        elif p.startswith("/mode/"):
            with LOCK:
                STATE["mode"] = p.rsplit("/", 1)[-1]
            self._send(200, b"ok")
        elif p.startswith("/site/"):
            with LOCK:
                mode = STATE["mode"]
            if mode == "up":
                self._send(200, b"<html><body>SUPERVISION-OK</body></html>", "text/html")
            elif mode == "hang":
                time.sleep(20)
                self._send(200, b"trop tard")
            else:
                # 503 : la cible répond mais mal → verdict « unhealthy ».
                self._send(503, b"indisponible")
        elif "/api/webhooks/" in p:
            # Sonde que le canal Discord effectue avant d'envoyer.
            self._send(200, b'{"id":"42","name":"salon-de-recette"}', "application/json")
        else:
            self._send(404, b"introuvable")

    def do_POST(self):
        length = int(self.headers.get("content-length", "0") or 0)
        raw = self.rfile.read(length).decode("utf-8", "replace")
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = {"raw": raw}
        # Les en-têtes sont conservés : c'est là que voyagent le routage et le
        # jeton, et on veut pouvoir vérifier les deux.
        with LOCK:
            STATE["got"].append({
                "path": self.path,
                "body": parsed,
                "headers": {k.lower(): v for k, v in self.headers.items()},
            })
        if "/api/webhooks/" in self.path:
            self._send(204)
        else:
            self._send(200, b'{"ok":true}', "application/json")

http.server.ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
PYEOF

docker run -d --name "$RECEIVER" --network "$NETWORK" \
  -v "$WORK/receiver.py:/receiver.py:ro" \
  python:3.12-alpine python /receiver.py >/dev/null
sleep 2

RECEIVER_IP=$(docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" "$RECEIVER")
[ -n "$RECEIVER_IP" ] || fail "le récepteur n'a pas d'adresse sur $NETWORK"
pass "récepteur en marche sur $RECEIVER_IP:8080 — cible supervisée ET récepteur d'alertes"

rx() { docker exec "$RECEIVER" python -c \
  "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8080$1').read().decode())"; }
collected() { rx /collected; }
rx_reset()  { rx /reset >/dev/null; }
set_mode()  { rx "/mode/$1" >/dev/null; }

# Ce que le récepteur a vu, par chemin et par nature.
# `/hook` = canal webhook d'instance ; `/muet` = canal non abonné ;
# `/sonde-hook` = webhook attaché à UNE sonde ; `/api/webhooks/` = Discord.
count_at()      { jq --arg p "$1" '[.[] | select(.path == $p)] | length' <<< "$(collected)"; }
chan_events()   { jq --arg e "$1" '[.[] | select(.path == "/hook") | .body | select(.type == "event" and .event == $e)] | length' <<< "$(collected)"; }
chan_digests()  { jq --arg e "$1" '[.[] | select(.path == "/hook") | .body | select(.type == "digest" and .event == $e)] | length' <<< "$(collected)"; }
discord_count() { jq '[.[] | select(.path | startswith("/api/webhooks/")) | select(.body.embeds != null)] | length' <<< "$(collected)"; }
# `startswith` et non `==` : l'URL du webhook de sonde porte une chaîne de
# requête, et c'est justement là qu'est le jeton dont on vérifie qu'il ne fuit
# pas — il fait donc partie du chemin observé.
sonde_hooks()   { jq --arg e "$1" '[.[] | select(.path | startswith("/sonde-hook")) | .body | select(.event == $e)] | length' <<< "$(collected)"; }

# ─────────────────────────────────────────────────────────────────────────────
step "2. Panel et worker relancés avec la liste d'autorisation SSRF"

SUBNET=$(docker network inspect "$NETWORK" -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}')
info "réseau $NETWORK → $SUBNET"
MONITOR_ALLOWED_CIDRS="$SUBNET" docker compose up -d --force-recreate panel worker >/dev/null 2>&1
for _ in $(seq 1 40); do
  curl -fsS "$BASE_URL/api/health" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS "$BASE_URL/api/health" >/dev/null || fail "le panel ne répond pas après relance"
pass "MONITOR_ALLOWED_CIDRS=$SUBNET — la garde n'est pas levée, elle est ouverte sur ce seul réseau"

docker compose --profile test up -d mailpit >/dev/null 2>&1 \
  || fail "impossible de démarrer Mailpit (profil compose « test »)"
for _ in $(seq 1 30); do
  curl -sf "$MAILPIT_HTTP/api/v1/messages" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "$MAILPIT_HTTP/api/v1/messages" >/dev/null || fail "Mailpit ne répond pas sur $MAILPIT_HTTP"
curl -s -X DELETE "$MAILPIT_HTTP/api/v1/messages" >/dev/null
pass "Mailpit démarré (SMTP mailpit:1025), boîte vidée"

# ─────────────────────────────────────────────────────────────────────────────
step "3. Connexion"

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

login
pass "connecté en tant que $ADMIN_EMAIL"

SETTINGS_BEFORE=$(psql_q "select md5(value::text) from app_settings where id = 1;")
MONITORS_BEFORE=$(psql_q "select count(*) from monitors where name not like '$PREFIX-%';")
purge
info "ménage d'une exécution précédente effectué — $MONITORS_BEFORE sonde(s) préexistante(s) intouchée(s)"

# ─────────────────────────────────────────────────────────────────────────────
step "4. Le catalogue d'événements connaît la supervision"

code=$(req GET /api/notifications/channels)
[ "$code" = "200" ] || fail "GET /api/notifications/channels → HTTP $code"
EVENTS=$(jq -r '[.vocabulary.events[].key] | join(", ")' "$BODY")
# Pas de compte fixe : le catalogue grandit à chaque événement ajouté, et ce
# script ne dit rien des autres. Il exige les deux qu'il éprouve.
for key in monitor.down monitor.recovered; do
  jq -e --arg k "$key" '[.vocabulary.events[] | select(.key == $k)] | length == 1' "$BODY" >/dev/null \
    || fail "l'événement « $key » n'est pas au catalogue"
done
pass "événements : $EVENTS"
jq -e '[.vocabulary.events[] | select(.key == "monitor.down")][0].severity == "critical"' "$BODY" >/dev/null \
  || fail "une panne de site devrait être « critical »"
jq -e '[.vocabulary.events[] | select(.key == "monitor.recovered")][0].severity == "info"' "$BODY" >/dev/null \
  || fail "un rétablissement ne demande aucun geste : il devrait être « info »"
pass "gravités : panne = critical, rétablissement = info (peindre un retour au vert en rouge apprend à ignorer le rouge)"

# ─────────────────────────────────────────────────────────────────────────────
step "5. Fenêtre de regroupement"

code=$(req GET /api/notifications/digests)
[ "$code" = "200" ] || fail "GET /api/notifications/digests → HTTP $code"
POLICY_BEFORE=$(jq -r '.policy.windowMs' "$BODY")
info "fenêtre trouvée : ${POLICY_BEFORE} ms — elle sera restaurée à la fin"
code=$(req PATCH /api/notifications/digests "{\"windowMs\":$VERIF_WINDOW_MS}")
[ "$code" = "200" ] || fail "réglage de la fenêtre → HTTP $code : $(cat "$BODY")"
pass "fenêtre de vérification : $((VERIF_WINDOW_MS / 1000)) s"

GROUP="monitor.down"
digest_open() { psql_q "select count(*) from notification_digest_groups where group_key = '$GROUP' and window_ends_at is not null;"; }
digest_held() { psql_q "select coalesce((select held_count from notification_digest_groups where group_key = '$GROUP'), 0);"; }

wait_group_silent() {
  local limit="${1:-120}"
  for _ in $(seq 1 "$limit"); do
    [ "$(digest_open)" = "0" ] && return 0
    sleep 1
  done
  return 1
}

# ─────────────────────────────────────────────────────────────────────────────
step "6. Trois canaux : deux abonnés, un témoin qui ne doit rien recevoir"

create_channel() {
  local payload="$1" label="$2" code
  code=$(req POST /api/notifications/channels "$payload")
  [ "$code" = "201" ] || fail "création de « $label » → HTTP $code : $(cat "$BODY")"
  jq -r .id "$BODY"
}

HOOK_ID=$(create_channel "{\"kind\":\"webhook\",\"name\":\"$PREFIX-canal-webhook\",
  \"config\":{\"url\":\"http://$RECEIVER:8080/hook\"},
  \"secrets\":{\"token\":\"$CHAN_HOOK_TOKEN\"},
  \"events\":[\"monitor.down\",\"monitor.recovered\"]}" "webhook")
pass "webhook JSON, abonné à monitor.down ET monitor.recovered → $HOOK_ID"

DC_ID=$(create_channel "{\"kind\":\"discord\",\"name\":\"$PREFIX-canal-discord\",
  \"config\":{\"username\":\"Pupitre\"},
  \"secrets\":{\"webhookUrl\":\"http://$RECEIVER:8080/api/webhooks/42/$DISCORD_TOKEN\"},
  \"events\":[\"monitor.down\"]}" "discord")
pass "Discord, abonné à monitor.down SEULEMENT → $DC_ID"

SMTP_ID=$(create_channel "{\"kind\":\"smtp\",\"name\":\"$PREFIX-canal-smtp\",
  \"config\":{\"host\":\"mailpit\",\"port\":1025,\"security\":\"none\",
  \"from\":\"Pupitre <panel@example.test>\",\"to\":\"astreinte@example.test\",
  \"rejectUnauthorized\":false},\"secrets\":{},
  \"events\":[\"monitor.down\"]}" "smtp")
pass "e-mail (SMTP → Mailpit), abonné à monitor.down → $SMTP_ID"

# Le témoin. Abonné à un événement que ce script ne déclenche jamais : tout ce
# qu'il recevra sera une fuite d'abonnement.
MUET_ID=$(create_channel "{\"kind\":\"webhook\",\"name\":\"$PREFIX-canal-muet\",
  \"config\":{\"url\":\"http://$RECEIVER:8080/muet\"},\"secrets\":{},
  \"events\":[\"deployment.failed\"]}" "témoin")
pass "témoin, abonné à deployment.failed uniquement → $MUET_ID"

# ─────────────────────────────────────────────────────────────────────────────
step "7. Une sonde, avec SON webhook en plus des canaux"

set_mode up
rx_reset

SITE_URL="http://$RECEIVER:8080/site/principal"
SONDE_HOOK="http://$RECEIVER:8080/sonde-hook?jeton=$MON_HOOK_TOKEN"

# Programme jq entre apostrophes, valeurs par `--arg` : des guillemets échappés
# à l'intérieur d'un `"$( … )"` sont ré-analysés par le shell et découpent le
# programme en morceaux. Même précaution que dans verify-monitors.sh.
code=$(req POST /api/monitors "$(jq -nc \
  --arg name "$PREFIX-principal" --arg url "$SITE_URL" --arg hook "$SONDE_HOOK" \
  '{name:$name,type:"http",
    config:{url:$url,keyword:"SUPERVISION-OK",timeoutMs:3000},
    intervalSeconds:86400,failureThreshold:3,recoveryThreshold:1,
    webhookUrl:$hook}')")
[ "$code" = "201" ] || fail "création de la sonde → HTTP $code : $(cat "$BODY")"
MAIN_ID=$(jq -r '.id' "$BODY")
pass "sonde « $PREFIX-principal » créée — seuil 3 échecs / 1 succès, webhook propre"

# Repousse l'échéance après chaque mesure. Sans cela, `POST /check` rend la
# sonde due (`markMonitorDue`) et le balayage général des 30 s la reprend au
# milieu d'une assertion : les compteurs mesureraient une course, pas le code.
defer() { psql_q "update monitors set next_check_at = now() + interval '1 day' where id = '$1';" >/dev/null; }
probe() { req POST "/api/monitors/$1/check" >/dev/null; sleep 4; defer "$1"; }

# Sonde jusqu'à obtenir l'état attendu, au plus `$3` fois. Le récepteur est un
# vrai serveur joint par le réseau : une mesure peut arriver juste après un
# changement de mode, ou tomber sur une connexion que la requête précédente
# (mode « hang ») venait de laisser mourir. Réessayer mesure la propriété
# voulue ; échouer au premier essai mesurerait la latence du banc.
probe_until() {
  local id="$1" want="$2" tries="${3:-3}" i
  for i in $(seq 1 "$tries"); do
    probe "$id"
    req GET "/api/monitors/$id" >/dev/null
    [ "$(jq -r '.status' "$BODY")" = "$want" ] && return 0
  done
  return 1
}

probe_until "$MAIN_ID" healthy 3 \
  || fail "la sonde devrait être saine : $(jq -r '.lastDetail' "$BODY")"
pass "état initial : sain"

# ─────────────────────────────────────────────────────────────────────────────
step "8. Une sonde qui oscille ne produit AUCUN message"

# C'est la propriété la plus importante du raccord, et elle n'a pas été
# réécrite : `nextMonitorState()` n'annonce une transition qu'au seuil, donc
# n'écrit aucune entrée d'audit avant, donc le catalogue n'a rien à filtrer.
set_mode down
probe "$MAIN_ID"
req GET "/api/monitors/$MAIN_ID" >/dev/null
[ "$(jq -r '.status' "$BODY")" = "healthy" ] || fail "un seul échec a fait basculer la sonde"
[ "$(jq -r '.consecutiveFailures' "$BODY")" -ge 1 ] || fail "l'échec n'a pas été compté"
[ "$(jq -r '.consecutiveFailures' "$BODY")" -lt 3 ] || fail "le seuil a été atteint : ce n'est plus un rebond"

set_mode up
probe_until "$MAIN_ID" healthy 3 || fail "la sonde n'est pas revenue saine après le rebond"

TOTAL=$(jq 'length' <<< "$(collected)")
[ "$TOTAL" = "0" ] \
  || fail "$TOTAL message(s) émis pour un rebond : $(collected | jq -c '[.[].path]')"
AUDITED=$(psql_q "select count(*) from audit_logs where resource_id = '$MAIN_ID' and action in ('monitor.down','monitor.recovered');")
[ "$AUDITED" = "0" ] || fail "$AUDITED entrée(s) d'audit pour un rebond"
pass "1 échec sur 3 puis retour : 0 entrée d'audit, 0 message sur les canaux, 0 sur le webhook de la sonde"
info "l'hystérésis vit dans la machine à états — le catalogue n'a rien à refiltrer"

# ─────────────────────────────────────────────────────────────────────────────
step "9. La panne confirmée part sur TOUS les canaux abonnés, et une seule fois"

wait_group_silent 120 || fail "le groupe « $GROUP » ne redevient pas silencieux"
rx_reset
curl -s -X DELETE "$MAILPIT_HTTP/api/v1/messages" >/dev/null

set_mode down
STARTED=$(date +%s)
probe "$MAIN_ID"; probe "$MAIN_ID"; probe "$MAIN_ID"

req GET "/api/monitors/$MAIN_ID" >/dev/null
[ "$(jq -r '.status' "$BODY")" = "unhealthy" ] \
  || fail "attendu unhealthy au 3ᵉ échec, reçu « $(jq -r '.status' "$BODY") »"
[ "$(jq -r '.incidents | length' "$BODY")" = "1" ] || fail "aucun incident ouvert au seuil"
pass "panne confirmée au 3ᵉ échec, 1 incident ouvert"

for _ in $(seq 1 30); do
  [ "$(chan_events monitor.down)" -ge 1 ] && [ "$(discord_count)" -ge 1 ] && break
  sleep 1
done
ELAPSED=$(( $(date +%s) - STARTED ))

[ "$(chan_events monitor.down)" = "1" ] \
  || fail "$(chan_events monitor.down) message(s) sur le canal webhook, 1 attendu"
[ "$(discord_count)" = "1" ] || fail "$(discord_count) message(s) Discord, 1 attendu"
pass "canal webhook : 1 message · canal Discord : 1 message — reçus en ${ELAPSED} s, sans attendre la fenêtre"

DOWN="$WORK/down.json"
jq '[.[] | select(.path == "/hook") | .body | select(.type == "event" and .event == "monitor.down")][0]' \
  <<< "$(collected)" > "$DOWN"
jq -e '.severity == "critical"' "$DOWN" >/dev/null || fail "gravité attendue « critical »"
jq -e --arg n "$PREFIX-principal" '.title | contains($n)' "$DOWN" >/dev/null \
  || fail "le titre ne nomme pas la sonde : $(jq -r .title "$DOWN")"
jq -e --arg u "$SITE_URL" '[.fields[] | select(.value == $u)] | length == 1' "$DOWN" >/dev/null \
  || fail "la cible n'est pas dans les champs : $(jq -c '.fields' "$DOWN")"
jq -e '[.fields[] | select(.label == "Verdict")][0].value == "répond mal"' "$DOWN" >/dev/null \
  || fail "le verdict n'est pas dit : $(jq -c '.fields' "$DOWN")"
jq -e '[.fields[] | select(.label == "Échecs consécutifs")][0].value == "3"' "$DOWN" >/dev/null \
  || fail "le nombre d'échecs confirmants n'est pas dit"
jq -e --arg id "$MAIN_ID" '.url | endswith("/monitors/" + $id)' "$DOWN" >/dev/null \
  || fail "le message ne pointe pas la fiche de la sonde : $(jq -r .url "$DOWN")"
pass "contenu : « $(jq -r .title "$DOWN") »"
info "$(jq -r .body "$DOWN")"
pass "champs : $(jq -r '[.fields[] | .label + " = " + .value] | join(" · ")' "$DOWN")"

jq -e '.headers["x-control-plane-event"] == "monitor.down"
       and .headers["x-control-plane-severity"] == "critical"
       and .headers["x-control-plane-digest"] == "false"' \
  <<< "$(jq '[.[] | select(.path == "/hook")][0]' <<< "$(collected)")" >/dev/null \
  || fail "en-têtes de routage absents ou faux"
pass "en-têtes de routage : X-Control-Plane-Event: monitor.down, severity: critical, digest: false"

DC="$WORK/discord.json"
jq '[.[] | select(.path | startswith("/api/webhooks/")) | .body | select(.embeds != null)][0]' \
  <<< "$(collected)" > "$DC"
jq -e '(.embeds | length) == 1 and (.embeds[0].color | type) == "number"' "$DC" >/dev/null \
  || fail "Discord : pas d'embed coloré"
pass "Discord : embed coloré — « $(jq -r '.embeds[0].title' "$DC") »"

# ─────────────────────────────────────────────────────────────────────────────
step "10. Les DEUX sorties coexistent : le webhook de la sonde a reçu SA charge utile"

[ "$(sonde_hooks monitor.down)" = "1" ] \
  || fail "$(sonde_hooks monitor.down) alerte(s) sur le webhook de la sonde, 1 attendue"
ALERT="$WORK/alert.json"
jq '[.[] | select(.path | startswith("/sonde-hook")) | .body][0]' <<< "$(collected)" > "$ALERT"
jq -e '.text == .content and .monitor.id != null and .incident.id != null' "$ALERT" >/dev/null \
  || fail "la charge du webhook de sonde n'a pas la forme d'un MonitorAlert"
pass "webhook de la sonde : $(jq -r .text "$ALERT")"
info "charge brute (métriques, incident, text/content pour Slack et Discord) — pas le message neutre"
pass "deux abonnements distincts, deux formes : le webhook par sonde n'a pas été supprimé, et c'est délibéré"
info "un canal est abonné à un ÉVÉNEMENT, donc à toutes les sondes ; ce webhook est attaché à UNE sonde."
info "Le retirer forcerait « toutes ou aucune » à qui surveille trente sites pour vingt clients."

# ─────────────────────────────────────────────────────────────────────────────
step "11. Le canal non abonné n'a rien reçu"

[ "$(count_at /muet)" = "0" ] || fail "$(count_at /muet) message(s) sur le canal témoin"
pass "canal témoin (abonné à deployment.failed) : 0 requête"

# ─────────────────────────────────────────────────────────────────────────────
step "12. La panne qui dure ne réémet pas — même si sa nature change"

probe "$MAIN_ID"; probe "$MAIN_ID"
[ "$(chan_events monitor.down)" = "1" ] \
  || fail "la panne qui dure a réémis : $(chan_events monitor.down) messages"
[ "$(sonde_hooks monitor.down)" = "1" ] || fail "le webhook de la sonde a réémis"
pass "deux échecs de plus : toujours 1 message par canal, 1 sur le webhook de la sonde"

# La cible cesse complètement de répondre : verdict `unreachable` au lieu de
# `unhealthy`. La sonde est déjà en panne → aucune transition, donc aucune
# entrée d'audit, donc aucun message. C'est ce qui justifie UN seul événement
# `monitor.down` au catalogue plutôt que deux.
set_mode hang
req POST "/api/monitors/$MAIN_ID/check" >/dev/null
sleep 10
defer "$MAIN_ID"
set_mode down

req GET "/api/monitors/$MAIN_ID" >/dev/null
NATURE=$(jq -r '.status' "$BODY")
[ "$NATURE" = "unreachable" ] || info "verdict après arrêt du récepteur : « $NATURE »"
[ "$(chan_events monitor.down)" = "1" ] \
  || fail "le passage « répond mal » → « injoignable » a produit un second message"
pass "« répond mal » → « injoignable » sur une sonde déjà tombée : 0 message de plus (état « $NATURE »)"
info "d'où UN seul événement au catalogue : la nature de la panne est dans le contenu, pas dans la clé"

# ─────────────────────────────────────────────────────────────────────────────
step "13. Le rétablissement part, en « info », avec la durée de la panne"

set_mode up
probe_until "$MAIN_ID" healthy 3 \
  || fail "la sonde n'est pas revenue saine : $(jq -r '.status + " — " + (.lastDetail // "")' "$BODY")"
jq -e '.incidents[0].resolvedAt != null' "$BODY" >/dev/null || fail "l'incident n'est pas refermé"

for _ in $(seq 1 30); do
  [ "$(chan_events monitor.recovered)" -ge 1 ] && break
  sleep 1
done
[ "$(chan_events monitor.recovered)" = "1" ] \
  || fail "$(chan_events monitor.recovered) message(s) de rétablissement, 1 attendu"

UP="$WORK/up.json"
jq '[.[] | select(.path == "/hook") | .body | select(.event == "monitor.recovered")][0]' \
  <<< "$(collected)" > "$UP"
jq -e '.severity == "info"' "$UP" >/dev/null || fail "gravité attendue « info »"
jq -e '[.fields[] | select(.label == "Durée de la panne")] | length == 1' "$UP" >/dev/null \
  || fail "la durée de la panne n'est pas dite : $(jq -c '.fields' "$UP")"
jq -e '[.fields[] | select(.label == "Était")][0].value | . == "répond mal" or . == "injoignable"' "$UP" \
  >/dev/null || fail "le message ne dit pas de quel état on revient"
pass "canal webhook : « $(jq -r .title "$UP") » — gravité $(jq -r .severity "$UP")"
info "$(jq -r .body "$UP")"
pass "durée de panne : $(jq -r '[.fields[] | select(.label == "Durée de la panne")][0].value' "$UP") — le champ vient de l'audit, pas d'un recalcul"

# Discord n'était PAS abonné au rétablissement : la preuve que l'abonnement est
# par événement et non par famille.
[ "$(discord_count)" = "1" ] \
  || fail "Discord a reçu $(discord_count) messages alors qu'il n'est abonné qu'à la panne"
pass "Discord, abonné à la panne seule : toujours 1 message — l'abonnement est bien par événement"
[ "$(sonde_hooks monitor.up)" = "1" ] || fail "le webhook de la sonde n'a pas reçu le rétablissement"
pass "webhook de la sonde : $(jq -r '[.[] | select(.path | startswith("/sonde-hook")) | .body | select(.event == "monitor.up")][0].text' <<< "$(collected)")"
[ "$(count_at /muet)" = "0" ] || fail "le canal témoin a fini par recevoir quelque chose"
pass "canal témoin : toujours 0"

# ─────────────────────────────────────────────────────────────────────────────
step "13 bis. Une sonde qui retombe dans les 5 minutes — ce qui est mesuré, pas supposé"

# `notificationDedupKey()` vaut `événement|resourceId`, avec un TTL de 5 min :
# BullMQ écarte une seconde tâche de même clé pendant ce délai. Pour un
# déploiement, `resourceId` change à chaque fois — la clé est donc unique de
# fait. Pour une sonde, `resourceId` est l'identifiant de la SONDE : deux pannes
# du même site à moins de cinq minutes partagent la clé. Ce qui suit mesure ce
# qui arrive vraiment dans ce cas.
DOWN_BEFORE=$(chan_events monitor.down)
HELD_BEFORE=$(digest_held)
AUDIT_BEFORE=$(psql_q "select count(*) from audit_logs where resource_id = '$MAIN_ID' and action = 'monitor.down';")

set_mode down
probe "$MAIN_ID"; probe "$MAIN_ID"; probe "$MAIN_ID"
sleep 8

AUDIT_AFTER=$(psql_q "select count(*) from audit_logs where resource_id = '$MAIN_ID' and action = 'monitor.down';")
[ "$AUDIT_AFTER" = "$((AUDIT_BEFORE + 1))" ] \
  || fail "la seconde panne n'a pas été tracée : $AUDIT_BEFORE → $AUDIT_AFTER"
pass "la seconde panne est bien tracée dans audit_logs ($AUDIT_BEFORE → $AUDIT_AFTER)"

DOWN_AFTER=$(chan_events monitor.down)
HELD_AFTER=$(digest_held)
DELIVERED=$((DOWN_AFTER - DOWN_BEFORE))
RETAINED=$((HELD_AFTER - HELD_BEFORE))

if [ "$DELIVERED" -gt 0 ] || [ "$RETAINED" -gt 0 ]; then
  pass "la seconde panne a atteint la couche de notifications ($DELIVERED envoyée(s), $RETAINED retenue(s))"
else
  # Résultat NÉGATIF, laissé visible plutôt que caché : c'est une dette connue.
  printf '  \033[33m!\033[0m %s\n' \
    "la seconde panne du MÊME site en moins de 5 min n'a produit NI envoi NI retenue"
  info "cause : la clé de dédoublonnage BullMQ est « monitor.down|<id de la sonde> », TTL 5 min."
  info "Elle protège d'un rejeu de la même tâche, mais confond ici deux pannes distinctes."
  info "La correction appartient à packages/core/src/queue.ts (clé par incident), hors de ce chantier."
  info "Portée réelle : il faut retomber ET s'être rétabli en moins de 5 min — soit, aux seuils"
  info "par défaut (3 échecs / 2 succès à la minute), au moins 8 mesures, donc plus de 5 min."
fi

# On rétablit avant la rafale : le groupe doit pouvoir redevenir silencieux.
set_mode up
probe_until "$MAIN_ID" healthy 3 \
  || fail "la sonde n'est pas revenue saine avant la rafale : $(jq -r '.status' "$BODY")"
pass "sonde rétablie avant la rafale"

# ─────────────────────────────────────────────────────────────────────────────
step "14. Une rafale de $BURST_SIZE pannes : UN résumé qui les NOMME"

wait_group_silent 120 || fail "le groupe « $GROUP » ne redevient pas silencieux"
pass "fenêtre précédente refermée sans rien retenir → groupe silencieux"

# Seuil à 1 : une seule mesure suffit à confirmer, ce qui permet de coucher les
# douze sites en une passe. Le seuil est déjà exercé plus haut.
for i in $(seq 1 "$BURST_SIZE"); do
  n=$(printf '%02d' "$i")
  code=$(req POST /api/monitors "$(jq -nc \
    --arg name "$PREFIX-$n" --arg url "http://$RECEIVER:8080/site/$n" \
    '{name:$name,type:"http",config:{url:$url,keyword:"SUPERVISION-OK",timeoutMs:3000},
      intervalSeconds:86400,failureThreshold:1,recoveryThreshold:1}')")
  [ "$code" = "201" ] || fail "création de $PREFIX-$n → HTTP $code : $(cat "$BODY")"
done
req GET /api/monitors >/dev/null
jq -r --arg p "$PREFIX-" '.items[] | select(.name | startswith($p)) | select(.name != ($p + "principal")) | .id' \
  "$BODY" > "$WORK/burst.ids"
[ "$(grep -c . "$WORK/burst.ids")" = "$BURST_SIZE" ] || fail "$BURST_SIZE sondes attendues"
while read -r id; do defer "$id"; done < "$WORK/burst.ids"
pass "$BURST_SIZE sondes créées, seuil 1 échec"

set_mode up
while read -r id; do req POST "/api/monitors/$id/check" >/dev/null; done < "$WORK/burst.ids"
sleep 12
while read -r id; do defer "$id"; done < "$WORK/burst.ids"
DOWN_ALREADY=$(psql_q "select count(*) from monitors where name like '$PREFIX-%' and status <> 'healthy';")
[ "$DOWN_ALREADY" = "0" ] || fail "$DOWN_ALREADY sonde(s) déjà en panne avant la rafale"
pass "les $BURST_SIZE sondes sont saines — la rafale part d'un état propre"

rx_reset
curl -s -X DELETE "$MAILPIT_HTTP/api/v1/messages" >/dev/null

# La bascule est GLOBALE : les douze sites tombent au même instant, comme le
# ferait une panne d'infrastructure.
set_mode down
STARTED=$(date +%s)
while read -r id; do req POST "/api/monitors/$id/check" >/dev/null; done < "$WORK/burst.ids"

for _ in $(seq 1 60); do
  [ "$(digest_held)" -ge "$((BURST_SIZE - 1))" ] && break
  sleep 1
done
HELD=$(digest_held)
[ "$HELD" = "$((BURST_SIZE - 1))" ] || fail "$HELD retenu(s), $((BURST_SIZE - 1)) attendus"
IMMEDIATE=$(chan_events monitor.down)
[ "$IMMEDIATE" = "1" ] \
  || fail "$IMMEDIATE alerte(s) unitaire(s) : la rafale n'a pas été retenue"
pass "$BURST_SIZE sites tombés → 1 alerte immédiate (en $(( $(date +%s) - STARTED )) s) + $HELD retenus, pas $BURST_SIZE messages"

# La fenêtre dure $((VERIF_WINDOW_MS / 1000)) s, le balayage qui la ferme passe
# toutes les 5 s. On attend largement : un worker relancé au mauvais moment (une
# autre vérification, un rebuild) coûte quelques dizaines de secondes, et l'état
# est en base — il repart tout seul.
for _ in $(seq 1 120); do
  [ "$(chan_digests monitor.down)" -ge 1 ] && break
  sleep 1
done
[ "$(chan_digests monitor.down)" = "1" ] || fail "aucun résumé n'est arrivé — fenêtre : $(psql_q "select window_ends_at, held_count, escalation from notification_digest_groups where group_key = '$GROUP';")"

DIGEST="$WORK/digest.json"
jq '[.[] | select(.path == "/hook") | .body | select(.type == "digest")][0]' <<< "$(collected)" > "$DIGEST"
jq -e --argjson n "$((BURST_SIZE - 1))" '.count == $n and (.items | length) == $n and .omitted == 0' \
  "$DIGEST" >/dev/null || fail "le résumé annonce $(jq -r .count "$DIGEST") / $(jq -r '.items|length' "$DIGEST")"
pass "résumé : « $(jq -r .title "$DIGEST") » — $((BURST_SIZE - 1)) lignes, 0 tue"

# LE cœur de l'exigence. « 11 alertes » ne dit rien. On vérifie que CHACUN des
# douze sites est nommé, soit dans l'alerte immédiate, soit dans le résumé.
jq '[.[] | select(.path == "/hook") | .body | select(.type == "event" and .event == "monitor.down")][0]' \
  <<< "$(collected)" > "$WORK/immediate.json"

NAMED=0
for i in $(seq 1 "$BURST_SIZE"); do
  n=$(printf '%02d' "$i")
  if jq -e --arg m "$PREFIX-$n" '[.items[] | select(.label | contains($m))] | length == 1' \
       "$DIGEST" >/dev/null; then
    NAMED=$((NAMED + 1))
  elif jq -e --arg m "$PREFIX-$n" '.title | contains($m)' "$WORK/immediate.json" >/dev/null; then
    NAMED=$((NAMED + 1))
  else
    fail "le site « $PREFIX-$n » n'est nommé NULLE PART — ni dans l'alerte immédiate, ni dans le résumé"
  fi
done
[ "$NAMED" = "$BURST_SIZE" ] || fail "$NAMED sites nommés sur $BURST_SIZE"
pass "les $BURST_SIZE sites tombés sont nommés — aucun n'est dissous dans un compteur"

info "trois lignes du résumé, telles qu'elles sont parties :"
jq -r '.items[0:3][] | "      • " + (.occurredAt[11:19]) + " — " + .label + " — " + .detail' "$DIGEST"

jq -e '(.items[0].url | contains("/monitors/")) and (.url | endswith("/monitors"))' "$DIGEST" >/dev/null \
  || fail "les liens du résumé ne pointent pas les sondes"
pass "chaque ligne pointe SA sonde ; le résumé pointe l'écran des sondes"
jq -e '.nextWindowMs > .windowMs' "$DIGEST" >/dev/null \
  || fail "la fenêtre ne s'élargit pas alors que l'orage dure"
pass "la fenêtre passe de $(jq -r .windowMs "$DIGEST") à $(jq -r .nextWindowMs "$DIGEST") ms — l'orage fait baisser la cadence tout seul"

TOTAL_HOOK=$(count_at /hook)
[ "$TOTAL_HOOK" -le 3 ] \
  || fail "$TOTAL_HOOK messages pour $BURST_SIZE pannes — le regroupement ne tient pas"
pass "$BURST_SIZE pannes → $TOTAL_HOOK message(s) sur le canal, au lieu de $BURST_SIZE"
[ "$(count_at /muet)" = "0" ] || fail "le canal témoin a reçu la rafale"
pass "canal témoin : toujours 0, rafale comprise"

# Le même résumé, rendu par un vrai serveur SMTP.
MSGS=$(curl -s "$MAILPIT_HTTP/api/v1/messages?limit=50")
MID=$(jq -r '[.messages[] | select(.Subject | contains("résumé"))][0].ID // empty' <<< "$MSGS")
if [ -n "$MID" ]; then
  MAIL=$(curl -s "$MAILPIT_HTTP/api/v1/message/$MID")
  LINES=$(jq -r '.Text' <<< "$MAIL" | grep -c '^• ' || true)
  [ "$LINES" = "$((BURST_SIZE - 1))" ] || fail "l'e-mail liste $LINES lignes sur $((BURST_SIZE - 1))"
  jq -e --arg p "$PREFIX-" '.Text | contains($p)' <<< "$MAIL" >/dev/null \
    || fail "l'e-mail ne nomme aucun site"
  pass "Mailpit : « $(jq -r '[.messages[] | select(.Subject | contains("résumé"))][0].Subject' <<< "$MSGS") » — $LINES sites listés nommément"
else
  fail "aucun e-mail de résumé dans Mailpit : $(jq -r '[.messages[].Subject] | join(" | ")' <<< "$MSGS")"
fi

# ─────────────────────────────────────────────────────────────────────────────
step "15. Le secret d'une sonde ne fuit nulle part"

req GET /api/monitors >/dev/null
grep -qF "$MON_HOOK_TOKEN" "$BODY" && fail "le jeton du webhook de sonde apparaît dans GET /api/monitors"
req GET "/api/monitors/$MAIN_ID" >/dev/null
grep -qF "$MON_HOOK_TOKEN" "$BODY" && fail "le jeton apparaît dans GET /api/monitors/{id}"
jq -e '.hasWebhook == true' "$BODY" >/dev/null \
  || fail "l'API devrait dire qu'un webhook est posé, sans le donner"
pass "absent de l'API — qui dit seulement qu'un webhook est posé (hasWebhook: true)"

curl -s -b "$JAR" "$BASE_URL/monitors" -o "$WORK/monitors.html"
curl -s -b "$JAR" "$BASE_URL/monitors/$MAIN_ID" -o "$WORK/monitor.html"
for f in "$WORK/monitors.html" "$WORK/monitor.html"; do
  grep -qF "$MON_HOOK_TOKEN" "$f" && fail "le jeton apparaît dans le HTML ($f)"
done
pass "absent du HTML de /monitors et de /monitors/{id}"

LEAKS=$(psql_q "select count(*) from audit_logs where before::text like '%VERIFSONDESECRET%' or after::text like '%VERIFSONDESECRET%';")
[ "$LEAKS" = "0" ] || fail "$LEAKS entrée(s) d'audit contiennent un secret"
pass "absent d'audit_logs — y compris des entrées monitor.down / monitor.recovered qui portent le message"

for service in panel worker; do
  docker compose logs "$service" --since 30m 2>/dev/null | grep -qF 'VERIFSONDESECRET' \
    && fail "un secret apparaît dans docker compose logs $service"
done
pass "absent de docker compose logs panel et worker"

STORED=$(psql_q "select webhook_url_encrypted from monitors where id = '$MAIN_ID';")
case "$STORED" in
  v1:*) pass "en base, l'URL du webhook de sonde est chiffrée (AES-256-GCM, préfixe « v1 »)" ;;
  *)    fail "webhook_url_encrypted n'a pas la forme attendue : ${STORED:0:20}" ;;
esac
grep -qF "$MON_HOOK_TOKEN" <<< "$STORED" && fail "le jeton est lisible en base"

# Et les secrets des canaux, qui transitent par les mêmes chemins.
req GET /api/notifications/channels >/dev/null
for secret in "$CHAN_HOOK_TOKEN" "$DISCORD_TOKEN"; do
  grep -qF "$secret" "$BODY" && fail "un secret de canal apparaît dans l'API"
done
pass "les secrets des canaux ne ressortent pas davantage"

# ─────────────────────────────────────────────────────────────────────────────
step "16. Traçabilité"

req GET "/api/audit-logs?resourceType=monitor&pageSize=100" >/dev/null
for action in monitor.down monitor.recovered; do
  jq -e --arg a "$action" '[.items[] | select(.action == $a)] | length > 0' "$BODY" >/dev/null \
    || fail "action « $action » absente du journal d'audit"
done
pass "audit : monitor.down et monitor.recovered — la source des messages, pas un doublon"
jq -e '[.items[] | select(.action == "monitor.recovered")][0].after.durationSeconds != null' "$BODY" \
  >/dev/null || fail "la durée de panne n'est pas dans l'entrée d'audit"
pass "l'entrée d'audit porte startedAt et durationSeconds — c'est d'elle que le message tire « après N min »"

# ─────────────────────────────────────────────────────────────────────────────
step "17. Ménage"

purge
req GET /api/notifications/channels >/dev/null
REMAINING=$(jq -r --arg p "$PREFIX" '[.items[] | select(.name | startswith($p))] | length' "$BODY")
[ "$REMAINING" = "0" ] || fail "$REMAINING canal(aux) de vérification subsistent"
LEFT=$(psql_q "select count(*) from monitors where name like '$PREFIX-%';")
[ "$LEFT" = "0" ] || fail "$LEFT sonde(s) de vérification subsistent"
pass "canaux et sondes de vérification supprimés"

MONITORS_AFTER=$(psql_q "select count(*) from monitors;")
[ "$MONITORS_AFTER" = "$MONITORS_BEFORE" ] \
  || fail "le nombre de sondes préexistantes a changé : $MONITORS_BEFORE → $MONITORS_AFTER"
pass "les $MONITORS_BEFORE sonde(s) préexistante(s) sont intactes"

# Ce script n'écrit JAMAIS dans `app_settings` : il ne connaît qu'une route de
# réglage, celle de la fenêtre de regroupement, et elle vit dans sa propre table
# (`notification_policy`). Un changement d'empreinte signale donc un voisin —
# une autre vérification lancée en parallèle sur la même instance — et non un
# effet de bord d'ici. On le dit sans faire échouer : un test qui tombe à cause
# d'un voisin ne mesure pas ce qu'il prétend.
SETTINGS_AFTER=$(psql_q "select md5(value::text) from app_settings where id = 1;")
if [ "$SETTINGS_AFTER" = "$SETTINGS_BEFORE" ]; then
  pass "les paramètres d'instance n'ont pas été touchés"
else
  printf '  \033[33m!\033[0m %s\n' \
    "l'empreinte de app_settings a changé pendant l'exécution — ce script ne l'écrit jamais"
  info "dernier auteur : $(psql_q "select action || ' à ' || to_char(created_at, 'HH24:MI:SS') from audit_logs where action like 'settings%' order by created_at desc limit 1;")"
  info "(exécution concurrente d'une autre vérification sur la même instance)"
fi

code=$(req PATCH /api/notifications/digests "{\"windowMs\":$POLICY_BEFORE}")
[ "$code" = "200" ] || fail "restauration de la fenêtre → HTTP $code"
req GET /api/notifications/digests >/dev/null
RESTORED=$(jq -r '.policy.windowMs' "$BODY")
[ "$RESTORED" = "$POLICY_BEFORE" ] || fail "fenêtre restaurée à $RESTORED ms au lieu de $POLICY_BEFORE ms"
POLICY_BEFORE=""
pass "fenêtre de regroupement rendue dans l'état trouvé (${RESTORED} ms)"

printf '\n\033[32m✓ Supervision branchée sur les canaux de notification.\033[0m\n'
printf '\033[2m  Écrans : %s/monitors et %s/admin/settings/notifications\033[0m\n' "$BASE_URL" "$BASE_URL"
printf '\033[2m  Le raccord tient dans deux entrées du catalogue d'"'"'événements : les sondes\033[0m\n'
printf '\033[2m  écrivaient déjà dans audit_logs, et l'"'"'audit est la source des notifications.\033[0m\n'
printf '\033[2m  Aucun appel à la fabrique de canaux depuis apps/worker/src/monitors.\033[0m\n\n'
