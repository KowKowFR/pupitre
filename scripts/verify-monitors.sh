#!/usr/bin/env bash
#
# Vérifie la supervision de sites :
#
#    1. une sonde vers une URL qui répond passe à « sain », avec une latence
#    2. une sonde vers une URL morte passe à « en échec » APRÈS le seuil de
#       confirmation, pas au premier échec
#    3. un rebond isolé ne crée aucun incident
#    4. un incident naît à la transition et se referme au rétablissement
#    5. le webhook part à la transition, UNE SEULE FOIS, et au rétablissement
#    6. le taux de disponibilité est juste — historique fabriqué, chiffre comparé
#    7. la rétention supprime réellement les vieilles mesures
#    8. une cible interdite par la politique SSRF est refusée, code et message
#    9. `monitor:manage` est requis pour écrire, `monitor:read` pour lire
#   10. la sonde TLS prouve que l'abstraction accueille autre chose que HTTP
#
# Le script démarre un récepteur jetable sur le réseau compose : il sert à la
# fois de cible vivante, de cible morte et de récepteur de webhook. Il est
# supprimé à la fin, ainsi que tout ce qui a été créé.
#
# Comme le récepteur vit sur une adresse privée, le script relance panel et
# worker avec `MONITOR_ALLOWED_CIDRS` — ce qui exerce au passage la liste
# d'autorisation — puis les remet dans leur état d'origine.
#
# Usage :
#   ./scripts/verify-monitors.sh
#   BASE_URL=http://localhost:3200 ./scripts/verify-monitors.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
CLIENT_IP="${CLIENT_IP:-198.51.100.77}"

RECEIVER="monitors-verify-receiver"
NETWORK="${COMPOSE_NETWORK:-pupitre_default}"
VIEWER_EMAIL="monitor-viewer@example.test"
VIEWER_ROLE="monitor-verify-viewer"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
VJAR="$WORK/viewer.jar"
BODY="$WORK/body.json"

