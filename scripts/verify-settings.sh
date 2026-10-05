#!/usr/bin/env bash
#
# Checks the instance settings and the AI configuration:
#
#   1. reading the settings — complete defaults on a blank database
#   2. changing the name, and its reappearance in the home page's HTML
#   3. a made-up time zone is refused (422)
#   4. the API key NEVER appears in a GET response, nor in the HTML of ANY of
#      the settings pages — /admin/settings/ai included
#   5. setting a key; PATCH without the field → kept; PATCH `null` → erased
#   6. the audit contains `settings.updated` and does NOT contain the key
#   7. `settings:manage` is required to write, and an auditor sees the sections
#      without being able to change them
#   8. each subsection is reachable and renders its fields
#   9. saving a section changes NO other section
#
# Usage:
#   ./scripts/verify-settings.sh
#   BASE_URL=http://localhost:3200 ./scripts/verify-settings.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
VIEWER_EMAIL="${VIEWER_EMAIL:-settings-viewer@example.test}"
VIEWER_PASSWORD="${VIEWER_PASSWORD:-motdepasse-tres-long}"
CLIENT_IP="${CLIENT_IP:-198.51.100.77}"

# Sentinel: a string no other field can contain by accident. It is the one we
# look for in the responses and in the audit log.
SECRET_KEY="${SECRET_KEY:-sk-or-v1-SENTINELLE-NE-DOIT-JAMAIS-FUIR-4242}"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
VIEWER_JAR="$WORK/viewer.jar"
BODY="$WORK/body.json"
KEY_SNAPSHOT="$WORK/ai-key.b64"

# The instance's API key, set aside then given back.
#
# Step 2 runs `delete from app_settings` — it has to, it is how we prove that
# an empty table returns complete defaults. But this table carries
# `ai_api_key_encrypted`, and **an erased encrypted key is lost**: neither the
# audit nor the logs keep a trace of it, it is the very guarantee of the
# encryption. The script then gave the settings back to their defaults and
# announced "key erased" as if it were an intended state. On an instance in
# service, running a verification has no business costing a key the operator
# will have to fetch again from their provider.
#
# We go through base64 rather than a direct interpolation: the encrypted value
# contains ":" and base64, and a single misplaced apostrophe in a hand-built SQL
# command would be enough to break everything.
snapshot_ai_key() {
  psql_q "select coalesce(encode(convert_to(ai_api_key_encrypted, 'UTF8'), 'base64'), '')
          from app_settings where id = 1;" 2>/dev/null | tr -d ' \n\r' > "$KEY_SNAPSHOT" || true
}

restore_ai_key() {
  local encoded
  encoded=$(cat "$KEY_SNAPSHOT" 2>/dev/null || true)
  [ -n "$encoded" ] || return 0
  psql_q "update app_settings
          set ai_api_key_encrypted = convert_from(decode('$encoded', 'base64'), 'UTF8')
          where id = 1;" >/dev/null 2>&1 || true
}

# On EXIT, so including after a `fail` along the way: a verification that stops
# at step 7 must not leave the instance crippled.
trap 'restore_ai_key; rm -rf "$WORK"' EXIT

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

psql_q() { docker compose exec -T postgres psql -U tp -d "${PGDATABASE:-tp}" -tAc "$1"; }

# The settings screen's pages, all of them.
#
# The settings are no longer a single page: each domain has its address, filed
# in one of the rail's four groups. This list is what keeps a non-leak
# assertion from settling for the first page that comes along.
SETTINGS_PAGES="/admin/settings/identity
/admin/settings/regional
/admin/settings/security
/admin/settings/sso
/admin/settings/accounts
/admin/settings/notifications
/admin/settings/ai
/admin/settings/onboarding"

# A page's HTML into $2, requiring an **outright** 200.
#
# Deliberately without `-L`: a subsection turned into a redirect would make all
# the following `grep`s pass without them looking at the right document.
# Requiring the direct 200 is requiring that the page really exists.
page() {
  local path="$1" out="$2" jar="${3:-$JAR}" code
  code=$(curl -s -o "$out" -w '%{http_code}' -b "$jar" -c "$jar" \
    -H "origin: $BASE_URL" "$BASE_URL$path")
  [ "$code" = "200" ] || fail "GET $path → HTTP $code (expected 200, without a redirect)"
}

