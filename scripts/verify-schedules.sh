#!/usr/bin/env bash
#
# Vérifie la saisie simplifiée et le fuseau horaire des tâches planifiées :
#
#   1. créer une tâche en mode simple écrit bien le cron attendu EN BASE
#   2. sans fuseau explicite, la tâche prend celui des paramètres d'instance
#   3. la relire renvoie le même mode simple
#   4. une expression cron invalide est refusée (422)
#   5. une expression exotique est acceptée et bascule en mode expert
#   6. la tâche est réellement enregistrée comme repeatable job dans BullMQ,
#      motif ET fuseau
#   7. « tous les jours à 3 h » en Europe/Paris tombe à 01:00 ou 02:00 UTC selon
#      la saison — jamais à 03:00 : le fuseau est réellement appliqué
#   8. changer le fuseau d'une tâche existante REPROGRAMME sa prochaine
#      occurrence dans BullMQ
#   9. un fuseau IANA inventé est refusé (422), et rien n'est écrit
#  10. les tâches antérieures à la migration 0009 sont restées en UTC, et leur
#      prochaine occurrence n'a pas bougé
#  11. modifier la cadence en mode simple met à jour base ET Redis
#  12. `job:manage` est requis pour écrire — un viewer ne peut que lire
#  13. ménage : les tâches créées ici sont désactivées puis supprimées
#
# Usage :
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

# Clés jetables, distinctes des clés par défaut : l'environnement est partagé,
# on ne touche à aucune tâche que quelqu'un d'autre aurait installée.
SIMPLE_KEY="${SIMPLE_KEY:-verify:schedule:simple}"
EXPERT_KEY="${EXPERT_KEY:-verify:schedule:expert}"
PARIS_KEY="${PARIS_KEY:-verify:schedule:paris}"

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

# Prochaine occurrence telle que BullMQ l'a calculée : le score du sorted set
# `bull:<queue>:repeat`, en millisecondes epoch. C'est la seule vérité — pas ce
# que le panel raconte, pas ce qu'on recalculerait de notre côté.
next_ms() { redis_q zscore bull:ops:repeat "$1" | tr -d '\r'; }

# Instant epoch → heure murale dans un fuseau. `node` plutôt que `date` : le
# `date` de macOS et celui de GNU ne parlent pas la même langue, et aucun des
# deux ne sait rendre une heure dans un fuseau IANA arbitraire de façon portable.
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

# Ménage systématique, y compris sur sortie en erreur : une tâche de test qui
# tourne toutes les cinq minutes pollue les logs de tout le monde.
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
  fail "« $ADMIN_EMAIL » a le rôle « ${role:-aucun} », pas « admin » — voir /admin/users"
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
  [ "$code" = "200" ] || fail "connexion impossible (HTTP $code) : $(cat "$BODY")"
  assert_admin
}

step "1. Connexion"
login
pass "connecté en tant que $ADMIN_EMAIL"

# Ménage d'une exécution précédente, avant toute chose.
for key in "$SIMPLE_KEY" "$EXPERT_KEY" "$PARIS_KEY"; do
  old=$(psql_q "select id from scheduled_jobs where key = '$key';" || true)
  [ -n "$old" ] && req DELETE "/api/jobs/$old" >/dev/null 2>&1 || true
done

step "2. Le mode simple produit l'expression cron attendue en base"
# « tous les lundis et mercredis à 04:30 » — jamais écrite à la main ici.
code=$(req POST /api/jobs "{
  \"type\":\"healthcheck\",
  \"key\":\"$SIMPLE_KEY\",
  \"schedule\":{\"kind\":\"weekly\",\"weekdays\":[1,3],\"hour\":4,\"minute\":30},
  \"enabled\":true
}")
[ "$code" = "201" ] || fail "POST /api/jobs → HTTP $code : $(cat "$BODY")"
SIMPLE_ID=$(jq -r '.id' "$BODY")
pass "tâche créée sans qu'aucune expression cron ne soit envoyée"

STORED=$(psql_q "select cron from scheduled_jobs where key = '$SIMPLE_KEY';")
[ "$STORED" = "30 4 * * 1,3" ] \
  || fail "la base contient « $STORED », attendu « 30 4 * * 1,3 »"
pass "en base : cron = « $STORED » (vérifié en SQL, pas via l'API)"

