#!/usr/bin/env bash
#
# Checks the simplified input and the time zone of scheduled jobs:
#
#   1. creating a job in simple mode does write the expected cron IN THE DATABASE
#   2. without an explicit zone, the job takes the instance settings' one
#   3. reading it back returns the same simple mode
#   4. an invalid cron expression is refused (422)
#   5. an exotic expression is accepted and switches to expert mode
#   6. the job is really registered as a repeatable job in BullMQ, pattern AND
#      zone
#   7. "every day at 3 am" in Europe/Paris falls at 01:00 or 02:00 UTC depending
#      on the season — never at 03:00: the zone is really applied
#   8. changing an existing job's zone RESCHEDULES its next occurrence in BullMQ
#   9. a made-up IANA zone is refused (422), and nothing is written
#  10. the jobs older than migration 0009 stayed in UTC, and their next
#      occurrence did not move
#  11. changing the cadence in simple mode updates the database AND Redis
#  12. `job:manage` is required to write — a viewer can only read
#  13. cleanup: the jobs created here are disabled then deleted
#
# Usage:
#   ./scripts/verify-schedules.sh
#   BASE_URL=http://localhost:3200 ./scripts/verify-schedules.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
VIEWER_EMAIL="${VIEWER_EMAIL:-schedule-viewer@example.test}"
VIEWER_PASSWORD="${VIEWER_PASSWORD:-motdepasse-tres-long}"
CLIENT_IP="${CLIENT_IP:-198.51.100.77}"

# Throwaway keys, distinct from the default keys: the environment is shared, we
# touch no job someone else may have installed.
SIMPLE_KEY="${SIMPLE_KEY:-verify:schedule:simple}"
EXPERT_KEY="${EXPERT_KEY:-verify:schedule:expert}"
PARIS_KEY="${PARIS_KEY:-verify:schedule:paris}"

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
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -H "x-forwarded-for: $CLIENT_IP" -b "$JAR" -c "$JAR")
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}

vreq() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -H "x-forwarded-for: $CLIENT_IP" -b "$VJAR" -c "$VJAR")
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }
redis_q() { docker compose exec -T redis redis-cli "$@"; }

# Next occurrence as BullMQ computed it: the score of the `bull:<queue>:repeat`
# sorted set, in epoch milliseconds. It is the only truth — not what the panel
# says, not what we would recompute on our side.
next_ms() { redis_q zscore bull:ops:repeat "$1" | tr -d '\r'; }

# Epoch instant → wall-clock time in a zone. `node` rather than `date`: macOS's
# `date` and GNU's do not speak the same language, and neither can render a time
# in an arbitrary IANA zone portably.
fmt_in() {
  node -e 'const [ms, tz] = process.argv.slice(1);
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(Number(ms)));
    const g = (t) => p.find((x) => x.type === t).value;
    process.stdout.write(`${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`);' \
    "$1" "$2"
}
hhmm_in() { fmt_in "$1" "$2" | cut -d' ' -f2 | cut -d: -f1,2; }

