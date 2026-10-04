#!/usr/bin/env bash
#
# Vérifie la supervision par serveur :
#
#   1. le relevé d'une cible joignable rend des métriques COHÉRENTES —
#      recoupées avec la machine elle-même (nproc, /proc/loadavg, /proc/meminfo)
#   2. une métrique manquante rend `null`, jamais zéro, et n'emporte pas le reste
#   3. une cible INJOIGNABLE rend un relevé en erreur explicite,
#      et ses applications restent listées
#   4. l'écran groupe par serveur : une application apparaît sous sa cible,
#      et sous elle seule
#   5. `target:read` est requis pour relever une machine
#   6. le relevé passe par la FILE, pas par une session SSH ouverte du panel
#
# Prérequis : une cible Docker déployable — `./scripts/setup-test-target.sh`
# en provisionne une. Le script crée sa propre application et sa propre cible
# morte, et les supprime toutes les deux à la fin.
#
# Usage :
#   ./scripts/verify-server-supervision.sh
#   BASE_URL=http://localhost:3100 TARGET_NAME=ma-vm ./scripts/verify-server-supervision.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
CLIENT_IP="${CLIENT_IP:-198.51.100.42}"
TARGET_NAME="${TARGET_NAME:-cible-de-verification}"
# Conteneur docker-in-docker qui porte la cible : c'est lui qu'on interroge
# directement pour recouper le relevé, et sur lui qu'on cache une commande.
TARGET_SERVICE="${TARGET_SERVICE:-ssh-target}"

# Matière propre au script. Rien de ce qui existait déjà n'est touché.
APP_NAME="${APP_NAME:-verif-supervision-serveur}"
DEAD_TARGET_NAME="${DEAD_TARGET_NAME:-verif-supervision-injoignable}"
# TEST-NET-3 (RFC 5737) : documentée comme non routable, donc injoignable
# partout et pour toujours — pas un hôte de quelqu'un d'autre qu'on irait sonder.
DEAD_HOST="${DEAD_HOST:-203.0.113.10}"
# Seconde adresse morte, pour couper temporairement la cible qui porte
# l'application : `targets` impose l'unicité de (host, port, ssh_user), et
# réutiliser la première ferait échouer la bascule sur une contrainte.
DEAD_HOST_FLIP="${DEAD_HOST_FLIP:-203.0.113.11}"
ROLE_KEY="${ROLE_KEY:-verif-supervision-sans-cible}"
VIEWER_EMAIL="${VIEWER_EMAIL:-supervision-sans-cible@example.test}"
VIEWER_PASSWORD="${VIEWER_PASSWORD:-motdepasse-tres-long}"
IMAGE_OK="${IMAGE_OK:-docker.io/library/nginx:1.29-alpine}"
KEY_PATH="${KEY_PATH:-.test-target-key}"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
VIEWER_JAR="$WORK/viewer.jar"
BODY="$WORK/body.json"
HTML="$WORK/apps.html"

# Ce que le script a modifié sur la machine ou en base, et qu'il doit rendre
# tel qu'il l'a trouvé même s'il meurt en route. Chaque entrée est « nom|chemin » :
# `df` vit dans /bin et `nproc` dans /usr/bin, les remettre au même endroit
# n'est pas une supposition qu'on peut se permettre.
HIDDEN=''
ORIGINAL_HOST=''
TARGET_ID=''

restore_all() {
  local entry name path
  for entry in $HIDDEN; do
    name="${entry%%|*}"
    path="${entry#*|}"
    docker compose exec -T "$TARGET_SERVICE" \
      sh -lc "[ -f /tmp/$name.hidden ] && mv /tmp/$name.hidden '$path'" >/dev/null 2>&1 || true
  done
  if [ -n "$ORIGINAL_HOST" ] && [ -n "$TARGET_ID" ]; then
    docker compose exec -T postgres psql -U tp -d tp -tAc \
      "update targets set host = '$ORIGINAL_HOST' where id = '$TARGET_ID';" >/dev/null 2>&1 || true
  fi
}

trap 'restore_all; rm -rf "$WORK"' EXIT

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

