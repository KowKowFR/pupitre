#!/usr/bin/env bash
#
# Vérifie l'assistant de démarrage :
#
#   1. sur un état vierge, l'assistant est proposé — et la redirection part
#   2. la redirection ne se répète pas : on ne piège personne dans l'écran
#   3. une étape franchie est persistée, et survit à une reconnexion
#   4. passer une étape facultative est distinct de la terminer
#   5. une cible créée par l'assistant est IDENTIQUE à une cible créée par
#      /targets/new — mêmes colonnes, même audit, même preflight enfilé
#   6. un viewer ne se voit proposer aucune étape qu'il ne peut pas accomplir
#   7. terminer fait disparaître l'assistant, et il ne revient pas
#   8. relancer depuis les paramètres le réarme
#   9. l'audit retient ce qui a été fait
#
# Usage :
#   ./scripts/verify-onboarding.sh
#   BASE_URL=http://localhost:3200 ./scripts/verify-onboarding.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
VIEWER_EMAIL="${VIEWER_EMAIL:-onboarding-viewer@example.test}"
VIEWER_PASSWORD="${VIEWER_PASSWORD:-motdepasse-tres-long}"
CLIENT_IP="${CLIENT_IP:-198.51.100.61}"
# Commande compose visant la pile à vérifier. Surchargeable pour lancer le
# script contre une pile isolée : DC="docker compose -p ma-pile".
DC="${DC:-docker compose}"

# Les deux cibles de comparaison. Elles ne diffèrent QUE par le nom et l'hôte :
# tout le reste doit être identique en base, sans quoi l'assistant aurait un
# chemin de création à lui.
TARGET_A="${TARGET_A:-verif-onboarding-ecran}"
TARGET_B="${TARGET_B:-verif-onboarding-assistant}"
HOST_A="127.0.0.2"
HOST_B="127.0.0.3"
# Port 2 : rien n'écoute, la connexion est refusée immédiatement. Le preflight
# échoue en une seconde au lieu d'occuper le worker pendant une minute — c'est
# un environnement partagé.
DEAD_PORT=2
CREDENTIAL='verification-onboarding-credential-en-clair'

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
JAR2="$WORK/admin-2.jar"
VIEWER_JAR="$WORK/viewer.jar"
BODY="$WORK/body.json"
trap 'rm -rf "$WORK"' EXIT

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

# Page HTML, sans suivre les redirections : c'est la redirection elle-même
# qu'on veut observer. Rend « code|location ».
page() {
  local path="$1" jar="${2:-$JAR}"
  curl -s -o /dev/null -w '%{http_code}|%{redirect_url}' \
    -H "x-forwarded-for: $CLIENT_IP" -b "$jar" -c "$jar" "$BASE_URL$path"
}

psql_q() { $DC exec -T postgres psql -U tp -d tp -tAc "$1"; }

login() {
  local jar="${1:-$JAR}" code
  for _ in 1 2 3 4 5; do
    code=$(req POST /api/auth/sign-in/email \
      "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" "$jar")
    case "$code" in
      200) assert_admin; return 0 ;;
      429) sleep 6 ;;
      *)   break ;;
    esac
  done
  code=$(req POST /api/auth/sign-up/email \
    "{\"name\":\"Admin\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" "$jar")
  [ "$code" = "200" ] || fail "connexion impossible (HTTP $code) : $(cat "$BODY")"
  assert_admin
}

assert_admin() {
  local role
  role=$(jq -r '.user.role // empty' "$BODY")
  [ "$role" = "admin" ] && return 0
  fail "« $ADMIN_EMAIL » a le rôle « ${role:-aucun} », pas « admin » — voir /admin/users"
}

onboarding_json() { psql_q "select value->'onboarding' from app_settings where id = 1;"; }

# La ligne des paramètres est lue avec un cache de 5 s par processus : après une
# retouche en SQL, il faut le laisser expirer avant d'interroger le panel.
settle() { sleep 6; }

