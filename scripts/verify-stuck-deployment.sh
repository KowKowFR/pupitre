#!/usr/bin/env bash
#
# Vérifie le déblocage d'un déploiement figé.
#
# Le défaut corrigé : quand le worker meurt en pleine exécution et que BullMQ
# finit par abandonner sa tâche, le déploiement reste `running` en base pour
# toujours. La destruction le refuse, la purge le refuse (`in_progress`), et
# l'application qui le porte devient indélébile. Le seul recours était le SQL.
#
#   1. ce qui n'est PAS un fantôme — c'est le test qui compte :
#      a. une tâche qui attend son tour (worker arrêté), même passée la fenêtre
#         de grâce : le détecteur n'est pas une minuterie
#      b. une tâche en cours d'exécution sur un déploiement long
#   2. le fantôme réel : deux redémarrages en vol, BullMQ abandonne la tâche
#      (« job stalled more than allowable limit ») sans jamais appeler notre
#      handler — le worker s'en aperçoit et arrête le déploiement en échec,
#      SANS le rejouer
#   3. le fantôme que rien n'annonce : tâche disparue de la file (Redis n'est
#      qu'un cache ici) — plus aucun événement à écouter, c'est le geste manuel
#      qui tranche
#   4. la permission exigée est `deployment:purge`, vérifiée avec un compte qui
#      a tout sauf elle
#   5. le message enregistré nomme ce qui reste à vérifier sur la cible
#   6. après déblocage, le déploiement se détruit et l'application se supprime
#
# Constat annexe, hors périmètre de ce chantier (il appartient au driver Docker) :
# le « docker compose up --wait » lancé par SSH tourne sur la CIBLE et survit à
# la mort du worker. Il peut remettre son conteneur debout après la destruction.
# Le script le nomme et le nettoie plutôt que de faire semblant de ne pas voir —
# c'est très exactement le résidu que le message enregistré demande d'aller
# vérifier sur la machine.
#
# Le script crée sa propre matière (applications « sd-* », rôle et compte de
# vérification) et la nettoie. L'inventaire de `/api/apps` est comparé avant et
# après : aucune application en service n'est touchée.
#
# La cible « vps » n'est JAMAIS sollicitée. Tout se joue sur
# « cible-de-verification » (le conteneur ssh-target).
#
# Le worker est arrêté et redémarré plusieurs fois : c'est le sujet même du
# test. Comptez une douzaine de minutes.
#
# Usage :
#   ./scripts/verify-stuck-deployment.sh
#   BASE_URL=http://localhost:3200 TARGET_NAME=ma-vm ./scripts/verify-stuck-deployment.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
TARGET_NAME="${TARGET_NAME:-cible-de-verification}"
CLIENT_IP="${CLIENT_IP:-198.51.100.42}"
IMAGE="${IMAGE:-docker.io/library/nginx:1.29-alpine}"

# Deux applications jetables : l'une pour le fantôme constaté, l'autre pour le
# fantôme dont la tâche a disparu.
FIGE_SLUG="${FIGE_SLUG:-sd-fige}"
PERDUE_SLUG="${PERDUE_SLUG:-sd-perdue}"

ROLE_KEY="${ROLE_KEY:-sd-verif-sans-purge}"
LIMITED_EMAIL="${LIMITED_EMAIL:-sd-sans-purge@example.test}"
LIMITED_PASSWORD="${LIMITED_PASSWORD:-motdepasse-tres-long}"

# Fenêtre de grâce du détecteur (STUCK_DEPLOYMENT_GRACE_MS), en secondes.
GRACE_SEC="${GRACE_SEC:-60}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
LJAR="$WORK/limite.jar"
BODY="$WORK/body.json"