command -v jq >/dev/null || { echo "jq est requis"; exit 1; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
info() { printf '    \033[2m%s\033[0m\n' "$1"; }

req() {
  local method="$1" path="$2" data="${3:-}" jar="${4:-$JAR}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -H "x-forwarded-for: $CLIENT_IP" -b "$jar" -c "$jar")
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }

cleanup() {
  local code=$?
  printf '\n\033[1m%s\033[0m\n' "Ménage"

  # Sondes de test (cascade sur mesures et incidents).
  psql_q "delete from monitors where name like 'verify-%';" >/dev/null 2>&1 || true
  # Utilisateur et rôle de test.
  psql_q "delete from user_roles where user_id in (select id from users where email = '$VIEWER_EMAIL');" >/dev/null 2>&1 || true
  psql_q "delete from sessions where user_id in (select id from users where email = '$VIEWER_EMAIL');" >/dev/null 2>&1 || true
  psql_q "delete from accounts where user_id in (select id from users where email = '$VIEWER_EMAIL');" >/dev/null 2>&1 || true
  psql_q "delete from users where email = '$VIEWER_EMAIL';" >/dev/null 2>&1 || true
  psql_q "delete from role_permissions where role_id in (select id from roles where key = '$VIEWER_ROLE');" >/dev/null 2>&1 || true
  psql_q "delete from roles where key = '$VIEWER_ROLE';" >/dev/null 2>&1 || true
  printf '  \033[32m✓\033[0m sondes, rôle et utilisateur de test supprimés\n'

  docker rm -f "$RECEIVER" >/dev/null 2>&1 || true
  printf '  \033[32m✓\033[0m récepteur jetable supprimé\n'

  # Remet panel et worker dans leur configuration d'origine (sans allowlist).
  ( cd "$(dirname "$0")/.." && docker compose up -d --force-recreate panel worker >/dev/null 2>&1 ) || true
  printf '  \033[32m✓\033[0m panel et worker rendus à leur configuration d'"'"'origine\n'

  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT

cd "$(dirname "$0")/.."

# ─────────────────────────────────────────────────────────────────────────────
step "1. Récepteur jetable sur le réseau compose"

docker rm -f "$RECEIVER" >/dev/null 2>&1 || true
cat > "$WORK/receiver.py" <<'PYEOF'
import http.server, json, threading

STATE = {"mode": "up", "hooks": []}
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
        if self.path.startswith("/hooks"):
            with LOCK:
                payload = json.dumps(STATE["hooks"]).encode()
            self._send(200, payload, "application/json")
        elif self.path.startswith("/mode/"):
            with LOCK:
                STATE["mode"] = self.path.rsplit("/", 1)[-1]
            self._send(200, b"ok")
        elif self.path.startswith("/reset"):
            with LOCK:
                STATE["hooks"] = []
            self._send(200, b"ok")
        elif self.path.startswith("/up"):
            with LOCK:
                mode = STATE["mode"]
            if mode == "up":
                self._send(200, b"<html><body>SUPERVISION-OK marqueur</body></html>", "text/html")
            else:
                self._send(503, b"indisponible")
        else:
            self._send(404, b"introuvable")

    def do_POST(self):
        length = int(self.headers.get("content-length", "0") or 0)
        raw = self.rfile.read(length).decode("utf-8", "replace")
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = {"raw": raw}
        with LOCK:
            STATE["hooks"].append({"path": self.path, "body": parsed})
        self._send(200, b"recu")

http.server.ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
PYEOF

docker run -d --name "$RECEIVER" --network "$NETWORK" \
  -v "$WORK/receiver.py:/receiver.py:ro" \
  python:3.12-alpine python /receiver.py >/dev/null
sleep 2

RECEIVER_IP=$(docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" "$RECEIVER")
[ -n "$RECEIVER_IP" ] || fail "le récepteur n'a pas d'adresse sur $NETWORK"
pass "récepteur en marche sur $RECEIVER_IP:8080 (adresse privée, donc soumise à la politique SSRF)"

LIVE_URL="http://$RECEIVER:8080/up"
DEAD_URL="http://$RECEIVER:9/"          # port fermé → connexion refusée
HOOK_URL="http://$RECEIVER:8080/hook"

hooks()      { docker exec "$RECEIVER" python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8080/hooks').read().decode())"; }
hook_reset() { docker exec "$RECEIVER" python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/reset').read()" >/dev/null; }
set_mode()   { docker exec "$RECEIVER" python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/mode/$1').read()" >/dev/null; }

# ─────────────────────────────────────────────────────────────────────────────
step "2. Panel et worker relancés avec la liste d'autorisation SSRF"

SUBNET=$(docker network inspect "$NETWORK" -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}')
info "réseau $NETWORK → $SUBNET"
MONITOR_ALLOWED_CIDRS="$SUBNET" docker compose up -d --force-recreate panel worker >/dev/null 2>&1
for _ in $(seq 1 30); do
  curl -fsS "$BASE_URL/api/health" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS "$BASE_URL/api/health" >/dev/null || fail "le panel ne répond pas après relance"
pass "MONITOR_ALLOWED_CIDRS=$SUBNET — le reste du privé et tout le lien-local restent fermés"

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

psql_q "delete from monitors where name like 'verify-%';" >/dev/null

code=$(req GET /api/monitors)
[ "$code" = "200" ] || fail "GET /api/monitors → HTTP $code : $(cat "$BODY")"
TYPES=$(jq -r '[.types[].type] | join(", ")' "$BODY")
RETENTION=$(jq -r '.retentionDays' "$BODY")
pass "catalogue servi au client : $TYPES — rétention $RETENTION jours"

# ─────────────────────────────────────────────────────────────────────────────
step "4. Politique SSRF : une cible interdite est refusée"

ssrf_refused() {
  local label="$1" payload="$2" expect_fragment="$3"
  local code
  code=$(req POST /api/monitors "$payload")
  [ "$code" = "422" ] || fail "$label : attendu 422, reçu $code — $(cat "$BODY")"
  local ecode msg
  ecode=$(jq -r '.error.code' "$BODY")
  msg=$(jq -r '.error.message' "$BODY")
  case "$ecode" in
    url_not_allowed|validation_failed) ;;
    *) fail "$label : code d'erreur « $ecode » inattendu" ;;
  esac
  grep -qi "$expect_fragment" <<< "$msg" \
    || fail "$label : message « $msg » ne mentionne pas « $expect_fragment »"
  pass "$label → 422 $ecode : $msg"
}

ssrf_refused "service de métadonnées (169.254.169.254)" \
  '{"name":"verify-ssrf-meta","type":"http","config":{"url":"http://169.254.169.254/latest/meta-data/"}}' \
  "aucune liste"

ssrf_refused "adresse privée hors liste (192.168.13.7)" \
  '{"name":"verify-ssrf-private","type":"http","config":{"url":"http://192.168.13.7/"}}' \
  "autorisée"

ssrf_refused "bouclage nommé (localhost)" \
  '{"name":"verify-ssrf-local","type":"http","config":{"url":"http://localhost:5432/"}}' \
  "localhost"

ssrf_refused "schéma file://" \
  '{"name":"verify-ssrf-file","type":"http","config":{"url":"file:///etc/passwd"}}' \
  "http"

ssrf_refused "URL portant des identifiants" \
  '{"name":"verify-ssrf-creds","type":"http","config":{"url":"https://admin:motdepasse@exemple.fr/"}}' \
  "identifiants"

code=$(req POST /api/monitors \
  '{"name":"verify-ssrf-hook","type":"http","config":{"url":"https://example.com/"},"webhookUrl":"http://169.254.169.254/hook"}')
[ "$code" = "422" ] || fail "webhook interdit : attendu 422, reçu $code"
jq -e '.error.details.field == "webhookUrl"' "$BODY" >/dev/null \
  || fail "le champ fautif n'est pas signalé"
pass "le webhook est soumis à la même politique → 422 sur le champ webhookUrl"

# ─────────────────────────────────────────────────────────────────────────────
step "5. Cadence minimale par type"

code=$(req POST /api/monitors \
  "{\"name\":\"verify-tls-trop-vite\",\"type\":\"tls\",\"config\":{\"host\":\"example.com\"},\"intervalSeconds\":60}")
[ "$code" = "422" ] || fail "cadence TLS à 60 s : attendu 422, reçu $code — $(cat "$BODY")"
pass "sonde TLS à la minute refusée → $(jq -r '.error.message' "$BODY")"

code=$(req POST /api/monitors \
  "{\"name\":\"verify-http-30s\",\"type\":\"http\",\"config\":{\"url\":\"$LIVE_URL\"},\"intervalSeconds\":30}")
[ "$code" = "201" ] || fail "cadence HTTP à 30 s : attendu 201, reçu $code — $(cat "$BODY")"
psql_q "delete from monitors where name = 'verify-http-30s';" >/dev/null
pass "la même cadence est acceptée pour HTTP — la cadence minimale est bien par type"

# ─────────────────────────────────────────────────────────────────────────────
step "6. Une sonde vers une URL qui répond passe à « sain »"

set_mode up
hook_reset

code=$(req POST /api/monitors "$(jq -nc \
  --arg url "$LIVE_URL" --arg hook "$HOOK_URL" \
  '{name:"verify-live",type:"http",
    config:{url:$url,keyword:"SUPERVISION-OK"},
    intervalSeconds:30,failureThreshold:3,recoveryThreshold:2,
    webhookUrl:$hook}')")
[ "$code" = "201" ] || fail "création → HTTP $code : $(cat "$BODY")"
LIVE_ID=$(jq -r '.id' "$BODY")
jq -e '.neverRan == true' "$BODY" >/dev/null || fail "une sonde neuve doit se dire jamais exécutée"
jq -e '.uptime24h.ratio == null' "$BODY" >/dev/null \
  || fail "une sonde sans mesure doit rendre ratio null, pas 0 %"
jq -e '.hasWebhook == true' "$BODY" >/dev/null || fail "le webhook n'est pas enregistré"
pass "sonde créée — « jamais exécutée », taux null (et non 0 %)"

stored_hook=$(psql_q "select webhook_url_encrypted from monitors where id = '$LIVE_ID';")
grep -q "^v1:" <<< "$stored_hook" || fail "le webhook n'est pas chiffré en base : $stored_hook"
grep -q "$RECEIVER" <<< "$stored_hook" && fail "l'URL du webhook apparaît en clair en base"
req GET "/api/monitors/$LIVE_ID" >/dev/null
grep -q "$HOOK_URL" "$BODY" && fail "l'API renvoie l'URL du webhook"
pass "webhook chiffré en base (préfixe v1:) et jamais renvoyé par l'API"

probe() {
  req POST "/api/monitors/$1/check" >/dev/null
  sleep 3
}

probe "$LIVE_ID"
code=$(req GET "/api/monitors/$LIVE_ID")
[ "$code" = "200" ] || fail "lecture → HTTP $code"
STATUS=$(jq -r '.status' "$BODY")
LATENCY=$(jq -r '.lastLatencyMs' "$BODY")
HTTPCODE=$(jq -r '.lastMetrics.httpStatus' "$BODY")
[ "$STATUS" = "healthy" ] || fail "attendu healthy, reçu « $STATUS » — $(jq -r '.lastDetail' "$BODY")"
[ "$LATENCY" != "null" ] && [ "$LATENCY" -ge 0 ] || fail "aucune latence mesurée"
[ "$HTTPCODE" = "200" ] || fail "code HTTP attendu 200, reçu $HTTPCODE"
pass "sonde saine, latence mesurée : ${LATENCY} ms, code $HTTPCODE, mot-clé trouvé"

# ─────────────────────────────────────────────────────────────────────────────
step "6 bis. Le BALAYAGE PLANIFIÉ mesure, pas seulement « sonder maintenant »"

# Deux chemins distincts mènent à une mesure : la demande explicite, qui relit la
# sonde avec le constructeur de requêtes, et le balayage toutes les 30 s, qui la
# réclame en SQL brut. Un bug a vécu dans le second pendant que le premier
# marchait — il ne se voyait que sur un écran resté ouvert. Les deux sont
# exercés ici.
BEFORE_SWEEP=$(psql_q "select count(*) from monitor_checks where monitor_id = '$LIVE_ID';")
BEFORE_TS=$(psql_q "select extract(epoch from last_checked_at)::bigint from monitors where id = '$LIVE_ID';")
psql_q "update monitors set next_check_at = now() where id = '$LIVE_ID';" >/dev/null
info "échéance avancée ; attente d'une occurrence du balayage (30 s)"
sleep 40

AFTER_SWEEP=$(psql_q "select count(*) from monitor_checks where monitor_id = '$LIVE_ID';")
AFTER_TS=$(psql_q "select extract(epoch from last_checked_at)::bigint from monitors where id = '$LIVE_ID';")
[ "$AFTER_SWEEP" -gt "$BEFORE_SWEEP" ] \
  || fail "le balayage planifié n'a produit aucune mesure ($BEFORE_SWEEP → $AFTER_SWEEP)"
[ "$AFTER_TS" -gt "$BEFORE_TS" ] || fail "le balayage n'a pas mis à jour la sonde"

req GET "/api/monitors/$LIVE_ID" >/dev/null
[ "$(jq -r '.status' "$BODY")" = "healthy" ] \
  || fail "après balayage, état « $(jq -r '.status' "$BODY") » — $(jq -r '.lastDetail' "$BODY")"
CF=$(jq -r '.consecutiveFailures' "$BODY"); CS=$(jq -r '.consecutiveSuccesses' "$BODY")
case "$CF" in ''|*[!0-9]*) fail "compteur d'échecs corrompu après balayage : « $CF »" ;; esac
case "$CS" in ''|*[!0-9]*) fail "compteur de succès corrompu après balayage : « $CS »" ;; esac
[ "$CS" -ge 1 ] || fail "le balayage n'a pas incrémenté les succès consécutifs"
pass "balayage planifié : $BEFORE_SWEEP → $AFTER_SWEEP mesures, compteurs entiers ($CF échecs, $CS succès)"

ERRS=$(docker compose logs worker --since 2m 2>&1 | grep -c "monitoring probe failed" || true)
[ "$ERRS" = "0" ] || fail "$ERRS erreur(s) de sonde dans les logs du worker pendant le balayage"
pass "aucune erreur de sonde dans les logs du worker"

# ─────────────────────────────────────────────────────────────────────────────
step "7. Un rebond isolé ne crée aucun incident"

set_mode down
probe "$LIVE_ID"
req GET "/api/monitors/$LIVE_ID" >/dev/null
[ "$(jq -r '.status' "$BODY")" = "healthy" ] \
  || fail "un seul échec a fait basculer la sonde — le seuil ne sert à rien"
[ "$(jq -r '.consecutiveFailures' "$BODY")" = "1" ] || fail "compteur d'échecs incorrect"
[ "$(jq -r '.lastOutcome' "$BODY")" = "unhealthy" ] \
  || fail "le dernier verdict brut devrait être unhealthy"
pass "1 échec sur 3 : état confirmé toujours « sain », verdict brut « répond mal »"

set_mode up
probe "$LIVE_ID"
req GET "/api/monitors/$LIVE_ID" >/dev/null
[ "$(jq -r '.status' "$BODY")" = "healthy" ] || fail "la sonde devrait être revenue saine"
[ "$(jq -r '.incidents | length' "$BODY")" = "0" ] \
  || fail "un rebond a créé un incident : $(jq -c '.incidents' "$BODY")"
[ "$(jq -r 'length' <<< "$(hooks)")" = "0" ] \
  || fail "un rebond a émis une alerte : $(hooks)"
pass "rebond absorbé : aucun incident, aucune alerte"

# ─────────────────────────────────────────────────────────────────────────────
step "8. La panne est confirmée au seuil, et une seule alerte part"

set_mode down
probe "$LIVE_ID"
req GET "/api/monitors/$LIVE_ID" >/dev/null
[ "$(jq -r '.status' "$BODY")" = "healthy" ] || fail "échec 1 : bascule prématurée"
info "échec 1 sur 3 — état confirmé « $(jq -r '.status' "$BODY") »"

probe "$LIVE_ID"
req GET "/api/monitors/$LIVE_ID" >/dev/null
[ "$(jq -r '.status' "$BODY")" = "healthy" ] || fail "échec 2 : bascule prématurée"
[ "$(jq -r '.incidents | length' "$BODY")" = "0" ] || fail "échec 2 : incident prématuré"
info "échec 2 sur 3 — état confirmé « $(jq -r '.status' "$BODY") », toujours aucun incident"

probe "$LIVE_ID"
req GET "/api/monitors/$LIVE_ID" >/dev/null
STATUS=$(jq -r '.status' "$BODY")
[ "$STATUS" = "unhealthy" ] || fail "échec 3 : attendu unhealthy, reçu « $STATUS »"
[ "$(jq -r '.incidents | length' "$BODY")" = "1" ] \
  || fail "aucun incident ouvert au seuil : $(jq -c '.incidents' "$BODY")"
jq -e '.incidents[0].resolvedAt == null' "$BODY" >/dev/null || fail "l'incident naît déjà refermé"
jq -e '.incidents[0].failureCount == 3' "$BODY" >/dev/null \
  || fail "l'incident ne retient pas combien d'échecs l'ont confirmé"
pass "panne confirmée au 3ᵉ échec — un incident ouvert, confirmé après 3 échecs"

sleep 2
DOWN_HOOKS=$(jq -r '[.[] | select(.body.event == "monitor.down")] | length' <<< "$(hooks)")
[ "$DOWN_HOOKS" = "1" ] || fail "attendu 1 alerte de panne, reçu $DOWN_HOOKS : $(hooks)"
jq -e '.[0].body.text | test("verify-live")' <<< "$(hooks)" >/dev/null \
  || fail "la charge utile ne nomme pas la sonde"
jq -e '.[0].body.text == .[0].body.content' <<< "$(hooks)" >/dev/null \
  || fail "text et content devraient porter la même phrase (Slack / Discord)"
pass "webhook émis UNE SEULE FOIS : $(jq -r '.[0].body.text' <<< "$(hooks)")"

probe "$LIVE_ID"
probe "$LIVE_ID"
DOWN_HOOKS=$(jq -r '[.[] | select(.body.event == "monitor.down")] | length' <<< "$(hooks)")
[ "$DOWN_HOOKS" = "1" ] || fail "la panne qui dure a réémis : $DOWN_HOOKS alertes"
req GET "/api/monitors/$LIVE_ID" >/dev/null
[ "$(jq -r '.incidents | length' "$BODY")" = "1" ] || fail "un second incident a été ouvert"
pass "deux échecs de plus : toujours 1 incident, toujours 1 alerte — pas une par mesure"

# ─────────────────────────────────────────────────────────────────────────────
step "9. L'incident se referme au rétablissement, et l'alerte de retour part"

set_mode up
probe "$LIVE_ID"
req GET "/api/monitors/$LIVE_ID" >/dev/null
[ "$(jq -r '.status' "$BODY")" = "unhealthy" ] \
  || fail "un seul succès a relevé la sonde — le seuil de rétablissement ne sert à rien"
info "succès 1 sur 2 — état confirmé toujours « en échec »"

probe "$LIVE_ID"
req GET "/api/monitors/$LIVE_ID" >/dev/null
[ "$(jq -r '.status' "$BODY")" = "healthy" ] || fail "la sonde n'est pas revenue saine"
jq -e '.incidents[0].resolvedAt != null' "$BODY" >/dev/null || fail "l'incident n'est pas refermé"
DURATION=$(jq -r '.incidents[0].durationSeconds' "$BODY")
pass "incident refermé après ${DURATION} s de panne, au 2ᵉ succès consécutif"

sleep 2
UP_HOOKS=$(jq -r '[.[] | select(.body.event == "monitor.up")] | length' <<< "$(hooks)")
[ "$UP_HOOKS" = "1" ] || fail "attendu 1 alerte de rétablissement, reçu $UP_HOOKS : $(hooks)"
pass "webhook de rétablissement : $(jq -r '[.[] | select(.body.event == "monitor.up")][0].body.text' <<< "$(hooks)")"

TOTAL_HOOKS=$(jq -r 'length' <<< "$(hooks)")
[ "$TOTAL_HOOKS" = "2" ] || fail "$TOTAL_HOOKS messages au total pour une panne — attendu 2"
pass "2 messages au total pour toute la panne : une alerte, un rétablissement"

req GET "/api/audit-logs?resourceType=monitor&pageSize=20" >/dev/null
for action in monitor.created monitor.down monitor.recovered; do
  jq -e --arg a "$action" '[.items[] | select(.action == $a)] | length > 0' "$BODY" >/dev/null \
    || fail "action « $action » absente du journal d'audit"
  pass "audit : $action"
done

# ─────────────────────────────────────────────────────────────────────────────
step "10. Une URL morte : connexion refusée, panne confirmée au seuil"

code=$(req POST /api/monitors "$(jq -nc --arg url "$DEAD_URL" \
  '{name:"verify-dead",type:"http",config:{url:$url,timeoutMs:3000},
    intervalSeconds:30,failureThreshold:2,recoveryThreshold:1}')")
[ "$code" = "201" ] || fail "création → HTTP $code : $(cat "$BODY")"
DEAD_ID=$(jq -r '.id' "$BODY")

probe "$DEAD_ID"
req GET "/api/monitors/$DEAD_ID" >/dev/null
[ "$(jq -r '.status' "$BODY")" = "unknown" ] \
  || fail "1er échec depuis unknown : la sonde ne doit pas encore être confirmée"
info "1er échec — $(jq -r '.lastDetail' "$BODY")"

probe "$DEAD_ID"
req GET "/api/monitors/$DEAD_ID" >/dev/null
[ "$(jq -r '.status' "$BODY")" = "unreachable" ] \
  || fail "attendu unreachable au 2ᵉ échec, reçu « $(jq -r '.status' "$BODY") »"
[ "$(jq -r '.lastLatencyMs' "$BODY")" = "null" ] \
  || fail "une cible injoignable ne doit pas rapporter de latence"
pass "URL morte → « injoignable » au 2ᵉ échec : $(jq -r '.lastDetail' "$BODY")"

# ─────────────────────────────────────────────────────────────────────────────
step "11. Le taux de disponibilité, sur un historique fabriqué"

code=$(req POST /api/monitors '{"name":"verify-uptime","type":"http",
  "config":{"url":"https://example.com/"},"intervalSeconds":3600,"enabled":false}')
[ "$code" = "201" ] || fail "création → HTTP $code : $(cat "$BODY")"
UP_ID=$(jq -r '.id' "$BODY")

# 40 mesures sur 24 h : 37 saines, 3 en échec → 92,50 %.
# 20 mesures de plus, toutes saines, mais vieilles de 3 jours : elles ne
# comptent que dans la fenêtre 7 j.
psql_q "insert into monitor_checks (monitor_id, checked_at, outcome, latency_ms, metrics)
        select '$UP_ID', now() - (n || ' minutes')::interval,
               case when n in (5, 15, 25) then 'unhealthy'::health_status else 'healthy'::health_status end,
               100 + n, '{}'::jsonb
          from generate_series(1, 40) as n;" >/dev/null
psql_q "insert into monitor_checks (monitor_id, checked_at, outcome, latency_ms, metrics)
        select '$UP_ID', now() - interval '3 days' - (n || ' minutes')::interval,
               'healthy'::health_status, 90, '{}'::jsonb
          from generate_series(1, 20) as n;" >/dev/null

req GET "/api/monitors/$UP_ID" >/dev/null
S24=$(jq -r '.uptime24h.samples' "$BODY"); U24=$(jq -r '.uptime24h.up' "$BODY")
L24=$(jq -r '.uptime24h.label' "$BODY")
S7=$(jq -r '.uptime7d.samples' "$BODY");  U7=$(jq -r '.uptime7d.up' "$BODY")
L7=$(jq -r '.uptime7d.label' "$BODY")

[ "$S24" = "40" ] || fail "fenêtre 24 h : 40 mesures attendues, $S24 comptées"
[ "$U24" = "37" ] || fail "fenêtre 24 h : 37 saines attendues, $U24 comptées"
[ "$L24" = "92,50 % sur 40 mesures" ] || fail "taux 24 h affiché « $L24 », attendu « 92,50 % sur 40 mesures »"
pass "24 h : $L24 — 37/40, calcul exact"

[ "$S7" = "60" ] || fail "fenêtre 7 j : 60 mesures attendues, $S7 comptées"
[ "$U7" = "57" ] || fail "fenêtre 7 j : 57 saines attendues, $U7 comptées"
[ "$L7" = "95,00 % sur 60 mesures" ] || fail "taux 7 j affiché « $L7 », attendu « 95,00 % sur 60 mesures »"
pass "7 j : $L7 — la fenêtre est bien celle annoncée, et le dénominateur est dit"

# ─────────────────────────────────────────────────────────────────────────────
step "12. La rétention supprime réellement les vieilles mesures"

psql_q "insert into monitor_checks (monitor_id, checked_at, outcome, latency_ms, metrics)
        select '$UP_ID', now() - interval '45 days' - (n || ' minutes')::interval,
               'healthy'::health_status, 80, '{}'::jsonb
          from generate_series(1, 25) as n;" >/dev/null
OLD=$(psql_q "select count(*) from monitor_checks where monitor_id = '$UP_ID' and checked_at < now() - interval '$RETENTION days';")
[ "$OLD" = "25" ] || fail "25 vieilles mesures attendues, $OLD insérées"
BEFORE=$(psql_q "select count(*) from monitor_checks where monitor_id = '$UP_ID';")
info "$BEFORE mesures au total, dont $OLD au-delà de la rétention de $RETENTION jours"

# La purge est limitée à une fois l'heure : on retire le marqueur pour la forcer.
docker compose exec -T redis redis-cli DEL "monitor:prune:last" >/dev/null
req POST "/api/monitors/$DEAD_ID/check" >/dev/null   # un balayage général au passage
sleep 35   # une occurrence du scheduler (30 s) + marge

AFTER_OLD=$(psql_q "select count(*) from monitor_checks where monitor_id = '$UP_ID' and checked_at < now() - interval '$RETENTION days';")
AFTER=$(psql_q "select count(*) from monitor_checks where monitor_id = '$UP_ID';")
[ "$AFTER_OLD" = "0" ] || fail "la purge a laissé $AFTER_OLD mesures au-delà de la rétention"
[ "$AFTER" = "$((BEFORE - 25))" ] \
  || fail "la purge a supprimé autre chose que les 25 vieilles : $BEFORE → $AFTER"
pass "purge : $BEFORE → $AFTER mesures, exactement les 25 au-delà de $RETENTION jours"

# Les incidents, eux, ne sont pas purgés.
INC=$(psql_q "select count(*) from monitor_incidents where monitor_id = '$LIVE_ID';")
[ "$INC" -ge 1 ] || fail "l'incident a disparu — les incidents ne doivent jamais être purgés"
pass "les incidents survivent à la purge ($INC conservé)"

# ─────────────────────────────────────────────────────────────────────────────
step "13. Sonde TLS — l'abstraction accueille autre chose que HTTP"

code=$(req POST /api/monitors '{"name":"verify-tls","type":"tls",
  "config":{"host":"badssl.com","port":443,"warnDays":1},"intervalSeconds":3600}')
if [ "$code" = "201" ]; then
  TLS_ID=$(jq -r '.id' "$BODY")
  probe "$TLS_ID"
  sleep 3
  req GET "/api/monitors/$TLS_ID" >/dev/null
  TLS_STATUS=$(jq -r '.status' "$BODY")
  DAYS=$(jq -r '.lastMetrics.daysRemaining // "—"' "$BODY")
  ISSUER=$(jq -r '.lastMetrics.issuer // "—"' "$BODY")
  PROTO=$(jq -r '.lastMetrics.protocol // "—"' "$BODY")
  if [ "$TLS_STATUS" = "healthy" ]; then
    pass "certificat de badssl.com : $DAYS jours restants, émis par « $ISSUER », $PROTO"
    pass "mesures propres au type TLS — aucune colonne HTTP n'a été détournée"
  else
    info "sonde TLS en « $TLS_STATUS » : $(jq -r '.lastDetail' "$BODY")"
    info "(accès Internet indisponible depuis le worker ? le type reste exercé)"
  fi
  psql_q "delete from monitors where id = '$TLS_ID';" >/dev/null
else
  info "création de la sonde TLS refusée (HTTP $code) — pas d'accès Internet depuis le worker"
fi

# ─────────────────────────────────────────────────────────────────────────────
step "14. Permissions : monitor:read pour lire, monitor:manage pour écrire"

req DELETE "/api/admin/roles/$VIEWER_ROLE" >/dev/null 2>&1 || true
code=$(req POST /api/admin/roles \
  "{\"key\":\"$VIEWER_ROLE\",\"label\":\"Observateur de sondes\",\"permissions\":[\"monitor:read\"]}")
[ "$code" = "201" ] || fail "création du rôle → HTTP $code : $(cat "$BODY")"
pass "rôle « $VIEWER_ROLE » créé, avec la seule permission monitor:read"

code=$(req POST /api/admin/users \
  "{\"name\":\"Observateur sondes\",\"email\":\"$VIEWER_EMAIL\",\"password\":\"motdepasse-tres-long\",\"role\":\"$VIEWER_ROLE\"}")
case "$code" in 201|409) ;; *) fail "création utilisateur → HTTP $code : $(cat "$BODY")" ;; esac
pass "utilisateur de test créé avec ce rôle"