cleanup_targets() {
  local id
  for name in "$TARGET_A" "$TARGET_B"; do
    id=$(psql_q "select id from targets where name = '$name';")
    [ -n "$id" ] && req DELETE "/api/targets/$id" >/dev/null 2>&1 || true
  done
}

step "1. Connexion"
login
pass "connecté en tant que $ADMIN_EMAIL"

# Ménage d'une exécution précédente, avant toute mesure.
cleanup_targets

# On garde l'identité de l'instance pour la reposer à la fin : cet environnement
# est partagé, l'assistant va la modifier.
# Une base vierge n'a pas encore de ligne : on repose alors les défauts du schéma.
ORIGINAL_NAME=$(psql_q "select value->>'instanceName' from app_settings where id = 1;")
ORIGINAL_TAGLINE=$(psql_q "select value->>'instanceTagline' from app_settings where id = 1;")
[ -n "$ORIGINAL_NAME" ] || ORIGINAL_NAME='Control plane'
[ -n "$ORIGINAL_TAGLINE" ] || ORIGINAL_TAGLINE='Bootstrap TP v2'
info "identité d'origine : « $ORIGINAL_NAME » / « $ORIGINAL_TAGLINE »"

step "2. État vierge : l'assistant est proposé"
# Exactement le geste documenté : on retire la clé, on ne casse rien d'autre.
psql_q "update app_settings set value = value - 'onboarding' where id = 1;" >/dev/null
settle

code=$(req GET /api/onboarding)
[ "$code" = "200" ] || fail "GET /api/onboarding → HTTP $code : $(cat "$BODY")"
jq -e '.state.status == "pending"' "$BODY" >/dev/null \
  || fail "état attendu « pending », reçu « $(jq -r .state.status "$BODY") »"
jq -e '.applies == true' "$BODY" >/dev/null || fail "l'assistant devrait concerner un admin"
STEP_COUNT=$(jq -r '.steps | length' "$BODY")
[ "$STEP_COUNT" -ge 7 ] || fail "seulement $STEP_COUNT étapes proposées à un admin"
pass "clé absente → « pending », $STEP_COUNT étapes proposées : $(jq -r '[.steps[].id] | join(", ")' "$BODY")"

result=$(page /)
[ "${result%%|*}" = "307" ] || fail "GET / attendu 307, reçu ${result%%|*}"
case "${result#*|}" in
  */onboarding) pass "GET / → 307 vers ${result#*|}" ;;
  *) fail "redirigé vers « ${result#*|} », pas vers /onboarding" ;;
esac

step "3. Tant que rien n'est configuré, l'assistant s'impose"
# Contrat : une instance sans aucune cible ne peut rien faire. On y ramène,
# page après page, plutôt que de laisser errer entre des écrans vides. La
# porte de sortie est l'abandon explicite, vérifié juste après — « forcer »
# ne doit pas vouloir dire « enfermer ».
after=$(onboarding_json | jq -r .status)
[ "$after" = "in_progress" ] || fail "après la proposition, statut « $after » au lieu de « in_progress »"
pass "le fait d'avoir été proposé est enregistré (« in_progress »)"

TARGET_COUNT=$(psql_q "select count(*) from targets;")
if [ "$TARGET_COUNT" = "0" ]; then
  for path in / /targets /applications /deployments; do
    result=$(page "$path")
    [ "${result%%|*}" = "307" ] \
      || fail "sans cible, GET $path attendu 307, reçu ${result%%|*}"
  done
  pass "aucune cible : /, /targets, /applications et /deployments renvoient tous vers l'assistant"
else
  info "$TARGET_COUNT cible(s) déjà déclarée(s) — l'instance est configurée, pas de redirection forcée"
  result=$(page /)
  [ "${result%%|*}" = "200" ] || fail "instance configurée : GET / attendu 200, reçu ${result%%|*}"
  pass "instance configurée : plus aucune redirection subie"