# Commande exécutée SUR la machine cible, pour recouper le relevé.
on_target() { docker compose exec -T "$TARGET_SERVICE" sh -lc "$1" | tr -d '\r'; }

assert_admin() {
  local role
  role=$(jq -r '.user.role // empty' "$BODY")
  [ "$role" = "admin" ] && return 0
  fail "« $ADMIN_EMAIL » a le rôle « ${role:-aucun} », pas « admin » — voir /admin/users"
}

# Better Auth limite les connexions répétées depuis une même IP. Les scripts de
# vérification s'enchaînent : on patiente plutôt que de retomber par erreur sur
# l'inscription, qui donnerait un message trompeur.
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

# Relève une cible et laisse le rapport dans $BODY. Écho : le code HTTP.
metrics() { req GET "/api/targets/$1/metrics"; }

# Cache une commande sur la machine cible, pour éprouver le chemin « absente ».
hide_command() {
  local name="$1" path
  path=$(on_target "command -v $name")
  [ -n "$path" ] || fail "« $name » est déjà absent de la cible — rien à éprouver"
  on_target "mv '$path' /tmp/$name.hidden" >/dev/null
  HIDDEN="$HIDDEN $name|$path"
}

restore_command() {
  local name="$1" entry path=''
  for entry in $HIDDEN; do
    if [ "${entry%%|*}" = "$name" ]; then path="${entry#*|}"; fi
  done
  [ -n "$path" ] || fail "« $name » n'a pas été caché par ce script"
  on_target "mv /tmp/$name.hidden '$path'" >/dev/null
  HIDDEN=$(printf '%s' "$HIDDEN" | sed "s#[[:space:]]*$name|[^ ]*##")
}

# Découpe la page /apps en sections par serveur et rend celle de la cible donnée.
#
# L'attribut n'existe sous cette forme littérale que dans le DOM : dans la
# charge RSC embarquée plus bas, il est sérialisé en JSON échappé
# (`\"data-server-id\":\"…\"`). Le découpage ne peut donc pas se tromper de moitié.
server_section() {
  awk -v RS='data-server-id="' -v id="$1" 'index($0, id) == 1 { print; exit }' "$HTML"
}

step "1. Connexion"
login
pass "connecté en tant que $ADMIN_EMAIL"

step "2. Prérequis"
# `grep -q` ferme le tuyau au premier succès : sous `pipefail`, le producteur
# meurt d'un SIGPIPE et fait échouer tout le pipeline. On matérialise donc la
# sortie avant de la filtrer, ici comme partout ailleurs dans ce script.
RUNNING=$(docker compose ps --format '{{.Service}}' 2>/dev/null || true)
printf '%s\n' "$RUNNING" | grep -qx "$TARGET_SERVICE" \
  || fail "le conteneur « $TARGET_SERVICE » ne tourne pas — lancez ./scripts/setup-test-target.sh"

code=$(req GET /api/targets)
[ "$code" = "200" ] || fail "GET /api/targets → HTTP $code"
TARGET_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY" | head -1)
[ -n "$TARGET_ID" ] || fail "cible « $TARGET_NAME » introuvable — lancez ./scripts/setup-test-target.sh"
ORIGINAL_HOST=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .host' "$BODY" | head -1)
pass "cible « $TARGET_NAME » — $TARGET_ID ($ORIGINAL_HOST)"

# Une seconde cible enregistrée sert de témoin au test de regroupement : une
# application ne doit apparaître que sous la sienne.
WITNESS_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name != $n) | .id' "$BODY" | head -1)


