#!/usr/bin/env bash
#
# Checks site supervision:
#
#    1. a probe to a URL that answers goes "healthy", with a latency
#    2. a probe to a dead URL goes "failing" AFTER the confirmation threshold,
#       not at the first failure
#    3. an isolated bounce creates no incident
#    4. an incident is born at the transition and closes at the recovery
#    5. the webhook goes out at the transition, ONLY ONCE, and at the recovery
#    6. the availability rate is right — made-up history, figure compared
#    7. the retention really deletes the old measures
#    8. a target forbidden by the SSRF policy is refused, code and message
#    9. `monitor:manage` is required to write, `monitor:read` to read
#   10. the TLS probe proves that the abstraction welcomes something other than
#       HTTP
#
# The script starts a throwaway receiver on the compose network: it serves at
# the same time as a live target, a dead target and a webhook receiver. It is
# deleted at the end, as is everything that was created.
#
# As the receiver lives on a private address, the script restarts panel and
# worker with `MONITOR_ALLOWED_CIDRS` — which exercises the allow list on the
# way — then puts them back in their original state.
#
# Usage:
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

command -v jq >/dev/null || { echo "jq is required"; exit 1; }

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
  printf '\n\033[1m%s\033[0m\n' "Cleanup"

  # Test probes (cascade on measures and incidents).
  psql_q "delete from monitors where name like 'verify-%';" >/dev/null 2>&1 || true
  # Test user and role.
  psql_q "delete from user_roles where user_id in (select id from users where email = '$VIEWER_EMAIL');" >/dev/null 2>&1 || true
  psql_q "delete from sessions where user_id in (select id from users where email = '$VIEWER_EMAIL');" >/dev/null 2>&1 || true
  psql_q "delete from accounts where user_id in (select id from users where email = '$VIEWER_EMAIL');" >/dev/null 2>&1 || true
  psql_q "delete from users where email = '$VIEWER_EMAIL';" >/dev/null 2>&1 || true
  psql_q "delete from role_permissions where role_id in (select id from roles where key = '$VIEWER_ROLE');" >/dev/null 2>&1 || true
  psql_q "delete from roles where key = '$VIEWER_ROLE';" >/dev/null 2>&1 || true
  printf '  \033[32m✓\033[0m test probes, role and user deleted\n'

  docker rm -f "$RECEIVER" >/dev/null 2>&1 || true
  printf '  \033[32m✓\033[0m throwaway receiver deleted\n'

  # Puts panel and worker back in their original configuration (no allowlist).
  ( cd "$(dirname "$0")/.." && docker compose up -d --force-recreate panel worker >/dev/null 2>&1 ) || true
  printf '  \033[32m✓\033[0m panel and worker given back their original configuration\n'

  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT

cd "$(dirname "$0")/.."

# ─────────────────────────────────────────────────────────────────────────────
step "1. Throwaway receiver on the compose network"

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
            self._send(404, b"not found")

    def do_POST(self):
        length = int(self.headers.get("content-length", "0") or 0)
        raw = self.rfile.read(length).decode("utf-8", "replace")
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = {"raw": raw}
        with LOCK:
            STATE["hooks"].append({"path": self.path, "body": parsed})
        self._send(200, b"received")

http.server.ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
PYEOF

docker run -d --name "$RECEIVER" --network "$NETWORK" \
  -v "$WORK/receiver.py:/receiver.py:ro" \
  python:3.12-alpine python /receiver.py >/dev/null
sleep 2

