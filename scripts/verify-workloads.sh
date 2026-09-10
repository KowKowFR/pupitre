#!/usr/bin/env bash
#
# Vérifie la gestion des charges d'une cible :
#
#   1. l'inventaire montre les charges du panel ET les autres, distinguées
#   2. une charge déployée par le panel REFUSE d'être supprimée → 409
#   3. une charge étrangère se met à jour, par la file, en publiant sa progression
#   4. une charge étrangère se supprime, et disparaît réellement de la machine
#   5. `workload:read` suffit pour lire, `workload:manage` est exigé pour écrire
#   6. l'audit retient l'action, avec le nom de la charge et la cible
#   7. les applications déployées par le panel tournent toujours à la fin
#
# Usage :
#   ./scripts/verify-workloads.sh
#   BASE_URL=http://localhost:3200 ./scripts/verify-workloads.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
TARGET_NAME="${TARGET_NAME:-cible-de-verification}"
COBAYE="${COBAYE:-cobaye-verif}"
VIEWER_EMAIL="${VIEWER_EMAIL:-workload-viewer@example.test}"
VIEWER_PASSWORD="${VIEWER_PASSWORD:-motdepasse-tres-long}"
CLIENT_IP="${CLIENT_IP:-198.51.100.77}"

WORK="$(mktemp -d)"
ADMIN_JAR="$WORK/admin.jar"
VIEWER_JAR="$WORK/viewer.jar"
JAR="$ADMIN_JAR"
BODY="$WORK/body.json"
SSE="$WORK/sse.txt"
SSE_PID=""

cleanup() {
  [ -n "$SSE_PID" ] && { kill "$SSE_PID"; wait "$SSE_PID"; } 2>/dev/null || true
  # Les cobayes ne survivent pas au script, quoi qu'il arrive.
  docker compose exec -T ssh-target sh -c \
    "docker rm -f \$(docker ps -aq --filter name=^${COBAYE}) >/dev/null 2>&1" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

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
on_target() { docker compose exec -T ssh-target sh -c "$1"; }

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

login_viewer() {
  local code
  JAR="$VIEWER_JAR"
  for _ in 1 2 3 4 5; do
    code=$(req POST /api/auth/sign-in/email \
      "{\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\"}")
    case "$code" in
      200) return 0 ;;
      429) sleep 6 ;;
      *)   fail "connexion viewer impossible (HTTP $code) : $(cat "$BODY")" ;;
    esac
  done
  fail "connexion viewer impossible après plusieurs tentatives"
}

# Attend qu'une tâche BullMQ soit terminée. Retourne son état final.
await_job() {
  local job_id="$1" deadline=$((SECONDS + 180)) state
  while [ "$SECONDS" -lt "$deadline" ]; do
    req GET "/api/queue/jobs/$job_id" >/dev/null
    state=$(jq -r '.state' "$BODY")
    case "$state" in
      completed|failed) echo "$state"; return 0 ;;
    esac
    sleep 1
  done
  echo "timeout"
}

inventory() {
  local code
  code=$(req GET "/api/targets/$TARGET_ID/workloads")
  [ "$code" = "200" ] || fail "GET workloads → HTTP $code : $(cat "$BODY")"
  cp "$BODY" "$WORK/inventory.json"
}

step "1. Connexion"
login
pass "connecté en tant que $ADMIN_EMAIL"

step "2. La cible de vérification"
code=$(req GET /api/targets)
[ "$code" = "200" ] || fail "GET /api/targets → HTTP $code"
TARGET_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY" | head -1)
[ -n "$TARGET_ID" ] || fail "aucune cible nommée « $TARGET_NAME »"
pass "cible « $TARGET_NAME » → $TARGET_ID"

# Les applications du panel, telles qu'elles sont AVANT toute manipulation.
req GET /api/apps >/dev/null
cp "$BODY" "$WORK/apps-before.json"
APPS_BEFORE=$(jq -r '[.items[].id] | sort | join(",")' "$WORK/apps-before.json")
APPS_COUNT=$(jq -r '.total' "$WORK/apps-before.json")
[ "$APPS_COUNT" -ge 1 ] || fail "aucune application déployée : rien à protéger, le test perdrait son sens"
info "$APPS_COUNT application(s) déployée(s) par le panel avant le test"