# Le worker est arrêté à plusieurs reprises : quoi qu'il arrive, il repart.
cleanup() {
  docker compose start worker >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

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

# Même chose, avec le bocal du compte qui n'a pas `deployment:purge`.
lreq() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -H "x-forwarded-for: $CLIENT_IP" -b "$LJAR" -c "$LJAR")
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }
redis_cli() { docker compose exec -T redis redis-cli "$@"; }
target_docker() { docker compose exec -T ssh-target docker "$@"; }
# Shell sur la cible : `target_docker` préfixe déjà « docker », il ne sait pas
# lancer autre chose.
target_sh() { docker compose exec -T ssh-target sh -c "$1"; }

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

# The account must be an administrator: without that the script would collapse
# much further on a cryptic 403.
assert_admin() {
  local role
  role=$(jq -r '.user.role // empty' "$BODY")
  [ "$role" = "admin" ] && return 0
  fail "\"$ADMIN_EMAIL\" has the role \"${role:-none}\", not \"admin\" — see $BASE_URL/admin/users"
}

# AppSpec courte : le déploiement aboutit en une trentaine de secondes.
spec_courte() {
  jq -n --arg n "$1" --arg i "$IMAGE" \
    '{name:$n, version:"1.0.0", services:[{
        name:"web",
        source:{type:"image", ref:$i},
        port:80,
        exposed:true,
        healthcheck:{path:"/", intervalSec:2, timeoutSec:3, retries:4}
      }]}'
}

# AppSpec LONGUE, et volontairement légitime : le chemin de santé n'existe pas,
# donc `docker compose up --wait` attend que le conteneur devienne sain — ce
# qu'il ne fera jamais — jusqu'à sa borne de cinq minutes. C'est un déploiement
# parfaitement normal qui met longtemps, exactement comme un gros `docker pull`
# ou un build. Le détecteur ne doit surtout pas le prendre pour un mort.
spec_longue() {
  jq -n --arg n "$1" --arg i "$IMAGE" \
    '{name:$n, version:"1.0.0", services:[{
        name:"web",
        source:{type:"image", ref:$i},
        port:80,
        exposed:true,
        healthcheck:{path:"/jamais-la", intervalSec:8, timeoutSec:3, retries:45}
      }]}'
}

upsert_app() {
  local slug="$1" spec="$2" id code
  req GET /api/applications >/dev/null
  id=$(jq -r --arg s "$slug" '.items[] | select(.slug == $s) | .id' "$BODY" | head -1)
  if [ -n "$id" ]; then printf '%s' "$id"; return; fi

  jq -n --argjson spec "$spec" '{appSpec:$spec}' > "$WORK/create.json"
  code=$(req POST /api/applications "@$WORK/create.json")
  [ "$code" = "201" ] || fail "POST /api/applications → HTTP $code : $(cat "$BODY")"
  jq -r .id "$BODY"
}

# Enfile un déploiement. Écho : "<deploymentId> <jobId>".
enqueue() {
  local app_id="$1" target_id="$2" code
  code=$(req POST /api/deployments \
    "{\"applicationId\":\"$app_id\",\"targetId\":\"$target_id\",\"runtime\":\"docker\",\"proxy\":\"traefik\",\"autoRollback\":false}")
  [ "$code" = "202" ] || fail "POST /api/deployments → HTTP $code : $(cat "$BODY")"
  printf '%s %s' "$(jq -r .id "$BODY")" "$(jq -r .jobId "$BODY")"
}

deployment_status() { psql_q "select status from deployments where id = '$1';"; }

# Le verdict du panel sur un déploiement, depuis /api/deployments/stuck.
# Écho : "<ghost> <état de la tâche ou 'aucune'>".
verdict() {
  local id="$1"
  req GET /api/deployments/stuck >/dev/null
  jq -r --arg d "$id" \
    '[.items[] | select(.id == $d)] | if length == 0 then "absent –"
      else "\(.[0].ghost) \(.[0].job.state // "aucune")" end' "$BODY"
}