# Systematic cleanup, including on an exit on error: a test job that runs every
# five minutes pollutes everybody's logs.
cleanup() {
  local id
  for key in "$SIMPLE_KEY" "$EXPERT_KEY" "$PARIS_KEY"; do
    id=$(psql_q "select id from scheduled_jobs where key = '$key';" 2>/dev/null || true)
    if [ -n "$id" ]; then
      req PATCH "/api/jobs/$id" '{"enabled":false}' >/dev/null 2>&1 || true
      req DELETE "/api/jobs/$id" >/dev/null 2>&1 || true
    fi
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

assert_admin() {
  local role
  role=$(jq -r '.user.role // empty' "$BODY")
  [ "$role" = "admin" ] && return 0
  fail "\"$ADMIN_EMAIL\" has the role \"${role:-none}\", not \"admin\" — see /admin/users"
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

step "1. Sign-in"
login
pass "signed in as $ADMIN_EMAIL"

# Cleanup from a previous run, before anything else.
for key in "$SIMPLE_KEY" "$EXPERT_KEY" "$PARIS_KEY"; do
  old=$(psql_q "select id from scheduled_jobs where key = '$key';" || true)
  [ -n "$old" ] && req DELETE "/api/jobs/$old" >/dev/null 2>&1 || true
done

step "2. Simple mode produces the expected cron expression in the database"
# "every Monday and Wednesday at 04:30" — never written by hand here.
code=$(req POST /api/jobs "{
  \"type\":\"healthcheck\",
  \"key\":\"$SIMPLE_KEY\",
  \"schedule\":{\"kind\":\"weekly\",\"weekdays\":[1,3],\"hour\":4,\"minute\":30},
  \"enabled\":true
}")
[ "$code" = "201" ] || fail "POST /api/jobs → HTTP $code: $(cat "$BODY")"
SIMPLE_ID=$(jq -r '.id' "$BODY")
pass "job created without any cron expression being sent"

STORED=$(psql_q "select cron from scheduled_jobs where key = '$SIMPLE_KEY';")
[ "$STORED" = "30 4 * * 1,3" ] \
  || fail "the database contains \"$STORED\", expected \"30 4 * * 1,3\""
pass "in the database: cron = \"$STORED\" (checked in SQL, not through the API)"

# Nothing but the cron is persisted: no second format.
COLS=$(psql_q "select string_agg(column_name, ',' order by column_name)
  from information_schema.columns where table_name = 'scheduled_jobs';")
case "$COLS" in
  *schedule*|*kind*|*weekday*) fail "a simplified periodicity column exists: $COLS" ;;
  *) pass "no \"schedule\" column in the database — a single format persisted" ;;
esac
info "columns: $COLS"

step "2b. Without an explicit zone, the job takes the instance settings' one"
code=$(req GET /api/settings)
[ "$code" = "200" ] || fail "GET /api/settings → HTTP $code"
INSTANCE_TZ=$(jq -r '.settings.timezone' "$BODY")
[ -n "$INSTANCE_TZ" ] && [ "$INSTANCE_TZ" != "null" ] \
  || fail "the instance settings announce no zone"
pass "instance zone: \"$INSTANCE_TZ\""

STORED_TZ=$(psql_q "select timezone from scheduled_jobs where key = '$SIMPLE_KEY';")
[ "$STORED_TZ" = "$INSTANCE_TZ" ] \
  || fail "the job is in \"$STORED_TZ\" although the instance is in \"$INSTANCE_TZ\""
pass "in the database: timezone = \"$STORED_TZ\" — the default is not hard-coded UTC"

code=$(req GET /api/jobs)
API_DEFAULT_TZ=$(jq -r '.defaultTimeZone' "$BODY")
[ "$API_DEFAULT_TZ" = "$INSTANCE_TZ" ] \
  || fail "/api/jobs announces \"$API_DEFAULT_TZ\" as the default, the instance says \"$INSTANCE_TZ\""
pass "/api/jobs will prefill the form with \"$API_DEFAULT_TZ\""

step "3. Reading it back returns the same simple mode"
code=$(req GET "/api/jobs/$SIMPLE_ID")
[ "$code" = "200" ] || fail "GET /api/jobs/:id → HTTP $code"
jq -e '.schedule.kind == "weekly"' "$BODY" >/dev/null \
  || fail "expected kind \"weekly\", got $(jq -c '.schedule' "$BODY")"
jq -e '.schedule.weekdays == [1,3] and .schedule.hour == 4 and .schedule.minute == 30' "$BODY" \
  >/dev/null || fail "periodicity read back differs: $(jq -c '.schedule' "$BODY")"
pass "read back: $(jq -c '.schedule' "$BODY")"
pass "description: $(jq -r '.cronDescription' "$BODY")"

step "4. An invalid cron expression is refused"
for bad in '0 99 * * *' '0 3 * *' 'tous les lundis' '*/0 * * * *'; do
  code=$(req POST /api/jobs "{\"type\":\"cleanup\",\"key\":\"verify:schedule:bad\",\"cron\":\"$bad\"}")
  [ "$code" = "422" ] || fail "\"$bad\": expected 422, got $code — $(cat "$BODY")"
  jq -e '.error.code == "validation_failed"' "$BODY" >/dev/null \
    || fail "unexpected error code for \"$bad\": $(jq -c '.error' "$BODY")"
done
pass "4 invalid expressions refused with 422"

left=$(psql_q "select count(*) from scheduled_jobs where key = 'verify:schedule:bad';")
[ "$left" = "0" ] || fail "a job was created despite the refusal"
pass "nothing was written in the database"

# An out-of-bounds simplified periodicity is refused too: the server trusts
# `schedule` no more than `cron`.
code=$(req POST /api/jobs \
  '{"type":"cleanup","key":"verify:schedule:bad","schedule":{"kind":"daily","hour":42,"minute":0}}')
[ "$code" = "422" ] || fail "out-of-bounds periodicity: expected 422, got $code"
pass "an out-of-bounds simplified periodicity is refused too (422)"

code=$(req POST /api/jobs \
  '{"type":"cleanup","key":"verify:schedule:bad","cron":"0 3 * * *","schedule":{"kind":"daily","hour":4,"minute":0}}')
[ "$code" = "422" ] || fail "cron AND schedule: expected 422, got $code"
pass "providing \"cron\" and \"schedule\" together is refused (422)"

# A made-up zone in the database would crash the computation of the next
# occurrence. It is refused at the entrance, by the same validator as the
# instance settings.
for bad_tz in 'Europe/Atlantide' 'UTC+2' 'GMT+0200' 'paris'; do
  code=$(req POST /api/jobs \
    "{\"type\":\"cleanup\",\"key\":\"verify:schedule:bad\",\"cron\":\"0 3 * * *\",\"timezone\":\"$bad_tz\"}")
  [ "$code" = "422" ] || fail "zone \"$bad_tz\": expected 422, got $code — $(cat "$BODY")"
  jq -e '.error.code == "validation_failed"' "$BODY" >/dev/null \
    || fail "unexpected error code for \"$bad_tz\": $(jq -c '.error' "$BODY")"
done
pass "4 made-up zones refused with 422"

left=$(psql_q "select count(*) from scheduled_jobs where key = 'verify:schedule:bad';")
[ "$left" = "0" ] || fail "a job was created despite the zone refusal"
pass "nothing was written in the database"

step "5. An exotic expression is accepted and switches to expert mode"
EXOTIC='*/7 2-5 * * 1,3'
code=$(req POST /api/jobs "{
  \"type\":\"cleanup\",
  \"key\":\"$EXPERT_KEY\",
  \"cron\":\"$EXOTIC\",
  \"enabled\":true
}")
[ "$code" = "201" ] || fail "POST /api/jobs → HTTP $code: $(cat "$BODY")"
EXPERT_ID=$(jq -r '.id' "$BODY")
jq -e '.schedule == null' "$BODY" >/dev/null \
  || fail "a simple periodicity was made up: $(jq -c '.schedule' "$BODY")"
pass "accepted, and \"schedule\": null → the screen will open in expert mode"

STORED=$(psql_q "select cron from scheduled_jobs where key = '$EXPERT_KEY';")
[ "$STORED" = "$EXOTIC" ] || fail "in the database: \"$STORED\" instead of \"$EXOTIC\""
pass "in the database: cron = \"$STORED\", unchanged"

DESC=$(jq -r '.cronDescription' "$BODY")
[ "$DESC" != "$EXOTIC" ] || fail "no description produced for the exotic expression"
pass "described all the same: \"$DESC\""

step "6. The jobs are real BullMQ repeatable jobs"
# The worker and the panel write into the same queue; Redis is read directly.
KEYS=$(redis_q --scan --pattern 'bull:*repeat*' | tr -d '\r' | sort)
[ -n "$KEYS" ] || fail "no \"bull:*repeat*\" key in Redis"
info "keys: $(echo "$KEYS" | tr '\n' ' ')"

# Several queues have repeatable jobs (ops, supervision, notifications…): keep
# the one whose sorted set holds the task created above, not the first one in
# alphabetical order.
REPEAT_KEY=""
for candidate in $(echo "$KEYS" | grep -E ':repeat$'); do
  if [ -n "$(redis_q zscore "$candidate" "$SIMPLE_KEY" | tr -d '\r')" ]; then
    REPEAT_KEY="$candidate"
    break
  fi
done
[ -n "$REPEAT_KEY" ] || fail "no \"bull:<queue>:repeat\" sorted set holds \"$SIMPLE_KEY\""

MEMBERS=$(redis_q zrange "$REPEAT_KEY" 0 -1 | tr -d '\r')
for key in "$SIMPLE_KEY" "$EXPERT_KEY"; do
  echo "$MEMBERS" | grep -qF "$key" \
    || fail "\"$key\" missing from $REPEAT_KEY: $MEMBERS"
  pass "\"$key\" present in $REPEAT_KEY"
done

# The pattern stored on BullMQ's side must be exactly the database's.
SCHED_HASH="${REPEAT_KEY%:repeat}:repeat:$SIMPLE_KEY"
PATTERN=$(redis_q hget "$SCHED_HASH" pattern | tr -d '\r')
[ "$PATTERN" = "30 4 * * 1,3" ] \
  || fail "BullMQ remembered \"$PATTERN\" instead of \"30 4 * * 1,3\""
pass "BullMQ remembered the same pattern: \"$PATTERN\""

# The zone too: without it, cron-parser would fall back on the process's.
BULL_TZ=$(redis_q hget "$SCHED_HASH" tz | tr -d '\r')
[ "$BULL_TZ" = "$INSTANCE_TZ" ] \
  || fail "BullMQ remembered tz = \"${BULL_TZ:-none}\", the database says \"$INSTANCE_TZ\""
pass "BullMQ remembered the zone: tz = \"$BULL_TZ\""

code=$(req GET /api/jobs)
jq -e --arg k "$SIMPLE_KEY" \
  '[.items[] | select(.key == $k)] | .[0].installed == true and .[0].nextRunAt != null' \
  "$BODY" >/dev/null || fail "the API does not see the installed scheduler"
pass "next occurrence computed by BullMQ: $(jq -r --arg k "$SIMPLE_KEY" '[.items[] | select(.key == $k)] | .[0].nextRunAt' "$BODY")"

step "7. \"Every day at 3 am\" in Europe/Paris does NOT fall at 03:00 UTC"
# The heart of the matter. No cron expression is written here: we ask for a
# simple periodicity and a zone, exactly as the form does.
code=$(req POST /api/jobs "{
  \"type\":\"cleanup\",
  \"key\":\"$PARIS_KEY\",
  \"schedule\":{\"kind\":\"daily\",\"hour\":3,\"minute\":0},
  \"timezone\":\"Europe/Paris\",
  \"enabled\":true
}")
[ "$code" = "201" ] || fail "POST /api/jobs → HTTP $code: $(cat "$BODY")"
PARIS_ID=$(jq -r '.id' "$BODY")
pass "job \"$PARIS_KEY\" created: every day at 03:00, Europe/Paris zone"

STORED=$(psql_q "select cron || ' | ' || timezone from scheduled_jobs where key = '$PARIS_KEY';")
[ "$STORED" = "0 3 * * * | Europe/Paris" ] \
  || fail "in the database: \"$STORED\", expected \"0 3 * * * | Europe/Paris\""
pass "in the database: \"$STORED\""

PARIS_HASH="${REPEAT_KEY%:repeat}:repeat:$PARIS_KEY"
BULL_TZ=$(redis_q hget "$PARIS_HASH" tz | tr -d '\r')
[ "$BULL_TZ" = "Europe/Paris" ] \
  || fail "BullMQ remembered tz = \"${BULL_TZ:-none}\" instead of \"Europe/Paris\""
pass "BullMQ remembered tz = \"$BULL_TZ\" (read in $PARIS_HASH)"

PARIS_MS=$(next_ms "$PARIS_KEY")
[ -n "$PARIS_MS" ] || fail "no next occurrence in bull:ops:repeat for \"$PARIS_KEY\""
PARIS_UTC=$(hhmm_in "$PARIS_MS" UTC)
PARIS_LOCAL=$(hhmm_in "$PARIS_MS" Europe/Paris)
info "next occurrence: $(fmt_in "$PARIS_MS" UTC) UTC = $(fmt_in "$PARIS_MS" Europe/Paris) Europe/Paris"

# 01:00 UTC in summer time (UTC+2), 02:00 UTC in winter time (UTC+1).
case "$PARIS_UTC" in
  01:00) pass "next occurrence at 01:00 UTC — summer time in Paris (UTC+2)" ;;
  02:00) pass "next occurrence at 02:00 UTC — winter time in Paris (UTC+1)" ;;
  03:00) fail "next occurrence at 03:00 UTC: the zone is NOT applied, that is the bug" ;;
  *)     fail "next occurrence at $PARIS_UTC UTC — neither 01:00 nor 02:00, inconsistent" ;;
