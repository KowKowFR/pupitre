#!/usr/bin/env bash
#
# Checks AI AppSpec generation, open to several providers:
#
#   1. the offline cases — validation loop, retry, catalog
#   2. the three providers are configurable, and the default model follows the
#      provider
#   3. without a key, the route returns 501 with a message saying what is missing
#   4. `application:create` is required to generate
#   5. the key never appears: neither in a response, nor in the HTML, nor in the
#      audit, nor in the settings JSONB, nor in the containers' logs
#   6. an AppSpec provided by hand goes through the whole journey, up to a
#      successful and reachable deployment
#
# ⚠ What this script CANNOT check: that a real model answers. No API key is
#   configured on this instance, and the script does not make one up. So
#   everything that depends on a provider is played either offline with a
#   simulated model (point 1), or on its own refusal (point 3).
#
# Usage:
#   ./scripts/verify-ai.sh
#   BASE_URL=http://localhost:3100 TARGET_NAME=my-vm ./scripts/verify-ai.sh
#
# Rerunnable: everything created is deleted, and the instance settings are
# restored to the state they were found in.
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
# ⚠ Never the "vps" target: it is a real production machine.
TARGET_NAME="${TARGET_NAME:-verification-target}"
CLIENT_IP="${CLIENT_IP:-198.51.100.42}"
ROLE_KEY="${ROLE_KEY:-sans-creation-ia}"
PEON_EMAIL="${PEON_EMAIL:-ia-sans-droit@example.test}"
PEON_PASSWORD="${PEON_PASSWORD:-motdepasse-tres-long}"
APP_SLUG="${APP_SLUG:-verif-ia-manuelle}"

# Sentinel: a string that can be searched for everywhere with no risk of a false
# positive. It plays the part of an API key, and must never come back out.
SENTINEL="sk-sentinelle-verif-ia-0000000000000000"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
PEON_JAR="$WORK/peon.jar"
BODY="$WORK/body.json"
trap 'rm -rf "$WORK"' EXIT

command -v jq >/dev/null || { echo "jq is required"; exit 1; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
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

peon_req() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -H "x-forwarded-for: $CLIENT_IP" -b "$PEON_JAR" -c "$PEON_JAR")
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

# Restores the settings as they were found, whatever happens — including on a
# failure along the way. The security policy is briefly borrowed at point 6; it
# must be given back intact.
INITIAL_AI=""
INITIAL_SECURITY=""
# 1 only if it is THIS script that set the sentinel key. A pre-existing key
# belongs to the operator: it is encrypted and unrecoverable once overwritten,
# so it is not touched — neither to overwrite it, nor to erase it "while
# cleaning up".
KEY_PLANTED=0
restore_settings() {
  local patch='{'
  [ "$KEY_PLANTED" = "1" ] && patch="$patch\"aiApiKey\":null,"
  [ -n "$INITIAL_AI" ] && patch="$patch\"ai\":$INITIAL_AI,"
  [ -n "$INITIAL_SECURITY" ] && patch="$patch\"security\":$INITIAL_SECURITY,"
  patch="${patch%,}}"
  [ "$patch" = "{}" ] && return 0
  req PATCH /api/settings "$patch" >/dev/null 2>&1 || true
}

# ─── 0. Context ───────────────────────────────────────────────────────────────

step "0. Sign-in, target and starting state"
login
pass "signed in as $ADMIN_EMAIL"

code=$(req GET /api/settings)
[ "$code" = "200" ] || fail "GET /api/settings → HTTP $code: $(cat "$BODY")"
INITIAL_AI=$(jq -c '.settings.ai' "$BODY")
INITIAL_SECURITY=$(jq -c '.settings.security' "$BODY")
KEY_CONFIGURED=$(jq -r '.aiApiKeyConfigured' "$BODY")
trap 'restore_settings; rm -rf "$WORK"' EXIT
info "starting AI section: $INITIAL_AI"

if [ "$KEY_CONFIGURED" = "true" ]; then
  warn "an API key is ALREADY saved on this instance"
  warn "points 3 and 5 will be skipped: this script never overwrites a key it did not set"
  warn "(a key is encrypted and unrecoverable once overwritten)"
