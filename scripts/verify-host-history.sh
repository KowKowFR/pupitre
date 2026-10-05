#!/usr/bin/env bash
#
# Checks the MEMORY of server supervision:
#
#    1. a sample is no longer lost — it is written, whatever triggered it
#    2. the samples accumulate, and the history is read in SQL (not over SSH),
#       so it answers even when the machine no longer does
#    3. the three layers of thresholds: catalog → instance default → machine
#    4. a threshold NOT crossed produces NO audit entry
#    5. a crossed threshold produces EXACTLY ONE entry — not one per sample
#    6. going back below the threshold produces exactly one, and only one
#    7. two open breaches on the same metric are impossible — a constraint in
#       the database, not an `if`
#    8. the sweep is a BullMQ repeatable job, installed by the worker. No Linux
#       cron, and no duplicate sample: a machine sampled less than the cadence
#       ago is not due
#    9. the purge purges — exactly beyond the retention, and the breaches
#       survive it
#   10. RBAC: `target:read` to read the history, `target:update` to set a
#       threshold
#
# Prerequisite: a reachable target — `./scripts/setup-test-target.sh`
# provisions one. The script creates no application and deploys nothing.
#
# What it touches, and gives back: the thresholds of the test target, the
# global DISK threshold, this target's breaches, and the made-up samples it
# marks to recognize them. The global thresholds of the other metrics and the
# real samples are never erased — they are the machine's history.
#
# Usage:
#   ./scripts/verify-host-history.sh
#   BASE_URL=http://localhost:3100 TARGET_NAME=my-vm ./scripts/verify-host-history.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
CLIENT_IP="${CLIENT_IP:-198.51.100.43}"
TARGET_NAME="${TARGET_NAME:-cible-de-verification}"
TARGET_SERVICE="${TARGET_SERVICE:-ssh-target}"

READER_ROLE="${READER_ROLE:-verif-histo-lecteur}"
READER_EMAIL="${READER_EMAIL:-histo-lecteur@example.test}"
BLIND_ROLE="${BLIND_ROLE:-verif-histo-aveugle}"
BLIND_EMAIL="${BLIND_EMAIL:-histo-aveugle@example.test}"
PASSWORD="${PASSWORD:-motdepasse-tres-long}"

# Cadence and retention, as the code sets them. The script cross-checks them
# with what the API announces: two truths that diverged would show here.
EXPECTED_INTERVAL=300
EXPECTED_RETENTION=30

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
READER_JAR="$WORK/reader.jar"
BLIND_JAR="$WORK/blind.jar"
BODY="$WORK/body.json"

TARGET_ID=''
FAKE_MARK='verification-purge'