# Rien d'autre que le cron n'est persisté : pas de second format.
COLS=$(psql_q "select string_agg(column_name, ',' order by column_name)
  from information_schema.columns where table_name = 'scheduled_jobs';")
case "$COLS" in
  *schedule*|*kind*|*weekday*) fail "une colonne de périodicité simplifiée existe : $COLS" ;;
  *) pass "aucune colonne « schedule » en base — un seul format persisté" ;;
esac
info "colonnes : $COLS"

step "2b. Sans fuseau explicite, la tâche prend celui des paramètres d'instance"
code=$(req GET /api/settings)
[ "$code" = "200" ] || fail "GET /api/settings → HTTP $code"
INSTANCE_TZ=$(jq -r '.settings.timezone' "$BODY")
[ -n "$INSTANCE_TZ" ] && [ "$INSTANCE_TZ" != "null" ] \
  || fail "les paramètres d'instance n'annoncent aucun fuseau"
pass "fuseau d'instance : « $INSTANCE_TZ »"

STORED_TZ=$(psql_q "select timezone from scheduled_jobs where key = '$SIMPLE_KEY';")
[ "$STORED_TZ" = "$INSTANCE_TZ" ] \
  || fail "la tâche est en « $STORED_TZ » alors que l'instance est en « $INSTANCE_TZ »"
pass "en base : timezone = « $STORED_TZ » — le défaut n'est pas UTC en dur"

code=$(req GET /api/jobs)
API_DEFAULT_TZ=$(jq -r '.defaultTimeZone' "$BODY")
[ "$API_DEFAULT_TZ" = "$INSTANCE_TZ" ] \
  || fail "/api/jobs annonce « $API_DEFAULT_TZ » comme défaut, l'instance dit « $INSTANCE_TZ »"
pass "/api/jobs pré-remplira le formulaire avec « $API_DEFAULT_TZ »"

step "3. La relire renvoie le même mode simple"
code=$(req GET "/api/jobs/$SIMPLE_ID")
[ "$code" = "200" ] || fail "GET /api/jobs/:id → HTTP $code"
jq -e '.schedule.kind == "weekly"' "$BODY" >/dev/null \
  || fail "kind attendu « weekly », reçu $(jq -c '.schedule' "$BODY")"
jq -e '.schedule.weekdays == [1,3] and .schedule.hour == 4 and .schedule.minute == 30' "$BODY" \
  >/dev/null || fail "périodicité relue différente : $(jq -c '.schedule' "$BODY")"
pass "relecture : $(jq -c '.schedule' "$BODY")"
pass "description : $(jq -r '.cronDescription' "$BODY")"

step "4. Une expression cron invalide est refusée"
for bad in '0 99 * * *' '0 3 * *' 'tous les lundis' '*/0 * * * *'; do
  code=$(req POST /api/jobs "{\"type\":\"cleanup\",\"key\":\"verify:schedule:bad\",\"cron\":\"$bad\"}")
  [ "$code" = "422" ] || fail "« $bad » : attendu 422, reçu $code — $(cat "$BODY")"
  jq -e '.error.code == "validation_failed"' "$BODY" >/dev/null \
    || fail "code d'erreur inattendu pour « $bad » : $(jq -c '.error' "$BODY")"
done
pass "4 expressions invalides refusées en 422"

left=$(psql_q "select count(*) from scheduled_jobs where key = 'verify:schedule:bad';")
[ "$left" = "0" ] || fail "une tâche a été créée malgré le refus"
pass "rien n'a été écrit en base"

# Une périodicité simplifiée hors bornes est refusée elle aussi : le serveur ne
# fait pas plus confiance à `schedule` qu'à `cron`.
code=$(req POST /api/jobs \
  '{"type":"cleanup","key":"verify:schedule:bad","schedule":{"kind":"daily","hour":42,"minute":0}}')
[ "$code" = "422" ] || fail "périodicité hors bornes : attendu 422, reçu $code"
pass "une périodicité simplifiée hors bornes est refusée elle aussi (422)"

code=$(req POST /api/jobs \
  '{"type":"cleanup","key":"verify:schedule:bad","cron":"0 3 * * *","schedule":{"kind":"daily","hour":4,"minute":0}}')
[ "$code" = "422" ] || fail "cron ET schedule : attendu 422, reçu $code"
pass "fournir « cron » et « schedule » ensemble est refusé (422)"