else
  pass "no key saved — that is the expected state on this instance"
fi

req GET /api/targets >/dev/null
TARGET_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY")
[ -n "$TARGET_ID" ] || fail "target \"$TARGET_NAME\" not found — run ./scripts/setup-test-target.sh"
jq -e --arg n "$TARGET_NAME" \
  '.items[] | select(.name == $n) | .runtimesAvailable.docker.available == true' "$BODY" >/dev/null \
  || fail "the target \"$TARGET_NAME\" has no Docker runtime — run a preflight"
pass "deployment target: $TARGET_NAME — $TARGET_ID"

# ─── 1. Offline ───────────────────────────────────────────────────────────────

step "1. The offline cases — no key, no network"
if (cd "$ROOT" && pnpm test:ai > "$WORK/test-ai.log" 2>&1); then
  pass "$(grep -c '✓' "$WORK/test-ai.log") multi-provider configuration assertions"
  tail -3 "$WORK/test-ai.log" | sed 's/^/    /'
else
  cat "$WORK/test-ai.log"
  fail "pnpm test:ai failed"
fi

if (cd "$ROOT" && pnpm --filter @pupitre/core test > "$WORK/test-core.log" 2>&1); then
  pass "generation loop under a simulated model: $(grep -E '^ℹ pass' "$WORK/test-core.log")"
  grep -E "retries ONCE|stops after the retry|wraps the JSON|truncated response|provider failure|never produces shell" \
    "$WORK/test-core.log" | sed 's/^/    /'
else
  tail -40 "$WORK/test-core.log"
  fail "the @pupitre/core tests failed"
fi

# ─── 2. The three providers ───────────────────────────────────────────────────

step "2. The three providers are configurable"