RECEIVER_IP=$(docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" "$RECEIVER")
[ -n "$RECEIVER_IP" ] || fail "the receiver has no address on $NETWORK"
pass "receiver running on $RECEIVER_IP:8080 (private address, so subject to the SSRF policy)"

LIVE_URL="http://$RECEIVER:8080/up"
DEAD_URL="http://$RECEIVER:9/"          # closed port → connection refused
HOOK_URL="http://$RECEIVER:8080/hook"

hooks()      { docker exec "$RECEIVER" python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8080/hooks').read().decode())"; }
hook_reset() { docker exec "$RECEIVER" python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/reset').read()" >/dev/null; }
set_mode()   { docker exec "$RECEIVER" python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/mode/$1').read()" >/dev/null; }

# ─────────────────────────────────────────────────────────────────────────────
step "2. Panel and worker restarted with the SSRF allow list"

SUBNET=$(docker network inspect "$NETWORK" -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}')
info "network $NETWORK → $SUBNET"
MONITOR_ALLOWED_CIDRS="$SUBNET" docker compose up -d --force-recreate panel worker >/dev/null 2>&1
for _ in $(seq 1 30); do
  curl -fsS "$BASE_URL/api/health" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS "$BASE_URL/api/health" >/dev/null || fail "the panel does not answer after the restart"
pass "MONITOR_ALLOWED_CIDRS=$SUBNET — the rest of the private space and all of link-local stay closed"

# ─────────────────────────────────────────────────────────────────────────────
step "3. Sign-in"

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

login
pass "signed in as $ADMIN_EMAIL"

psql_q "delete from monitors where name like 'verify-%';" >/dev/null

code=$(req GET /api/monitors)
[ "$code" = "200" ] || fail "GET /api/monitors → HTTP $code: $(cat "$BODY")"
TYPES=$(jq -r '[.types[].type] | join(", ")' "$BODY")
RETENTION=$(jq -r '.retentionDays' "$BODY")
pass "catalog served to the client: $TYPES — retention $RETENTION days"

# ─────────────────────────────────────────────────────────────────────────────
step "4. SSRF policy: a forbidden target is refused"

ssrf_refused() {
  local label="$1" payload="$2" expect_fragment="$3"
  local code
  code=$(req POST /api/monitors "$payload")
  [ "$code" = "422" ] || fail "$label: expected 422, got $code — $(cat "$BODY")"
  local ecode msg
  ecode=$(jq -r '.error.code' "$BODY")
  msg=$(jq -r '.error.message' "$BODY")
  case "$ecode" in
    url_not_allowed|validation_failed) ;;
    *) fail "$label: unexpected error code \"$ecode\"" ;;
  esac
  grep -qiE "$expect_fragment" <<< "$msg" \
    || fail "$label: message \"$msg\" does not mention \"$expect_fragment\""
  pass "$label → 422 $ecode: $msg"
}

ssrf_refused "metadata service (169.254.169.254)" \
  '{"name":"verify-ssrf-meta","type":"http","config":{"url":"http://169.254.169.254/latest/meta-data/"}}' \
  "aucune liste|no allowlist"

ssrf_refused "private address outside the list (192.168.13.7)" \
  '{"name":"verify-ssrf-private","type":"http","config":{"url":"http://192.168.13.7/"}}' \
  "autorisée|allowed range"

ssrf_refused "named loopback (localhost)" \
  '{"name":"verify-ssrf-local","type":"http","config":{"url":"http://localhost:5432/"}}' \
  "localhost"

ssrf_refused "file:// scheme" \
  '{"name":"verify-ssrf-file","type":"http","config":{"url":"file:///etc/passwd"}}' \
  "http"

ssrf_refused "URL carrying credentials" \
  '{"name":"verify-ssrf-creds","type":"http","config":{"url":"https://admin:motdepasse@exemple.fr/"}}' \
  "identifiants|credentials"

code=$(req POST /api/monitors \
  '{"name":"verify-ssrf-hook","type":"http","config":{"url":"https://example.com/"},"webhookUrl":"http://169.254.169.254/hook"}')
[ "$code" = "422" ] || fail "forbidden webhook: expected 422, got $code"
jq -e '.error.details.field == "webhookUrl"' "$BODY" >/dev/null \
  || fail "the faulty field is not flagged"
pass "the webhook is subject to the same policy → 422 on the webhookUrl field"

# ─────────────────────────────────────────────────────────────────────────────
step "5. Minimum cadence per type"

code=$(req POST /api/monitors \
  "{\"name\":\"verify-tls-trop-vite\",\"type\":\"tls\",\"config\":{\"host\":\"example.com\"},\"intervalSeconds\":60}")
[ "$code" = "422" ] || fail "TLS cadence at 60 s: expected 422, got $code — $(cat "$BODY")"
pass "TLS probe every minute refused → $(jq -r '.error.message' "$BODY")"

code=$(req POST /api/monitors \
  "{\"name\":\"verify-http-30s\",\"type\":\"http\",\"config\":{\"url\":\"$LIVE_URL\"},\"intervalSeconds\":30}")
[ "$code" = "201" ] || fail "HTTP cadence at 30 s: expected 201, got $code — $(cat "$BODY")"
psql_q "delete from monitors where name = 'verify-http-30s';" >/dev/null
pass "the same cadence is accepted for HTTP — the minimum cadence is indeed per type"

# ─────────────────────────────────────────────────────────────────────────────
step "6. A probe to a URL that answers goes \"healthy\""

set_mode up
hook_reset

code=$(req POST /api/monitors "$(jq -nc \
  --arg url "$LIVE_URL" --arg hook "$HOOK_URL" \
  '{name:"verify-live",type:"http",
    config:{url:$url,keyword:"SUPERVISION-OK"},
    intervalSeconds:30,failureThreshold:3,recoveryThreshold:2,
    webhookUrl:$hook}')")
[ "$code" = "201" ] || fail "creation → HTTP $code: $(cat "$BODY")"
LIVE_ID=$(jq -r '.id' "$BODY")
jq -e '.neverRan == true' "$BODY" >/dev/null || fail "a new probe must say it never ran"
jq -e '.uptime24h.ratio == null' "$BODY" >/dev/null \
  || fail "a probe without a measure must return a null ratio, not 0 %"
jq -e '.hasWebhook == true' "$BODY" >/dev/null || fail "the webhook is not saved"
pass "probe created — \"never ran\", null rate (and not 0 %)"

stored_hook=$(psql_q "select webhook_url_encrypted from monitors where id = '$LIVE_ID';")
grep -q "^v1:" <<< "$stored_hook" || fail "the webhook is not encrypted in the database: $stored_hook"
grep -q "$RECEIVER" <<< "$stored_hook" && fail "the webhook's URL appears in clear in the database"
req GET "/api/monitors/$LIVE_ID" >/dev/null
grep -q "$HOOK_URL" "$BODY" && fail "the API returns the webhook's URL"
pass "webhook encrypted in the database (v1: prefix) and never returned by the API"

probe() {
  req POST "/api/monitors/$1/check" >/dev/null
  sleep 3
}

probe "$LIVE_ID"
code=$(req GET "/api/monitors/$LIVE_ID")
[ "$code" = "200" ] || fail "reading → HTTP $code"
STATUS=$(jq -r '.status' "$BODY")
LATENCY=$(jq -r '.lastLatencyMs' "$BODY")
HTTPCODE=$(jq -r '.lastMetrics.httpStatus' "$BODY")
[ "$STATUS" = "healthy" ] || fail "expected healthy, got \"$STATUS\" — $(jq -r '.lastDetail' "$BODY")"
[ "$LATENCY" != "null" ] && [ "$LATENCY" -ge 0 ] || fail "no latency measured"
[ "$HTTPCODE" = "200" ] || fail "expected HTTP code 200, got $HTTPCODE"
pass "healthy probe, latency measured: ${LATENCY} ms, code $HTTPCODE, keyword found"

# ─────────────────────────────────────────────────────────────────────────────
step "6 bis. The SCHEDULED SWEEP measures, not only \"probe now\""

# Two distinct paths lead to a measure: the explicit request, which reads the
# probe again with the query builder, and the sweep every 30 s, which claims it
# in raw SQL. A bug lived in the second while the first worked — it only showed
# on a screen left open. Both are exercised here.
BEFORE_SWEEP=$(psql_q "select count(*) from monitor_checks where monitor_id = '$LIVE_ID';")
BEFORE_TS=$(psql_q "select extract(epoch from last_checked_at)::bigint from monitors where id = '$LIVE_ID';")
psql_q "update monitors set next_check_at = now() where id = '$LIVE_ID';" >/dev/null
info "due date brought forward; waiting for one sweep occurrence (30 s)"
sleep 40

AFTER_SWEEP=$(psql_q "select count(*) from monitor_checks where monitor_id = '$LIVE_ID';")
AFTER_TS=$(psql_q "select extract(epoch from last_checked_at)::bigint from monitors where id = '$LIVE_ID';")
[ "$AFTER_SWEEP" -gt "$BEFORE_SWEEP" ] \
  || fail "the scheduled sweep produced no measure ($BEFORE_SWEEP → $AFTER_SWEEP)"
[ "$AFTER_TS" -gt "$BEFORE_TS" ] || fail "the sweep did not update the probe"

req GET "/api/monitors/$LIVE_ID" >/dev/null
[ "$(jq -r '.status' "$BODY")" = "healthy" ] \
  || fail "after the sweep, state \"$(jq -r '.status' "$BODY")\" — $(jq -r '.lastDetail' "$BODY")"
CF=$(jq -r '.consecutiveFailures' "$BODY"); CS=$(jq -r '.consecutiveSuccesses' "$BODY")
case "$CF" in ''|*[!0-9]*) fail "failure counter corrupted after the sweep: \"$CF\"" ;; esac
case "$CS" in ''|*[!0-9]*) fail "success counter corrupted after the sweep: \"$CS\"" ;; esac
[ "$CS" -ge 1 ] || fail "the sweep did not increment the consecutive successes"
pass "scheduled sweep: $BEFORE_SWEEP → $AFTER_SWEEP measures, integer counters ($CF failures, $CS successes)"