esac

[ "$PARIS_LOCAL" = "03:00" ] \
  || fail "in Paris, this occurrence falls at $PARIS_LOCAL, not at 03:00"
pass "and in Paris, it does fall at $PARIS_LOCAL — the requested time"

step "8. Changing the zone RESCHEDULES the next occurrence"
# Proven in Redis, not deduced: an `upsertJobScheduler` with the same key and a
# different `tz` must rewrite the sorted set's score, not leave it as is.
BEFORE_MS="$PARIS_MS"
code=$(req PATCH "/api/jobs/$PARIS_ID" '{"timezone":"Asia/Tokyo"}')
[ "$code" = "200" ] || fail "PATCH { timezone } → HTTP $code: $(cat "$BODY")"
jq -e '.timeZone == "Asia/Tokyo" and .cron == "0 3 * * *"' "$BODY" >/dev/null \
  || fail "unexpected response: $(jq -c '{cron, timeZone}' "$BODY")"
pass "PATCH { timezone: Asia/Tokyo } accepted, cadence unchanged"

STORED=$(psql_q "select timezone from scheduled_jobs where key = '$PARIS_KEY';")
[ "$STORED" = "Asia/Tokyo" ] || fail "in the database: \"$STORED\""
pass "in the database: timezone = \"$STORED\""