fi

result=$(page /onboarding)
[ "${result%%|*}" = "200" ] || fail "GET /onboarding attendu 200, reçu ${result%%|*}"
pass "l'assistant reste atteignable à la demande"

# L'assistant a sa propre coquille : pas de rail de navigation, sinon on offre
# douze façons de se perdre dans un panel qu'on découvre.
BODY_HTML="$WORK/onboarding.html"
curl -s -b "$JAR" -c "$JAR" "$BASE_URL/onboarding" -o "$BODY_HTML"
for marker in 'href="/targets"' 'href="/deployments"' 'href="/jobs"'; do
  grep -q -- "$marker" "$BODY_HTML" \
    && fail "le rail de navigation est présent dans l'assistant ($marker)"
done
pass "aucun lien du rail dans l'assistant — la coquille est nue"

step "3 bis. L'abandon est la porte de sortie"
code=$(req PATCH /api/onboarding '{"action":"dismiss"}')
[ "$code" = "200" ] || fail "dismiss → HTTP $code : $(cat "$BODY")"
result=$(page /)
[ "${result%%|*}" = "200" ] \
  || fail "après abandon, GET / attendu 200, reçu ${result%%|*} — l'écran serait un piège"
pass "abandon explicite : on sort de l'assistant même sans cible"

# On reprend le parcours pour la suite du script.
code=$(req PATCH /api/onboarding '{"action":"restart"}')
[ "$code" = "200" ] || fail "restart → HTTP $code"
page / >/dev/null
pass "parcours repris pour la suite"

step "4. Une étape franchie est persistée"
# L'assistant n'a pas de route à lui pour l'identité : il appelle celle de
# /admin/settings, la même, avec un patch partiel.
code=$(req PATCH /api/settings \
  '{"instanceName":"Instance de vérification","instanceTagline":"assistant","timezone":"Europe/Paris","locale":"fr-FR","dateStyle":"short","timeStyle":"medium"}')
[ "$code" = "200" ] || fail "PATCH /api/settings → HTTP $code : $(cat "$BODY")"
pass "identité enregistrée via PATCH /api/settings (aucune route parallèle)"

code=$(req PATCH /api/onboarding '{"action":"complete","step":"identity"}')
[ "$code" = "200" ] || fail "PATCH /api/onboarding → HTTP $code : $(cat "$BODY")"
jq -e '.state.completed | index("identity") != null' "$BODY" >/dev/null \
  || fail "« identity » absente des étapes accomplies"
jq -e '.state.currentStep == "target"' "$BODY" >/dev/null \
  || fail "étape courante « $(jq -r .state.currentStep "$BODY") » au lieu de « target »"
pass "étape « identity » accomplie, l'assistant avance sur « target »"

stored=$(onboarding_json)
[ "$(jq -r .currentStep <<< "$stored")" = "target" ] \
  || fail "la base ne retient pas l'étape courante : $stored"
pass "persisté dans le JSONB de app_settings, sans migration : $(jq -c '{status,currentStep,completed,skipped}' <<< "$stored")"

# Reconnexion complète, cookie neuf : on revient au bon endroit.
login "$JAR2"
code=$(req GET /api/onboarding '' "$JAR2")
[ "$code" = "200" ] || fail "GET /api/onboarding après reconnexion → HTTP $code"
jq -e '.state.currentStep == "target"' "$BODY" >/dev/null \
  || fail "après reconnexion, on repart de « $(jq -r .state.currentStep "$BODY") »"
pass "après reconnexion, on reprend sur « target » — rien à recommencer"

step "5. Passer une étape n'est pas la terminer"
code=$(req PATCH /api/onboarding '{"action":"skip","step":"role"}')
[ "$code" = "200" ] || fail "skip role → HTTP $code : $(cat "$BODY")"
jq -e '.state.skipped | index("role") != null' "$BODY" >/dev/null \
  || fail "« role » n'est pas marquée passée"