# Fingerprint of the sections OTHER than the one just saved.
#
# The sections are intentions, not JSONB keys: "regional settings" covers four
# root fields, "AI" covers `ai` plus the key's state. The fingerprint groups
# them as the screen groups them, then removes the targeted one — what remains
# must be identical down to the bit.
fingerprint() {
  local skip="$1" file="$2"
  jq -S --arg skip "$skip" '{
    identity: { name: .settings.instanceName, tagline: .settings.instanceTagline },
    regional: {
      tz: .settings.timezone, locale: .settings.locale,
      date: .settings.dateStyle, time: .settings.timeStyle
    },
    security: .settings.security,
    ai: (.settings.ai + { key: .aiApiKeyConfigured, last4: .aiApiKeyLast4 }),
    accounts: .settings.accounts,
    onboarding: .settings.onboarding
  } | del(.[$skip])' "$file"
}

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

step "1. Sign-in"
login
pass "signed in as $ADMIN_EMAIL"

step "2. Reading the settings — the defaults are complete"
# Table reset: we want to prove that a blank database does return a complete
# object, not a `null` nor an object with holes.
snapshot_ai_key
psql_q "delete from app_settings;" >/dev/null
code=$(req GET /api/settings)
[ "$code" = "200" ] || fail "GET /api/settings → HTTP $code: $(cat "$BODY")"
cp "$BODY" "$WORK/defaults.json"

for field in instanceName instanceTagline timezone locale dateStyle timeStyle; do
  jq -e --arg f "$field" '.settings[$f] != null' "$BODY" >/dev/null \
    || fail "field \"$field\" missing from the default settings"
done
for field in provider model enabled temperature maxTokens; do
  jq -e --arg f "$field" '.settings.ai[$f] != null' "$BODY" >/dev/null \
    || fail "field \"ai.$field\" missing from the default settings"
done
# The default comes from `DEFAULT_APP_SETTINGS` in `packages/core/src/settings.ts`,
# never from the column default: it is `mergeAppSettings()` that fills an empty
# table. If the two ever diverge, it is here that it will show.
jq -e '.settings.instanceName == "Pupitre"' "$BODY" >/dev/null \
  || fail "unexpected default name: $(jq -c .settings.instanceName "$BODY")"
jq -e '.settings.timezone == "Europe/Paris"' "$BODY" >/dev/null \
  || fail "unexpected default time zone"
jq -e '.settings.locale == "en-US" and .settings.instanceTagline == "Deployment control plane"' "$BODY" >/dev/null \
  || fail "unexpected default language: $(jq -c '[.settings.locale, .settings.instanceTagline]' "$BODY")"
jq -e '.aiApiKeyConfigured == false' "$BODY" >/dev/null \
  || fail "a key is flagged although the table is empty"
TZ_COUNT=$(jq -r '.vocabulary.timezones | length' "$BODY")
[ "$TZ_COUNT" -ge 100 ] || fail "suspicious time zone vocabulary: $TZ_COUNT entry(ies)"
pass "complete object on a blank database — $(jq -r '.settings.instanceName' "$WORK/defaults.json") / $(jq -r '.settings.timezone' "$WORK/defaults.json")"
info "$TZ_COUNT time zones offered, $(jq -r '.vocabulary.locales | join(", ")' "$BODY")"

# The setup guide, settled immediately.
#
# The table was just emptied: the progress started from zero again, and the
# `(app)` layout then sends EVERY authenticated page to /onboarding — a 307. So
# all the following `grep`s on HTML would read an empty redirect body and
# succeed without looking at the right document. It is precisely the kind of
# assertion that lies: we settle the journey before looking at anything, and
# `page()` then requires an outright 200.
code=$(req PATCH /api/onboarding '{"action":"dismiss"}')
[ "$code" = "200" ] || fail "abandoning the guide → HTTP $code: $(cat "$BODY")"
pass "setup guide settled — the panel's screens answer 200 again"

step "3. Changing the name, and finding it in the HTML"
NEW_NAME="Panel de vérification"
code=$(req PATCH /api/settings "{\"instanceName\":\"$NEW_NAME\",\"instanceTagline\":\"accroche de test\"}")
[ "$code" = "200" ] || fail "PATCH → HTTP $code: $(cat "$BODY")"
jq -e --arg n "$NEW_NAME" '.settings.instanceName == $n' "$BODY" >/dev/null \
  || fail "the name was not kept: $(jq -c .settings.instanceName "$BODY")"