# Un fuseau inventé en base ferait planter le calcul de la prochaine occurrence.
# Il est refusé à l'entrée, par le même validateur que les paramètres d'instance.
for bad_tz in 'Europe/Atlantide' 'UTC+2' 'GMT+0200' 'paris'; do
  code=$(req POST /api/jobs \
    "{\"type\":\"cleanup\",\"key\":\"verify:schedule:bad\",\"cron\":\"0 3 * * *\",\"timezone\":\"$bad_tz\"}")
  [ "$code" = "422" ] || fail "fuseau « $bad_tz » : attendu 422, reçu $code — $(cat "$BODY")"
  jq -e '.error.code == "validation_failed"' "$BODY" >/dev/null \
    || fail "code d'erreur inattendu pour « $bad_tz » : $(jq -c '.error' "$BODY")"
done
pass "4 fuseaux inventés refusés en 422"

left=$(psql_q "select count(*) from scheduled_jobs where key = 'verify:schedule:bad';")
[ "$left" = "0" ] || fail "une tâche a été créée malgré le refus de fuseau"
pass "rien n'a été écrit en base"

step "5. Une expression exotique est acceptée et bascule en mode expert"
EXOTIC='*/7 2-5 * * 1,3'
code=$(req POST /api/jobs "{
  \"type\":\"cleanup\",
  \"key\":\"$EXPERT_KEY\",
  \"cron\":\"$EXOTIC\",
  \"enabled\":true
}")
[ "$code" = "201" ] || fail "POST /api/jobs → HTTP $code : $(cat "$BODY")"
EXPERT_ID=$(jq -r '.id' "$BODY")
jq -e '.schedule == null' "$BODY" >/dev/null \
  || fail "une périodicité simple a été inventée : $(jq -c '.schedule' "$BODY")"
pass "acceptée, et « schedule »: null → l'écran s'ouvrira en mode expert"

STORED=$(psql_q "select cron from scheduled_jobs where key = '$EXPERT_KEY';")
[ "$STORED" = "$EXOTIC" ] || fail "en base : « $STORED » au lieu de « $EXOTIC »"
pass "en base : cron = « $STORED », inchangé"

DESC=$(jq -r '.cronDescription' "$BODY")
[ "$DESC" != "$EXOTIC" ] || fail "aucune description produite pour l'expression exotique"
pass "décrite quand même : « $DESC »"

step "6. Les tâches sont de vrais repeatable jobs BullMQ"
# Le worker et le panel écrivent dans la même queue ; on lit Redis directement.
KEYS=$(redis_q --scan --pattern 'bull:*repeat*' | tr -d '\r' | sort)
[ -n "$KEYS" ] || fail "aucune clé « bull:*repeat* » dans Redis"
info "clés : $(echo "$KEYS" | tr '\n' ' ')"

REPEAT_KEY=$(echo "$KEYS" | grep -E ':repeat$' | head -1)
[ -n "$REPEAT_KEY" ] || fail "pas de sorted set « bull:<queue>:repeat »"

MEMBERS=$(redis_q zrange "$REPEAT_KEY" 0 -1 | tr -d '\r')
for key in "$SIMPLE_KEY" "$EXPERT_KEY"; do
  echo "$MEMBERS" | grep -qF "$key" \
    || fail "« $key » absente de $REPEAT_KEY : $MEMBERS"
  pass "« $key » présente dans $REPEAT_KEY"
done

# Le motif stocké côté BullMQ doit être exactement celui de la base.
SCHED_HASH="${REPEAT_KEY%:repeat}:repeat:$SIMPLE_KEY"
PATTERN=$(redis_q hget "$SCHED_HASH" pattern | tr -d '\r')
[ "$PATTERN" = "30 4 * * 1,3" ] \
  || fail "BullMQ a mémorisé « $PATTERN » au lieu de « 30 4 * * 1,3 »"
pass "BullMQ a mémorisé le même motif : « $PATTERN »"

# Le fuseau aussi : sans lui, cron-parser retomberait sur celui du process.
BULL_TZ=$(redis_q hget "$SCHED_HASH" tz | tr -d '\r')
[ "$BULL_TZ" = "$INSTANCE_TZ" ] \
  || fail "BullMQ a mémorisé tz = « ${BULL_TZ:-aucun} », la base dit « $INSTANCE_TZ »"
pass "BullMQ a mémorisé le fuseau : tz = « $BULL_TZ »"