# The defaults are read from the catalog, not copied: a default that changes in
# the code must not make this script lie.
DEFAULTS=$(cd "$ROOT" && npx tsx -e '
import { AI_PROVIDERS, aiProviderDescriptor } from "@pupitre/core/ai";
process.stdout.write(JSON.stringify(Object.fromEntries(
  AI_PROVIDERS.map((p) => [p, aiProviderDescriptor(p)]),
)));
')
PROVIDERS=$(jq -r 'keys[]' <<< "$DEFAULTS")
info "catalogue: $(tr '\n' ' ' <<< "$PROVIDERS")"

for provider in $PROVIDERS; do
  model=$(jq -r --arg p "$provider" '.[$p].defaultModel' <<< "$DEFAULTS")
  code=$(req PATCH /api/settings "{\"ai\":{\"provider\":\"$provider\",\"model\":\"$model\"}}")
  [ "$code" = "200" ] || fail "PATCH ai.provider=$provider → HTTP $code: $(cat "$BODY")"
  jq -e --arg p "$provider" --arg m "$model" \
    '.settings.ai.provider == $p and .settings.ai.model == $m' "$BODY" >/dev/null \
    || fail "provider not kept: $(jq -c .settings.ai "$BODY")"
  pass "\"$provider\" kept, default model \"$model\""
done

code=$(req PATCH /api/settings '{"ai":{"provider":"skynet"}}')
[ "$code" = "422" ] || fail "made-up provider: expected 422, got $code"
pass "a provider outside the catalog is refused → 422"

code=$(req PATCH /api/settings '{"ai":{"baseUrl":"pas-une-url"}}')
[ "$code" = "422" ] || fail "shaky base URL: expected 422, got $code"
pass "an invalid base URL is refused → 422"

# Regression: `aiSettingsSchema.partial()` filled in the defaults, and a PATCH
# carrying only `enabled` reset the provider, model and temperature.
req PATCH /api/settings '{"ai":{"provider":"anthropic","model":"claude-opus-4-5","temperature":0.35}}' >/dev/null
code=$(req PATCH /api/settings '{"ai":{"enabled":true}}')
[ "$code" = "200" ] || fail "partial PATCH → HTTP $code"
jq -e '.settings.ai.provider == "anthropic" and .settings.ai.model == "claude-opus-4-5"
       and .settings.ai.temperature == 0.35' "$BODY" >/dev/null \
  || fail "a partial PATCH reset the AI section: $(jq -c .settings.ai "$BODY")"
pass "a partial PATCH erases neither the provider, nor the model, nor the temperature"

# ─── 3. Without a key, the route refuses cleanly ──────────────────────────────

step "3. Without an API key, generation returns 501 and says what is missing"
if [ "$KEY_CONFIGURED" = "true" ]; then
  warn "skipped: a key is saved on this instance"
else
  for provider in $PROVIDERS; do
    model=$(jq -r --arg p "$provider" '.[$p].defaultModel' <<< "$DEFAULTS")
    label=$(jq -r --arg p "$provider" '.[$p].label' <<< "$DEFAULTS")
    envvar=$(jq -r --arg p "$provider" '.[$p].envApiKeyVar // ""' <<< "$DEFAULTS")

    req PATCH /api/settings \
      "{\"ai\":{\"provider\":\"$provider\",\"model\":\"$model\",\"enabled\":true}}" >/dev/null

    code=$(req POST /api/applications/generate \
      '{"prompt":"une application GLPI avec sa base de donnees"}')
    [ "$code" = "501" ] || fail "$provider: expected 501, got $code — $(cat "$BODY")"

    message=$(jq -r '.error.message' "$BODY")
    grep -q "$label" <<< "$message" || fail "the message does not name \"$label\": $message"
    if [ -n "$envvar" ]; then
      grep -q "$envvar" <<< "$message" || fail "the message does not name \"$envvar\": $message"
    fi
    pass "$provider → 501: $message"
  done

  # A malformed request stays malformed, with or without a key: the body
  # validation comes BEFORE the configuration.
  code=$(req POST /api/applications/generate '{"prompt":"court"}')
  [ "$code" = "422" ] || fail "prompt too short: expected 422, got $code"
  pass "a prompt that is too short is refused with 422, not hidden by the 501"

  # The switch produces a message different from the missing key: the two
  # causes are not cured the same way.
  req PATCH /api/settings '{"ai":{"enabled":false}}' >/dev/null
  code=$(req POST /api/applications/generate \
    '{"prompt":"une application GLPI avec sa base de donnees"}')
  [ "$code" = "501" ] || fail "AI switched off: expected 501, got $code"
  jq -e '.error.message | test("désactivée dans les paramètres|off in this instance")' "$BODY" >/dev/null \
    || fail "message indistinct from the missing key: $(jq -r .error.message "$BODY")"
  pass "AI switched off in the settings → 501, with a distinct reason"
  req PATCH /api/settings '{"ai":{"enabled":true}}' >/dev/null
fi

# ─── 4. Permissions ───────────────────────────────────────────────────────────

step "4. \"application:create\" is required"
req DELETE "/api/admin/roles/$ROLE_KEY" >/dev/null 2>&1 || true
code=$(req POST /api/admin/roles \
  "{\"key\":\"$ROLE_KEY\",\"label\":\"Sans création\",\"permissions\":[\"application:read\",\"deployment:read\"]}")
case "$code" in
  201) pass "role \"$ROLE_KEY\" created, without application:create" ;;
  409) pass "role \"$ROLE_KEY\" already present" ;;
  *)   fail "POST /api/admin/roles → HTTP $code: $(cat "$BODY")" ;;
esac

code=$(req POST /api/admin/users \
  "{\"name\":\"Sans droit IA\",\"email\":\"$PEON_EMAIL\",\"password\":\"$PEON_PASSWORD\",\"role\":\"$ROLE_KEY\"}")
case "$code" in
  201|409) PEON_ID=$(psql_q "select id from users where email = '$PEON_EMAIL';") ;;
  *)       fail "POST /api/admin/users → HTTP $code: $(cat "$BODY")" ;;
esac
[ -n "$PEON_ID" ] || fail "test user's identifier not found"
req PATCH "/api/admin/users/$PEON_ID/role" "{\"role\":\"$ROLE_KEY\"}" >/dev/null
pass "user \"$PEON_EMAIL\" — $PEON_ID"