pass "name saved: $NEW_NAME"

stored=$(psql_q "select value->>'instanceName' from app_settings where id = 1;")
[ "$stored" = "$NEW_NAME" ] || fail "in the database: \"$stored\""
rows=$(psql_q "select count(*) from app_settings;")
[ "$rows" = "1" ] || fail "app_settings contains $rows row(s), the singleton does not hold"
pass "a single row in the database, id = 1"

# The home page is rendered by the server: the name must be in it.
#
# The settings are cached for a few seconds, and this cache is PER PROCESS: the
# write invalidates the one of the process that handled the PATCH, another Next
# worker can still serve the old value for the TTL's duration. So we give the
# cache time to expire rather than claiming an immediate consistency that is
# not promised.
home_ok=""
for _ in $(seq 1 12); do
  curl -sL -b "$JAR" -c "$JAR" -H "origin: $BASE_URL" "$BASE_URL/" > "$WORK/home.html"
  if grep -q "$NEW_NAME" "$WORK/home.html"; then home_ok="yes"; break; fi
  sleep 1
done
[ -n "$home_ok" ] || fail "\"$NEW_NAME\" missing from the HTML of $BASE_URL/ after 12 s"
pass "the name appears in the home page's HTML"
grep -q "Control plane" "$WORK/home.html" \
  && fail "the old hard-coded name \"Control plane\" is still in the HTML"
pass "no trace left of the hard-coded name"

step "4. A made-up time zone is refused"
code=$(req PATCH /api/settings '{"timezone":"Mars/Olympus_Mons"}')
[ "$code" = "422" ] || fail "invalid time zone: expected 422, got $code — $(cat "$BODY")"
jq -e '.error.code == "validation_failed"' "$BODY" >/dev/null || fail "unexpected error code"
pass "Mars/Olympus_Mons → 422 validation_failed"

still=$(psql_q "select value->>'timezone' from app_settings where id = 1;")
[ "$still" = "Europe/Paris" ] || fail "the time zone in the database moved: \"$still\""
pass "the time zone in the database is intact ($still)"

code=$(req PATCH /api/settings '{"timezone":"Asia/Tokyo","locale":"en-GB"}')
[ "$code" = "200" ] || fail "fuseau valide → HTTP $code: $(cat "$BODY")"
pass "Asia/Tokyo accepted"

# A partial patch touches ONLY what it names. Regression already met:
# `.default(x).optional()` in Zod returns the default when the key is missing,
# which silently reset every field not mentioned.
jq -e --arg n "$NEW_NAME" '.settings.instanceName == $n' "$BODY" >/dev/null \
  || fail "partial patch: the name was reset → $(jq -c .settings.instanceName "$BODY")"
jq -e '.settings.instanceTagline == "accroche de test"' "$BODY" >/dev/null \
  || fail "partial patch: the tagline was reset → $(jq -c .settings.instanceTagline "$BODY")"
pass "partial patch: the fields not mentioned are intact"

code=$(req PATCH /api/settings '{"ai":{"enabled":false}}')
[ "$code" = "200" ] || fail "partial ai patch → HTTP $code: $(cat "$BODY")"
jq -e '.settings.ai.enabled == false and .settings.ai.model == "anthropic/claude-sonnet-4.5"' "$BODY" >/dev/null \
  || fail "partial ai patch: the model was dropped → $(jq -c .settings.ai "$BODY")"
pass "partial ai patch: ai.enabled changed, ai.model kept"
code=$(req PATCH /api/settings '{"ai":{"enabled":true}}')
[ "$code" = "200" ] || fail "re-enabling the AI → HTTP $code"

code=$(req PATCH /api/settings '{"timezone":"Europe/Paris","locale":"fr-FR"}')
[ "$code" = "200" ] || fail "restoring the time zone → HTTP $code"
pass "time zone restored to Europe/Paris"

step "5. The API key never comes out"
code=$(req PATCH /api/settings "{\"aiApiKey\":\"$SECRET_KEY\"}")
[ "$code" = "200" ] || fail "setting the key → HTTP $code: $(cat "$BODY")"
jq -e '.aiApiKeyConfigured == true' "$BODY" >/dev/null || fail "the key is not flagged as set"
grep -qF "$SECRET_KEY" "$BODY" && fail "the key appears in the PATCH's response"
pass "key set, absent from the PATCH's response"