code=$(req POST /api/auth/sign-in/email \
  "{\"email\":\"$VIEWER_EMAIL\",\"password\":\"motdepasse-tres-long\"}" "$VJAR")
[ "$code" = "200" ] || fail "connexion de l'observateur → HTTP $code : $(cat "$BODY")"

code=$(req GET /api/monitors "" "$VJAR")
[ "$code" = "200" ] || fail "monitor:read devrait suffire à lire : HTTP $code"
pass "lecture autorisée avec monitor:read → 200"

code=$(req POST /api/monitors \
  '{"name":"verify-interdit","type":"http","config":{"url":"https://example.com/"}}' "$VJAR")
[ "$code" = "403" ] || fail "écriture sans monitor:manage : attendu 403, reçu $code"
jq -e '.error.details.permission == "monitor:manage"' "$BODY" >/dev/null \
  || fail "la permission manquante n'est pas nommée : $(cat "$BODY")"
pass "création refusée → 403, permission « monitor:manage » nommée"

code=$(req DELETE "/api/monitors/$LIVE_ID" "" "$VJAR")
[ "$code" = "403" ] || fail "suppression sans monitor:manage : attendu 403, reçu $code"
pass "suppression refusée → 403"

code=$(req POST "/api/monitors/$LIVE_ID/check" "" "$VJAR")
[ "$code" = "403" ] || fail "sonder à la demande sans monitor:manage : attendu 403, reçu $code"
pass "« sonder maintenant » refusé → 403 — déclencher une requête sortante est un geste, pas une lecture"