# Attend qu'une étape donnée soit en cours. Sert à provoquer l'interruption
# pendant l'étape LONGUE, la seule qui laisse le temps à BullMQ de constater
# deux fois que la tâche est bloquée.
wait_step() {
  local id="$1" key="$2" limit="${3:-90}"
  for _ in $(seq 1 "$limit"); do
    if [ "$(psql_q "select status from deployment_steps where deployment_id = '$id' and key = '$key';")" = "running" ]; then
      return 0
    fi
    sleep 2
  done
  fail "l'étape « $key » de $id n'a jamais démarré"
}

started_at_of() { psql_q "select started_at from deployments where id = '$1';"; }

wait_status() {
  local id="$1" want="$2" limit="${3:-90}" seen
  for _ in $(seq 1 "$limit"); do
    seen=$(deployment_status "$id")
    [ "$seen" = "$want" ] && return 0
    sleep 2
  done
  fail "le déploiement $id est resté « $(deployment_status "$id") » au lieu de « $want »"
}

# ─── 1. Contexte ──────────────────────────────────────────────────────────────

step "1. Connexion, cible et inventaire de départ"
login
pass "signed in as $ADMIN_EMAIL"

req GET /api/targets >/dev/null
TARGET_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY")
[ -n "$TARGET_ID" ] || fail "target \"$TARGET_NAME\" not found — run ./scripts/setup-test-target.sh"
TARGET_HOST=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .host' "$BODY")
pass "cible $TARGET_NAME ($TARGET_HOST) — $TARGET_ID"

req GET /api/apps >/dev/null
LIVE_BEFORE=$(jq -r '[.items[].applicationSlug] | sort | join(",")' "$BODY")
pass "applications en service avant : ${LIVE_BEFORE:-aucune}"

# Ménage d'une exécution précédente interrompue.
for slug in "$FIGE_SLUG" "$PERDUE_SLUG"; do
  req GET /api/applications >/dev/null
  stale=$(jq -r --arg s "$slug" '.items[] | select(.slug == $s) | .id' "$BODY" | head -1)
  [ -n "$stale" ] || continue
  # Un reste de ce script peut être figé : on le débloque avant de forcer.
  for d in $(psql_q "select id from deployments where application_id = '$stale' and status in ('pending','running');"); do
    req POST "/api/deployments/$d/unblock" '{}' >/dev/null 2>&1 || true
  done
  req POST "/api/applications/$stale/cascade" "{\"force\":true,\"confirm\":\"$slug\"}" >/dev/null 2>&1 || true
  warn "reste d'une exécution précédente : « $slug » effacée de force"
  sleep 5
done
req DELETE "/api/admin/roles/$ROLE_KEY" >/dev/null 2>&1 || true

# ─── 2. Ce qui n'est PAS un fantôme ───────────────────────────────────────────

step "2. Une tâche qui attend son tour n'est pas un fantôme"
info "worker arrêté : le déploiement restera « pending », sa tâche en file d'attente"

docker compose stop worker >/dev/null
FIGE_ID=$(upsert_app "$FIGE_SLUG" "$(spec_longue "$FIGE_SLUG")")
read -r FIGE_DEPLOY FIGE_JOB <<< "$(enqueue "$FIGE_ID" "$TARGET_ID")"
pass "déploiement $FIGE_DEPLOY enfilé (tâche BullMQ #$FIGE_JOB), worker à l'arrêt"

[ "$(deployment_status "$FIGE_DEPLOY")" = "pending" ] \
  || fail "le déploiement devrait être « pending », il est « $(deployment_status "$FIGE_DEPLOY")»"

read -r GHOST STATE <<< "$(verdict "$FIGE_DEPLOY")"
[ "$GHOST" = "false" ] || fail "un déploiement en attente est pris pour un fantôme"
[ "$STATE" = "wait" ] || fail "état de tâche attendu « wait », obtenu « $STATE »"
pass "verdict : pas un fantôme — la tâche est à l'état « $STATE »"

code=$(req POST "/api/deployments/$FIGE_DEPLOY/unblock" '{}')
[ "$code" = "409" ] || fail "déblocage : attendu 409, reçu $code — $(cat "$BODY")"
jq -e '.error.code == "deployment_not_stuck"' "$BODY" >/dev/null \
  || fail "code d'erreur inattendu : $(jq -c .error.code "$BODY")"