step "3. Poser une charge étrangère au panel"
on_target "docker rm -f $COBAYE >/dev/null 2>&1" >/dev/null 2>&1 || true
on_target "docker run -d --name $COBAYE nginx:alpine" >/dev/null \
  || fail "impossible de lancer le cobaye sur la cible"
pass "conteneur « $COBAYE » lancé sur la cible, hors du panel"

step "4. L'inventaire voit tout, et distingue"
inventory
TOTAL=$(jq -r '.total' "$WORK/inventory.json")
MANAGED=$(jq -r '.managed' "$WORK/inventory.json")
jq -e '.runtimes | length >= 1' "$WORK/inventory.json" >/dev/null \
  || fail "aucun runtime interrogé"
jq -e '[.runtimes[] | select(.ok | not)] | length == 0' "$WORK/inventory.json" >/dev/null \
  || fail "un runtime n'a rien pu dire : $(jq -c '.runtimes' "$WORK/inventory.json")"
pass "$TOTAL charge(s) vue(s) sur $(jq -r '[.runtimes[].runtime] | join(", ")' "$WORK/inventory.json")"

jq -e --arg n "$COBAYE" \
  '[.items[] | select(.name == $n and .managed == false)] | length == 1' \
  "$WORK/inventory.json" >/dev/null \
  || fail "« $COBAYE » absent de l'inventaire, ou marqué à tort comme géré par le panel"
pass "« $COBAYE » présent, marqué hors panel"

[ "$MANAGED" -ge 1 ] || fail "aucune charge marquée comme déployée par le panel"
jq -e '[.items[] | select(.managed) | select(.managedApp == null)] | length == 0' \
  "$WORK/inventory.json" >/dev/null \
  || fail "une charge du panel ne dit pas de quelle application elle vient"
pass "$MANAGED charge(s) reconnue(s) comme déployée(s) par le panel : $(
  jq -r '[.items[] | select(.managed) | "\(.name) → \(.managedApp)"] | join(", ")' "$WORK/inventory.json")"

step "5. LE test : une charge du panel refuse d'être supprimée"
MANAGED_REF=$(jq -r '[.items[] | select(.managed)][0].ref' "$WORK/inventory.json")
MANAGED_NAME=$(jq -r '[.items[] | select(.managed)][0].name' "$WORK/inventory.json")
code=$(req DELETE "/api/targets/$TARGET_ID/workloads/$MANAGED_REF")
[ "$code" = "409" ] || fail "suppression d'une charge du panel : attendu 409, reçu $code"
jq -e '.error.code == "conflict"' "$BODY" >/dev/null || fail "code d'erreur inattendu"
MSG=$(jq -r '.error.message' "$BODY")
case "$MSG" in
  *"$MANAGED_NAME"*) : ;;
  *) fail "le message ne nomme pas la charge : $MSG" ;;
esac
case "$MSG" in
  *deployment:destroy*) : ;;
  *) fail "le message ne dit pas quoi faire à la place : $MSG" ;;
esac
pass "refusée → 409"
info "$MSG"

# Et elle est toujours là.
on_target "docker ps --format '{{.Names}}'" | grep -qx "$MANAGED_NAME" \
  || fail "« $MANAGED_NAME » a disparu de la machine malgré le refus"
pass "« $MANAGED_NAME » tourne toujours sur la machine"

step "6. Mettre à jour la charge étrangère — par la file, avec sa progression"
COBAYE_REF=$(jq -r --arg n "$COBAYE" '.items[] | select(.name == $n) | .ref' "$WORK/inventory.json")

# On s'abonne AVANT d'enfiler : s'abonner après, c'est perdre le début.
curl -s -N -b "$ADMIN_JAR" --max-time 120 \
  "$BASE_URL/api/targets/$TARGET_ID/workloads/events" > "$SSE" &
SSE_PID=$!
sleep 2

code=$(req POST "/api/targets/$TARGET_ID/workloads/$COBAYE_REF/update")
[ "$code" = "202" ] || fail "mise à jour : attendu 202 (enfilée), reçu $code : $(cat "$BODY")"
JOB_ID=$(jq -r '.jobId' "$BODY")
CHANNEL=$(jq -r '.channel' "$BODY")
[ -n "$JOB_ID" ] && [ "$JOB_ID" != "null" ] || fail "aucun identifiant de tâche"
pass "mise à jour enfilée (tâche $JOB_ID) — la route n'a rien exécuté elle-même"
info "progression publiée sur « $CHANNEL »"