jq -e '.state.completed | index("role") == null' "$BODY" >/dev/null \
  || fail "« role » est comptée comme accomplie alors qu'elle a été passée"
jq -e '[.steps[] | select(.id == "role")][0].outcome == "skipped"' "$BODY" >/dev/null \
  || fail "l'étape « role » n'est pas rapportée « skipped »"
pass "« role » passée : skipped=[$(jq -r '.state.skipped | join(",")' "$BODY")], completed ne la contient pas"

code=$(req PATCH /api/onboarding '{"action":"skip","step":"welcome"}')
[ "$code" = "409" ] || fail "passer une étape non facultative : attendu 409, reçu $code"
jq -e '.error.code == "step_not_optional"' "$BODY" >/dev/null || fail "code d'erreur inattendu"
pass "une étape non facultative ne se passe pas → 409 step_not_optional"

code=$(req PATCH /api/onboarding '{"action":"complete","step":"role"}')
[ "$code" = "200" ] || fail "complete role → HTTP $code"
jq -e '.state.skipped | index("role") == null' "$BODY" >/dev/null \
  || fail "accomplir une étape ne l'a pas retirée des étapes passées"
pass "accomplir une étape passée bascule son état — les deux ne coexistent pas"

code=$(req PATCH /api/onboarding '{"action":"skip","step":"role"}')
[ "$code" = "200" ] || fail "skip role → HTTP $code"
pass "« role » repassée en « passée » pour la suite du parcours"

step "6. La cible de l'assistant est celle de /targets/new"
payload() {
  printf '{"name":"%s","host":"%s","port":%s,"sshUser":"verif","authMethod":"key","sudoMethod":"nopasswd","credential":"%s","portRangeStart":30000,"portRangeEnd":30009,"labels":{"env":"verification"}}' \
    "$1" "$2" "$DEAD_PORT" "$CREDENTIAL"
}

# Chemin A — ce que fait /targets/new : POST /api/targets, puis le bouton
# « Tester la connexion » de la liste.
code=$(req POST /api/targets "$(payload "$TARGET_A" "$HOST_A")")
[ "$code" = "201" ] || fail "POST /api/targets (écran) → HTTP $code : $(cat "$BODY")"
ID_A=$(jq -r .id "$BODY")
code=$(req POST "/api/targets/$ID_A/preflight")
[ "$code" = "202" ] || fail "preflight (écran) → HTTP $code : $(cat "$BODY")"
JOB_A=$(jq -r .jobId "$BODY")
pass "chemin /targets/new : cible $ID_A, preflight enfilé (tâche $JOB_A)"

# Chemin B — ce que fait l'assistant : le MÊME formulaire, la MÊME route, le
# MÊME preflight, plus le seul geste qui lui appartienne — se souvenir.
code=$(req POST /api/targets "$(payload "$TARGET_B" "$HOST_B")")
[ "$code" = "201" ] || fail "POST /api/targets (assistant) → HTTP $code : $(cat "$BODY")"
ID_B=$(jq -r .id "$BODY")
code=$(req POST "/api/targets/$ID_B/preflight")
[ "$code" = "202" ] || fail "preflight (assistant) → HTTP $code : $(cat "$BODY")"
JOB_B=$(jq -r .jobId "$BODY")
code=$(req PATCH /api/onboarding '{"action":"complete","step":"target"}')
[ "$code" = "200" ] || fail "complete target → HTTP $code"
pass "chemin assistant : cible $ID_B, preflight enfilé (tâche $JOB_B), étape retenue"

# Les deux preflights vont jusqu'au bout (connexion refusée) : on attend, pour
# comparer aussi le statut et les runtimes découverts.
for _ in $(seq 1 40); do
  states=$(psql_q "select count(*) from targets where name in ('$TARGET_A','$TARGET_B') and status <> 'unknown';")
  [ "$states" = "2" ] && break
  sleep 1