code=$(peon_req POST /api/auth/sign-in/email \
  "{\"email\":\"$PEON_EMAIL\",\"password\":\"$PEON_PASSWORD\"}")
[ "$code" = "200" ] || fail "test user sign-in → HTTP $code"

code=$(peon_req POST /api/applications/generate \
  '{"prompt":"une application GLPI avec sa base de donnees"}')
[ "$code" = "403" ] || fail "generation without permission: expected 403, got $code"
pass "POST /api/applications/generate without application:create → 403"

code=$(peon_req POST /api/applications \
  '{"appSpec":{"name":"interdit","version":"1.0.0","services":[]}}')
[ "$code" = "403" ] || fail "creation without permission: expected 403, got $code"
pass "POST /api/applications without application:create → 403"

# ─── 5. The key never leaks ───────────────────────────────────────────────────

step "5. The API key appears nowhere"
if [ "$KEY_CONFIGURED" = "true" ]; then
  warn "skipped: a key is already saved, and this script will not overwrite it"
  warn "  rerun after removing it from $BASE_URL/admin/settings"
else
SINCE=$(date -u '+%Y-%m-%dT%H:%M:%S')
OR_MODEL=$(jq -r '.openrouter.defaultModel' <<< "$DEFAULTS")
KEY_PLANTED=1
code=$(req PATCH /api/settings \
  "{\"ai\":{\"provider\":\"openrouter\",\"model\":\"$OR_MODEL\",\"enabled\":true},\"aiApiKey\":\"$SENTINEL\"}")
[ "$code" = "200" ] || fail "PATCH with a key → HTTP $code: $(cat "$BODY")"
if grep -q "$SENTINEL" "$BODY"; then fail "the key came back in the PATCH response"; fi
jq -e '.aiApiKeyConfigured == true' "$BODY" >/dev/null || fail "the key was not saved"
pass "key saved — the response does not contain it, only …$(jq -r .aiApiKeyLast4 "$BODY")"

code=$(req GET /api/settings)
if grep -q "$SENTINEL" "$BODY"; then fail "the key leaks through GET /api/settings"; fi
pass "GET /api/settings does not contain it"

# /admin/settings/ai, and not /admin/settings: since the settings were split
# into sub-pages, the root is a summary that renders no key field. Searching it
# for the sentinel would always pass, without proving anything. So we aim at
# the page that really carries the field, and check that it carries it.
curl -s -b "$JAR" -H "origin: $BASE_URL" "$BASE_URL/admin/settings/ai" > "$WORK/settings.html" || true
if ! grep -q 'id="apiKey"' "$WORK/settings.html"; then
  fail "/admin/settings/ai does not render the key field — the following grep would prove nothing"
fi
if grep -q "$SENTINEL" "$WORK/settings.html"; then fail "the key leaks into the HTML of /admin/settings/ai"; fi
pass "the HTML of /admin/settings/ai does not contain it ($(wc -c < "$WORK/settings.html") bytes)"

curl -s -b "$JAR" -H "origin: $BASE_URL" "$BASE_URL/applications?add=new" > "$WORK/new.html" || true
if grep -q "$SENTINEL" "$WORK/new.html"; then fail "the key leaks into the HTML of /applications?add=new"; fi
pass "the HTML of /applications?add=new does not contain it"

req GET "/api/audit-logs?pageSize=50" >/dev/null
if grep -q "$SENTINEL" "$BODY"; then fail "the key leaks into the audit log"; fi
jq -e '[.items[] | select(.action == "settings.updated")] | length > 0' "$BODY" >/dev/null \
  || fail "no settings.updated entry in the audit"
pass "the audit log carries settings.updated, without the key"