BULL_TZ=$(redis_q hget "$PARIS_HASH" tz | tr -d '\r')
[ "$BULL_TZ" = "Asia/Tokyo" ] \
  || fail "BullMQ kept tz = \"${BULL_TZ:-none}\": the scheduler did not follow"
pass "BullMQ followed: tz = \"$BULL_TZ\""

AFTER_MS=$(next_ms "$PARIS_KEY")
[ -n "$AFTER_MS" ] || fail "no next occurrence left after the zone change"
info "before: $(fmt_in "$BEFORE_MS" UTC) UTC — after: $(fmt_in "$AFTER_MS" UTC) UTC"
[ "$AFTER_MS" != "$BEFORE_MS" ] \
  || fail "the next occurrence did not move ($BEFORE_MS): BullMQ did not reschedule"
pass "the next occurrence was recomputed: $BEFORE_MS → $AFTER_MS"

TOKYO_LOCAL=$(hhmm_in "$AFTER_MS" Asia/Tokyo)
[ "$TOKYO_LOCAL" = "03:00" ] \
  || fail "in Tokyo, this occurrence falls at $TOKYO_LOCAL, not at 03:00"
pass "and it does fall at $TOKYO_LOCAL in Tokyo — it is the new zone that decides"

# The pattern, for its part, was not touched: only a setting changed.
PATTERN=$(redis_q hget "$PARIS_HASH" pattern | tr -d '\r')
[ "$PATTERN" = "0 3 * * *" ] || fail "the pattern changed on its own: \"$PATTERN\""
pass "the pattern stayed \"$PATTERN\""