# Ménage d'une exécution précédente interrompue. Entièrement « au mieux » :
# rien de ce qu'elle fait n'est un critère, elle remet seulement le terrain à plat.
precleanup() {
  local ids id
  req GET /api/apps >/dev/null || true
  ids=$(jq -r --arg s "$APP_NAME" '.items[] | select(.applicationSlug == $s) | .id' "$BODY" 2>/dev/null || true)
  for id in $ids; do
    info "reste d'une exécution précédente : déploiement $id — destruction"
    req DELETE "/api/deployments/$id" >/dev/null || true
    for _ in $(seq 1 90); do
      sleep 2
      req GET "/api/deployments/$id" >/dev/null || true
      if [ "$(jq -r '.status // ""' "$BODY")" = "destroyed" ]; then break; fi
    done
    req DELETE "/api/deployments/$id/purge" >/dev/null || true
  done

  req GET /api/applications >/dev/null || true
  id=$(jq -r --arg s "$APP_NAME" '.items[] | select(.slug == $s) | .id' "$BODY" 2>/dev/null | head -1)
  if [ -n "$id" ]; then req DELETE "/api/applications/$id" >/dev/null || true; fi

  req GET /api/targets >/dev/null || true
  id=$(jq -r --arg n "$DEAD_TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY" 2>/dev/null | head -1)
  if [ -n "$id" ]; then req DELETE "/api/targets/$id" >/dev/null || true; fi

  id=$(psql_q "select id from users where email = '$VIEWER_EMAIL';" 2>/dev/null || true)
  if [ -n "$id" ]; then req DELETE "/api/admin/users/$id" >/dev/null || true; fi
  req DELETE "/api/admin/roles/$ROLE_KEY" >/dev/null 2>&1 || true
}

step "3. Matière : une application déployée sur la cible"
precleanup

# Photo de départ, prise APRÈS le ménage : à la fin du script, elle doit être identique.
req GET /api/apps >/dev/null
LIVE_BEFORE=$(jq -r '[.items[].applicationSlug] | sort | join(",")' "$BODY")
info "applications en marche avant le test : ${LIVE_BEFORE:-aucune}"

jq -n --arg n "$APP_NAME" --arg i "$IMAGE_OK" \
  '{appSpec:{name:$n, version:"1.0.0", services:[{
      name:"web", source:{type:"image", ref:$i}, port:80, exposed:true,
      healthcheck:{path:"/", intervalSec:2, timeoutSec:3, retries:4}}]}}' > "$WORK/app.json"

req GET /api/applications >/dev/null
APP_ID=$(jq -r --arg s "$APP_NAME" '.items[] | select(.slug == $s) | .id' "$BODY" | head -1)
if [ -n "$APP_ID" ]; then
  code=$(req PATCH "/api/applications/$APP_ID" "@$WORK/app.json")
  [ "$code" = "200" ] || fail "PATCH /api/applications/$APP_ID → HTTP $code : $(cat "$BODY")"
else
  code=$(req POST /api/applications "@$WORK/app.json")
  [ "$code" = "201" ] || fail "POST /api/applications → HTTP $code : $(cat "$BODY")"
  APP_ID=$(jq -r .id "$BODY")
fi
APP_SLUG=$(jq -r '.slug' "$BODY")
pass "application « $APP_SLUG » ($APP_ID)"

code=$(req POST /api/deployments \
  "{\"applicationId\":\"$APP_ID\",\"targetId\":\"$TARGET_ID\",\"runtime\":\"docker\",\"proxy\":\"traefik\",\"autoRollback\":false}")
[ "$code" = "202" ] || fail "POST /api/deployments → HTTP $code : $(cat "$BODY")"
DEP_ID=$(jq -r .id "$BODY")

DEP_STATUS=''
for _ in $(seq 1 150); do
  sleep 2
  req GET "/api/deployments/$DEP_ID" >/dev/null
  DEP_STATUS=$(jq -r .status "$BODY")
  case "$DEP_STATUS" in success|failed|rolled_back|destroyed) break ;; esac
done
[ "$DEP_STATUS" = "success" ] \
  || fail "le déploiement $DEP_ID a fini en « $DEP_STATUS » : $(jq -r '.error // ""' "$BODY")"
pass "déploiement $DEP_ID en marche"

step "4. Un relevé cohérent, recoupé avec la machine"
code=$(metrics "$TARGET_ID")
[ "$code" = "200" ] || fail "GET /api/targets/$TARGET_ID/metrics → HTTP $code : $(cat "$BODY")"
cp "$BODY" "$WORK/metrics.json"
jq -e '.reachable == true' "$BODY" >/dev/null || fail "la cible est annoncée injoignable"
pass "relevé pris en $(jq -r '.latencyMs' "$BODY") ms de latence SSH"