pass "déblocage refusé → $(jq -r '.error.message' "$BODY" | head -c 150)…"

info "on laisse passer la fenêtre de grâce ($GRACE_SEC s) : le verdict ne doit pas changer"
sleep $((GRACE_SEC + 20))
read -r GHOST STATE <<< "$(verdict "$FIGE_DEPLOY")"
[ "$GHOST" = "false" ] || fail "le détecteur a conclu à la mort par simple écoulement du temps"
pass "toujours pas un fantôme après $((GRACE_SEC + 20)) s — le détecteur n'est PAS une minuterie"

step "3. Un déploiement long, réellement en cours, n'est pas un fantôme non plus"
docker compose start worker >/dev/null
wait_status "$FIGE_DEPLOY" running 60
pass "worker relancé, déploiement passé « running »"

# L'étape « Démarrage des services » attend que le conteneur devienne sain :
# cinq minutes de borne. Un déploiement long, mais parfaitement vivant.
wait_step "$FIGE_DEPLOY" deploy 120
read -r GHOST STATE <<< "$(verdict "$FIGE_DEPLOY")"
[ "$STATE" = "active" ] || fail "tâche attendue « active », obtenue « $STATE »"
[ "$GHOST" = "false" ] || fail "un déploiement en cours d'exécution est pris pour un fantôme"
pass "verdict : pas un fantôme — tâche « $STATE », étape « Démarrage des services » (borne : 5 min)"

code=$(req POST "/api/deployments/$FIGE_DEPLOY/unblock" '{}')
[ "$code" = "409" ] || fail "déblocage : attendu 409, reçu $code"
jq -e '.error.details.job.state == "active"' "$BODY" >/dev/null \
  || fail "le refus ne nomme pas l'état de la tâche : $(jq -c .error.details "$BODY")"
pass "déblocage refusé, et le refus dit pourquoi :"
info "$(jq -r '.error.message' "$BODY")"

# ─── 4. Le fantôme réel ───────────────────────────────────────────────────────

step "4. Deux redémarrages en vol : BullMQ abandonne la tâche"
info "un seul redémarrage ne suffit pas — BullMQ récupère la tâche bloquée et la"
info "rejoue. C'est à la SECONDE récupération qu'il dépasse maxStalledCount et la"
info "met en échec SANS appeler notre handler : personne n'écrit alors le verdict."

STARTED_BEFORE=$(started_at_of "$FIGE_DEPLOY")
docker compose restart worker >/dev/null
pass "redémarrage n°1 en pleine étape « Démarrage des services »"

# Preuve de la récupération : `markDeploymentRunning()` réécrit `started_at` à
# chaque démarrage du pipeline. Tant que l'horodatage n'a pas bougé, la tâche
# traîne encore dans `active` sans personne au bout — l'attendre est le seul
# moyen de ne pas confondre « pas encore récupérée » et « récupérée ».
RECOVERED=""
for _ in $(seq 1 60); do
  sleep 5
  if [ "$(started_at_of "$FIGE_DEPLOY")" != "$STARTED_BEFORE" ]; then RECOVERED=oui; break; fi
done
[ -n "$RECOVERED" ] || fail "BullMQ n'a pas récupéré la tâche après le premier redémarrage"
pass "BullMQ a récupéré la tâche tout seul et l'a rejouée — le statut reste « $(deployment_status "$FIGE_DEPLOY") »"
info "au passage : cette reprise automatique redéploie par-dessus ce que la"
info "première passe avait déjà commencé. C'est BullMQ, pas nous ; et c'est"
info "exactement pourquoi le déblocage, lui, ne rejoue jamais rien."

wait_step "$FIGE_DEPLOY" deploy 120
docker compose restart worker >/dev/null
pass "redémarrage n°2, de nouveau en pleine étape « Démarrage des services »"