psql_q "select coalesce(value::text,'') from app_settings;" > "$WORK/settings.sql" 2>/dev/null || true
if grep -q "$SENTINEL" "$WORK/settings.sql"; then fail "the key leaks into the settings JSONB"; fi
ENCRYPTED=$(psql_q "select coalesce(ai_api_key_encrypted,'') from app_settings;" 2>/dev/null || echo '')
[ -n "$ENCRYPTED" ] || fail "the encrypted column is empty although a key was just set"
if [ "$ENCRYPTED" = "$SENTINEL" ]; then fail "the key is stored IN CLEAR in ai_api_key_encrypted"; fi
if grep -q "$SENTINEL" <<< "$ENCRYPTED"; then fail "the key appears in the encrypted column"; fi
pass "in the database: JSONB without the key, unreadable encrypted column ($(wc -c <<< "$ENCRYPTED") bytes)"

# A REAL call against each provider, with a dummy key. Whatever happens —
# refusal from the provider, network down, timeout — neither the key nor a
# fragment of the key must come back out.
#
# It is not theoretical: OpenAI answers "Incorrect API key provided:
# sk-senti***…***0000", that is twelve characters of the key in clear. So we
# also search for the prefix, not only the whole string.
PREFIX="${SENTINEL:0:8}"

# The route is rate limited — that is deliberate, it costs money. The script
# must still reach the three providers: it waits for the delay the response
# announces rather than concluding on a 429.
generate_once() {
  local code
  code=$(req POST /api/applications/generate \
    '{"prompt":"une application GLPI avec sa base de donnees"}')
  if [ "$code" = "429" ]; then
    local wait_s
    wait_s=$(jq -r '.error.message' "$BODY" | grep -oE '[0-9]+ s' | grep -oE '[0-9]+' | head -1)
    wait_s=$(( ${wait_s:-60} + 3 ))
    [ "$wait_s" -gt 180 ] && wait_s=180
    warn "rate limit reached, waiting ${wait_s} s"
    sleep "$wait_s"
    code=$(req POST /api/applications/generate \
      '{"prompt":"une application GLPI avec sa base de donnees"}')
  fi
  printf '%s' "$code"
}

REACHED=0
for provider in $PROVIDERS; do
  model=$(jq -r --arg p "$provider" '.[$p].defaultModel' <<< "$DEFAULTS")
  req PATCH /api/settings \
    "{\"ai\":{\"provider\":\"$provider\",\"model\":\"$model\",\"enabled\":true},\"aiApiKey\":\"$SENTINEL\"}" >/dev/null
  code=$(generate_once)
  if grep -q "$SENTINEL" "$BODY"; then fail "$provider: the key leaks into the error response"; fi
  if grep -q "$PREFIX" "$BODY"; then
    fail "$provider: a fragment of the key leaks — $(jq -r .error.message "$BODY")"
  fi
  [ "$code" = "502" ] && REACHED=$((REACHED + 1))
  info "$provider → HTTP $code: $(jq -r '.error.message // "—"' "$BODY" | head -c 110)"
done
[ "$REACHED" = "3" ] \
  || fail "only $REACHED provider(s) out of 3 were reached — the others proved nothing"
pass "the three providers were called for real: no fragment of the key in the response"

# Bounded to this run: an entry written BEFORE the masking fix legitimately
# carries the old message, and has nothing to say about today's code.
req GET "/api/audit-logs?resourceType=application&pageSize=50&from=${SINCE}Z" >/dev/null
if grep -q "$PREFIX" "$BODY"; then fail "a fragment of the key leaks into the audit log"; fi
GENERATED=$(jq -r '[.items[] | select(.action == "application.generation.failed")] | length' "$BODY")
[ "$GENERATED" -ge "$REACHED" ] \
  || fail "$REACHED calls reached, but only $GENERATED audit entry(ies)"
pass "$GENERATED application.generation.failed entries, none carries a fragment of the key"

for service in panel worker; do
  docker compose logs --no-color --since "${SINCE}Z" "$service" > "$WORK/$service.log" 2>/dev/null || true
  if grep -q "$SENTINEL" "$WORK/$service.log"; then
    fail "the key appears in the logs of the \"$service\" container"
  fi
  if grep -q "$PREFIX" "$WORK/$service.log"; then
    fail "a fragment of the key appears in the logs of the \"$service\" container"
  fi
  pass "logs of \"$service\": no trace of the key ($(wc -l < "$WORK/$service.log") lines)"
done