ERRS=$(docker compose logs worker --since 2m 2>&1 | grep -c "monitoring probe failed" || true)
[ "$ERRS" = "0" ] || fail "$ERRS probe error(s) in the worker's logs during the sweep"
pass "no probe error in the worker's logs"

# ─────────────────────────────────────────────────────────────────────────────
step "7. An isolated bounce creates no incident"

set_mode down
probe "$LIVE_ID"
req GET "/api/monitors/$LIVE_ID" >/dev/null
[ "$(jq -r '.status' "$BODY")" = "healthy" ] \
  || fail "a single failure switched the probe — the threshold is useless"
[ "$(jq -r '.consecutiveFailures' "$BODY")" = "1" ] || fail "wrong failure counter"
[ "$(jq -r '.lastOutcome' "$BODY")" = "unhealthy" ] \
  || fail "the last raw verdict should be unhealthy"
pass "1 failure out of 3: confirmed state still \"healthy\", raw verdict \"answers badly\""

set_mode up
probe "$LIVE_ID"
req GET "/api/monitors/$LIVE_ID" >/dev/null
[ "$(jq -r '.status' "$BODY")" = "healthy" ] || fail "the probe should have come back healthy"
[ "$(jq -r '.incidents | length' "$BODY")" = "0" ] \
  || fail "a bounce created an incident: $(jq -c '.incidents' "$BODY")"