FAILED_REASON=""
for _ in $(seq 1 60); do
  sleep 5
  FAILED_REASON=$(redis_cli hget "bull:ops:$FIGE_JOB" failedReason | tr -d '\r')
  if [ -n "$FAILED_REASON" ]; then break; fi
done
[ -n "$FAILED_REASON" ] || fail "BullMQ n'a pas abandonné la tâche #$FIGE_JOB en $((60 * 5)) s"
pass "tâche #$FIGE_JOB abandonnée par BullMQ : « $FAILED_REASON »"
if [ "$FAILED_REASON" != "job stalled more than allowable limit" ]; then
  warn "raison inattendue — le test reste valable, la tâche est bien morte"
fi

# C'est ICI que le panel mentait : la tâche est morte, la base dit « running ».
# Le worker écoute son propre événement `failed` et arrête le déploiement.
wait_status "$FIGE_DEPLOY" failed 60
pass "le worker s'en est aperçu : déploiement arrêté à « failed », sans rejeu"

read -r GHOST STATE <<< "$(verdict "$FIGE_DEPLOY")"
[ "$GHOST" = "absent" ] || fail "le déploiement figure encore parmi les déploiements en cours"
pass "il ne figure plus parmi les déploiements « en cours »"

# Le pipeline n'a PAS été rejoué une troisième fois : l'étape sur laquelle il
# s'est arrêté est marquée en échec, le reste est sauté.
FAILED_STEP=$(psql_q "select failed_step from deployments where id = '$FIGE_DEPLOY';")
SKIPPED=$(psql_q "select count(*) from deployment_steps where deployment_id = '$FIGE_DEPLOY' and status = 'skipped';")
pass "arrêté sur l'étape « $FAILED_STEP », $SKIPPED étape(s) sautée(s)"

step "5. Le message enregistré dit ce qui reste à vérifier sur la cible"
MESSAGE=$(psql_q "select error from deployments where id = '$FIGE_DEPLOY';")
printf '\n\033[2m%s\033[0m\n\n' "$MESSAGE"

for needle in "app-$FIGE_SLUG" "$TARGET_NAME" "$TARGET_HOST" "Détruisez"; do
  grep -qF -- "$needle" <<< "$MESSAGE" || fail "le message ne mentionne pas « $needle »"
  pass "le message nomme « $needle »"
done
grep -qF "job stalled more than allowable limit" <<< "$MESSAGE" \
  || fail "le message ne dit pas ce que BullMQ a fait de la tâche"
pass "le message dit pourquoi c'est définitif, pas seulement « interrompu »"