code=$(req GET /api/jobs)
jq -e --arg k "$SIMPLE_KEY" \
  '[.items[] | select(.key == $k)] | .[0].installed == true and .[0].nextRunAt != null' \
  "$BODY" >/dev/null || fail "l'API ne voit pas le scheduler installé"
pass "prochaine occurrence calculée par BullMQ : $(jq -r --arg k "$SIMPLE_KEY" '[.items[] | select(.key == $k)] | .[0].nextRunAt' "$BODY")"

step "7. « Tous les jours à 3 h » en Europe/Paris ne tombe PAS à 03:00 UTC"
# Le cœur du sujet. Aucune expression cron n'est écrite ici : on demande une
# périodicité simple et un fuseau, exactement comme le formulaire le fait.
code=$(req POST /api/jobs "{
  \"type\":\"cleanup\",
  \"key\":\"$PARIS_KEY\",
  \"schedule\":{\"kind\":\"daily\",\"hour\":3,\"minute\":0},
  \"timezone\":\"Europe/Paris\",
  \"enabled\":true
}")
[ "$code" = "201" ] || fail "POST /api/jobs → HTTP $code : $(cat "$BODY")"
PARIS_ID=$(jq -r '.id' "$BODY")
pass "tâche « $PARIS_KEY » créée : tous les jours à 03:00, fuseau Europe/Paris"

STORED=$(psql_q "select cron || ' | ' || timezone from scheduled_jobs where key = '$PARIS_KEY';")
[ "$STORED" = "0 3 * * * | Europe/Paris" ] \
  || fail "en base : « $STORED », attendu « 0 3 * * * | Europe/Paris »"
pass "en base : « $STORED »"

PARIS_HASH="${REPEAT_KEY%:repeat}:repeat:$PARIS_KEY"
BULL_TZ=$(redis_q hget "$PARIS_HASH" tz | tr -d '\r')
[ "$BULL_TZ" = "Europe/Paris" ] \
  || fail "BullMQ a mémorisé tz = « ${BULL_TZ:-aucun} » au lieu de « Europe/Paris »"
pass "BullMQ a mémorisé tz = « $BULL_TZ » (lu dans $PARIS_HASH)"

PARIS_MS=$(next_ms "$PARIS_KEY")
[ -n "$PARIS_MS" ] || fail "aucune prochaine occurrence dans bull:ops:repeat pour « $PARIS_KEY »"
PARIS_UTC=$(hhmm_in "$PARIS_MS" UTC)
PARIS_LOCAL=$(hhmm_in "$PARIS_MS" Europe/Paris)
info "prochaine occurrence : $(fmt_in "$PARIS_MS" UTC) UTC = $(fmt_in "$PARIS_MS" Europe/Paris) Europe/Paris"

# 01:00 UTC en heure d'été (UTC+2), 02:00 UTC en heure d'hiver (UTC+1).
case "$PARIS_UTC" in
  01:00) pass "prochaine occurrence à 01:00 UTC — heure d'été à Paris (UTC+2)" ;;
  02:00) pass "prochaine occurrence à 02:00 UTC — heure d'hiver à Paris (UTC+1)" ;;
  03:00) fail "prochaine occurrence à 03:00 UTC : le fuseau n'est PAS appliqué, c'est le bug" ;;
  *)     fail "prochaine occurrence à $PARIS_UTC UTC — ni 01:00 ni 02:00, incohérent" ;;
esac

[ "$PARIS_LOCAL" = "03:00" ] \
  || fail "à Paris, cette occurrence tombe à $PARIS_LOCAL, pas à 03:00"
pass "et à Paris, elle tombe bien à $PARIS_LOCAL — l'heure demandée"

step "8. Changer le fuseau REPROGRAMME la prochaine occurrence"
# Prouvé dans Redis, pas déduit : un `upsertJobScheduler` avec la même clé et un
# `tz` différent doit réécrire le score du sorted set, pas le laisser tel quel.
BEFORE_MS="$PARIS_MS"
code=$(req PATCH "/api/jobs/$PARIS_ID" '{"timezone":"Asia/Tokyo"}')
[ "$code" = "200" ] || fail "PATCH { timezone } → HTTP $code : $(cat "$BODY")"
jq -e '.timeZone == "Asia/Tokyo" and .cron == "0 3 * * *"' "$BODY" >/dev/null \
  || fail "réponse inattendue : $(jq -c '{cron, timeZone}' "$BODY")"