# ── cœurs : valeur exacte, sinon la charge n'est comparable à rien
REAL_CORES=$(on_target 'nproc')
API_CORES=$(jq -r '.load.cores' "$BODY")
[ "$API_CORES" = "$REAL_CORES" ] || fail "cœurs : le relevé dit $API_CORES, la machine dit $REAL_CORES"
pass "cœurs : $API_CORES — identique à « nproc » sur la machine"

# ── charge : une valeur qui bouge entre deux lectures, on vérifie l'ordre de grandeur
REAL_LOAD=$(on_target 'cat /proc/loadavg' | awk '{print $1}')
API_LOAD=$(jq -r '.load.one' "$BODY")
awk -v a="$API_LOAD" -v b="$REAL_LOAD" 'BEGIN { exit !(a >= 0 && b >= 0 && (a - b < 2) && (b - a < 2)) }' \
  || fail "charge : le relevé dit $API_LOAD, la machine dit $REAL_LOAD — écart trop grand"
pass "charge 1 min : $API_LOAD (machine : $REAL_LOAD) — /proc/loadavg concorde"

# ── la charge rapportée aux cœurs, qui est la seule valeur comparable
API_PER_CORE=$(jq -r '.load.perCore' "$BODY")
awk -v p="$API_PER_CORE" -v l="$API_LOAD" -v c="$API_CORES" \
  'BEGIN { d = p - l / c; if (d < 0) d = -d; exit !(d < 0.01) }' \
  || fail "perCore ($API_PER_CORE) ne vaut pas charge/cœurs ($API_LOAD/$API_CORES)"
pass "charge par cœur : $API_PER_CORE — soit $API_LOAD ÷ $API_CORES"

# ── mémoire : MemTotal est stable, on l'exige au kibioctet près
REAL_MEMTOTAL=$(on_target 'cat /proc/meminfo' | awk '/^MemTotal:/ {print $2}')
API_MEMTOTAL=$(jq -r '.memory.totalKb' "$BODY")
[ "$API_MEMTOTAL" = "$REAL_MEMTOTAL" ] \
  || fail "MemTotal : le relevé dit $API_MEMTOTAL kB, la machine dit $REAL_MEMTOTAL kB"
pass "MemTotal : $API_MEMTOTAL kB — identique à /proc/meminfo"

# `MemAvailable` et pas `MemFree` : sur Linux la mémoire « libre » est du cache.
jq -e '.memory.availableKb > 0 and .memory.usedKb == (.memory.totalKb - .memory.availableKb)' \
  "$BODY" >/dev/null || fail "la mémoire utilisée ne dérive pas de MemAvailable"
pass "utilisée = MemTotal − MemAvailable ($(jq -r '.memory.usedPercent' "$BODY") %)"

# ── disque : la partition qui porte les déploiements, pas seulement `/`
API_DISK_PATH=$(jq -r '.disk.path' "$BODY")
REAL_DF=$(on_target "df -Pk '$API_DISK_PATH'" | tail -1 | awk '{print $2}')
API_DISK_SIZE=$(jq -r '.disk.sizeKb' "$BODY")
[ "$API_DISK_SIZE" = "$REAL_DF" ] \
  || fail "disque : le relevé dit $API_DISK_SIZE kB, « df -Pk $API_DISK_PATH » dit $REAL_DF kB"
pass "disque « $API_DISK_PATH » : $API_DISK_SIZE kB — identique à df -Pk"

# ── uptime et noyau
REAL_UPTIME=$(on_target 'cat /proc/uptime' | awk '{printf "%d", $1}')
API_UPTIME=$(jq -r '.uptimeSeconds' "$BODY")
awk -v a="$API_UPTIME" -v b="$REAL_UPTIME" 'BEGIN { d = a - b; if (d < 0) d = -d; exit !(d < 120) }' \
  || fail "uptime : le relevé dit $API_UPTIME s, la machine dit $REAL_UPTIME s"
pass "uptime : $API_UPTIME s (machine : $REAL_UPTIME s)"