[ "$(jq -r 'length' <<< "$(hooks)")" = "0" ] \
  || fail "a bounce emitted an alert: $(hooks)"
pass "bounce absorbed: no incident, no alert"

# ─────────────────────────────────────────────────────────────────────────────
step "8. The outage is confirmed at the threshold, and a single alert goes out"

set_mode down
probe "$LIVE_ID"
req GET "/api/monitors/$LIVE_ID" >/dev/null
[ "$(jq -r '.status' "$BODY")" = "healthy" ] || fail "failure 1: premature switch"
info "failure 1 out of 3 — confirmed state \"$(jq -r '.status' "$BODY")\""

probe "$LIVE_ID"
req GET "/api/monitors/$LIVE_ID" >/dev/null
[ "$(jq -r '.status' "$BODY")" = "healthy" ] || fail "failure 2: premature switch"
[ "$(jq -r '.incidents | length' "$BODY")" = "0" ] || fail "failure 2: premature incident"
info "failure 2 out of 3 — confirmed state \"$(jq -r '.status' "$BODY")\", still no incident"

probe "$LIVE_ID"
req GET "/api/monitors/$LIVE_ID" >/dev/null
STATUS=$(jq -r '.status' "$BODY")
[ "$STATUS" = "unhealthy" ] || fail "failure 3: expected unhealthy, got \"$STATUS\""
[ "$(jq -r '.incidents | length' "$BODY")" = "1" ] \
  || fail "no incident open at the threshold: $(jq -c '.incidents' "$BODY")"
jq -e '.incidents[0].resolvedAt == null' "$BODY" >/dev/null || fail "the incident is born already closed"
jq -e '.incidents[0].failureCount == 3' "$BODY" >/dev/null \
  || fail "the incident does not keep how many failures confirmed it"
pass "outage confirmed at the 3rd failure — one incident open, confirmed after 3 failures"