# Changing the provider without changing the model must be FLAGGED, not
# discovered a minute later in a 404 from the provider. The key is still set:
# generation is therefore active, and the screen must carry the warning.
req PATCH /api/settings \
  '{"ai":{"provider":"anthropic","model":"anthropic/claude-sonnet-4.5","enabled":true}}' >/dev/null
curl -s -b "$JAR" -H "origin: $BASE_URL" "$BASE_URL/applications?add=new" > "$WORK/mismatch.html" || true
if grep -qE "identifiant OpenRouter|ID for OpenRouter" "$WORK/mismatch.html"; then
  pass "model inconsistent with the provider → flagged on /applications?add=new"
else
  fail "no warning on /applications?add=new for anthropic + anthropic/claude-sonnet-4.5"
fi

req PATCH /api/settings '{"aiApiKey":null}' >/dev/null
jq -e '.aiApiKeyConfigured == false' "$BODY" >/dev/null || fail "the key was not erased"
KEY_PLANTED=0
pass "test key erased"
fi

# ─── 6. The whole journey, up to the deployment ───────────────────────────────

step "6. An AppSpec provided by hand goes up to the deployment"

# Single service on purpose: a database would declare secrets, whose values the
# panel does not store yet — it would start without a password.
cat > "$WORK/spec.json" <<JSON
{
  "appSpec": {
    "name": "$APP_SLUG",
    "version": "1.0.0",
    "services": [
      {
        "name": "web",
        "source": { "type": "image", "ref": "docker.io/library/nginx:1.29-alpine" },
        "port": 80,
        "exposed": true,
        "resources": { "cpuMilli": 250, "memoryMi": 256 },
        "healthcheck": { "path": "/", "intervalSec": 5, "timeoutSec": 3, "retries": 10 }
      }
    ]
  }
}
JSON

req GET /api/applications >/dev/null
APP_ID=$(jq -r --arg s "$APP_SLUG" '.items[] | select(.slug == $s) | .id' "$BODY" | head -1)
if [ -n "$APP_ID" ]; then
  code=$(req PATCH "/api/applications/$APP_ID" "@$WORK/spec.json")
  [ "$code" = "200" ] || fail "PATCH /api/applications → HTTP $code: $(cat "$BODY")"
  pass "application \"$APP_SLUG\" replaced — $APP_ID"
else
  code=$(req POST /api/applications "@$WORK/spec.json")
  [ "$code" = "201" ] || fail "POST /api/applications → HTTP $code: $(cat "$BODY")"
  APP_ID=$(jq -r .id "$BODY")
  pass "application \"$APP_SLUG\" created — $APP_ID"
fi

# `scanConfig` deliberately absent: it is the instance's security policy that
# applies, and choosing it here would require `scan:configure`.
deploy_and_wait() {
  code=$(req POST /api/deployments \
    "{\"applicationId\":\"$APP_ID\",\"targetId\":\"$TARGET_ID\",\"runtime\":\"docker\",\"proxy\":\"traefik\",\"autoRollback\":true}")
  [ "$code" = "202" ] || fail "POST /api/deployments → HTTP $code: $(cat "$BODY")"
  DEPLOY_ID=$(jq -r .id "$BODY")
  STATUS=""
  for _ in $(seq 1 150); do
    sleep 2
    req GET "/api/deployments/$DEPLOY_ID" >/dev/null
    STATUS=$(jq -r .status "$BODY")
    case "$STATUS" in success|failed|rolled_back|destroyed) break ;; esac
  done
}

destroy_deployment() {
  [ -n "${1:-}" ] || return 0
  req DELETE "/api/deployments/$1" >/dev/null 2>&1 || true
  for _ in $(seq 1 90); do
    sleep 2
    req GET "/api/deployments/$1" >/dev/null
    [ "$(jq -r .status "$BODY")" = "destroyed" ] && break
  done
}

deploy_and_wait
pass "deployment queued — $DEPLOY_ID (without scanConfig: instance policy)"
info "policy applied: $(jq -rc '{scanners:.scanConfig.scanners, failOn:.scanConfig.failOn}' "$BODY")"