encrypted=$(psql_q "select ai_api_key_encrypted from app_settings where id = 1;")
case "$encrypted" in
  v1:*) pass "in the database: AES-256-GCM encrypted (${encrypted:0:16}…)" ;;
  *)    fail "unexpected column: $encrypted" ;;
esac
[ "$encrypted" = "$SECRET_KEY" ] && fail "the key is stored in clear"
psql_q "select value::text from app_settings where id = 1;" | grep -qF "$SECRET_KEY" \
  && fail "the key slipped into the configuration JSONB"
pass "absent from the configuration JSONB"

code=$(req GET /api/settings)
[ "$code" = "200" ] || fail "GET → HTTP $code"
grep -qF "$SECRET_KEY" "$BODY" && fail "the key appears in the raw GET response"
pass "grep on the raw GET response: no occurrence of the key"
jq -e '.aiApiKeyConfigured == true' "$BODY" >/dev/null || fail "aiApiKeyConfigured should be true"
jq -e '.aiApiKeyLast4 == "4242"' "$BODY" >/dev/null \
  || fail "last 4 characters expected \"4242\", got $(jq -c .aiApiKeyLast4 "$BODY")"
pass "only aiApiKeyConfigured=true and aiApiKeyLast4=\"4242\" are exposed"

# The screens' HTML must not contain it either.
#
# This assertion only aimed at /admin/settings. Since the split, this address
# is a summary: it renders no key field, and the grep would pass there whatever
# happens — an assertion that succeeds by looking at the wrong place lies, it
# protects nothing. So we sweep the summary and its six sections, and prove
# separately that the one really carrying the field was indeed read.
#
# `notifications` was missing from this list for a long time. It was the worst
# of the six to forget: it is the only other one carrying encrypted secrets.
for path in $SETTINGS_PAGES; do
  page "$path" "$WORK/page.html"
  grep -qF "$SECRET_KEY" "$WORK/page.html" && fail "the key is in the HTML of $path"
done
pass "key absent from the HTML of the $(echo "$SETTINGS_PAGES" | wc -l | tr -d ' ') settings pages"

page /admin/settings/ai "$WORK/ia.html"
grep -q 'id="apiKey"' "$WORK/ia.html" \
  || fail "/admin/settings/ai does not render the key field — the grep above would prove nothing"
grep -qF "$SECRET_KEY" "$WORK/ia.html" && fail "the key is in the HTML of /admin/settings/ai"
grep -qF "4242" "$WORK/ia.html" \
  || fail "the last 4 characters should be shown as a landmark on the AI section"
pass "/admin/settings/ai does render the field, with …4242 as a landmark and without the key"

step "6. The aiApiKey field's three cases"
code=$(req PATCH /api/settings '{"instanceTagline":"clé inchangée"}')
[ "$code" = "200" ] || fail "PATCH without the field → HTTP $code: $(cat "$BODY")"
jq -e '.aiApiKeyConfigured == true' "$BODY" >/dev/null \
  || fail "field omitted: the key disappeared although it was supposed to stay"
after_omit=$(psql_q "select ai_api_key_encrypted from app_settings where id = 1;")
[ "$after_omit" = "$encrypted" ] || fail "field omitted: the encrypted value changed"
pass "field omitted → key unchanged, down to the ciphertext"

code=$(req PATCH /api/settings '{"aiApiKey":null}')
[ "$code" = "200" ] || fail "PATCH null → HTTP $code: $(cat "$BODY")"
jq -e '.aiApiKeyConfigured == false' "$BODY" >/dev/null || fail "null: the key is still flagged"
jq -e '.aiApiKeyLast4 == null' "$BODY" >/dev/null || fail "null: characters are still exposed"
cleared=$(psql_q "select coalesce(ai_api_key_encrypted, 'NULL') from app_settings where id = 1;")
[ "$cleared" = "NULL" ] || fail "the column is not emptied: $cleared"
pass "aiApiKey: null → column erased in the database"

code=$(req PATCH /api/settings "{\"aiApiKey\":\"$SECRET_KEY\"}")
[ "$code" = "200" ] || fail "setting the key again → HTTP $code"
pass "key set again (for the audit check)"