REAL_KERNEL=$(on_target 'uname -r')
API_KERNEL=$(jq -r '.os.kernel' "$BODY")
[ "$API_KERNEL" = "$REAL_KERNEL" ] || fail "noyau : « $API_KERNEL » ≠ « $REAL_KERNEL »"
pass "noyau : $API_KERNEL — $(jq -r '.os.prettyName' "$BODY")"

jq -e '[.probes[] | select(.status == "failed")] | length == 0' "$BODY" >/dev/null \
  || fail "un relevé a échoué : $(jq -c '[.probes[] | select(.status == "failed")]' "$BODY")"
pass "les $(jq -r '.probes | length' "$BODY") relevés sont passés"

step "5. Une métrique manquante rend « null », pas zéro"
hide_command nproc
code=$(metrics "$TARGET_ID")
[ "$code" = "200" ] || fail "GET metrics sans nproc → HTTP $code : $(cat "$BODY")"

jq -e '.load.cores == null' "$BODY" >/dev/null \
  || fail "cœurs : attendu null, reçu $(jq -c '.load.cores' "$BODY")"
jq -e '.load.perCore == null' "$BODY" >/dev/null \
  || fail "perCore : attendu null, reçu $(jq -c '.load.perCore' "$BODY")"
pass "sans « nproc » : cores = null et perCore = null — pas 0, pas 1"

jq -e '.load.one >= 0 and .memory != null and .disk != null and .uptimeSeconds != null' "$BODY" \
  >/dev/null || fail "le relevé entier a été emporté par l'absence de nproc"
pass "le reste du relevé survit — charge $(jq -r '.load.one' "$BODY"), mémoire, disque, uptime"

jq -e '[.probes[] | select(.key == "cpu")] | .[0].status == "failed" and (.[0].error | test("nproc"))' \
  "$BODY" >/dev/null || fail "le relevé « cpu » ne dit pas pourquoi il a échoué"
pass "la raison est dite : $(jq -r '[.probes[] | select(.key == "cpu")] | .[0].error' "$BODY")"

restore_command nproc

# Même épreuve sur le disque : une commande absente ne doit jamais devenir « 0 % ».
hide_command df
code=$(metrics "$TARGET_ID")
[ "$code" = "200" ] || fail "GET metrics sans df → HTTP $code"
jq -e '.disk == null' "$BODY" >/dev/null \
  || fail "disque : attendu null, reçu $(jq -c '.disk' "$BODY")"
jq -e '.memory != null and .load != null' "$BODY" >/dev/null \
  || fail "l'absence de df a emporté la mémoire ou la charge"
pass "sans « df » : disk = null, mémoire et charge intactes"
restore_command df

code=$(metrics "$TARGET_ID")
jq -e '.load.cores != null and .disk != null' "$BODY" >/dev/null \
  || fail "les commandes n'ont pas été rendues à la machine"
pass "commandes restaurées, relevé de nouveau complet"

step "6. Une cible injoignable"
# a) une cible qui n'a jamais répondu
jq -n --arg n "$DEAD_TARGET_NAME" --arg h "$DEAD_HOST" --arg key "$(cat "$KEY_PATH")" \
  '{name:$n, host:$h, port:22, sshUser:"tp", authMethod:"key", sudoMethod:"nopasswd",
    credential:$key, labels:{env:"test"}, portRangeStart:30000, portRangeEnd:30009}' \
  > "$WORK/dead.json"
req GET /api/targets >/dev/null
DEAD_ID=$(jq -r --arg n "$DEAD_TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY" | head -1)
if [ -z "$DEAD_ID" ]; then
  code=$(req POST /api/targets "@$WORK/dead.json")
  [ "$code" = "201" ] || fail "POST /api/targets → HTTP $code : $(cat "$BODY")"
  DEAD_ID=$(jq -r .id "$BODY")
fi
pass "cible morte « $DEAD_TARGET_NAME » ($DEAD_HOST) — $DEAD_ID"

code=$(metrics "$DEAD_ID")
[ "$code" = "200" ] || fail "une cible injoignable doit rendre 200 avec un rapport, pas $code"
jq -e '.reachable == false and (.error | length > 0)' "$BODY" >/dev/null \
  || fail "le rapport ne dit pas pourquoi : $(cat "$BODY")"