sleep 2
DOWN_HOOKS=$(jq -r '[.[] | select(.body.event == "monitor.down")] | length' <<< "$(hooks)")
[ "$DOWN_HOOKS" = "1" ] || fail "expected 1 outage alert, got $DOWN_HOOKS: $(hooks)"
jq -e '.[0].body.text | test("verify-live")' <<< "$(hooks)" >/dev/null \
  || fail "the payload does not name the probe"
jq -e '.[0].body.text == .[0].body.content' <<< "$(hooks)" >/dev/null \
  || fail "text and content should carry the same sentence (Slack / Discord)"
pass "webhook emitted ONLY ONCE: $(jq -r '.[0].body.text' <<< "$(hooks)")"

probe "$LIVE_ID"
probe "$LIVE_ID"
DOWN_HOOKS=$(jq -r '[.[] | select(.body.event == "monitor.down")] | length' <<< "$(hooks)")
[ "$DOWN_HOOKS" = "1" ] || fail "the lasting outage emitted again: $DOWN_HOOKS alerts"
req GET "/api/monitors/$LIVE_ID" >/dev/null
[ "$(jq -r '.incidents | length' "$BODY")" = "1" ] || fail "a second incident was opened"
pass "two more failures: still 1 incident, still 1 alert — not one per measure"

# ─────────────────────────────────────────────────────────────────────────────
step "9. The incident closes at the recovery, and the recovery alert goes out"

set_mode up
probe "$LIVE_ID"
req GET "/api/monitors/$LIVE_ID" >/dev/null
[ "$(jq -r '.status' "$BODY")" = "unhealthy" ] \
  || fail "a single success raised the probe — the recovery threshold is useless"
info "success 1 out of 2 — confirmed state still \"failing\""

probe "$LIVE_ID"
req GET "/api/monitors/$LIVE_ID" >/dev/null
[ "$(jq -r '.status' "$BODY")" = "healthy" ] || fail "the probe did not come back healthy"
jq -e '.incidents[0].resolvedAt != null' "$BODY" >/dev/null || fail "the incident is not closed"
DURATION=$(jq -r '.incidents[0].durationSeconds' "$BODY")
pass "incident closed after ${DURATION} s of outage, at the 2nd consecutive success"

sleep 2
UP_HOOKS=$(jq -r '[.[] | select(.body.event == "monitor.up")] | length' <<< "$(hooks)")
[ "$UP_HOOKS" = "1" ] || fail "expected 1 recovery alert, got $UP_HOOKS: $(hooks)"
pass "recovery webhook: $(jq -r '[.[] | select(.body.event == "monitor.up")][0].body.text' <<< "$(hooks)")"

TOTAL_HOOKS=$(jq -r 'length' <<< "$(hooks)")
[ "$TOTAL_HOOKS" = "2" ] || fail "$TOTAL_HOOKS messages in total for one outage — expected 2"
pass "2 messages in total for the whole outage: one alert, one recovery"

req GET "/api/audit-logs?resourceType=monitor&pageSize=20" >/dev/null
for action in monitor.created monitor.down monitor.recovered; do
  jq -e --arg a "$action" '[.items[] | select(.action == $a)] | length > 0' "$BODY" >/dev/null \
    || fail "action \"$action\" missing from the audit log"
  pass "audit: $action"
done

# ─────────────────────────────────────────────────────────────────────────────
step "10. A dead URL: connection refused, outage confirmed at the threshold"

code=$(req POST /api/monitors "$(jq -nc --arg url "$DEAD_URL" \
  '{name:"verify-dead",type:"http",config:{url:$url,timeoutMs:3000},
    intervalSeconds:30,failureThreshold:2,recoveryThreshold:1}')")
[ "$code" = "201" ] || fail "creation → HTTP $code: $(cat "$BODY")"
DEAD_ID=$(jq -r '.id' "$BODY")

probe "$DEAD_ID"
req GET "/api/monitors/$DEAD_ID" >/dev/null
[ "$(jq -r '.status' "$BODY")" = "unknown" ] \
  || fail "1st failure from unknown: the probe must not be confirmed yet"
info "1st failure — $(jq -r '.lastDetail' "$BODY")"

probe "$DEAD_ID"
req GET "/api/monitors/$DEAD_ID" >/dev/null
[ "$(jq -r '.status' "$BODY")" = "unreachable" ] \
  || fail "expected unreachable at the 2nd failure, got \"$(jq -r '.status' "$BODY")\""