pass "PATCH { timezone: Asia/Tokyo } accepté, cadence inchangée"

STORED=$(psql_q "select timezone from scheduled_jobs where key = '$PARIS_KEY';")
[ "$STORED" = "Asia/Tokyo" ] || fail "en base : « $STORED »"
pass "en base : timezone = « $STORED »"

BULL_TZ=$(redis_q hget "$PARIS_HASH" tz | tr -d '\r')
[ "$BULL_TZ" = "Asia/Tokyo" ] \
  || fail "BullMQ a gardé tz = « ${BULL_TZ:-aucun} » : le scheduler n'a pas suivi"
pass "BullMQ a suivi : tz = « $BULL_TZ »"

AFTER_MS=$(next_ms "$PARIS_KEY")
[ -n "$AFTER_MS" ] || fail "plus de prochaine occurrence après le changement de fuseau"
info "avant : $(fmt_in "$BEFORE_MS" UTC) UTC — après : $(fmt_in "$AFTER_MS" UTC) UTC"
[ "$AFTER_MS" != "$BEFORE_MS" ] \
  || fail "la prochaine occurrence n'a pas bougé ($BEFORE_MS) : BullMQ n'a pas reprogrammé"
pass "la prochaine occurrence a été recalculée : $BEFORE_MS → $AFTER_MS"

TOKYO_LOCAL=$(hhmm_in "$AFTER_MS" Asia/Tokyo)
[ "$TOKYO_LOCAL" = "03:00" ] \
  || fail "à Tokyo, cette occurrence tombe à $TOKYO_LOCAL, pas à 03:00"
pass "et elle tombe bien à $TOKYO_LOCAL à Tokyo — c'est le nouveau fuseau qui décide"

# Le motif, lui, n'a pas été touché : on n'a changé qu'un réglage.
PATTERN=$(redis_q hget "$PARIS_HASH" pattern | tr -d '\r')
[ "$PATTERN" = "0 3 * * *" ] || fail "le motif a changé tout seul : « $PATTERN »"
pass "le motif est resté « $PATTERN »"

# Un fuseau inventé sur une tâche existante est refusé lui aussi, et ne modifie rien.
code=$(req PATCH "/api/jobs/$PARIS_ID" '{"timezone":"Europe/Atlantide"}')
[ "$code" = "422" ] || fail "fuseau inventé en PATCH : attendu 422, reçu $code"
STORED=$(psql_q "select timezone from scheduled_jobs where key = '$PARIS_KEY';")
[ "$STORED" = "Asia/Tokyo" ] || fail "le fuseau a bougé malgré le refus : « $STORED »"
pass "un fuseau inventé en PATCH est refusé (422) et ne modifie rien"

step "9. Les tâches antérieures à la migration 0009 sont restées en UTC"
# `health:periodic` et `scan:periodic` ont été installées quand le motif partait
# à BullMQ sans `tz`, donc interprété en UTC. La migration a posé `UTC` sur ces
# lignes — pas le fuseau d'instance — pour ne pas déplacer une exécution que
# personne n'a demandé à changer.
LEGACY_SEEN=0
for key in health:periodic scan:periodic; do
  row=$(psql_q "select cron || '|' || timezone from scheduled_jobs where key = '$key';")
  if [ -z "$row" ]; then
    info "« $key » absente de cette instance — rien à vérifier"
    continue
  fi
  LEGACY_SEEN=$((LEGACY_SEEN + 1))
  legacy_cron="${row%%|*}"
  legacy_tz="${row##*|}"
  [ "$legacy_tz" = "UTC" ] \
    || fail "« $key » est en « $legacy_tz » : la migration a déplacé une tâche existante"
  pass "« $key » ($legacy_cron) toujours en UTC — comportement préservé"

  bull_tz=$(redis_q hget "${REPEAT_KEY%:repeat}:repeat:$key" tz | tr -d '\r')
  [ "$bull_tz" = "UTC" ] || fail "BullMQ interprète « $key » en « ${bull_tz:-aucun} »"

  ms=$(next_ms "$key")
  [ -n "$ms" ] || fail "« $key » n'a pas de prochaine occurrence dans BullMQ"
  # Sur un cron « M H * * * », la prochaine occurrence doit tomber à H:M UTC —
  # exactement là où elle tombait avant la migration.
  if printf '%s' "$legacy_cron" | grep -qE '^[0-9]+ [0-9]+ \* \* \*$'; then
    expected=$(printf '%02d:%02d' "$(printf '%s' "$legacy_cron" | cut -d' ' -f2)" \
                                  "$(printf '%s' "$legacy_cron" | cut -d' ' -f1)")
    actual=$(hhmm_in "$ms" UTC)
    [ "$actual" = "$expected" ] \
      || fail "« $key » : prochaine occurrence à $actual UTC, attendu $expected UTC"
    pass "« $key » : prochaine occurrence à $actual UTC — inchangée"
  else
    info "« $key » : $(fmt_in "$ms" UTC) UTC (cadence non horaire, pas d'heure fixe à comparer)"
  fi