jq -e '.load == null and .memory == null and .disk == null and .uptimeSeconds == null' "$BODY" \
  >/dev/null || fail "une cible injoignable a rendu des métriques"
pass "relevé en erreur explicite : $(jq -r '.error' "$BODY")"

# b) la cible QUI PORTE l'application devient injoignable
#    (bascule en base : changer l'hôte par l'API réencoderait le credential
#    pour rien, alors qu'on veut exactement la même cible à une adresse morte)
psql_q "update targets set host = '$DEAD_HOST_FLIP' where id = '$TARGET_ID';" >/dev/null
pass "« $TARGET_NAME » pointe temporairement sur $DEAD_HOST_FLIP"

code=$(metrics "$TARGET_ID")
[ "$code" = "200" ] || fail "GET metrics sur cible coupée → HTTP $code"
jq -e '.reachable == false' "$BODY" >/dev/null || fail "la cible coupée est annoncée joignable"
pass "relevé impossible, et le rapport le dit : $(jq -r '.error' "$BODY")"

code=$(req GET /api/apps)
[ "$code" = "200" ] || fail "GET /api/apps → HTTP $code"
jq -e --arg id "$DEP_ID" '[.items[] | select(.id == $id)] | length == 1' "$BODY" >/dev/null \
  || fail "l'application a disparu de la supervision parce que sa machine ne répond plus"
pass "l'application « $APP_SLUG » reste listée alors que sa machine ne répond plus"

curl -s -b "$JAR" -c "$JAR" "$BASE_URL/apps" -o "$HTML"
printf '%s\n' "$(server_section "$TARGET_ID")" | grep -q "href=\"/apps?app=$DEP_ID\"" \
  || fail "l'écran n'affiche plus l'application sous sa cible injoignable"
pass "l'écran la montre toujours, sous son serveur"

psql_q "update targets set host = '$ORIGINAL_HOST' where id = '$TARGET_ID';" >/dev/null
NOW_HOST=$(psql_q "select host from targets where id = '$TARGET_ID';")
[ "$NOW_HOST" = "$ORIGINAL_HOST" ] || fail "la cible n'a pas retrouvé son hôte ($NOW_HOST)"
pass "« $TARGET_NAME » rendue à $ORIGINAL_HOST"
ORIGINAL_HOST=''

step "7. L'écran groupe par serveur"
curl -s -b "$JAR" -c "$JAR" "$BASE_URL/apps" -o "$HTML"
grep -q 'data-server-id="' "$HTML" || fail "aucun serveur rendu sur /apps"
SERVERS=$(grep -o 'data-server-id="[^"]*"' "$HTML" | wc -l | tr -d ' ')
pass "$SERVERS serveur(s) rendus, un panneau chacun"

printf '%s\n' "$(server_section "$TARGET_ID")" | grep -q "href=\"/apps?app=$DEP_ID\"" \
  || fail "« $APP_SLUG » n'apparaît pas sous « $TARGET_NAME »"
pass "« $APP_SLUG » apparaît sous « $TARGET_NAME »"

# … et sous elle seule : aucune autre section ne doit la contenir.
FOREIGN=0
for id in $(grep -o 'data-server-id="[^"]*"' "$HTML" | sed 's/data-server-id="//; s/"$//'); do
  [ "$id" = "$TARGET_ID" ] && continue
  if printf '%s\n' "$(server_section "$id")" | grep -q "href=\"/apps?app=$DEP_ID\""; then
    FOREIGN=$((FOREIGN + 1))
    info "trouvée aussi sous $id"
  fi
done
[ "$FOREIGN" = "0" ] || fail "l'application apparaît sous $FOREIGN serveur(s) qui ne sont pas le sien"
pass "elle n'apparaît sous aucun autre serveur"

# Un serveur sans application le dit plutôt que d'offrir un dépliant vide.
if [ -n "$WITNESS_ID" ]; then
  WITNESS_SECTION=$(server_section "$WITNESS_ID")
  printf '%s' "$WITNESS_SECTION" | grep -qE 'Aucune application supervisée|No monitored application' \
    || fail "le serveur témoin n'annonce pas qu'il est vide"
  if printf '%s' "$WITNESS_SECTION" | grep -q 'aria-expanded'; then
    fail "un serveur vide ne doit pas offrir de dépliant"
  fi
  pass "un serveur sans application le dit, et n'offre aucun dépliant"