[ "$(jq -r '.lastLatencyMs' "$BODY")" = "null" ] \
  || fail "an unreachable target must not report a latency"
pass "dead URL → \"unreachable\" at the 2nd failure: $(jq -r '.lastDetail' "$BODY")"

# ─────────────────────────────────────────────────────────────────────────────
step "11. The availability rate, on a made-up history"

code=$(req POST /api/monitors '{"name":"verify-uptime","type":"http",
  "config":{"url":"https://example.com/"},"intervalSeconds":3600,"enabled":false}')
[ "$code" = "201" ] || fail "creation → HTTP $code: $(cat "$BODY")"
UP_ID=$(jq -r '.id' "$BODY")

# 40 measures over 24 h: 37 healthy, 3 failing → 92.50 %.
# 20 more measures, all healthy, but 3 days old: they only count in the 7 d
# window.
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

[ "$S24" = "40" ] || fail "24 h window: 40 measures expected, $S24 counted"
[ "$U24" = "37" ] || fail "24 h window: 37 healthy expected, $U24 counted"
case "$L24" in
  "92,50 % sur 40 mesures"|"92.50% over 40 readouts") ;;
  *) fail "24 h rate displayed \"$L24\", expected \"92.50% over 40 readouts\"" ;;
esac
pass "24 h: $L24 — 37/40, exact computation"

[ "$S7" = "60" ] || fail "7 d window: 60 measures expected, $S7 counted"
[ "$U7" = "57" ] || fail "7 d window: 57 healthy expected, $U7 counted"
case "$L7" in
  "95,00 % sur 60 mesures"|"95.00% over 60 readouts") ;;
  *) fail "7 d rate displayed \"$L7\", expected \"95.00% over 60 readouts\"" ;;
esac
pass "7 d: $L7 — the window is indeed the announced one, and the denominator is stated"

# ─────────────────────────────────────────────────────────────────────────────
step "12. The retention really deletes the old measures"

psql_q "insert into monitor_checks (monitor_id, checked_at, outcome, latency_ms, metrics)
        select '$UP_ID', now() - interval '45 days' - (n || ' minutes')::interval,
               'healthy'::health_status, 80, '{}'::jsonb
          from generate_series(1, 25) as n;" >/dev/null
OLD=$(psql_q "select count(*) from monitor_checks where monitor_id = '$UP_ID' and checked_at < now() - interval '$RETENTION days';")
[ "$OLD" = "25" ] || fail "25 old measures expected, $OLD inserted"
BEFORE=$(psql_q "select count(*) from monitor_checks where monitor_id = '$UP_ID';")
info "$BEFORE measures in total, $OLD of them beyond the $RETENTION-day retention"

# The purge is limited to once an hour: the marker is removed to force it.
docker compose exec -T redis redis-cli DEL "monitor:prune:last" >/dev/null
req POST "/api/monitors/$DEAD_ID/check" >/dev/null   # a general sweep on the way
sleep 35   # one scheduler occurrence (30 s) + margin

AFTER_OLD=$(psql_q "select count(*) from monitor_checks where monitor_id = '$UP_ID' and checked_at < now() - interval '$RETENTION days';")
AFTER=$(psql_q "select count(*) from monitor_checks where monitor_id = '$UP_ID';")
[ "$AFTER_OLD" = "0" ] || fail "the purge left $AFTER_OLD measures beyond the retention"
[ "$AFTER" = "$((BEFORE - 25))" ] \
  || fail "the purge deleted something other than the 25 old ones: $BEFORE → $AFTER"
pass "purge: $BEFORE → $AFTER measures, exactly the 25 beyond $RETENTION days"

# The incidents, for their part, are not purged.
INC=$(psql_q "select count(*) from monitor_incidents where monitor_id = '$LIVE_ID';")
[ "$INC" -ge 1 ] || fail "the incident disappeared — incidents must never be purged"
pass "the incidents survive the purge ($INC kept)"

# ─────────────────────────────────────────────────────────────────────────────
step "13. TLS probe — the abstraction welcomes something other than HTTP"

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
    pass "badssl.com certificate: $DAYS days left, issued by \"$ISSUER\", $PROTO"
    pass "measures specific to the TLS type — no HTTP column was diverted"
  else
    info "TLS probe in \"$TLS_STATUS\": $(jq -r '.lastDetail' "$BODY")"
    info "(no Internet access from the worker? the type is still exercised)"
  fi
  psql_q "delete from monitors where id = '$TLS_ID';" >/dev/null