state=$(await_job "$JOB_ID")
[ "$state" = "completed" ] || fail "la tâche de mise à jour a fini « $state » : $(jq -r '.failedReason // "?"' "$BODY")"
pass "tâche terminée par le worker"

sleep 1
# `wait` avale la notification « Terminated » que bash émettrait sinon.
{ kill "$SSE_PID"; wait "$SSE_PID"; } 2>/dev/null || true
SSE_PID=""

grep -q 'event: lifecycle' "$SSE" || fail "aucun événement de cycle de vie relayé en SSE"
grep -q '"status":"started"' "$SSE" || fail "le démarrage n'a pas été publié"
grep -q '"status":"succeeded"' "$SSE" || fail "la fin n'a pas été publiée"
LOG_LINES=$(grep -c 'event: log' "$SSE" || true)
[ "$LOG_LINES" -ge 3 ] || fail "progression trop pauvre : $LOG_LINES ligne(s)"
pass "$LOG_LINES ligne(s) de progression relayées en SSE, plus le début et la fin"
info "$(sed -n 's/^data: //p' "$SSE" | jq -r 'select(.line) | .line' 2>/dev/null \
        | sed -n '1p;$p' | paste -sd' … ' - || true)"

on_target "docker ps --format '{{.Names}}'" | grep -qx "$COBAYE" \
  || fail "« $COBAYE » n'a pas survécu à sa mise à jour"
on_target "docker ps -a --format '{{.Names}}'" | grep -q -- "-tp-prev-" \
  && fail "un conteneur de secours a été laissé derrière"
pass "« $COBAYE » tourne toujours, et rien n'a été laissé derrière"

step "7. Supprimer la charge étrangère"
# La mise à jour a recréé le conteneur : sa référence a changé.
inventory
COBAYE_REF=$(jq -r --arg n "$COBAYE" '.items[] | select(.name == $n) | .ref' "$WORK/inventory.json")
[ -n "$COBAYE_REF" ] && [ "$COBAYE_REF" != "null" ] || fail "« $COBAYE » introuvable après mise à jour"

code=$(req DELETE "/api/targets/$TARGET_ID/workloads/$COBAYE_REF")
[ "$code" = "202" ] || fail "suppression : attendu 202 (enfilée), reçu $code : $(cat "$BODY")"
JOB_ID=$(jq -r '.jobId' "$BODY")
pass "suppression enfilée (tâche $JOB_ID)"

state=$(await_job "$JOB_ID")
[ "$state" = "completed" ] || fail "la tâche de suppression a fini « $state » : $(jq -r '.failedReason // "?"' "$BODY")"
pass "tâche terminée par le worker"

on_target "docker ps -a --format '{{.Names}}'" | grep -qx "$COBAYE" \
  && fail "« $COBAYE » est toujours sur la machine : la suppression n'a rien fait"
pass "« $COBAYE » a réellement disparu de la cible (docker ps -a)"

inventory
jq -e --arg n "$COBAYE" '[.items[] | select(.name == $n)] | length == 0' \
  "$WORK/inventory.json" >/dev/null || fail "l'inventaire le montre encore"
pass "il a disparu de l'inventaire"

step "8. Les permissions"
code=$(req POST /api/admin/users \
  "{\"name\":\"Lecteur charges\",\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\",\"role\":\"viewer\"}")
case "$code" in
  201) pass "utilisateur viewer créé" ;;
  409) pass "utilisateur viewer déjà présent" ;;
  *)   fail "POST /api/admin/users → HTTP $code : $(cat "$BODY")" ;;
esac
VIEWER_ID=$(psql_q "select id from users where email = '$VIEWER_EMAIL';")

perms=$(req GET /api/admin/roles >/dev/null; jq -r '[.items[] | select(.key=="viewer") | .permissions[]] | join(" ")' "$BODY")
case "$perms" in
  *workload:read*) : ;;
  *) fail "le rôle viewer n'a pas « workload:read » — le test ne prouverait rien" ;;
esac
case "$perms" in
  *workload:manage*) fail "le rôle viewer a « workload:manage » — le test ne prouverait rien" ;;
esac
pass "viewer porte « workload:read » et pas « workload:manage »"

login_viewer
code=$(req GET "/api/targets/$TARGET_ID/workloads")
[ "$code" = "200" ] || fail "viewer en lecture : attendu 200, reçu $code"
pass "viewer lit l'inventaire → 200"