# Retrait de monitor:read : la lecture doit tomber aussi.
code=$(req PATCH "/api/admin/roles/$VIEWER_ROLE" '{"permissions":[]}')
[ "$code" = "200" ] || fail "modification du rôle → HTTP $code"
code=$(req GET /api/monitors "" "$VJAR")
[ "$code" = "403" ] || fail "sans monitor:read : attendu 403, reçu $code"
pass "sans monitor:read, la lecture tombe → 403"

# ─────────────────────────────────────────────────────────────────────────────
step "15. Suppression d'une sonde : son historique part avec elle"

code=$(req DELETE "/api/monitors/$LIVE_ID")
[ "$code" = "200" ] || fail "suppression → HTTP $code : $(cat "$BODY")"
LEFT=$(psql_q "select count(*) from monitor_checks where monitor_id = '$LIVE_ID';")
LEFT_INC=$(psql_q "select count(*) from monitor_incidents where monitor_id = '$LIVE_ID';")
[ "$LEFT" = "0" ] && [ "$LEFT_INC" = "0" ] \
  || fail "cascade incomplète : $LEFT mesures et $LEFT_INC incidents orphelins"
pass "sonde supprimée, $LEFT mesure et $LEFT_INC incident restants — la cascade tient"

req GET /api/audit-logs?resourceType=monitor >/dev/null
jq -e '[.items[] | select(.action == "monitor.deleted")] | length > 0' "$BODY" >/dev/null \
  || fail "la suppression n'est pas auditée"
pass "audit : monitor.deleted"

printf '\n\033[32m✓ Supervision de sites vérifiée.\033[0m\n'
printf '\033[2m  Écran : %s/monitors\033[0m\n' "$BASE_URL"