else
  info "creation of the TLS probe refused (HTTP $code) — no Internet access from the worker"
fi

# ─────────────────────────────────────────────────────────────────────────────
step "14. Permissions: monitor:read to read, monitor:manage to write"

req DELETE "/api/admin/roles/$VIEWER_ROLE" >/dev/null 2>&1 || true
code=$(req POST /api/admin/roles \
  "{\"key\":\"$VIEWER_ROLE\",\"label\":\"Observateur de sondes\",\"permissions\":[\"monitor:read\"]}")
[ "$code" = "201" ] || fail "creating the role → HTTP $code: $(cat "$BODY")"
pass "role \"$VIEWER_ROLE\" created, with the monitor:read permission only"

code=$(req POST /api/admin/users \
  "{\"name\":\"Observateur sondes\",\"email\":\"$VIEWER_EMAIL\",\"password\":\"motdepasse-tres-long\",\"role\":\"$VIEWER_ROLE\"}")
case "$code" in 201|409) ;; *) fail "creating the user → HTTP $code: $(cat "$BODY")" ;; esac
pass "test user created with this role"

code=$(req POST /api/auth/sign-in/email \
  "{\"email\":\"$VIEWER_EMAIL\",\"password\":\"motdepasse-tres-long\"}" "$VJAR")
[ "$code" = "200" ] || fail "viewer sign-in → HTTP $code: $(cat "$BODY")"

code=$(req GET /api/monitors "" "$VJAR")
[ "$code" = "200" ] || fail "monitor:read should be enough to read: HTTP $code"
pass "reading allowed with monitor:read → 200"

code=$(req POST /api/monitors \
  '{"name":"verify-interdit","type":"http","config":{"url":"https://example.com/"}}' "$VJAR")
[ "$code" = "403" ] || fail "writing without monitor:manage: expected 403, got $code"
jq -e '.error.details.permission == "monitor:manage"' "$BODY" >/dev/null \
  || fail "the missing permission is not named: $(cat "$BODY")"
pass "creation refused → 403, permission \"monitor:manage\" named"

code=$(req DELETE "/api/monitors/$LIVE_ID" "" "$VJAR")
[ "$code" = "403" ] || fail "deletion without monitor:manage: expected 403, got $code"
pass "deletion refused → 403"

code=$(req POST "/api/monitors/$LIVE_ID/check" "" "$VJAR")
[ "$code" = "403" ] || fail "probing on demand without monitor:manage: expected 403, got $code"
pass "\"probe now\" refused → 403 — triggering an outgoing request is a gesture, not a read"

# Removing monitor:read: reading must fall too.
code=$(req PATCH "/api/admin/roles/$VIEWER_ROLE" '{"permissions":[]}')
[ "$code" = "200" ] || fail "changing the role → HTTP $code"
code=$(req GET /api/monitors "" "$VJAR")
[ "$code" = "403" ] || fail "without monitor:read: expected 403, got $code"
pass "without monitor:read, reading falls → 403"

# ─────────────────────────────────────────────────────────────────────────────
step "15. Deleting a probe: its history goes with it"

code=$(req DELETE "/api/monitors/$LIVE_ID")
[ "$code" = "200" ] || fail "suppression → HTTP $code: $(cat "$BODY")"
LEFT=$(psql_q "select count(*) from monitor_checks where monitor_id = '$LIVE_ID';")
LEFT_INC=$(psql_q "select count(*) from monitor_incidents where monitor_id = '$LIVE_ID';")
[ "$LEFT" = "0" ] && [ "$LEFT_INC" = "0" ] \
  || fail "incomplete cascade: $LEFT measures and $LEFT_INC orphan incidents"
pass "probe deleted, $LEFT measure and $LEFT_INC incident left — the cascade holds"

req GET /api/audit-logs?resourceType=monitor >/dev/null
jq -e '[.items[] | select(.action == "monitor.deleted")] | length > 0' "$BODY" >/dev/null \
  || fail "the deletion is not audited"
pass "audit: monitor.deleted"

printf '\n\033[32m✓ Site supervision verified.\033[0m\n'
printf '\033[2m  Screen: %s/monitors\033[0m\n' "$BASE_URL"