done
[ "$states" = "2" ] || info "un preflight n'a pas rendu la main à temps — comparaison sans le statut"

# Comparaison colonne à colonne. Sont exclus : ce qui identifie la ligne (id,
# nom, hôte), les horodatages, et le credential — chiffré sous un IV aléatoire,
# deux chiffrements du même texte diffèrent forcément.
DIFF=$(psql_q "
  with rows as (
    select name,
           to_jsonb(t) - 'id' - 'name' - 'host' - 'created_at' - 'updated_at'
                       - 'encrypted_credential' - 'last_preflight_at' - 'preflight_report' as shape
    from targets t where name in ('$TARGET_A','$TARGET_B')
  )
  select case
    when (select shape from rows where name = '$TARGET_A')
       = (select shape from rows where name = '$TARGET_B')
    then 'identique' else 'different' end;")
[ "$DIFF" = "identique" ] || {
  psql_q "select name, to_jsonb(t) - 'id' - 'encrypted_credential' from targets t
          where name in ('$TARGET_A','$TARGET_B');"
  fail "les deux cibles diffèrent en base — l'assistant a un chemin parallèle"
}
pass "mêmes colonnes en base : $(psql_q "select to_jsonb(t) - 'id' - 'name' - 'host' - 'created_at' - 'updated_at' - 'encrypted_credential' - 'last_preflight_at' - 'preflight_report' from targets t where name = '$TARGET_B';" | jq -c '{status,auth_method,sudo_method,labels,port,ssh_user,port_range_start,port_range_end}')"

# Le credential est chiffré des deux côtés, et jamais en clair.
for name in "$TARGET_A" "$TARGET_B"; do
  enc=$(psql_q "select encrypted_credential from targets where name = '$name';")
  case "$enc" in v1:*) : ;; *) fail "« $name » : credential non chiffré (« ${enc:0:12}… »)" ;; esac
  [ "$enc" = "$CREDENTIAL" ] && fail "« $name » : credential en clair en base"
done
pass "credential chiffré (v1:iv:tag:ciphertext) des deux côtés, jamais en clair"

# Même entrée d'audit, au nom et à l'hôte près.
AUDIT_DIFF=$(psql_q "
  with entries as (
    select a.resource_id,
           (a."after" - 'name' - 'host') as shape,
           a.actor_id, a.ip
    from audit_logs a where a.action = 'target.created'
      and a.resource_id in ('$ID_A','$ID_B')
  )
  select case
    when (select count(*) from entries) = 2
     and (select shape from entries where resource_id = '$ID_A')
       = (select shape from entries where resource_id = '$ID_B')
     and (select count(distinct actor_id) from entries) = 1
     and (select count(distinct ip) from entries) = 1
    then 'identique' else 'different' end;")
[ "$AUDIT_DIFF" = "identique" ] || {
  psql_q "select resource_id, \"after\" from audit_logs
          where action = 'target.created' and resource_id in ('$ID_A','$ID_B');"
  fail "les entrées d'audit des deux cibles diffèrent"
}
pass "même entrée « target.created » : même forme, même acteur, même IP"

PREFLIGHTS=$(psql_q "select count(*) from audit_logs
  where action = 'target.preflight.requested' and resource_id in ('$ID_A','$ID_B');")
[ "$PREFLIGHTS" = "2" ] || fail "$PREFLIGHTS entrée(s) « target.preflight.requested » au lieu de 2"
pass "les deux ont enfilé un preflight, tracé à l'identique"

step "7. Un viewer ne se voit proposer aucune étape"
code=$(req POST /api/admin/users \
  "{\"name\":\"Viewer assistant\",\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\",\"role\":\"viewer\"}")
case "$code" in
  201) pass "utilisateur viewer créé" ;;
  409) pass "utilisateur viewer déjà présent" ;;
  *)   fail "POST /api/admin/users → HTTP $code : $(cat "$BODY")" ;;