fi

# Le dépliant du serveur peuplé est un vrai bouton, et il annonce son état.
SECTION=$(server_section "$TARGET_ID")
printf '%s' "$SECTION" | grep -q 'aria-expanded="' || fail "le dépliant n'annonce pas son état"
printf '%s' "$SECTION" | grep -q 'aria-controls="' || fail "le dépliant ne désigne pas son panneau"
printf '%s' "$SECTION" | grep -q '<button[^>]*aria-expanded' \
  || fail "le dépliant n'est pas un <button> — il ne serait pas manipulable au clavier"
PANEL_ID=$(printf '%s' "$SECTION" | grep -o 'aria-controls="[^"]*"' | head -1 | sed 's/aria-controls="//; s/"$//')
printf '%s' "$SECTION" | grep -q "id=\"$PANEL_ID\"" \
  || fail "aria-controls désigne « $PANEL_ID », qui n'existe pas dans la page"
pass "dépliant : <button aria-expanded> → panneau « $PANEL_ID », présent dans la page"

step "8. « target:read » est requis"
req DELETE "/api/admin/roles/$ROLE_KEY" >/dev/null 2>&1 || true
code=$(req POST /api/admin/roles \
  "{\"key\":\"$ROLE_KEY\",\"label\":\"Supervision sans cible\",\"permissions\":[\"deployment:read\"]}")
[ "$code" = "201" ] || fail "POST /api/admin/roles → HTTP $code : $(cat "$BODY")"
pass "rôle « $ROLE_KEY » : deployment:read seulement"

code=$(req POST /api/admin/users \
  "{\"name\":\"Supervision sans cible\",\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\",\"role\":\"$ROLE_KEY\"}")
case "$code" in
  201) pass "utilisateur créé avec ce rôle" ;;
  409) pass "utilisateur déjà présent" ;;
  *)   fail "POST /api/admin/users → HTTP $code : $(cat "$BODY")" ;;
esac
VIEWER_ID=$(psql_q "select id from users where email = '$VIEWER_EMAIL';")

code=$(req POST /api/auth/sign-in/email \
  "{\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\"}" "$VIEWER_JAR")
[ "$code" = "200" ] || fail "connexion du testeur → HTTP $code : $(cat "$BODY")"

code=$(req GET "/api/targets/$TARGET_ID/metrics" '' "$VIEWER_JAR")
[ "$code" = "403" ] || fail "relevé sans target:read : attendu 403, reçu $code"
jq -e '.error.code == "forbidden" and .error.details.permission == "target:read"' "$BODY" >/dev/null \
  || fail "le refus ne nomme pas la permission manquante : $(cat "$BODY")"
pass "relevé refusé → 403, permission « target:read » nommée"