# A made-up zone on an existing job is refused too, and changes nothing.
code=$(req PATCH "/api/jobs/$PARIS_ID" '{"timezone":"Europe/Atlantide"}')
[ "$code" = "422" ] || fail "made-up zone in PATCH: expected 422, got $code"
STORED=$(psql_q "select timezone from scheduled_jobs where key = '$PARIS_KEY';")
[ "$STORED" = "Asia/Tokyo" ] || fail "the zone moved despite the refusal: \"$STORED\""
pass "a made-up zone in PATCH is refused (422) and changes nothing"

step "9. The jobs older than migration 0009 stayed in UTC"
# `health:periodic` and `scan:periodic` were installed when the pattern went to
# BullMQ without `tz`, so interpreted in UTC. The migration set `UTC` on these
# rows — not the instance zone — so as not to move a run nobody asked to
# change.
LEGACY_SEEN=0
for key in health:periodic scan:periodic; do
  row=$(psql_q "select cron || '|' || timezone from scheduled_jobs where key = '$key';")
  if [ -z "$row" ]; then
    info "\"$key\" missing from this instance — nothing to check"
    continue
  fi
  LEGACY_SEEN=$((LEGACY_SEEN + 1))
  legacy_cron="${row%%|*}"
  legacy_tz="${row##*|}"
  [ "$legacy_tz" = "UTC" ] \
    || fail "\"$key\" is in \"$legacy_tz\": the migration moved an existing job"
  pass "\"$key\" ($legacy_cron) still in UTC — behavior preserved"

  bull_tz=$(redis_q hget "${REPEAT_KEY%:repeat}:repeat:$key" tz | tr -d '\r')
  [ "$bull_tz" = "UTC" ] || fail "BullMQ interprets \"$key\" in \"${bull_tz:-none}\""

  ms=$(next_ms "$key")
  [ -n "$ms" ] || fail "\"$key\" has no next occurrence in BullMQ"
  # On an "M H * * *" cron, the next occurrence must fall at H:M UTC — exactly
  # where it fell before the migration.
  if printf '%s' "$legacy_cron" | grep -qE '^[0-9]+ [0-9]+ \* \* \*$'; then
    expected=$(printf '%02d:%02d' "$(printf '%s' "$legacy_cron" | cut -d' ' -f2)" \
                                  "$(printf '%s' "$legacy_cron" | cut -d' ' -f1)")
    actual=$(hhmm_in "$ms" UTC)
    [ "$actual" = "$expected" ] \
      || fail "\"$key\": next occurrence at $actual UTC, expected $expected UTC"
    pass "\"$key\": next occurrence at $actual UTC — unchanged"
  else
    info "\"$key\": $(fmt_in "$ms" UTC) UTC (non-hourly cadence, no fixed time to compare)"
  fi