step "7. Traceability, without the secret"
code=$(req GET "/api/audit-logs?resourceType=settings&pageSize=50")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
jq -e '[.items[] | select(.action == "settings.updated")] | length > 0' "$BODY" >/dev/null \
  || fail "action \"settings.updated\" missing from the log"
COUNT=$(jq -r '[.items[] | select(.action == "settings.updated")] | length' "$BODY")
pass "audit: settings.updated present ($COUNT entry(ies))"

grep -qF "$SECRET_KEY" "$BODY" && fail "the key appears in the audit log returned by the API"
pass "grep on the audit response: no occurrence of the key"

# And directly in the table, not only in what the API is willing to return.
leaks=$(psql_q "select count(*) from audit_logs
  where before::text like '%SENTINELLE%' or after::text like '%SENTINELLE%';")
[ "$leaks" = "0" ] || fail "$leaks audit entry(ies) contain the key in the database"
pass "grep in the database on audit_logs.before/after: no occurrence"

jq -e '[.items[] | select(.action == "settings.updated")][0].after.aiApiKey
       | . == "(set)" or . == "(cleared)"' "$BODY" >/dev/null \
  || fail "the expected key marker is missing: $(jq -c '[.items[] | select(.action == "settings.updated")][0].after.aiApiKey' "$BODY")"
pass "the key is reduced to a marker: $(jq -r '[.items[] | select(.action == "settings.updated")][0].after.aiApiKey' "$BODY")"

# The settings reader is an auditor: the viewer only reads operations, without
# `settings:read`. The variables keep the name "viewer", that of a read-only
# account.
step "8. settings:manage to write — an auditor sees, and touches nothing"
code=$(req POST /api/admin/users \
  "{\"name\":\"Viewer paramètres\",\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\",\"role\":\"auditor\"}")
case "$code" in
  201) pass "viewer user created" ;;
  409) pass "viewer user already present" ;;
  *)   fail "POST /api/admin/users → HTTP $code: $(cat "$BODY")" ;;
esac

viewer_id=$(psql_q "select id from users where email = '$VIEWER_EMAIL';")
[ -n "$viewer_id" ] || fail "viewer user not found in the database"

# An account already present may have kept another role from a previous pass.
code=$(req PATCH "/api/admin/users/$viewer_id/role" '{"role":"auditor"}')
[ "$code" = "200" ] || fail "auditor role → HTTP $code: $(cat "$BODY")"
code=$(req GET /api/admin/roles)
[ "$code" = "200" ] || fail "GET /api/admin/roles → HTTP $code"
jq -e '[.items[] | select(.key == "auditor") | .permissions[]] | index("settings:read") != null
       and index("settings:manage") == null' "$BODY" >/dev/null \
  || fail "the auditor role does not carry settings:read without settings:manage — the test would prove nothing"
pass "the account is an auditor: settings:read, without settings:manage"

for _ in 1 2 3 4 5; do
  code=$(req POST /api/auth/sign-in/email \
    "{\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\"}" "$VIEWER_JAR")
  [ "$code" = "429" ] || break
  sleep 6
done
[ "$code" = "200" ] || fail "viewer sign-in failed (HTTP $code): $(cat "$BODY")"
pass "signed in as $VIEWER_EMAIL"

code=$(req GET /api/settings '' "$VIEWER_JAR")
[ "$code" = "200" ] || fail "a viewer must be able to read the settings: HTTP $code"
grep -qF "$SECRET_KEY" "$BODY" && fail "the key leaks into a viewer's read"
pass "reading allowed (settings:read), still without the key"

# A reader must SEE the sections — read-only, with the note explaining it.
# Active fields that would end in 403 on saving would be a promise the screen
# cannot keep.
for path in $SETTINGS_PAGES; do
  page "$path" "$WORK/viewer-page.html" "$VIEWER_JAR"
  grep -qF "$SECRET_KEY" "$WORK/viewer-page.html" && fail "the key leaks on $path for a viewer"
done
pass "the settings pages answer 200 to a viewer, without the key"

page /admin/settings/ai "$WORK/viewer-ia.html" "$VIEWER_JAR"
grep -q 'id="apiKey"' "$WORK/viewer-ia.html" \
  || fail "the viewer does not see the AI section: read-only is not an empty page"