PORT=$(psql_q "select coalesce(d.published_port, p.port) from deployments d
  left join port_allocations p on p.target_id = d.target_id and p.application_id = d.application_id
  where d.id = '$FIGE_DEPLOY';")
if [ -n "$PORT" ]; then
  grep -qF "$PORT" <<< "$MESSAGE" || fail "le message ne nomme pas le port $PORT resté réservé"
  pass "le message nomme le port $PORT, encore réservé à cette application"
fi

# Le journal d'activité porte la même trace, écrite par le worker.
code=$(req GET "/api/audit-logs?resourceType=deployment&pageSize=25")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
jq -e --arg d "$FIGE_DEPLOY" \
  '[.items[] | select(.action == "deployment.unblocked" and .resourceId == $d)] | length > 0' \
  "$BODY" >/dev/null || fail "aucune entrée « deployment.unblocked » pour $FIGE_DEPLOY"
pass "logs d'activité : deployment.unblocked"

# ─── 6. Après déblocage, l'application redevient supprimable ──────────────────

step "6. Après déblocage : destruction possible, puis suppression de l'application"

# Le déploiement s'était arrêté APRÈS le démarrage des services : le panel
# considère toujours que la cible porte peut-être quelque chose, et refuse donc
# d'effacer l'application sans passer par la destruction. C'est voulu — c'est
# précisément ce que le message demande de faire.
code=$(req DELETE "/api/applications/$FIGE_ID")
[ "$code" = "409" ] || fail "suppression sans destruction : attendu 409, reçu $code"
pass "suppression encore refusée → $(jq -r '.error.code' "$BODY") (des conteneurs peuvent tourner)"

code=$(req DELETE "/api/deployments/$FIGE_DEPLOY")
[ "$code" = "202" ] || fail "DELETE /api/deployments/$FIGE_DEPLOY → HTTP $code : $(cat "$BODY")"
pass "destruction enfilée — c'était impossible tant que le statut disait « en cours »"
wait_status "$FIGE_DEPLOY" destroyed 90

code=$(req DELETE "/api/applications/$FIGE_ID")
[ "$code" = "200" ] || fail "suppression de l'application → HTTP $code : $(cat "$BODY")"
pass "application « $FIGE_SLUG » supprimée — la boucle est bouclée"

# Résidu connu, et c'est précisément ce dont parle le message enregistré : le
# `docker compose up --wait` lancé par SSH survit à la mort du worker (il tourne
# sur la CIBLE, pas dans le worker) et peut remettre son conteneur debout après
# la destruction. Le panel ne peut pas le savoir d'ici — il le dit, et c'est
# tout ce qu'on lui demande. On laisse un peu de temps, puis on nomme le résidu
# et on le nettoie à la main, comme un opérateur le ferait.
LEFTOVER=""
for _ in $(seq 1 15); do
  if target_docker ps -a --format '{{.Names}}' | grep -q "^app-$FIGE_SLUG"; then
    LEFTOVER=oui; sleep 4
  else
    LEFTOVER=""; break
  fi
done
if [ -n "$LEFTOVER" ]; then
  warn "un conteneur « app-$FIGE_SLUG » subsiste sur $TARGET_NAME — exactement le"
  info "résidu que le message annonçait. Origine : un « docker compose up --wait »"
  info "orphelin, lancé par SSH et resté vivant sur la cible après la mort du worker :"
  target_sh "ps aux | grep -F 'compose up -d --remove-orphans' | grep -v grep" || true
  target_sh "pkill -f 'compose up -d --remove-orphans'" || true
  target_docker rm -f "app-$FIGE_SLUG-web-1" >/dev/null 2>&1 || true
  pass "résidu nettoyé à la main — le panel avait dit où regarder"
else
  pass "plus aucun conteneur « app-$FIGE_SLUG » sur $TARGET_NAME"
fi

# ─── 7. Le fantôme dont la tâche a disparu ────────────────────────────────────

step "7. Tâche disparue de la file : c'est le geste manuel qui tranche"
info "Redis n'est qu'un cache ici — la base est la source de vérité. Une tâche"
info "perdue (Redis vidé, rétention, éviction) ne produit aucun événement : le"
info "worker n'a rien à écouter, personne ne viendra."

docker compose stop worker >/dev/null
PERDUE_ID=$(upsert_app "$PERDUE_SLUG" "$(spec_courte "$PERDUE_SLUG")")
read -r PERDUE_DEPLOY PERDUE_JOB <<< "$(enqueue "$PERDUE_ID" "$TARGET_ID")"
pass "déploiement $PERDUE_DEPLOY enfilé (tâche #$PERDUE_JOB), worker à l'arrêt"

redis_cli lrem bull:ops:wait 0 "$PERDUE_JOB" >/dev/null
redis_cli del "bull:ops:$PERDUE_JOB" >/dev/null
[ "$(redis_cli exists "bull:ops:$PERDUE_JOB" | tr -d '\r')" = "0" ] \
  || fail "la tâche #$PERDUE_JOB est toujours dans Redis"
pass "tâche #$PERDUE_JOB effacée de la file — la base, elle, dit toujours « pending »"

docker compose start worker >/dev/null
sleep 10
[ "$(deployment_status "$PERDUE_DEPLOY")" = "pending" ] \
  || fail "le déploiement a bougé : $(deployment_status "$PERDUE_DEPLOY")"
pass "worker relancé : rien ne reprend ce déploiement, il reste « pending »"

info "on attend la fenêtre de grâce avant de conclure"
sleep $((GRACE_SEC + 10))
read -r GHOST STATE <<< "$(verdict "$PERDUE_DEPLOY")"
[ "$GHOST" = "true" ] || fail "le fantôme n'est pas détecté (ghost=$GHOST, tâche=$STATE)"
[ "$STATE" = "aucune" ] || fail "une tâche subsiste : $STATE"
pass "verdict : fantôme avéré — aucune tâche exécutable ne le porte"

# ─── 8. La permission ─────────────────────────────────────────────────────────

step "8. Le déblocage exige « deployment:purge »"
info "il ne touche pas la machine : il corrige un enregistrement, comme la purge."

# Un rôle qui a TOUT sur les déploiements sauf la purge.
code=$(req POST /api/admin/roles \
  "{\"key\":\"$ROLE_KEY\",\"label\":\"Vérification sans purge\",\"permissions\":[\"application:read\",\"target:read\",\"deployment:read\",\"deployment:create\",\"deployment:rollback\",\"deployment:destroy\"]}")
case "$code" in
  201) pass "rôle « $ROLE_KEY » créé : tout sur les déploiements SAUF deployment:purge" ;;
  409) pass "role \"$ROLE_KEY\" already present" ;;
  *)   fail "POST /api/admin/roles → HTTP $code : $(cat "$BODY")" ;;