done
[ "$LEGACY_SEEN" -gt 0 ] \
  && info "$LEGACY_SEEN pre-existing job(s) checked" \
  || info "no pre-existing job on this instance"

step "10. Changing the cadence in simple mode"
code=$(req PATCH "/api/jobs/$SIMPLE_ID" \
  '{"schedule":{"kind":"interval","everyMinutes":30}}')
[ "$code" = "200" ] || fail "PATCH → HTTP $code: $(cat "$BODY")"
jq -e '.cron == "*/30 * * * *"' "$BODY" >/dev/null \
  || fail "cron rendu: $(jq -r .cron "$BODY")"
pass "PATCH { schedule: interval 30 min } → cron \"*/30 * * * *\""

STORED=$(psql_q "select cron from scheduled_jobs where key = '$SIMPLE_KEY';")
[ "$STORED" = "*/30 * * * *" ] || fail "in the database: \"$STORED\""
pass "in the database: \"$STORED\""

PATTERN=$(redis_q hget "$SCHED_HASH" pattern | tr -d '\r')
[ "$PATTERN" = "*/30 * * * *" ] || fail "BullMQ did not follow: \"$PATTERN\""
pass "BullMQ followed: \"$PATTERN\""

jq -e '.schedule.kind == "interval" and .schedule.everyMinutes == 30' "$BODY" >/dev/null \
  || fail "wrong simplified read-back: $(jq -c '.schedule' "$BODY")"
pass "read back in simple mode: $(jq -c '.schedule' "$BODY")"

step "11. The process's zone no longer comes into play"
TZ_PANEL=$(docker compose exec -T panel node -e \
  'process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone)' | tr -d '\r')
TZ_WORKER=$(docker compose exec -T worker node -e \
  'process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone)' | tr -d '\r')
info "panel: $TZ_PANEL — worker: $TZ_WORKER (no TZ variable in the containers)"

# Step 8's job is in Asia/Tokyo. If the process's zone still counted, its next
# occurrence would fall at 03:00 in THAT zone.
TOKYO_MS=$(next_ms "$PARIS_KEY")
IN_PROC=$(hhmm_in "$TOKYO_MS" "$TZ_PANEL")
[ "$IN_PROC" != "03:00" ] || fail "the occurrence falls at 03:00 $TZ_PANEL: the process's zone still decides"
pass "\"$PARIS_KEY\" falls at $IN_PROC in the process's zone, 03:00 in its own"

# No installed scheduler must stay without `tz`, nor disagree with its row: it
# is exactly the gap the worker corrects at startup.
DRIFT=0
while IFS='|' read -r jkey jtz; do
  [ -n "$jkey" ] || continue
  btz=$(redis_q hget "${REPEAT_KEY%:repeat}:repeat:$jkey" tz | tr -d '\r')
  if [ "$btz" != "$jtz" ]; then
    printf '    \033[31m%s\033[0m\n' "\"$jkey\": database \"$jtz\", BullMQ \"${btz:-none}\""
    DRIFT=$((DRIFT + 1))
  fi
done <<< "$(psql_q "select key || '|' || timezone from scheduled_jobs where enabled;")"
[ "$DRIFT" = "0" ] || fail "$DRIFT scheduler(s) disagreeing with the database on the zone"
pass "all active jobs: database and BullMQ agree on the zone"