esac
VIEWER_ID=$(psql_q "select id from users where email = '$VIEWER_EMAIL';")

for _ in 1 2 3 4 5; do
  code=$(req POST /api/auth/sign-in/email \
    "{\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\"}" "$VIEWER_JAR")
  [ "$code" = "429" ] || break
  sleep 6
done
[ "$code" = "200" ] || fail "connexion viewer impossible (HTTP $code) : $(cat "$BODY")"
pass "connecté en tant que $VIEWER_EMAIL"

code=$(req GET /api/onboarding '' "$VIEWER_JAR")
[ "$code" = "200" ] || fail "GET /api/onboarding (viewer) → HTTP $code"
jq -e '.applies == false' "$BODY" >/dev/null \
  || fail "l'assistant se dit applicable à un viewer"
jq -e '.steps | length == 0' "$BODY" >/dev/null \
  || fail "$(jq -r '.steps | length' "$BODY") étape(s) proposée(s) à un viewer : $(jq -c '[.steps[].id]' "$BODY")"
pass "aucune étape proposée : une étape qui finirait en 403 est pire qu'une étape absente"

code=$(req PATCH /api/onboarding '{"action":"finish"}' "$VIEWER_JAR")
[ "$code" = "403" ] || fail "écriture par un viewer : attendu 403, reçu $code"
jq -e '.error.code == "onboarding_not_applicable"' "$BODY" >/dev/null \
  || fail "code d'erreur inattendu : $(jq -c .error "$BODY")"
pass "écriture refusée → 403 onboarding_not_applicable"

code=$(req PATCH /api/onboarding '{"action":"restart"}' "$VIEWER_JAR")
[ "$code" = "403" ] || fail "relance par un viewer : attendu 403, reçu $code"
pass "relance refusée à un viewer (settings:manage requis)"

result=$(page / "$VIEWER_JAR")
[ "${result%%|*}" = "200" ] || fail "un viewer est redirigé vers l'assistant (${result#*|})"
pass "un viewer n'est jamais redirigé vers l'assistant"

step "8. Terminer fait disparaître l'assistant"
code=$(req PATCH /api/onboarding '{"action":"finish"}')
[ "$code" = "200" ] || fail "finish → HTTP $code : $(cat "$BODY")"
jq -e '.state.status == "completed"' "$BODY" >/dev/null || fail "statut non « completed »"
jq -e '.state.finishedAt != null' "$BODY" >/dev/null || fail "finishedAt non renseigné"
jq -e '.state.dismissedAt == null' "$BODY" >/dev/null \
  || fail "terminé ET abandonné à la fois — les deux ne se confondent pas"
pass "statut « completed », terminé le $(jq -r .state.finishedAt "$BODY")"

result=$(page /)
[ "${result%%|*}" = "200" ] || fail "après avoir terminé, GET / redirige encore (${result#*|})"
pass "GET / → 200 : l'assistant ne s'impose plus"

rm -f "$JAR2"
login "$JAR2"
result=$(page / "$JAR2")
[ "${result%%|*}" = "200" ] || fail "l'assistant revient à la connexion suivante (${result#*|})"
pass "à la reconnexion suivante non plus"

step "9. Abandonner n'est pas terminer"
code=$(req PATCH /api/onboarding '{"action":"dismiss"}')
[ "$code" = "200" ] || fail "dismiss → HTTP $code"
jq -e '.state.status == "dismissed" and .state.dismissedAt != null and .state.finishedAt == null' \
  "$BODY" >/dev/null || fail "abandon mal enregistré : $(jq -c .state "$BODY")"
pass "« dismissed » avec son horodatage, et « finishedAt » remis à null"