esac

code=$(req POST /api/admin/users \
  "{\"name\":\"Sans purge\",\"email\":\"$LIMITED_EMAIL\",\"password\":\"$LIMITED_PASSWORD\",\"role\":\"$ROLE_KEY\"}")
case "$code" in
  201|409) pass "compte « $LIMITED_EMAIL » disponible" ;;
  *) fail "POST /api/admin/users → HTTP $code : $(cat "$BODY")" ;;
esac
LIMITED_ID=$(psql_q "select id from users where email = '$LIMITED_EMAIL';")

code=$(lreq POST /api/auth/sign-in/email \
  "{\"email\":\"$LIMITED_EMAIL\",\"password\":\"$LIMITED_PASSWORD\"}")
[ "$code" = "200" ] || fail "connexion du compte limité → HTTP $code : $(cat "$BODY")"
pass "connecté en tant que $LIMITED_EMAIL"

code=$(lreq POST "/api/deployments/$PERDUE_DEPLOY/unblock" '{}')
[ "$code" = "403" ] || fail "déblocage sans permission : attendu 403, reçu $code — $(cat "$BODY")"
jq -e '.error.details.permission == "deployment:purge"' "$BODY" >/dev/null \
  || fail "la permission exigée n'est pas nommée : $(jq -c .error "$BODY")"
pass "refusé → 403, permission « deployment:purge » exigée"

# Et détruire ne suffit pas non plus : le statut « pending » bloque toujours.
code=$(lreq DELETE "/api/deployments/$PERDUE_DEPLOY")
[ "$code" = "409" ] || fail "destruction d'un déploiement en cours : attendu 409, reçu $code"
pass "deployment:destroy ne débloque rien : la destruction refuse toujours un « en cours »"

code=$(req PATCH "/api/admin/roles/$ROLE_KEY" \
  '{"permissions":["application:read","target:read","deployment:read","deployment:create","deployment:rollback","deployment:destroy","deployment:purge"]}')
[ "$code" = "200" ] || fail "PATCH rôle → HTTP $code : $(cat "$BODY")"
pass "« deployment:purge » accordée au rôle"

code=$(lreq POST "/api/deployments/$PERDUE_DEPLOY/unblock" '{}')
[ "$code" = "200" ] || fail "déblocage avec la permission → HTTP $code : $(cat "$BODY")"
jq -e '.status == "failed"' "$BODY" >/dev/null || fail "statut inattendu : $(jq -c .status "$BODY")"
pass "déblocage accepté par le même compte, une permission plus tard"
PERDUE_MESSAGE=$(jq -r .error "$BODY")
printf '\n\033[2m%s\033[0m\n\n' "$PERDUE_MESSAGE"