# Une charge quelconque suffit : le refus vient de la permission, pas de la cible.
ANY_REF=$(jq -r '.items[0].ref' "$WORK/inventory.json")
code=$(req DELETE "/api/targets/$TARGET_ID/workloads/$ANY_REF")
[ "$code" = "403" ] || fail "viewer en suppression : attendu 403, reçu $code"
jq -e '.error.details.permission == "workload:manage"' "$BODY" >/dev/null \
  || fail "le 403 ne nomme pas la permission manquante"
pass "viewer ne supprime pas → 403 « workload:manage »"

code=$(req POST "/api/targets/$TARGET_ID/workloads/$ANY_REF/update")
[ "$code" = "403" ] || fail "viewer en mise à jour : attendu 403, reçu $code"
pass "viewer ne met pas à jour → 403"

JAR="$ADMIN_JAR"

step "9. Traçabilité"
code=$(req GET "/api/audit-logs?resourceType=target&pageSize=50")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"

for action in workload.remove.refused workload.update.requested workload.updated \
              workload.remove.requested workload.removed; do
  jq -e --arg a "$action" '[.items[] | select(.action == $a)] | length > 0' "$BODY" >/dev/null \
    || fail "action « $action » absente du journal d'audit"
  pass "audit : $action"
done

jq -e --arg n "$COBAYE" --arg t "$TARGET_NAME" \
  '[.items[] | select(.action == "workload.removed")
     | select(.after.workload == $n and .after.targetName == $t)] | length > 0' \
  "$BODY" >/dev/null \
  || fail "la suppression n'est pas tracée avec le nom de la charge et la cible"
pass "la suppression nomme « $COBAYE » et la cible « $TARGET_NAME »"

jq -e --arg n "$MANAGED_NAME" \
  '[.items[] | select(.action == "workload.remove.refused")
     | select(.after.workload == $n and .after.reason == "managed_by_panel")] | length > 0' \
  "$BODY" >/dev/null \
  || fail "le refus n'est pas tracé"
pass "le refus est tracé, avec sa raison"

step "10. Les applications du panel n'ont pas bougé"
code=$(req GET /api/apps)
[ "$code" = "200" ] || fail "GET /api/apps → HTTP $code"
APPS_AFTER=$(jq -r '[.items[].id] | sort | join(",")' "$BODY")
[ "$APPS_AFTER" = "$APPS_BEFORE" ] \
  || fail "la liste des applications a changé : « $APPS_BEFORE » → « $APPS_AFTER »"
pass "les $APPS_COUNT application(s) sont toujours là"

jq -e '[.items[] | select(.status != "success" and .status != "rolled_back")] | length == 0' "$BODY" \
  >/dev/null || fail "une application n'est plus dans un état vivant : $(jq -c '[.items[] | {applicationSlug, status}]' "$BODY")"
pass "toutes en état vivant : $(jq -r '[.items[] | "\(.applicationSlug)=\(.status)"] | join(", ")' "$BODY")"

# Seules celles déployées sur CETTE cible y ont des conteneurs : le panel en
# pilote plusieurs, et les autres ne prouveraient rien ici.
HERE=$(jq -r --arg t "$TARGET_NAME" '[.items[] | select(.targetName == $t) | .applicationSlug] | join(" ")' \
  "$WORK/apps-before.json")
[ -n "$HERE" ] || fail "aucune application du panel sur « $TARGET_NAME » : le garde-fou n'aurait rien à protéger"
for slug in $HERE; do
  on_target "docker ps --format '{{.Names}}'" | grep -q "^app-$slug-" \
    || fail "aucun conteneur en marche pour « $slug » sur la cible"
done
pass "leurs conteneurs tournent toujours sur « $TARGET_NAME » : $HERE"

step "11. Ménage"
on_target "docker rm -f $COBAYE >/dev/null 2>&1" >/dev/null 2>&1 || true
remaining=$(on_target "docker ps -aq --filter name=^$COBAYE" | wc -l | tr -d ' ')
[ "$remaining" = "0" ] || fail "$remaining cobaye(s) survivant(s) sur la cible"
pass "aucun cobaye ne survit sur la cible"

[ -n "$VIEWER_ID" ] && req DELETE "/api/admin/users/$VIEWER_ID" >/dev/null
pass "utilisateur de test supprimé"

printf '\n\033[32m✓ Gestion des charges vérifiée.\033[0m\n'
printf '\033[2m  Écran : %s/targets/%s\033[0m\n\n' "$BASE_URL" "$TARGET_ID"