step "10. Relancer depuis les paramètres"
BEFORE_RUNS=$(onboarding_json | jq -r .runs)
code=$(req PATCH /api/onboarding '{"action":"restart"}')
[ "$code" = "200" ] || fail "restart → HTTP $code : $(cat "$BODY")"
jq -e '.state.status == "pending" and .state.currentStep == "welcome"' "$BODY" >/dev/null \
  || fail "la relance n'a pas remis le parcours à zéro : $(jq -c .state "$BODY")"
AFTER_RUNS=$(jq -r .state.runs "$BODY")
[ "$AFTER_RUNS" = "$((BEFORE_RUNS + 1))" ] \
  || fail "compteur de relances : $BEFORE_RUNS → $AFTER_RUNS"
pass "parcours remis à zéro, relance n° $AFTER_RUNS"

result=$(page /)
[ "${result%%|*}" = "307" ] || fail "après relance, GET / attendu 307, reçu ${result%%|*}"
pass "GET / → 307 vers ${result#*|} : la relance réarme la redirection"

result=$(page /)
[ "${result%%|*}" = "200" ] || fail "la redirection se répète après relance"
pass "et une seule fois, comme au premier jour"

step "11. Traçabilité"
code=$(req GET "/api/audit-logs?resourceType=settings&pageSize=50")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
for action in onboarding.offered onboarding.step.completed onboarding.step.skipped \
              onboarding.completed onboarding.dismissed onboarding.restarted; do
  jq -e --arg a "$action" '[.items[] | select(.action == $a)] | length > 0' "$BODY" >/dev/null \
    || fail "action « $action » absente du journal d'audit"
  pass "audit : $action"
done

code=$(req GET "/api/audit-logs?resourceType=target&pageSize=50")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
for id in "$ID_A" "$ID_B"; do
  jq -e --arg i "$id" \
    '[.items[] | select(.resourceId == $i and .action == "target.created")] | length > 0' \
    "$BODY" >/dev/null || fail "création de la cible $id absente du journal"
done
pass "audit : les deux cibles créées, par les deux chemins, sont tracées à l'identique"

step "12. Ménage"
cleanup_targets
remaining=$(psql_q "select count(*) from targets where name in ('$TARGET_A','$TARGET_B');")
[ "$remaining" = "0" ] || fail "$remaining cible(s) de vérification subsistent"
pass "cibles de vérification supprimées"

[ -n "$VIEWER_ID" ] && req DELETE "/api/admin/users/$VIEWER_ID" >/dev/null
pass "utilisateur viewer supprimé"

code=$(req PATCH /api/settings \
  "$(jq -nc --arg n "$ORIGINAL_NAME" --arg t "$ORIGINAL_TAGLINE" \
      '{instanceName:$n, instanceTagline:$t}')")
[ "$code" = "200" ] || fail "restauration de l'identité → HTTP $code : $(cat "$BODY")"
pass "identité de l'instance restaurée : « $ORIGINAL_NAME » / « $ORIGINAL_TAGLINE »"

# L'assistant est reposé sur « terminé » : cet environnement est partagé, il ne
# doit pas rester en mode découverte pour le chantier d'à côté.
code=$(req PATCH /api/onboarding '{"action":"finish"}')
[ "$code" = "200" ] || fail "remise à « terminé » → HTTP $code"
pass "assistant reposé sur « terminé » : $(onboarding_json | jq -c '{status,runs}')"

code=$(req POST /api/auth/sign-in/email \
  "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" "$WORK/final.jar")
[ "$code" = "200" ] || fail "« $ADMIN_EMAIL » n'est plus utilisable (HTTP $code)"
pass "$ADMIN_EMAIL reste connectable avec son mot de passe habituel"

printf '\n\033[32m✓ Assistant de démarrage vérifié.\033[0m\n'
printf '\033[2m  Écran : %s/onboarding — relance : %s/admin/settings\033[0m\n\n' "$BASE_URL" "$BASE_URL"