step "12. job:manage is required to write"
code=$(req POST /api/admin/users \
  "{\"name\":\"Viewer planning\",\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\",\"role\":\"viewer\"}")
case "$code" in
  201) pass "viewer user created" ;;
  409) pass "viewer user already present" ;;
  *)   fail "POST /api/admin/users → HTTP $code: $(cat "$BODY")" ;;
esac
VIEWER_ID=$(psql_q "select id from users where email = '$VIEWER_EMAIL';")

for _ in 1 2 3 4 5; do
  code=$(vreq POST /api/auth/sign-in/email \
    "{\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\"}")
  [ "$code" = "429" ] || break
  sleep 6
done
[ "$code" = "200" ] || fail "viewer sign-in failed (HTTP $code): $(cat "$BODY")"
pass "signed in as $VIEWER_EMAIL"

code=$(vreq GET /api/jobs)
[ "$code" = "200" ] || fail "a viewer must be able to read (job:read) — HTTP $code"
pass "reading allowed (job:read)"

code=$(vreq POST /api/jobs \
  '{"type":"cleanup","key":"verify:schedule:viewer","schedule":{"kind":"daily","hour":5,"minute":0}}')
[ "$code" = "403" ] || fail "creation by a viewer: expected 403, got $code"
jq -e '.error.details.permission == "job:manage"' "$BODY" >/dev/null \
  || fail "the missing permission is not named: $(jq -c '.error' "$BODY")"
pass "creation refused → 403, permission \"job:manage\""

code=$(vreq PATCH "/api/jobs/$SIMPLE_ID" '{"schedule":{"kind":"hourly","minute":0}}')
[ "$code" = "403" ] || fail "change by a viewer: expected 403, got $code"
pass "change refused → 403"

code=$(vreq DELETE "/api/jobs/$SIMPLE_ID")
[ "$code" = "403" ] || fail "deletion by a viewer: expected 403, got $code"
pass "deletion refused → 403"

STORED=$(psql_q "select cron from scheduled_jobs where key = '$SIMPLE_KEY';")
[ "$STORED" = "*/30 * * * *" ] || fail "the cadence moved despite the refusals: \"$STORED\""
pass "the cadence did not move: \"$STORED\""

step "13. Traceability"
code=$(req GET "/api/audit-logs?resourceType=scheduled_job&pageSize=20")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
for action in schedule.created schedule.updated; do
  jq -e --arg a "$action" '[.items[] | select(.action == $a)] | length > 0' "$BODY" >/dev/null \
    || fail "action \"$action\" missing from the audit log"
  pass "audit: $action"
done

step "14. Cleanup"
for key in "$SIMPLE_KEY:$SIMPLE_ID" "$EXPERT_KEY:$EXPERT_ID" "$PARIS_KEY:$PARIS_ID"; do
  name="${key%:*}"
  id="${key##*:}"
  code=$(req PATCH "/api/jobs/$id" '{"enabled":false}')
  [ "$code" = "200" ] || fail "disabling \"$name\" → HTTP $code"
  pass "\"$name\" disabled"

  code=$(req DELETE "/api/jobs/$id")
  [ "$code" = "204" ] || fail "deleting \"$name\" → HTTP $code"
  pass "\"$name\" deleted"
done

MEMBERS=$(redis_q zrange "$REPEAT_KEY" 0 -1 | tr -d '\r')
for name in "$SIMPLE_KEY" "$EXPERT_KEY" "$PARIS_KEY"; do
  echo "$MEMBERS" | grep -qF "$name" \
    && fail "\"$name\" still lingers in BullMQ: $MEMBERS"
done
pass "none of the three lingers in BullMQ"

left=$(psql_q "select count(*) from scheduled_jobs where key like 'verify:schedule:%';")
[ "$left" = "0" ] || fail "$left test job(s) remain in the database"
pass "no test job in the database"

[ -n "$VIEWER_ID" ] && req DELETE "/api/admin/users/$VIEWER_ID" >/dev/null 2>&1 || true
pass "test user deleted"

printf '\n\033[32m✓ Simplified input and time zone of scheduled jobs verified.\033[0m\n'
printf '\033[2m  Screen: %s/jobs — default zone of new jobs: %s\033[0m\n\n' \
  "$BASE_URL" "$INSTANCE_TZ"