# Gives the ground back as it was found, even on a death along the way.
cleanup() {
  if [ -n "$TARGET_ID" ]; then
    docker compose exec -T postgres psql -U tp -d tp -tAc \
      "delete from target_metric_thresholds
         where target_id = '$TARGET_ID' or (target_id is null and metric = 'disk');
       delete from target_metric_breaches where target_id = '$TARGET_ID';
       delete from target_metric_samples where error = '$FAKE_MARK';" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

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

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1" | tr -d '\r'; }
redis_cli() { docker compose exec -T redis redis-cli "$@" | tr -d '\r'; }

assert_admin() {
  local role
  role=$(jq -r '.user.role // empty' "$BODY")
  [ "$role" = "admin" ] && return 0
  fail "\"$ADMIN_EMAIL\" has the role \"${role:-none}\", not \"admin\""
}

# Better Auth limits repeated sign-ins from the same IP: we wait rather than
# fall back on the sign-up, which would give a misleading message.
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

# A sample, through the existing route. It goes through the queue, the worker,
# SSH — and, since this work, the database.
probe() {
  local code
  code=$(req GET "/api/targets/$TARGET_ID/metrics")
  [ "$code" = "200" ] || fail "GET metrics → HTTP $code: $(cat "$BODY")"
}

samples_of() { psql_q "select count(*) from target_metric_samples where target_id = '$TARGET_ID';"; }

# Threshold audit entries for THIS target and THIS metric. The filter on the
# metric is essential: the host machine's memory can legitimately cross its own
# threshold during the test, and would skew a global count.
audit_count() {
  psql_q "select count(*) from audit_logs
           where action = '$1' and resource_id = '$TARGET_ID'
             and after->>'metric' = '$2';"
}

# Sets a disk threshold for the target. Echoes: nothing, fails if the API refuses.
set_disk_limit() {
  local code
  code=$(req PUT /api/supervision/thresholds \
    "{\"targetId\":\"$TARGET_ID\",\"metric\":\"disk\",\"limitPercent\":$1}")
  [ "$code" = "200" ] || fail "PUT disk threshold $1 % → HTTP $code: $(cat "$BODY")"
}

step "1. Sign-in"
login
pass "signed in as $ADMIN_EMAIL"

step "2. Prerequisites"
RUNNING=$(docker compose ps --format '{{.Service}}' 2>/dev/null || true)
printf '%s\n' "$RUNNING" | grep -qx "$TARGET_SERVICE" \
  || fail "the \"$TARGET_SERVICE\" container is not running — run ./scripts/setup-test-target.sh"

code=$(req GET /api/targets)
[ "$code" = "200" ] || fail "GET /api/targets → HTTP $code"
TARGET_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY" | head -1)
[ -n "$TARGET_ID" ] || fail "target \"$TARGET_NAME\" not found"
pass "target \"$TARGET_NAME\" — $TARGET_ID"

# Clean ground: neither threshold nor breach inherited from a previous run.
psql_q "delete from target_metric_thresholds
          where target_id = '$TARGET_ID' or (target_id is null and metric = 'disk');
        delete from target_metric_breaches where target_id = '$TARGET_ID';" >/dev/null
pass "this target's thresholds and breaches reset"

step "3. A sample is no longer lost"
BEFORE=$(samples_of)
info "samples already in memory for this target: $BEFORE"

probe
DISK_NOW=$(jq -r '.disk.usePercent' "$BODY")
MEM_NOW=$(jq -r '.memory.usedPercent' "$BODY")
CORES=$(jq -r '.load.cores' "$BODY")
AFTER=$(samples_of)
[ "$AFTER" = "$((BEFORE + 1))" ] \
  || fail "a sample should have written one row: $BEFORE → $AFTER"
pass "a call to /metrics writes exactly one row ($BEFORE → $AFTER)"

ROW=$(psql_q "select source || '|' || round(disk_percent::numeric, 4) || '|' || cores || '|' || reachable
                from target_metric_samples
               where target_id = '$TARGET_ID' order by sampled_at desc limit 1;")
SRC=$(printf '%s' "$ROW" | cut -d'|' -f1)
ROW_DISK=$(printf '%s' "$ROW" | cut -d'|' -f2)
ROW_CORES=$(printf '%s' "$ROW" | cut -d'|' -f3)
[ "$SRC" = "manual" ] || fail "the row should carry source = manual, it carries \"$SRC\""
[ "$ROW_CORES" = "$CORES" ] || fail "cores: the database says $ROW_CORES, the API answered $CORES"
awk -v a="$ROW_DISK" -v b="$DISK_NOW" 'BEGIN { d = a - b; if (d < 0) d = -d; exit !(d < 0.01) }' \
  || fail "disk: the database says $ROW_DISK %, the API answered $DISK_NOW %"
pass "the written row is indeed the returned one: disk $ROW_DISK %, $ROW_CORES cores, source \"manual\""
info "memory at the same moment: $MEM_NOW % — the row carries the three dimensions, as columns"


step "4. The samples accumulate, and the history is read in SQL"
for _ in 1 2 3; do probe; done
COUNT=$(samples_of)
[ "$COUNT" = "$((BEFORE + 4))" ] || fail "4 samples expected, $((COUNT - BEFORE)) written"
pass "4 samples in a row → 4 rows ($BEFORE → $COUNT)"

code=$(req GET "/api/targets/$TARGET_ID/metrics/history?hours=24&buckets=48")
[ "$code" = "200" ] || fail "GET metrics/history → HTTP $code: $(cat "$BODY")"
API_INTERVAL=$(jq -r '.intervalSeconds' "$BODY")
API_RETENTION=$(jq -r '.retentionDays' "$BODY")
[ "$API_INTERVAL" = "$EXPECTED_INTERVAL" ] \
  || fail "announced cadence $API_INTERVAL s, expected $EXPECTED_INTERVAL s"
[ "$API_RETENTION" = "$EXPECTED_RETENTION" ] \
  || fail "announced retention $API_RETENTION d, expected $EXPECTED_RETENTION d"
pass "the history announces itself: cadence $API_INTERVAL s, retention $API_RETENTION days"

HIST_SAMPLES=$(jq -r '.samples' "$BODY")
[ "$HIST_SAMPLES" -ge 4 ] || fail "the 24 h window only counts $HIST_SAMPLES samples"
POINTS=$(jq -r '.points | length' "$BODY")
WORST=$(jq -r '.summary.disk.worst' "$BODY")
SQL_WORST=$(psql_q "select round(max(disk_percent)::numeric, 4) from target_metric_samples
                     where target_id = '$TARGET_ID' and sampled_at >= now() - interval '24 hours';")
awk -v a="$WORST" -v b="$SQL_WORST" 'BEGIN { d = a - b; if (d < 0) d = -d; exit !(d < 0.01) }' \
  || fail "worst sample: the API says $WORST, the database says $SQL_WORST"
pass "$HIST_SAMPLES samples aggregated into $POINTS intervals — worst disk $WORST % (= max in the database)"

# The aggregation is a `max()`, not an average: it is the peak that matters.
[ "$POINTS" -le 48 ] || fail "$POINTS points returned for 48 requested intervals"
pass "at most 48 points carried, whatever the density of the samples"

# Four samples in a row fit in a single interval: that does not prove that a
# CURVE reads. We make one, over 24 h, marked to be removed right afterwards: a
# disk that climbs from 16 % to 85 % in one day.
psql_q "insert into target_metric_samples
          (target_id, sampled_at, source, reachable, error, disk_percent, memory_percent, load_percent)
        select '$TARGET_ID',
               now() - interval '1 minute' - ((n - 1) * 60 || ' minutes')::interval,
               'sweep', true, '$FAKE_MARK', 85 - (n - 1) * 3, 40, 25
          from generate_series(1, 24) as n;" >/dev/null

req GET "/api/targets/$TARGET_ID/metrics/history?hours=24&buckets=48" >/dev/null
CURVE_POINTS=$(jq -r '.points | length' "$BODY")
CURVE_WORST=$(jq -r '.summary.disk.worst' "$BODY")
CURVE_TREND=$(jq -r '.summary.disk.trend' "$BODY")
CURVE_FIRST=$(jq -r '[.points[] | select(.diskPercent != null)] | .[0].diskPercent' "$BODY")

[ "$CURVE_POINTS" -ge 20 ] || fail "a day of hourly samples should make ≥ 20 points, there are $CURVE_POINTS"
awk -v w="$CURVE_WORST" 'BEGIN { exit !(w > 84.9 && w < 85.1) }' \
  || fail "the window's worst sample should be 85 %, it is $CURVE_WORST"
awk -v t="$CURVE_TREND" 'BEGIN { exit !(t > 60) }' \
  || fail "the trend should be clearly rising, it is $CURVE_TREND"
pass "curve over 24 h: $CURVE_POINTS points, from $CURVE_FIRST % to $CURVE_WORST % — trend +$CURVE_TREND pt"
info "it is exactly the question a single number does not answer:"
info "85 % after a week at 85 %, or 85 % after a day at 16 %?"

psql_q "delete from target_metric_samples where error = '$FAKE_MARK';" >/dev/null
req GET "/api/targets/$TARGET_ID/metrics/history?hours=24&buckets=48" >/dev/null
BACK_WORST=$(jq -r '.summary.disk.worst' "$BODY")
awk -v w="$BACK_WORST" 'BEGIN { exit !(w < 84) }' \
  || fail "the made-up samples were not removed (worst still at $BACK_WORST %)"
pass "made-up samples removed — the window falls back to $BACK_WORST %, the real measure"

step "5. The three layers of thresholds"
code=$(req GET /api/supervision/thresholds)
[ "$code" = "200" ] || fail "GET /api/supervision/thresholds → HTTP $code"
CATALOG=$(jq -r '[.catalog[] | "\(.metric)=\(.defaultLimitPercent)%/\(.defaultBreachSamples)"] | join(" ")' "$BODY")
pass "catalog served: $CATALOG"
jq -e '[.catalog[] | select(.metric == "disk")] | .[0].defaultBreachSamples == 1' "$BODY" >/dev/null \
  || fail "the disk should open from the first sample"
jq -e '[.catalog[] | select(.metric == "load")] | .[0].defaultBreachSamples == 3' "$BODY" >/dev/null \
  || fail "the load should require three consecutive samples"
pass "the number of confirming samples is specific to the metric: disk 1, load 3"

origin_of() {
  req GET "/api/targets/$TARGET_ID/metrics/history?hours=1" >/dev/null
  jq -r '.thresholds.disk | "\(.origin)@\(.limitPercent)"' "$BODY"
}

[ "$(origin_of)" = "default@90" ] || fail "without a setting, the threshold should be \"default@90\", it is \"$(origin_of)\""
pass "no setting → the catalog applies: default@90"

code=$(req PUT /api/supervision/thresholds '{"targetId":null,"metric":"disk","limitPercent":80}')
[ "$code" = "200" ] || fail "PUT seuil global → HTTP $code: $(cat "$BODY")"
[ "$(origin_of)" = "global@80" ] || fail "the instance default does not apply: \"$(origin_of)\""
pass "an instance default → global@80, it overrides the catalog"

set_disk_limit 70
[ "$(origin_of)" = "target@70" ] || fail "the machine's threshold does not apply: \"$(origin_of)\""
pass "a machine threshold → target@70, it overrides the instance default"

# Two global rows for the same metric: impossible, through a partial unique
# index. Without it, `unique(target_id, metric)` would let them through — two
# NULLs are never equal in SQL.
DUP=$(psql_q "insert into target_metric_thresholds (target_id, metric, limit_percent)
              values (null, 'disk', 55);" 2>&1 || true)
printf '%s' "$DUP" | grep -qi 'duplicate key\|unique' \
  || fail "a second global row was accepted: $DUP"
pass "a second instance default is refused by the database: $(printf '%s' "$DUP" | head -1 | cut -c1-90)"

code=$(req DELETE "/api/supervision/thresholds?targetId=$TARGET_ID&metric=disk")
[ "$code" = "200" ] || fail "DELETE seuil machine → HTTP $code"
[ "$(origin_of)" = "global@80" ] || fail "removing the machine threshold should hand over to the global one"
pass "removing the machine's threshold hands over to the layer below"

code=$(req DELETE "/api/supervision/thresholds?metric=disk")
[ "$code" = "200" ] || fail "DELETE seuil global → HTTP $code"
[ "$(origin_of)" = "default@90" ] || fail "removing the global one should hand over to the catalog"
pass "removing the instance default hands over to the catalog"

step "6. A threshold NOT crossed produces no audit entry"
OVER=$(awk -v d="$DISK_NOW" 'BEGIN { printf "%d", d + 5 }')
set_disk_limit "$OVER"
info "measured disk: $DISK_NOW % — threshold deliberately set above: $OVER %"

A0=$(audit_count 'target.threshold.breached' 'disk')
for _ in 1 2 3; do probe; done
A1=$(audit_count 'target.threshold.breached' 'disk')
[ "$A1" = "$A0" ] || fail "3 samples below the threshold produced $((A1 - A0)) entry(ies)"
OPEN=$(psql_q "select count(*) from target_metric_breaches
                where target_id = '$TARGET_ID' and metric = 'disk' and resolved_at is null;")
[ "$OPEN" = "0" ] || fail "a breach is open although nothing was crossed"
pass "3 samples at $DISK_NOW % below a threshold at $OVER % → 0 audit entries, 0 breaches"

step "7. A CROSSED threshold produces exactly ONE entry — not one per sample"
UNDER=$(awk -v d="$DISK_NOW" 'BEGIN { v = d - 5; if (v < 1) v = 1; printf "%d", v }')
set_disk_limit "$UNDER"
info "threshold lowered below the measure: $UNDER % (disk at $DISK_NOW %)"

S0=$(samples_of)
for _ in 1 2 3 4; do probe; done
S1=$(samples_of)
A2=$(audit_count 'target.threshold.breached' 'disk')

[ "$((S1 - S0))" = "4" ] || fail "4 samples expected, $((S1 - S0)) written"
[ "$((A2 - A1))" = "1" ] \
  || fail "4 samples above the threshold produced $((A2 - A1)) audit entries — expected: 1"
pass "4 samples above the threshold → 4 series rows, and EXACTLY 1 audit entry"

BREACH=$(psql_q "select id || '|' || samples || '|' || round(peak_value::numeric,2) || '|' || round(limit_percent::numeric,2)
                   from target_metric_breaches
                  where target_id = '$TARGET_ID' and metric = 'disk' and resolved_at is null;")
[ -n "$BREACH" ] || fail "no open breach although the threshold is crossed"
B_SAMPLES=$(printf '%s' "$BREACH" | cut -d'|' -f2)
B_PEAK=$(printf '%s' "$BREACH" | cut -d'|' -f3)
B_LIMIT=$(printf '%s' "$BREACH" | cut -d'|' -f4)
[ "$B_SAMPLES" = "4" ] \
  || fail "the episode should have followed the 4 samples, it counts $B_SAMPLES"
pass "the episode followed the 4 samples without announcing anything more: samples=$B_SAMPLES, worst=$B_PEAK %"

# The threshold is COPIED into the episode: it says under which rule it was decided.
awk -v a="$B_LIMIT" -v b="$UNDER" 'BEGIN { exit !(a == b) }' \
  || fail "the episode carries the threshold $B_LIMIT %, it was opened under $UNDER %"
pass "the episode copies the threshold that opened it ($B_LIMIT %) — it never reads it again"

AUDIT=$(psql_q "select after->>'detail' from audit_logs
                 where action = 'target.threshold.breached' and resource_id = '$TARGET_ID'
                   and after->>'metric' = 'disk' order by created_at desc limit 1;")
[ -n "$AUDIT" ] || fail "the audit entry says nothing readable"
pass "the audit entry reads: \"$AUDIT\""
info "action: target.threshold.breached — resource_type \"target\", resource_id the target"

step "8. Two open breaches on the same metric: impossible"
DUP=$(psql_q "insert into target_metric_breaches
                (target_id, metric, limit_percent, opened_value, peak_value, last_value)
              values ('$TARGET_ID', 'disk', 50, 99, 99, 99);" 2>&1 || true)
printf '%s' "$DUP" | grep -qi 'duplicate key\|unique' \
  || fail "a second open breach was accepted: $DUP"
pass "refused by the partial unique index — a constraint, not an \"if\""

step "9. The crossing rule, laid bare"
# The number of consecutive samples is not demonstrated by moving a threshold:
# the counters are DERIVED from the series (see `decideBreach`), so a moved
# threshold applies retroactively — that is deliberate, and it is proven at the
# next step. So the rule itself is tried where it lives: the pure function. The
# module is loaded through its absolute path: the script writes its test file
# in a temporary folder, outside the tree, where "@pupitre/db" does not
# resolve.
DB_DIST="$REPO_ROOT/packages/db/dist/index.js"
[ -f "$DB_DIST" ] || fail "\"$DB_DIST\" missing — run \"pnpm build:packages\" first"

cat > "$WORK/rule.mjs" <<NODE
import { decideBreach } from 'file://$DB_DIST';
NODE
cat >> "$WORK/rule.mjs" <<'NODE'

const rule = (breach, clear) => ({
  metric: 'disk', limitPercent: 90, breachSamples: breach, clearSamples: clear,
  enabled: true, origin: 'default',
});

// [ title, values (most recent first), threshold, episode open?, expected verdict ]
const cases = [
  ['disk: a single sample above is enough',          [95],               rule(1, 2), false, 'open'],
  ['load: two samples are not enough',               [95, 95],           rule(3, 3), false, null],
  ['load: three in a row, and only then',            [95, 95, 95],       rule(3, 3), false, 'open'],
  ['load: an isolated spike opens nothing',          [95, 50, 95],       rule(3, 3), false, null],
  ['recovery: one sample below does not close',      [50],               rule(1, 2), true,  null],
  ['recovery: two samples below close',              [50, 50],           rule(1, 2), true,  'clear'],
  ['right on the threshold is not above',            [90],               rule(1, 2), false, null],
  ['sample without a measure: skipped, not counted', [null, 50, null, 50], rule(1, 2), true, 'clear'],
  ['silent machine: nothing closes on its own',      [null, null, null], rule(1, 2), true,  null],
];

let failures = 0;
for (const [title, values, threshold, open, expected] of cases) {
  const got = decideBreach(values, threshold, open);
  const ok = got === expected;
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'ok  ' : 'KO  '}${title} → ${got === null ? 'nothing' : got}` +
      (ok ? '' : ` (expected ${expected === null ? 'nothing' : expected})`),
  );
}
process.exit(failures === 0 ? 0 : 1);
NODE

RULE_OUT=$(node "$WORK/rule.mjs" 2>&1) || fail "the crossing rule does not hold:
$RULE_OUT"
printf '%s\n' "$RULE_OUT" | while IFS= read -r line; do info "$line"; done
pass "the rule's 9 cases pass — hysteresis, isolated spike, equality, silent samples"

step "10. Going back below the threshold produces exactly one entry, and only one"
C0=$(audit_count 'target.threshold.cleared' 'disk')
set_disk_limit "$OVER"
info "threshold raised to $OVER %: the machine goes back below the threshold without having moved"

probe
C1=$(audit_count 'target.threshold.cleared' 'disk')
[ "$((C1 - C0))" = "1" ] || fail "the recovery produced $((C1 - C0)) entries — expected: 1"
pass "the episode closes and writes EXACTLY 1 \"target.threshold.cleared\" entry"
info "raising a threshold closes right away, without waiting for two samples: the counters"
info "are derived from the series, so a setting applies to the past — symmetric to the"
info "reverse case, where lowering a threshold alerts immediately instead of waiting a quarter of an hour."

RESOLVED=$(psql_q "select count(*) from target_metric_breaches
                    where target_id = '$TARGET_ID' and metric = 'disk' and resolved_at is not null;")
[ "$RESOLVED" -ge 1 ] || fail "the episode was not closed in the database"
DURATION=$(psql_q "select after->>'durationSeconds' from audit_logs
                    where action = 'target.threshold.cleared' and resource_id = '$TARGET_ID'
                      and after->>'metric' = 'disk' order by created_at desc limit 1;")
pass "episode closed in the database, and the announcement says how long it lasted: ${DURATION} s"

probe; probe
C2=$(audit_count 'target.threshold.cleared' 'disk')
[ "$C2" = "$C1" ] || fail "samples below the threshold keep writing entries"
pass "the following samples, still below the threshold, no longer write anything"

step "11. The sweep: a BullMQ repeatable job, not a cron"
SCHED=$(redis_cli --scan --pattern 'bull:supervision:repeat:*' | sort -u | paste -sd' ' -)
printf '%s' "$SCHED" | grep -q 'target-metrics-sweep' \
  || fail "no \"target-metrics-sweep\" scheduler in Redis (seen: $SCHED)"
pass "BullMQ scheduler present: target-metrics-sweep"

EVERY=$(redis_cli HGET 'bull:supervision:repeat:target-metrics-sweep' every)
JOB_NAME=$(redis_cli HGET 'bull:supervision:repeat:target-metrics-sweep' name)
[ "$EVERY" = "60000" ] || fail "scheduler cadence: $EVERY ms, expected 60000"
[ "$JOB_NAME" = "target:metrics_sweep" ] \
  || fail "the scheduler queues \"$JOB_NAME\", expected \"target:metrics_sweep\""
pass "it queues \"$JOB_NAME\" every $EVERY ms — the cadence is in Redis, not in a file"

# No cron on the worker: the project's decision is held.
CRON=$(docker compose exec -T worker sh -lc 'crontab -l 2>&1 || true; ls -1 /etc/cron* 2>&1 || true' || true)
printf '%s' "$CRON" | grep -qi 'target\|metrics\|sweep' \
  && fail "something resembling a cron talks about samples: $CRON"
pass "nothing in the worker's cron — BullMQ is the only clock"

# Does the sweep write on its own? Two distinct things to prove, and they must
# be separated: that it RUNS, and that it WRITES.
#
# That it writes is not proven by waiting for one more row: an occurrence that
# finds no due machine writes none, and that is precisely the intended
# behavior (proven right after). So we look at the rows already written by the
# sweep, which no human asked for.
SWEEP_ROWS=$(psql_q "select count(*) from target_metric_samples where source = 'sweep';")
[ "$SWEEP_ROWS" -ge 1 ] \
  || fail "no \"sweep\" row in the database — the sweep never wrote anything"
SWEEP_LAST=$(psql_q "select to_char(max(sampled_at), 'YYYY-MM-DD HH24:MI:SS')
                       from target_metric_samples where source = 'sweep';")
pass "$SWEEP_ROWS samples written by the sweep, without anyone asking for them (last: $SWEEP_LAST)"

# That it RUNS reads on the iteration counter BullMQ keeps on the scheduler
# itself (`ic`). It is the only reliable source: the list of completed jobs is
# capped at a hundred entries, and the probes sweep — twice as frequent — has
# already filled it.
sweep_iterations() { redis_cli HGET 'bull:supervision:repeat:target-metrics-sweep' ic; }
IC_BEFORE=$(sweep_iterations)
info "scheduler iterations at this moment: $IC_BEFORE — waiting for one more (≤ 90 s)"
IC_AFTER="$IC_BEFORE"
for _ in $(seq 1 18); do
  sleep 5
  IC_AFTER=$(sweep_iterations)
  [ "$IC_AFTER" -gt "$IC_BEFORE" ] && break
done
[ "$IC_AFTER" -gt "$IC_BEFORE" ] \
  || fail "the iteration counter did not move in 90 s — the clock is not running"
pass "the clock is running: iteration $IC_BEFORE → $IC_AFTER, without anyone triggering anything"

# … and it does not repeat a machine sampled just now: the cadence is the data
# itself (`sampled_at`), not a parallel due-date column.
MINE_BEFORE=$(psql_q "select count(*) from target_metric_samples
                       where target_id = '$TARGET_ID' and source = 'sweep'
                         and sampled_at >= now() - make_interval(secs => $EXPECTED_INTERVAL);")
[ "$MINE_BEFORE" = "0" ] \
  || fail "the target was just sampled by hand, yet the sweep took it again"
pass "the target sampled by hand was not taken again by the sweep — no duplicate"

# An unreachable machine is recorded too: a gap does not say whether there was
# an outage or no supervisor.
DEAD=$(psql_q "select count(*) from target_metric_samples where reachable = false;")
if [ "$DEAD" -gt 0 ]; then
  DEAD_ERR=$(psql_q "select error from target_metric_samples where reachable = false
                      order by sampled_at desc limit 1;")
  pass "unreachable machines are recorded too ($DEAD rows): \"$(printf '%s' "$DEAD_ERR" | cut -c1-70)\""
else
  info "no unreachable machine in the fleet — the path could not be observed"
fi

step "12. The purge purges"
psql_q "insert into target_metric_samples (target_id, sampled_at, source, reachable, error, disk_percent)
        select '$TARGET_ID', now() - interval '40 days' - (n || ' minutes')::interval,
               'sweep', true, '$FAKE_MARK', 42
          from generate_series(1, 25) as n;" >/dev/null
OLD=$(psql_q "select count(*) from target_metric_samples
               where target_id = '$TARGET_ID' and sampled_at < now() - interval '$EXPECTED_RETENTION days';")
[ "$OLD" = "25" ] || fail "25 old samples expected, $OLD inserted"
TOTAL_BEFORE=$(samples_of)
BREACHES_BEFORE=$(psql_q "select count(*) from target_metric_breaches where target_id = '$TARGET_ID';")
info "$TOTAL_BEFORE samples in total, $OLD of them beyond the $EXPECTED_RETENTION-day retention"

# The purge is limited to once an hour: its marker is removed to force it.
redis_cli DEL 'target:metrics:prune:last' >/dev/null
TOTAL_AFTER="$TOTAL_BEFORE"
for _ in $(seq 1 18); do
  sleep 5
  TOTAL_AFTER=$(samples_of)
  [ "$TOTAL_AFTER" -lt "$TOTAL_BEFORE" ] && break
done
AFTER_OLD=$(psql_q "select count(*) from target_metric_samples
                     where target_id = '$TARGET_ID' and sampled_at < now() - interval '$EXPECTED_RETENTION days';")
[ "$AFTER_OLD" = "0" ] || fail "the purge left $AFTER_OLD samples beyond the retention"
REMOVED=$((TOTAL_BEFORE - TOTAL_AFTER))
# The sweep may have added a row in the meantime: we check that it is indeed
# the 25 old ones that went, not an exact count down to the sample.
[ "$REMOVED" -ge 24 ] && [ "$REMOVED" -le 25 ] \
  || fail "the purge removed $REMOVED rows, expected 25 (± a concurrent sample)"
pass "purge: $TOTAL_BEFORE → $TOTAL_AFTER samples — exactly the 25 beyond $EXPECTED_RETENTION days"

BREACHES_AFTER=$(psql_q "select count(*) from target_metric_breaches where target_id = '$TARGET_ID';")
[ "$BREACHES_AFTER" = "$BREACHES_BEFORE" ] \
  || fail "the purge took breaches away: $BREACHES_BEFORE → $BREACHES_AFTER"
pass "the breaches survive the purge ($BREACHES_AFTER kept) — they tell the story"

step "13. RBAC"
req DELETE "/api/admin/roles/$BLIND_ROLE" >/dev/null 2>&1 || true
req DELETE "/api/admin/roles/$READER_ROLE" >/dev/null 2>&1 || true

code=$(req POST /api/admin/roles \
  "{\"key\":\"$BLIND_ROLE\",\"label\":\"Histo sans cible\",\"permissions\":[\"deployment:read\"]}")
[ "$code" = "201" ] || fail "blind role POST → HTTP $code: $(cat "$BODY")"
code=$(req POST /api/admin/roles \
  "{\"key\":\"$READER_ROLE\",\"label\":\"Histo lecteur\",\"permissions\":[\"deployment:read\",\"target:read\"]}")
[ "$code" = "201" ] || fail "reader role POST → HTTP $code: $(cat "$BODY")"
pass "two roles: one without \"target:read\", the other with it but without \"target:update\""

for pair in "$BLIND_EMAIL|$BLIND_ROLE" "$READER_EMAIL|$READER_ROLE"; do
  email="${pair%%|*}"; role="${pair#*|}"
  code=$(req POST /api/admin/users \
    "{\"name\":\"$role\",\"email\":\"$email\",\"password\":\"$PASSWORD\",\"role\":\"$role\"}")
  case "$code" in 201|409) ;; *) fail "POST /api/admin/users ($email) → HTTP $code: $(cat "$BODY")" ;; esac
done
BLIND_ID=$(psql_q "select id from users where email = '$BLIND_EMAIL';")
READER_ID=$(psql_q "select id from users where email = '$READER_EMAIL';")

code=$(req POST /api/auth/sign-in/email "{\"email\":\"$BLIND_EMAIL\",\"password\":\"$PASSWORD\"}" "$BLIND_JAR")
[ "$code" = "200" ] || fail "blind sign-in → HTTP $code"
code=$(req GET "/api/targets/$TARGET_ID/metrics/history" '' "$BLIND_JAR")
[ "$code" = "403" ] || fail "history without target:read: expected 403, got $code"
jq -e '.error.details.permission == "target:read"' "$BODY" >/dev/null \
  || fail "the refusal does not name the permission: $(cat "$BODY")"
pass "history without \"target:read\" → 403, permission named"

DENIED=$(psql_q "select count(*) from audit_logs where action = 'permission.denied'
                  and resource_id = 'target:read' and actor_id = '$BLIND_ID';")
[ "$DENIED" -ge 1 ] || fail "the refusal was not logged"
pass "refusal traced in the audit log ($DENIED row(s))"

code=$(req POST /api/auth/sign-in/email "{\"email\":\"$READER_EMAIL\",\"password\":\"$PASSWORD\"}" "$READER_JAR")
[ "$code" = "200" ] || fail "reader sign-in → HTTP $code"
code=$(req GET "/api/targets/$TARGET_ID/metrics/history" '' "$READER_JAR")
[ "$code" = "200" ] || fail "history with target:read → HTTP $code"
pass "with \"target:read\", the history reads ($(jq -r '.samples' "$BODY") samples)"

code=$(req PUT /api/supervision/thresholds \
  "{\"targetId\":\"$TARGET_ID\",\"metric\":\"disk\",\"limitPercent\":50}" "$READER_JAR")
[ "$code" = "403" ] || fail "setting without target:update: expected 403, got $code"
jq -e '.error.details.permission == "target:update"' "$BODY" >/dev/null \
  || fail "the refusal does not name \"target:update\": $(cat "$BODY")"
pass "setting a threshold without \"target:update\" → 403, permission named"

# And the threshold did not move: a refusal that wrote anyway would be worst of all.
STILL=$(psql_q "select round(limit_percent::numeric) from target_metric_thresholds
                 where target_id = '$TARGET_ID' and metric = 'disk';")
[ "$STILL" = "$OVER" ] || fail "the threshold changed despite the refusal: $STILL % instead of $OVER %"
pass "the threshold stayed at $STILL % — the refusal wrote nothing"

step "14. Cleanup"
for id in "$BLIND_ID" "$READER_ID"; do
  [ -n "$id" ] && req DELETE "/api/admin/users/$id" >/dev/null
done
req DELETE "/api/admin/roles/$BLIND_ROLE" >/dev/null
req DELETE "/api/admin/roles/$READER_ROLE" >/dev/null
pass "test users and roles deleted"

psql_q "delete from target_metric_thresholds
          where target_id = '$TARGET_ID' or (target_id is null and metric = 'disk');
        delete from target_metric_breaches where target_id = '$TARGET_ID';
        delete from target_metric_samples where error = '$FAKE_MARK';" >/dev/null
TARGET_ID=''
pass "the test's thresholds, breaches and fake samples removed"
info "the real samples, for their part, are kept: they are the machine's history"

printf '\n\033[32m✓ Server supervision has a memory.\033[0m\n'
printf '\033[2m  Screen: %s/apps — log: %s/admin/audit\033[0m\n\n' "$BASE_URL" "$BASE_URL"