done
[ "$LEGACY_SEEN" -gt 0 ] \
  && info "$LEGACY_SEEN tâche(s) préexistante(s) vérifiée(s)" \
  || info "aucune tâche préexistante sur cette instance"

step "10. Modifier la cadence en mode simple"
code=$(req PATCH "/api/jobs/$SIMPLE_ID" \
  '{"schedule":{"kind":"interval","everyMinutes":30}}')
[ "$code" = "200" ] || fail "PATCH → HTTP $code : $(cat "$BODY")"
jq -e '.cron == "*/30 * * * *"' "$BODY" >/dev/null \
  || fail "cron rendu : $(jq -r .cron "$BODY")"
pass "PATCH { schedule: interval 30 min } → cron « */30 * * * * »"

STORED=$(psql_q "select cron from scheduled_jobs where key = '$SIMPLE_KEY';")
[ "$STORED" = "*/30 * * * *" ] || fail "en base : « $STORED »"
pass "en base : « $STORED »"

PATTERN=$(redis_q hget "$SCHED_HASH" pattern | tr -d '\r')
[ "$PATTERN" = "*/30 * * * *" ] || fail "BullMQ n'a pas suivi : « $PATTERN »"
pass "BullMQ a suivi : « $PATTERN »"

jq -e '.schedule.kind == "interval" and .schedule.everyMinutes == 30' "$BODY" >/dev/null \
  || fail "relecture simplifiée fausse : $(jq -c '.schedule' "$BODY")"
pass "relue en mode simple : $(jq -c '.schedule' "$BODY")"

step "11. Le fuseau du process n'entre plus en jeu"
TZ_PANEL=$(docker compose exec -T panel node -e \
  'process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone)' | tr -d '\r')
TZ_WORKER=$(docker compose exec -T worker node -e \
  'process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone)' | tr -d '\r')
info "panel : $TZ_PANEL — worker : $TZ_WORKER (aucune variable TZ dans les conteneurs)"

# La tâche de l'étape 8 est en Asia/Tokyo. Si le fuseau du process comptait
# encore, sa prochaine occurrence tomberait à 03:00 dans CE fuseau-là.
TOKYO_MS=$(next_ms "$PARIS_KEY")
IN_PROC=$(hhmm_in "$TOKYO_MS" "$TZ_PANEL")
[ "$IN_PROC" != "03:00" ] || fail "l'occurrence tombe à 03:00 $TZ_PANEL : le fuseau du process décide encore"
pass "« $PARIS_KEY » tombe à $IN_PROC dans le fuseau du process, 03:00 dans le sien"

# Aucun scheduler installé ne doit rester sans `tz`, ni en désaccord avec sa
# ligne : c'est exactement l'écart que le worker corrige au démarrage.
DRIFT=0
while IFS='|' read -r jkey jtz; do
  [ -n "$jkey" ] || continue
  btz=$(redis_q hget "${REPEAT_KEY%:repeat}:repeat:$jkey" tz | tr -d '\r')
  if [ "$btz" != "$jtz" ]; then
    printf '    \033[31m%s\033[0m\n' "« $jkey » : base « $jtz », BullMQ « ${btz:-aucun} »"
    DRIFT=$((DRIFT + 1))
  fi
done <<< "$(psql_q "select key || '|' || timezone from scheduled_jobs where enabled;")"
[ "$DRIFT" = "0" ] || fail "$DRIFT scheduler(s) en désaccord de fuseau avec la base"
pass "toutes les tâches actives : base et BullMQ s'accordent sur le fuseau"

step "12. job:manage est requis pour écrire"
code=$(req POST /api/admin/users \
  "{\"name\":\"Viewer planning\",\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\",\"role\":\"viewer\"}")