jq -e 'has("mayHaveStartedServices")' "$BODY" >/dev/null \
  || fail "la réponse ne dit pas si des services ont pu démarrer"
grep -qF "app-$PERDUE_SLUG" <<< "$PERDUE_MESSAGE" \
  || fail "le message ne nomme pas le projet « app-$PERDUE_SLUG »"
pass "le message nomme le projet et la cible à vérifier"

[ "$(deployment_status "$PERDUE_DEPLOY")" = "failed" ] \
  || fail "la base n'a pas suivi : $(deployment_status "$PERDUE_DEPLOY")"
pass "en base : « failed »"

# Deux fois de suite : le second appel n'a plus rien à débloquer.
code=$(req POST "/api/deployments/$PERDUE_DEPLOY/unblock" '{}')
[ "$code" = "409" ] || fail "second déblocage : attendu 409, reçu $code"
pass "un second déblocage ne réécrit rien → 409"

# ─── 9. Ménage ────────────────────────────────────────────────────────────────

step "9. Cleanup"

code=$(req POST "/api/applications/$PERDUE_ID/cascade" "{\"confirm\":\"$PERDUE_SLUG\"}")
if [ "$code" = "202" ]; then
  JOB=$(jq -r .jobId "$BODY")
  for _ in $(seq 1 60); do
    sleep 2
    req GET "/api/applications/$PERDUE_ID/cascade?jobId=$JOB" >/dev/null
    if [ "$(jq -r '.state // empty' "$BODY")" = "completed" ]; then break; fi
  done
  pass "application « $PERDUE_SLUG » supprimée en cascade"
else
  req DELETE "/api/applications/$PERDUE_ID" >/dev/null
  pass "application « $PERDUE_SLUG » supprimée"
fi

req PATCH "/api/admin/users/$LIMITED_ID/role" '{"role":"viewer"}' >/dev/null
req DELETE "/api/admin/users/$LIMITED_ID" >/dev/null
req DELETE "/api/admin/roles/$ROLE_KEY" >/dev/null
pass "compte et rôle de vérification supprimés"

target_sh "pkill -f 'compose up -d --remove-orphans'" >/dev/null 2>&1 || true
for slug in "$FIGE_SLUG" "$PERDUE_SLUG"; do
  if target_docker ps -a --format '{{.Names}}' | grep -q "^app-$slug"; then
    target_docker rm -f "app-$slug-web-1" >/dev/null 2>&1 || true
    warn "conteneur « app-$slug » retiré à la main (processus distant orphelin)"
  fi
done
if target_docker ps -a --format '{{.Names}}' | grep -qE "^app-($FIGE_SLUG|$PERDUE_SLUG)"; then
  fail "un conteneur de vérification résiste sur $TARGET_NAME"
fi
pass "aucun conteneur de vérification sur $TARGET_NAME"

LEFT=$(psql_q "select count(*) from deployments d join applications a on a.id = d.application_id
  where a.slug in ('$FIGE_SLUG', '$PERDUE_SLUG');")
[ "$LEFT" = "0" ] || fail "$LEFT déploiement(s) de vérification subsistent en base"
pass "aucune ligne de déploiement de vérification en base"

req GET /api/apps >/dev/null
LIVE_AFTER=$(jq -r '[.items[].applicationSlug] | sort | join(",")' "$BODY")
[ "$LIVE_AFTER" = "$LIVE_BEFORE" ] \
  || fail "l'inventaire des applications en service a changé : « $LIVE_BEFORE » → « $LIVE_AFTER »"
pass "applications en service inchangées : ${LIVE_AFTER:-aucune}"

docker compose start worker >/dev/null 2>&1 || true
printf '\n\033[32m✓ Déblocage des déploiements figés vérifié.\033[0m\n'
printf '\033[2m  Écran : %s/deployments\033[0m\n\n' "$BASE_URL"