if [ "$STATUS" != "success" ]; then
  BLOCKED=$(jq -r '[.steps[] | select(.key == "scan") | .log, .error] | join(" ")' "$BODY" | tail -c 400)
  if grep -qiE "déploiement bloqué|deployment blocked" <<< "$BLOCKED"; then
    # It is NOT a defect of the journey: the instance's policy (failOn=CRITICAL,
    # all scanners) blocks any public image whose vulnerability database
    # reports a CRITICAL — which is the case of nginx:alpine today. We say so,
    # then replay with the policy loosened for the time of the proof, and put it
    # back afterwards.
    warn "the instance's security policy blocked the release — it is the policy speaking"
    info "$(tr -d '\n' <<< "$BLOCKED" | tail -c 220)"
    pass "the instance policy does apply to calls that omit scanConfig"

    destroy_deployment "$DEPLOY_ID"
    req PATCH /api/settings '{"security":{"failOn":"NONE"}}' >/dev/null
    warn "policy temporarily loosened (failOn=NONE) to prove the rest of the journey"
    deploy_and_wait
  fi
fi

[ "$STATUS" = "success" ] \
  || fail "deployment in \"$STATUS\" — $(jq -r '[.steps[].log] | join("")' "$BODY" | tail -c 600)"

PORT=$(jq -r '.publishedPort // empty' "$BODY")
[ -n "$PORT" ] || fail "the deployment published no port"
http=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://127.0.0.1:$PORT" || echo 000)
[ "$http" = "200" ] || fail "http://127.0.0.1:$PORT → HTTP $http"
pass "deployed and reachable — HTTP 200 on port $PORT"

SCANNERS=$(jq -rc '.scanConfig.scanners // []' "$BODY")
info "scan policy inherited from the instance: $SCANNERS"

# ─── 7. Cleanup ───────────────────────────────────────────────────────────────

step "7. Cleanup"
destroy_deployment "$DEPLOY_ID"
pass "deployment destroyed"

# The application can only be deleted once its deployments are purged from the
# log — a "destroyed" deployment stays a trace, and that is deliberate. So it is
# kept, as the other verification scripts do: the next pass replaces it by
# PATCH rather than recreating it.
code=$(req DELETE "/api/applications/$APP_ID")
case "$code" in
  200|204) pass "application \"$APP_SLUG\" deleted" ;;
  409)     info "application \"$APP_SLUG\" kept: $(jq -r .error.message "$BODY")" ;;
  *)       warn "DELETE /api/applications → HTTP $code" ;;
esac

req PATCH "/api/admin/users/$PEON_ID/role" '{"role":"viewer"}' >/dev/null 2>&1 || true
req DELETE "/api/admin/users/$PEON_ID" >/dev/null 2>&1 || true
req DELETE "/api/admin/roles/$ROLE_KEY" >/dev/null 2>&1 || true
pass "test user and role deleted"

restore_settings
req GET /api/settings >/dev/null
jq -e --argjson expected "$INITIAL_AI" '.settings.ai == $expected' "$BODY" >/dev/null \
  || fail "AI section not restored: $(jq -c .settings.ai "$BODY")"
jq -e --argjson expected "$INITIAL_SECURITY" '.settings.security == $expected' "$BODY" >/dev/null \
  || fail "security policy not restored: $(jq -c .settings.security "$BODY")"
if [ "$KEY_CONFIGURED" != "true" ]; then
  jq -e '.aiApiKeyConfigured == false' "$BODY" >/dev/null \
    || fail "a test key stayed saved"
fi
pass "settings restored — AI: $(jq -c .settings.ai "$BODY")"
pass "settings restored — security: $(jq -c .settings.security "$BODY")"

printf '\n\033[32m✓ Multi-provider generation verified.\033[0m\n'
printf '\033[33m  ! NOT VERIFIED for lack of a key: that a real model produces an AppSpec.\n'
printf '    The loop is covered offline (simulated model); the network call is not.\033[0m\n'
printf '\033[2m  Screens: %s/applications/new — %s/admin/settings\033[0m\n\n' "$BASE_URL" "$BASE_URL"