case "$code" in
  201) pass "utilisateur viewer créé" ;;
  409) pass "utilisateur viewer déjà présent" ;;
  *)   fail "POST /api/admin/users → HTTP $code : $(cat "$BODY")" ;;
esac
VIEWER_ID=$(psql_q "select id from users where email = '$VIEWER_EMAIL';")

for _ in 1 2 3 4 5; do
  code=$(vreq POST /api/auth/sign-in/email \
    "{\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\"}")
  [ "$code" = "429" ] || break
  sleep 6
done
[ "$code" = "200" ] || fail "connexion viewer impossible (HTTP $code) : $(cat "$BODY")"
pass "connecté en tant que $VIEWER_EMAIL"

code=$(vreq GET /api/jobs)
[ "$code" = "200" ] || fail "un viewer doit pouvoir lire (job:read) — HTTP $code"
pass "lecture autorisée (job:read)"

code=$(vreq POST /api/jobs \
  '{"type":"cleanup","key":"verify:schedule:viewer","schedule":{"kind":"daily","hour":5,"minute":0}}')
[ "$code" = "403" ] || fail "création par un viewer : attendu 403, reçu $code"
jq -e '.error.details.permission == "job:manage"' "$BODY" >/dev/null \
  || fail "la permission manquante n'est pas nommée : $(jq -c '.error' "$BODY")"
pass "création refusée → 403, permission « job:manage »"

code=$(vreq PATCH "/api/jobs/$SIMPLE_ID" '{"schedule":{"kind":"hourly","minute":0}}')
[ "$code" = "403" ] || fail "modification par un viewer : attendu 403, reçu $code"
pass "modification refusée → 403"

code=$(vreq DELETE "/api/jobs/$SIMPLE_ID")
[ "$code" = "403" ] || fail "suppression par un viewer : attendu 403, reçu $code"
pass "suppression refusée → 403"

STORED=$(psql_q "select cron from scheduled_jobs where key = '$SIMPLE_KEY';")
[ "$STORED" = "*/30 * * * *" ] || fail "la cadence a bougé malgré les refus : « $STORED »"
pass "la cadence n'a pas bougé : « $STORED »"

step "13. Traçabilité"
code=$(req GET "/api/audit-logs?resourceType=scheduled_job&pageSize=20")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
for action in schedule.created schedule.updated; do
  jq -e --arg a "$action" '[.items[] | select(.action == $a)] | length > 0' "$BODY" >/dev/null \
    || fail "action « $action » absente du journal d'audit"
  pass "audit : $action"
done

step "14. Ménage"
for key in "$SIMPLE_KEY:$SIMPLE_ID" "$EXPERT_KEY:$EXPERT_ID" "$PARIS_KEY:$PARIS_ID"; do
  name="${key%:*}"
  id="${key##*:}"
  code=$(req PATCH "/api/jobs/$id" '{"enabled":false}')
  [ "$code" = "200" ] || fail "désactivation de « $name » → HTTP $code"
  pass "« $name » désactivée"

  code=$(req DELETE "/api/jobs/$id")
  [ "$code" = "204" ] || fail "suppression de « $name » → HTTP $code"
  pass "« $name » supprimée"
done

MEMBERS=$(redis_q zrange "$REPEAT_KEY" 0 -1 | tr -d '\r')
for name in "$SIMPLE_KEY" "$EXPERT_KEY" "$PARIS_KEY"; do
  echo "$MEMBERS" | grep -qF "$name" \
    && fail "« $name » traîne encore dans BullMQ : $MEMBERS"
done
pass "aucune des trois ne traîne dans BullMQ"

left=$(psql_q "select count(*) from scheduled_jobs where key like 'verify:schedule:%';")
[ "$left" = "0" ] || fail "$left tâche(s) de test subsiste(nt) en base"
pass "aucune tâche de test en base"

[ -n "$VIEWER_ID" ] && req DELETE "/api/admin/users/$VIEWER_ID" >/dev/null 2>&1 || true
pass "utilisateur de test supprimé"

printf '\n\033[32m✓ Saisie simplifiée et fuseau des tâches planifiées vérifiés.\033[0m\n'
printf '\033[2m  Écran : %s/jobs — fuseau par défaut des nouvelles tâches : %s\033[0m\n\n' \
  "$BASE_URL" "$INSTANCE_TZ"