grep -q 'settings:manage' "$WORK/viewer-ia.html" \
  || fail "the note explaining the read-only mode is missing"
grep -q 'type="submit"' "$WORK/viewer-ia.html" \
  && fail "a save button is offered to a viewer"
grep -q 'disabled=""' "$WORK/viewer-ia.html" \
  || fail "the AI section's fields are not disabled for a viewer"
pass "viewer: section visible, inactive fields, no save button"

page /admin/settings/onboarding "$WORK/viewer-onb.html" "$VIEWER_JAR"
grep -q 'settings:manage' "$WORK/viewer-onb.html" \
  || fail "the guide does not tell the viewer why they cannot restart it"
grep -qE "Relancer l|Run the guide again" "$WORK/viewer-onb.html" \
  && fail "the restart button is offered to a viewer"
pass "viewer: the guide shows without its restart button"

code=$(req PATCH /api/settings '{"instanceName":"Détourné par un viewer"}' "$VIEWER_JAR")
[ "$code" = "403" ] || fail "writing by a viewer: expected 403, got $code — $(cat "$BODY")"
jq -e '.error.details.permission == "settings:manage"' "$BODY" >/dev/null \
  || fail "missing permission badly reported: $(jq -c .error "$BODY")"
pass "writing refused → 403, permission \"settings:manage\""

untouched=$(psql_q "select value->>'instanceName' from app_settings where id = 1;")
[ "$untouched" = "$NEW_NAME" ] || fail "the name changed despite the refusal: \"$untouched\""
pass "the refusal wrote nothing"

step "9. Disabling the security analysis, permanently"
# We sign in again as the administrator: the previous step switched to a viewer.
login

code=$(req PATCH /api/settings '{"security":{"scanningEnabled":false}}')
[ "$code" = "200" ] || fail "PATCH security → HTTP $code: $(cat "$BODY")"
jq -e '.settings.security.scanningEnabled == false' "$BODY" >/dev/null \
  || fail "the setting was not kept"
pass "analysis disabled"

persisted=$(psql_q "select value->'security'->>'scanningEnabled' from app_settings where id = 1;")
[ "$persisted" = "false" ] || fail "setting not persisted: \"$persisted\""
pass "persisted in the database — the setting survives a restart"

# The real test: a deployment that ASKS for scanners must not get any.
APP_ID=$(req GET "/api/applications?pageSize=1" >/dev/null; jq -r '.items[0].id // empty' "$BODY")
TARGET_ID=$(req GET /api/targets >/dev/null; jq -r '[.items[] | select(.status != "unreachable")][0].id // empty' "$BODY")

if [ -n "$APP_ID" ] && [ -n "$TARGET_ID" ]; then
  code=$(req POST /api/deployments \
    "{\"applicationId\":\"$APP_ID\",\"targetId\":\"$TARGET_ID\",\"runtime\":\"docker\",\"proxy\":\"traefik\",\"scanConfig\":{\"scanners\":[\"trivy\",\"grype\"],\"failOn\":\"CRITICAL\"},\"autoRollback\":false}")
  [ "$code" = "201" ] || [ "$code" = "202" ] || [ "$code" = "200" ] \
    || fail "creating the deployment → HTTP $code: $(cat "$BODY")"

  DEPLOY_ID=$(jq -r '.id' "$BODY")
  jq -e '.scanConfig.scanners == [] and .scanConfig.disabledBy == "settings"' "$BODY" >/dev/null \
    || fail "the requested scanners survived: $(jq -c .scanConfig "$BODY")"
  pass "trivy+grype requested, none kept — reason \"settings\""

  # What is frozen in the database must describe what will run, not what was
  # requested: otherwise the history would keep the trace of a scanner that was
  # never started.
  frozen=$(psql_q "select scan_config->>'disabledBy' from deployments where id = '$DEPLOY_ID';")
  [ "$frozen" = "settings" ] || fail "misleading frozen configuration: \"$frozen\""
  pass "the frozen configuration tells the truth"

  # The intention must stay readable somewhere: it is the audit's role.
  req GET "/api/audit-logs?resourceType=deployment&pageSize=10" >/dev/null
  jq -e --arg id "$DEPLOY_ID" \
    '[.items[] | select(.resourceId == $id and .after.scanRequested != null)] | length > 0' \
    "$BODY" >/dev/null || fail "the audit keeps no trace of the requested scanners"
  pass "audit: the requested scanners and the refusal's reason are recorded"