DENIED=$(psql_q "select count(*) from audit_logs
  where action = 'permission.denied' and resource_id = 'target:read'
    and actor_id = '$VIEWER_ID';")
[ "$DENIED" -ge 1 ] || fail "le refus n'a pas été journalisé"
pass "refus tracé dans le journal d'audit ($DENIED ligne(s))"

# L'écran reste consultable : voir ce qui tourne ne demande que deployment:read.
curl -s -b "$VIEWER_JAR" -c "$VIEWER_JAR" "$BASE_URL/apps" -o "$WORK/viewer.html"
grep -q "$APP_SLUG" "$WORK/viewer.html" || fail "le testeur ne voit plus les applications"
grep -qE 'Relevé indisponible|Readout unavailable' "$WORK/viewer.html" \
  || fail "l'écran ne dit pas pourquoi il n'affiche aucune métrique"
pass "il voit les applications, et l'écran annonce « relevé indisponible »"

step "9. Le relevé passe par la file, pas par une session SSH du panel"
# `panel` et `worker` partagent UNE image (docker-compose.yml, ancre x-app-image) :
# `/app/node_modules` est l'arbre de dépendances du worker, et `ssh2` s'y trouve
# forcément — c'est lui qui ouvre les sessions. Un `find /` sur le conteneur
# panel le voit donc, et le verrait même sans ce chantier. Ce qui doit rester
# vide, c'est le **bundle tracé du panel**, `/app/web` : `ssh2` ou `node-ssh`
# dedans voudrait dire que du code de session SSH a fui dans le graphe de Next.
PANEL_SSH2=$(docker compose exec -T panel find /app/web -name ssh2 2>/dev/null || true)
PANEL_NODESSH=$(docker compose exec -T panel find /app/web -name node-ssh 2>/dev/null || true)
[ -z "$PANEL_SSH2$PANEL_NODESSH" ] \
  || fail "le bundle du panel embarque une couche SSH : $PANEL_SSH2 $PANEL_NODESSH"
pass "aucun « ssh2 » ni « node-ssh » dans /app/web — le panel ne peut pas ouvrir de session"
info "l'image est partagée avec le worker : /app/node_modules porte bien ssh2, c'est sa place"

# La preuve positive : une tâche `target:metrics` a bien été consommée.
JOB_NAMES=$(docker compose exec -T redis sh -lc \
  'for k in $(redis-cli --scan --pattern "bull:supervision:*"); do redis-cli HGET "$k" name; done' \
  | tr -d '\r' | sort -u | paste -sd' ' -)
printf '%s' "$JOB_NAMES" | grep -q 'target:metrics' \
  || fail "aucune tâche « target:metrics » dans la file de supervision (vu : $JOB_NAMES)"
pass "la file « supervision » porte des tâches « target:metrics »"

WORKER_LOG=$(docker compose logs worker --since 30m 2>&1 || true)
printf '%s\n' "$WORKER_LOG" | grep -q 'metrics reading completed' \
  || fail "le worker n'a jamais journalisé de relevé"
pass "c'est le worker qui a ouvert les sessions SSH"

step "10. Ménage"
code=$(req DELETE "/api/deployments/$DEP_ID")
[ "$code" = "202" ] || fail "DELETE /api/deployments/$DEP_ID → HTTP $code : $(cat "$BODY")"
for _ in $(seq 1 90); do
  sleep 2
  req GET "/api/deployments/$DEP_ID" >/dev/null
  [ "$(jq -r .status "$BODY")" = "destroyed" ] && break
done
[ "$(jq -r .status "$BODY")" = "destroyed" ] || fail "le déploiement n'a pas été détruit"
pass "déploiement détruit sur la cible"

code=$(req DELETE "/api/deployments/$DEP_ID/purge")
[ "$code" = "200" ] || info "purge → HTTP $code : $(jq -r '.error.message // ""' "$BODY")"
code=$(req DELETE "/api/applications/$APP_ID")
[ "$code" = "200" ] || [ "$code" = "204" ] || fail "DELETE /api/applications/$APP_ID → HTTP $code"
pass "application « $APP_SLUG » supprimée"

code=$(req DELETE "/api/targets/$DEAD_ID")
[ "$code" = "200" ] || [ "$code" = "204" ] || fail "DELETE /api/targets/$DEAD_ID → HTTP $code"
pass "cible morte supprimée"

if [ -n "$VIEWER_ID" ]; then req DELETE "/api/admin/users/$VIEWER_ID" >/dev/null; fi
code=$(req DELETE "/api/admin/roles/$ROLE_KEY")
[ "$code" = "200" ] || fail "DELETE /api/admin/roles/$ROLE_KEY → HTTP $code : $(cat "$BODY")"
pass "utilisateur et rôle de test supprimés"

req GET /api/apps >/dev/null
LIVE_AFTER=$(jq -r '[.items[].applicationSlug] | sort | join(",")' "$BODY")
[ "$LIVE_AFTER" = "$LIVE_BEFORE" ] \
  || fail "l'inventaire a changé : « $LIVE_BEFORE » → « $LIVE_AFTER »"
pass "les applications en marche sont exactement celles d'avant : ${LIVE_AFTER:-aucune}"

printf '\n\033[32m✓ Supervision par serveur vérifiée.\033[0m\n'
printf '\033[2m  Écran : %s/apps\033[0m\n\n' "$BASE_URL"