else
  info "no usable application or target — effect on a deployment not exercised"
fi

step "10. Setting a single scanner aside"
code=$(req PATCH /api/settings '{"security":{"scanningEnabled":true,"disabledScanners":["trivy"]}}')
[ "$code" = "200" ] || fail "PATCH → HTTP $code"
jq -e '.settings.security.disabledScanners == ["trivy"]' "$BODY" >/dev/null \
  || fail "the exclusion was not kept"
pass "trivy set aside, analysis still active"

code=$(req PATCH /api/settings '{"security":{"disabledScanners":["monde:dominer"]}}')
[ "$code" = "422" ] || fail "made-up scanner: expected 422, got $code"
pass "a scanner outside the vocabulary is refused"

step "11. Each subsection is reachable and renders its fields"
# /admin/settings leads to the first tab of the first group. Each section
# carries the rail of the four groups, and the tabs of its own.
root=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -b "$JAR" "$BASE_URL/admin/settings")
case "$root" in
  30[78]\ */admin/settings/identity) ;;
  *) fail "/admin/settings: expected a redirect to /admin/settings/identity, got \"$root\"" ;;
esac
pass "/admin/settings leads to the Identity tab"
page /admin/settings/security "$WORK/group.html"
for target in identity security integrations backups sso accounts; do
  grep -q "href=\"/admin/settings/$target\"" "$WORK/group.html" \
    || fail "the rail or the tabs of \"Security and access\" do not lead to /admin/settings/$target"
done
pass "the rail leads to the four groups, the tabs to the group's three sections"

# A "reachable" section that would not render its fields would be one more
# dead page: so we name, for each one, the identifiers it must carry.
check_page() {
  local path="$1"; shift
  local file="$WORK/section.html" marker
  page "$path" "$file"
  for marker in "$@"; do
    grep -qF "$marker" "$file" || fail "\"$marker\" missing from $path"
  done
  pass "$path — $# marker(s) present"
}

check_page /admin/settings/identity 'id="instanceName"' 'id="instanceTagline"'
check_page /admin/settings/regional \
  'id="timezone"' 'id="locale"' 'id="dateStyle"' 'id="timeStyle"' 'Europe/Paris'
check_page /admin/settings/security 'id="failOn"' 'Scanners' 'trivy'
check_page /admin/settings/sso 'id="sso-issuer"' 'id="sso-client"' '/api/auth/callback/oidc'
check_page /admin/settings/accounts 'name="two-factor-policy"' 'id="session-idle"' 'id="session-max"'
check_page /admin/settings/notifications 'Ajouter un canal' 'Notifications'
check_page /admin/settings/ai 'id="aiProvider"' 'id="aiModel"' 'id="apiKey"' 'type="submit"'
check_page /admin/settings/onboarding 'Relancer l' 'Assistant de d'

step "12. Saving a section touches no other"
# THE trap of this test: if the other sections stayed at their default values,
# an overwrite by the defaults is indistinguishable from keeping them, and the
# test succeeds even though the bug is there. So we customize EVERYTHING before
# touching a single thing.
code=$(req PATCH /api/settings '{
  "instanceName":"Instance cloisonnée","instanceTagline":"témoin de cloisonnement",
  "timezone":"Asia/Tokyo","locale":"en-GB","dateStyle":"long","timeStyle":"short",
  "security":{"scanningEnabled":true,"disabledScanners":["syft"],"failOn":"HIGH"},
  "ai":{"enabled":false,"provider":"openai","model":"gpt-4.1-mini","temperature":0.65,"maxTokens":1024},
  "accounts":{"sessionIdleHours":8}
}')
[ "$code" = "200" ] || fail "prior customization → HTTP $code: $(cat "$BODY")"
jq -e '.settings.instanceTagline == "témoin de cloisonnement"
       and .settings.timezone == "Asia/Tokyo" and .settings.dateStyle == "long"
       and .settings.security.disabledScanners == ["syft"]
       and .settings.security.failOn == "HIGH"
       and .settings.ai.temperature == 0.65 and .settings.ai.maxTokens == 1024
       and .settings.accounts.sessionIdleHours == 8
       and .aiApiKeyConfigured == true' "$BODY" >/dev/null \
  || fail "the prior customization did not take: $(jq -c .settings "$BODY")"
pass "the sections carry values distinct from their defaults"

# $1 name of the saved section, $2 PATCH body (its own fields only), $3 jq
# expression proving that the targeted section did change — and that whatever
# else it contains survived.
isolate() {
  local name="$1" body="$2" probe="$3" before after
  req GET /api/settings >/dev/null
  before=$(fingerprint "$name" "$BODY")
  code=$(req PATCH /api/settings "$body")
  [ "$code" = "200" ] || fail "PATCH \"$name\" → HTTP $code: $(cat "$BODY")"
  jq -e "$probe" "$BODY" >/dev/null \
    || fail "\"$name\": the section did not take the expected value → $(jq -c .settings "$BODY")"
  after=$(fingerprint "$name" "$BODY")
  if [ "$before" != "$after" ]; then
    diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | head -20
    fail "saving \"$name\" changed other sections (see the diff above)"
  fi
  pass "\"$name\" saved alone — the other sections are intact down to the bit"
}

isolate identity \
  '{"instanceName":"Renommée depuis sa section"}' \
  '.settings.instanceName == "Renommée depuis sa section"
   and .settings.instanceTagline == "témoin de cloisonnement"'

isolate regional \
  '{"timezone":"Europe/Lisbon"}' \
  '.settings.timezone == "Europe/Lisbon" and .settings.locale == "en-GB"
   and .settings.dateStyle == "long" and .settings.timeStyle == "short"'

isolate security \
  '{"security":{"failOn":"NONE"}}' \
  '.settings.security == {"scanningEnabled":true,"disabledScanners":["syft"],"failOn":"NONE","onlyFixable":false}'

isolate ai \
  '{"ai":{"temperature":0.15}}' \
  '.settings.ai.temperature == 0.15 and .settings.ai.model == "gpt-4.1-mini"
   and .settings.ai.maxTokens == 1024 and .settings.ai.enabled == false
   and .aiApiKeyConfigured == true'

isolate accounts \
  '{"accounts":{"sessionMaxHours":168}}' \
  '.settings.accounts == {"twoFactorPolicy":"off","sessionIdleHours":8,"sessionMaxHours":168}'

step "13. Cleanup"
req PATCH /api/settings '{"aiApiKey":null}' >/dev/null
# Security setting given back to its default: the other scripts depend on it.
req PATCH /api/settings '{"security":{"scanningEnabled":true,"disabledScanners":[],"failOn":"NONE"}}' >/dev/null
req PATCH /api/settings '{"accounts":{"twoFactorPolicy":"off","sessionIdleHours":168,"sessionMaxHours":null}}' >/dev/null
# Step 12 customized the AI so that the isolation shows: we give it back.
req PATCH /api/settings \
  '{"ai":{"enabled":true,"provider":"openrouter","model":"anthropic/claude-sonnet-4.5","baseUrl":"","temperature":0.2,"maxTokens":8192}}' >/dev/null
code=$(req PATCH /api/settings \
  '{"instanceName":"Pupitre","instanceTagline":"Deployment control plane","timezone":"Europe/Paris","locale":"en-US","dateStyle":"short","timeStyle":"medium"}')
[ "$code" = "200" ] || fail "restauration → HTTP $code: $(cat "$BODY")"
if [ -s "$KEY_SNAPSHOT" ]; then
  pass "settings restored; the instance key will be put back on the way out"
else
  pass "settings restored, test key erased (no instance key at the start)"
fi
req DELETE "/api/admin/users/$viewer_id" >/dev/null
pass "viewer user deleted"
# The guide was abandoned at step 2 to make the pages viewable. We leave it
# "finished" rather than "abandoned": it is the state of an instance in
# service, and the one the other scripts find.
req PATCH /api/onboarding '{"action":"finish"}' >/dev/null
pass "setup guide marked finished"

printf '\n\033[32m✓ Instance settings verified.\033[0m\n'
printf '\033[2m  Screens: %s/admin/settings — and its %s subsections\033[0m\n\n' \
  "$BASE_URL" "$(echo "$SETTINGS_PAGES" | wc -l | tr -d ' ')"
