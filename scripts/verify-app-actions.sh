#!/usr/bin/env bash
#
# Les gestes d'exploitation d'une application en marche, sur les DEUX runtimes.
#
#   1. Arrêter    → les processus s'arrêtent, rien n'est démonté : les données
#                   du volume survivent, le port reste réservé, l'adresse cesse
#                   de répondre. En Compose les conteneurs restent `exited` ; en
#                   K3s les Deployments passent à zéro réplique et les PVC,
#                   Service et Ingress restent en place.
#   2. Démarrer   → la même version repart, le port est repris, les données sont
#                   toujours là, la santé redevient `healthy`.
#   3. Les refus  → arrêter deux fois, démarrer ce qui tourne, redémarrer ce qui
#                   est arrêté, revenir en arrière sans version précédente :
#                   quatre 409 qui nomment la raison, pas quatre boutons morts.
#   4. Le RBAC    → un observateur reçoit 403 sur `deployment:restart`, et le
#                   refus est dans le journal d'activité.
#   5. L'audit    → `app.stop.requested`, `app.stopped`, `app.start.requested`,
#                   `app.started` avec l'acteur et l'IP.
#   6. Détruire   → depuis l'écran de l'application, c'est la route du
#                   déploiement qui est appelée : plus rien sur la machine, port
#                   rendu, namespace disparu.
#
# Le script emprunte exactement les mêmes routes que l'interface.
#
# Prérequis : une cible Docker et une cible K3s déployables.
#   ./scripts/setup-test-target.sh   provisionne la première
#   docs/getting-started.md          explique la seconde
#
# Usage :
#   ./scripts/verify-app-actions.sh
#   BASE_URL=http://localhost:3006 ./scripts/verify-app-actions.sh
#   ONLY=docker ./scripts/verify-app-actions.sh      # un seul runtime
#
# Relançable : les applications de test sont détruites en fin de course, et
# recréées à chaque passage.
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
VIEWER_EMAIL="${VIEWER_EMAIL:-viewer@example.test}"
VIEWER_PASSWORD="${VIEWER_PASSWORD:-motdepasse-tres-long}"
DOCKER_TARGET="${DOCKER_TARGET:-cible-de-verification}"
K3S_TARGET="${K3S_TARGET:-cible-k3s}"
# Conteneurs portant les cibles de test : servent aux contrôles « au plus près »,
# ceux qui regardent la machine et non la base du panel.
DOCKER_CONTAINER="${DOCKER_CONTAINER:-pupitre-ssh-target-1}"
K3S_CONTAINER="${K3S_CONTAINER:-pupitre-k3s-target-1}"
# Port par lequel le poste joint l'Ingress de la cible K3s.
K3S_HTTP_PORT="${K3S_HTTP_PORT:-8080}"
CLIENT_IP="${CLIENT_IP:-198.51.100.77}"
# `docker`, `k3s`, ou vide pour les deux.
ONLY="${ONLY:-}"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
VIEWER_JAR="$WORK/viewer.jar"
BODY="$WORK/body.json"
trap 'rm -rf "$WORK"' EXIT

command -v jq >/dev/null || { echo "jq est requis"; exit 1; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
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

# ─── connexion ────────────────────────────────────────────────────────────────

login() {
  local code
  for _ in 1 2 3 4 5; do
    code=$(req POST /api/auth/sign-in/email \
      "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
    case "$code" in
      200) break ;;
      429) sleep 6 ;;
      *)
        code=$(req POST /api/auth/sign-up/email \
          "{\"name\":\"Admin\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
        [ "$code" = "200" ] || fail "connexion impossible (HTTP $code) : $(cat "$BODY")"
        break
        ;;
    esac
  done
  [ "$(jq -r '.user.role // empty' "$BODY")" = "admin" ] \
    || fail "« $ADMIN_EMAIL » n'est pas administrateur — relancez avec un compte admin"
}

# ─── helpers métier ───────────────────────────────────────────────────────────

# AppSpec minimale, avec un volume : c'est lui qui prouve que l'arrêt ne perd
# rien. `ingress_host` vide = exposition par port publié (Docker).
spec_json() {
  local name="$1" ingress_host="$2"
  jq -n --arg n "$name" --arg h "$ingress_host" '
    {
      name: $n,
      version: "1.0.0",
      services: [{
        name: "web",
        source: { type: "image", ref: "docker.io/library/nginx:1.29-alpine" },
        port: 80,
        exposed: true,
        volumes: [{ name: "donnees", mountPath: "/data", size: "1Gi" }],
        healthcheck: { path: "/", intervalSec: 2, timeoutSec: 3, retries: 6 }
      }]
    }
    + (if $h == "" then {} else { ingress: { host: $h, tls: false, targetService: "web" } } end)'
}

upsert_app() {
  local slug="$1" spec="$2" id code
  req GET /api/applications >/dev/null
  id=$(jq -r --arg s "$slug" '.items[] | select(.slug == $s) | .id' "$BODY" | head -1)

  if [ -n "$id" ]; then
    jq -n --argjson spec "$spec" '{appSpec:$spec}' > "$WORK/patch.json"
    code=$(req PATCH "/api/applications/$id" "@$WORK/patch.json")
    [ "$code" = "200" ] || fail "PATCH /api/applications/$id → HTTP $code : $(cat "$BODY")"
    printf '%s' "$id"
    return
  fi

  jq -n --argjson spec "$spec" '{appSpec:$spec}' > "$WORK/create.json"
  code=$(req POST /api/applications "@$WORK/create.json")
  [ "$code" = "201" ] || fail "POST /api/applications → HTTP $code : $(cat "$BODY")"
  jq -r .id "$BODY"
}

deploy_and_wait() {
  local app_id="$1" target_id="$2" runtime="$3" code id status
  code=$(req POST /api/deployments \
    "{\"applicationId\":\"$app_id\",\"targetId\":\"$target_id\",\"runtime\":\"$runtime\",\"proxy\":\"traefik\",\"autoRollback\":false}")
  [ "$code" = "202" ] || fail "POST /api/deployments → HTTP $code : $(cat "$BODY")"
  id=$(jq -r .id "$BODY")

  for _ in $(seq 1 180); do
    sleep 2
    req GET "/api/deployments/$id" >/dev/null
    status=$(jq -r .status "$BODY")
    case "$status" in
      success|failed|rolled_back|destroyed) printf '%s %s' "$id" "$status"; return ;;
    esac
  done
  fail "le déploiement $id n'a pas abouti en 6 minutes (statut « $status »)"
}

deployment_log() {
  req GET "/api/deployments/$1" >/dev/null
  jq -r '[.steps[].log] | join("")' "$BODY"
}

# État lu par la même route que l'écran : `GET /api/apps/:id/state`.
app_state() {
  local code
  code=$(req GET "/api/apps/$1/state")
  [ "$code" = "200" ] || fail "GET /api/apps/$1/state → HTTP $code : $(cat "$BODY")"
}

# Enfile un geste, puis attend que l'état bascule.
#
# Plusieurs essais sont prévus, et c'est un aveu assumé : en développement, deux
# arbres de travail peuvent faire tourner chacun leur worker sur le même Redis,
# et celui qui ne connaît pas le nom de la tâche la refuse au lieu de la rendre.
# Avec un seul worker — le cas normal —, le premier essai suffit toujours.
#
# Un 409 en cours de route n'est pas un échec : c'est la preuve qu'un essai
# précédent a fini par prendre. On revérifie l'état avant de conclure.
GESTURE_ATTEMPTS="${GESTURE_ATTEMPTS:-4}"

gesture_and_wait() {
  local deployment_id="$1" path="$2" expect="$3" attempt code
  for attempt in $(seq 1 "$GESTURE_ATTEMPTS"); do
    code=$(req POST "/api/apps/$deployment_id/$path")
    if [ "$code" = "409" ]; then
      app_state "$deployment_id"
      jq -e "$expect" "$BODY" >/dev/null && return 0
      fail "POST /api/apps/$deployment_id/$path → 409 : $(jq -r '.error.message' "$BODY")"
    fi
    [ "$code" = "202" ] || fail "POST /api/apps/$deployment_id/$path → HTTP $code : $(cat "$BODY")"

    for _ in $(seq 1 25); do
      sleep 2
      app_state "$deployment_id"
      if jq -e "$expect" "$BODY" >/dev/null; then return 0; fi
    done
    warn "« $path » sans effet en 50 s (essai $attempt) — on redemande"
  done
  fail "le geste « $path » n'a rien changé : $(jq -c '{stoppedAt,status}' "$BODY")"
}

# Refus attendu : le code ET le motif, parce qu'un 409 muet ne vaut rien.
expect_conflict() {
  local method="$1" path="$2" needle="$3" code
  code=$(req "$method" "$path")
  [ "$code" = "409" ] || fail "$method $path : attendu 409, reçu $code — $(cat "$BODY")"
  jq -e --arg n "$needle" '.error.message | test($n)' "$BODY" >/dev/null \
    || fail "$method $path : message inattendu — $(jq -r '.error.message' "$BODY")"
  pass "409 — $(jq -r '.error.message' "$BODY")"
}

# Code HTTP, ou 000 quand rien ne répond. `curl -w` imprime déjà « 000 » sur une
# connexion refusée, mais il sort en erreur : sans ce garde-fou, `set -e`
# arrêterait le script au moment précis où l'absence de réponse est le résultat
# attendu.
http_code() {
  local url="$1" host="${2:-}" out
  local args=(-s -o /dev/null -w '%{http_code}' --max-time 10 "$url")
  [ -n "$host" ] && args+=(-H "Host: $host")
  out=$(curl "${args[@]}" 2>/dev/null || true)
  printf '%s' "${out:-000}"
}

on_docker() { docker exec "$DOCKER_CONTAINER" sh -c "$1"; }
on_k3s() { docker exec "$K3S_CONTAINER" sh -c "$1"; }

# Le journal se filtre par action côté serveur ; le tri par ressource se fait
# ici, `auditQuerySchema` n'exposant pas `resourceId`.
audit_count() {
  local action="$1" resource="$2" code
  code=$(req GET "/api/audit-logs?action=$action&pageSize=100")
  [ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code : $(cat "$BODY")"
  jq -r --arg r "$resource" '[.items[] | select(.resourceId == $r)] | length' "$BODY"
}

# ─── 0. Contexte ──────────────────────────────────────────────────────────────

step "0. Le panel répond, et l'on s'y connecte"
code=$(req GET /api/health)
[ "$code" = "200" ] || fail "GET /api/health → HTTP $code"
pass "/api/health → $(jq -c '{status,db,redis}' "$BODY")"
login
pass "connecté en tant que $ADMIN_EMAIL"

req GET /api/targets >/dev/null
DOCKER_TARGET_ID=$(jq -r --arg n "$DOCKER_TARGET" '.items[] | select(.name == $n) | .id' "$BODY")
K3S_TARGET_ID=$(jq -r --arg n "$K3S_TARGET" '.items[] | select(.name == $n) | .id' "$BODY")

RUNTIMES=""
if [ "$ONLY" = "" ] || [ "$ONLY" = "docker" ]; then
  [ -n "$DOCKER_TARGET_ID" ] || fail "cible « $DOCKER_TARGET » introuvable"
  RUNTIMES="docker"
  pass "cible Docker « $DOCKER_TARGET » — $DOCKER_TARGET_ID"
fi
if [ "$ONLY" = "" ] || [ "$ONLY" = "k3s" ]; then
  [ -n "$K3S_TARGET_ID" ] || fail "cible « $K3S_TARGET » introuvable"
  RUNTIMES="$RUNTIMES k3s"
  pass "cible K3s « $K3S_TARGET » — $K3S_TARGET_ID"
fi

# ─── la même séquence, sur chaque runtime ─────────────────────────────────────

for RUNTIME in $RUNTIMES; do
  if [ "$RUNTIME" = "docker" ]; then
    SLUG="geste-docker"; TARGET_ID="$DOCKER_TARGET_ID"; TARGET_NAME="$DOCKER_TARGET"
    INGRESS_HOST=""
  else
    SLUG="geste-k3s"; TARGET_ID="$K3S_TARGET_ID"; TARGET_NAME="$K3S_TARGET"
    INGRESS_HOST="geste-k3s.localtest.me"
  fi
  NAMESPACE="app-$SLUG"

  step "── $RUNTIME ──  1. Une application en marche sur « $TARGET_NAME »"
  APP_ID=$(upsert_app "$SLUG" "$(spec_json "$SLUG" "$INGRESS_HOST")")
  read -r DEPLOY_ID STATUS <<< "$(deploy_and_wait "$APP_ID" "$TARGET_ID" "$RUNTIME")"
  [ "$STATUS" = "success" ] \
    || fail "$SLUG : statut « $STATUS » — $(deployment_log "$DEPLOY_ID" | tail -c 800)"

  app_state "$DEPLOY_ID"
  PORT=$(jq -r '.publishedPort // empty' "$BODY")
  jq -e '.stoppedAt == null' "$BODY" >/dev/null || fail "une application neuve est déclarée arrêtée"
  pass "$SLUG déployée — déploiement $DEPLOY_ID${PORT:+, port $PORT}"

  # Une marque écrite dans le volume : c'est elle qui dira, après l'arrêt et le
  # redémarrage, si les données ont survécu. Un décompte de conteneurs ne le
  # prouve pas.
  MARK="marque-$(date +%s)"
  if [ "$RUNTIME" = "docker" ]; then
    CONTAINER=$(on_docker "docker ps -q --filter label=com.docker.compose.project=$NAMESPACE" | head -1)
    [ -n "$CONTAINER" ] || fail "aucun conteneur pour le projet $NAMESPACE"
    on_docker "docker exec $CONTAINER sh -c 'echo $MARK > /data/marque'" >/dev/null
  else
    on_k3s "kubectl -n $NAMESPACE exec deploy/web -- sh -c 'echo $MARK > /data/marque'" >/dev/null
  fi
  pass "marque « $MARK » écrite dans le volume"

  if [ "$RUNTIME" = "docker" ]; then
    HTTP=$(http_code "http://127.0.0.1:$PORT")
    [ "$HTTP" = "200" ] || fail "http://127.0.0.1:$PORT → HTTP $HTTP"
    pass "l'adresse répond — HTTP 200 sur le port $PORT"
  else
    HTTP=$(http_code "http://127.0.0.1:$K3S_HTTP_PORT/" "$INGRESS_HOST")
    if [ "$HTTP" = "200" ]; then
      pass "l'Ingress répond — HTTP 200 sur $INGRESS_HOST"
    else
      warn "l'Ingress répond HTTP $HTTP depuis le poste — contrôle reporté sur les pods"
    fi
  fi

  # ─── 2. Arrêter ─────────────────────────────────────────────────────────────

  step "── $RUNTIME ──  2. Arrêter"
  gesture_and_wait "$DEPLOY_ID" stop '.stoppedAt != null'
  pass "arrêtée — stoppedAt = $(jq -r .stoppedAt "$BODY")"

  jq -e '.status == "success"' "$BODY" >/dev/null \
    || fail "le statut du déploiement a bougé : $(jq -r .status "$BODY") — un arrêt n'est pas une issue"
  pass "le statut du déploiement reste « success » : arrêter n'est pas défaire"

  if [ "$RUNTIME" = "docker" ]; then
    STATES=$(on_docker "docker ps -a --filter label=com.docker.compose.project=$NAMESPACE --format '{{.State}}'" | tr '\n' ' ')
    printf '%s' "$STATES" | grep -q 'exited' \
      || fail "les conteneurs de $NAMESPACE ne sont pas à l'arrêt : « $STATES »"
    printf '%s' "$STATES" | grep -q 'running' \
      && fail "un conteneur de $NAMESPACE tourne encore : « $STATES »"
    pass "conteneurs à l'état « exited » — ils ne sont pas supprimés"

    VOLUMES=$(on_docker "docker volume ls -q --filter label=com.docker.compose.project=$NAMESPACE" | wc -l | tr -d ' ')
    [ "$VOLUMES" -ge 1 ] || fail "les volumes de $NAMESPACE ont disparu"
    pass "$VOLUMES volume(s) toujours en place"

    HTTP=$(http_code "http://127.0.0.1:$PORT")
    [ "$HTTP" = "000" ] || fail "le port $PORT répond encore (HTTP $HTTP) après l'arrêt"
    pass "le port $PORT ne répond plus — la liaison est rendue avec le conteneur"
  else
    REPLICAS=$(on_k3s "kubectl -n $NAMESPACE get deploy -o jsonpath='{.items[*].spec.replicas}'" | tr -d ' ')
    [ "$REPLICAS" = "0" ] || fail "les Deployments ne sont pas à zéro réplique : « $REPLICAS »"
    pass "Deployments à zéro réplique"

    PODS=$(on_k3s "kubectl -n $NAMESPACE get pods --no-headers 2>/dev/null | wc -l" | tr -d ' ')
    [ "$PODS" = "0" ] || fail "$PODS pod(s) subsistent dans $NAMESPACE"
    pass "plus aucun pod dans $NAMESPACE"

    KEPT=$(on_k3s "kubectl -n $NAMESPACE get pvc,svc,ingress --no-headers 2>/dev/null | wc -l" | tr -d ' ')
    [ "$KEPT" -ge 3 ] || fail "PVC, Service ou Ingress ont disparu (il en reste $KEPT)"
    pass "PVC, Service et Ingress conservés ($KEPT objets)"

    HTTP=$(http_code "http://127.0.0.1:$K3S_HTTP_PORT/" "$INGRESS_HOST")
    [ "$HTTP" != "200" ] || fail "l'Ingress sert encore l'application après l'arrêt"
    pass "l'Ingress ne sert plus l'application (HTTP $HTTP) — l'objet reste, la charge est partie"
  fi

  # Le port reste réservé : personne d'autre ne doit pouvoir le prendre.
  if [ "$RUNTIME" = "docker" ]; then
    req GET "/api/targets/$TARGET_ID/ports" >/dev/null
    jq -e --argjson p "$PORT" --arg s "$SLUG" \
      '[.allocations[] | select(.port == $p and .applicationSlug == $s)] | length == 1' "$BODY" \
      >/dev/null || fail "la réservation du port $PORT a été rendue pendant l'arrêt"
    pass "le port $PORT reste réservé à « $SLUG » pendant l'arrêt"
  fi

  step "── $RUNTIME ──  3. Les refus"
  expect_conflict POST "/api/apps/$DEPLOY_ID/stop" 'déjà arrêtée'
  expect_conflict POST "/api/apps/$DEPLOY_ID/restart" 'démarrez-la'

  # ─── 4. Démarrer ────────────────────────────────────────────────────────────

  step "── $RUNTIME ──  4. Démarrer"
  gesture_and_wait "$DEPLOY_ID" start '.stoppedAt == null'
  pass "démarrée — stoppedAt de nouveau nul"

  expect_conflict POST "/api/apps/$DEPLOY_ID/start" "n'est pas arrêtée"

  if [ "$RUNTIME" = "docker" ]; then
    CONTAINER=$(on_docker "docker ps -q --filter label=com.docker.compose.project=$NAMESPACE" | head -1)
    [ -n "$CONTAINER" ] || fail "aucun conteneur en marche après le démarrage"
    READ_BACK=$(on_docker "docker exec $CONTAINER cat /data/marque" | tr -d '\r\n')
    HTTP=$(http_code "http://127.0.0.1:$PORT")
  else
    READ_BACK=$(on_k3s "kubectl -n $NAMESPACE exec deploy/web -- cat /data/marque" | tr -d '\r\n')
    HTTP=$(http_code "http://127.0.0.1:$K3S_HTTP_PORT/" "$INGRESS_HOST")
  fi

  [ "$READ_BACK" = "$MARK" ] \
    || fail "la marque du volume a été perdue : « $READ_BACK » au lieu de « $MARK »"
  pass "la marque « $MARK » est intacte — l'arrêt n'a rien perdu"

  if [ "$HTTP" = "200" ]; then
    pass "l'adresse répond de nouveau — HTTP 200"
  elif [ "$RUNTIME" = "k3s" ]; then
    warn "l'Ingress répond HTTP $HTTP depuis le poste"
  else
    fail "le port $PORT ne répond pas après le démarrage (HTTP $HTTP)"
  fi

  app_state "$DEPLOY_ID"
  jq -e --argjson p "${PORT:-null}" '.publishedPort == $p' "$BODY" >/dev/null \
    || fail "le port publié a changé : $(jq -r .publishedPort "$BODY")"
  pass "même version, même port : le démarrage n'a rien redéployé"

  # ─── 5. L'audit ─────────────────────────────────────────────────────────────

  step "── $RUNTIME ──  5. Le journal d'activité"
  # L'entrée d'audit est écrite par le worker **après** le geste et sa sonde de
  # santé : elle arrive quelques secondes après la bascule d'état que l'on a
  # attendue. On lui laisse ce délai plutôt que de courser le worker.
  for action in app.stop.requested app.stopped app.start.requested app.started; do
    COUNT=0
    for _ in $(seq 1 15); do
      COUNT=$(audit_count "$action" "$DEPLOY_ID")
      [ "$COUNT" -ge 1 ] && break
      sleep 2
    done
    [ "$COUNT" -ge 1 ] || fail "aucune entrée « $action » pour $DEPLOY_ID"
    pass "$action — $COUNT entrée(s)"
  done
  req GET "/api/audit-logs?action=app.stopped&pageSize=100" >/dev/null
  jq -e --arg r "$DEPLOY_ID" --arg ip "$CLIENT_IP" \
    '[.items[] | select(.resourceId == $r)][0] | .ip == $ip and .actorEmail != null' "$BODY" \
    >/dev/null || fail "l'acteur ou son IP manquent dans l'audit : $(jq -c '.items[0]' "$BODY")"
  pass "l'acteur et son IP sont tracés — $(jq -rc --arg r "$DEPLOY_ID" '[.items[] | select(.resourceId == $r)][0] | {actorEmail, ip, action}' "$BODY")"

  # ─── 6. Revenir en arrière, sans version précédente ─────────────────────────

  step "── $RUNTIME ──  6. Revenir à la version précédente, quand il n'y en a pas"
  app_state "$DEPLOY_ID"
  if jq -e '.previous == null' "$BODY" >/dev/null; then
    expect_conflict POST "/api/deployments/$DEPLOY_ID/rollback" 'nulle part où revenir'
  else
    info "cette application a une version précédente ($(jq -r .previous.version "$BODY")) — refus non applicable"
  fi

  # ─── 7. Détruire ────────────────────────────────────────────────────────────

  step "── $RUNTIME ──  7. Détruire"
  code=$(req DELETE "/api/deployments/$DEPLOY_ID")
  [ "$code" = "202" ] || fail "DELETE /api/deployments/$DEPLOY_ID → HTTP $code : $(cat "$BODY")"
  for _ in $(seq 1 90); do
    sleep 2
    req GET "/api/deployments/$DEPLOY_ID" >/dev/null
    [ "$(jq -r .status "$BODY")" = "destroyed" ] && break
  done
  [ "$(jq -r .status "$BODY")" = "destroyed" ] || fail "le déploiement n'a pas été détruit"
  pass "déploiement détruit"

  if [ "$RUNTIME" = "docker" ]; then
    LEFT=$(on_docker "docker ps -aq --filter label=com.docker.compose.project=$NAMESPACE | wc -l" | tr -d ' ')
    [ "$LEFT" = "0" ] || fail "$LEFT conteneur(s) subsistent pour $NAMESPACE"
    VOL_LEFT=$(on_docker "docker volume ls -q --filter label=com.docker.compose.project=$NAMESPACE | wc -l" | tr -d ' ')
    [ "$VOL_LEFT" = "0" ] || fail "$VOL_LEFT volume(s) subsistent pour $NAMESPACE"
    pass "plus aucun conteneur ni volume pour $NAMESPACE"

    req GET "/api/targets/$TARGET_ID/ports" >/dev/null
    jq -e --argjson p "$PORT" '[.allocations[] | select(.port == $p)] | length == 0' "$BODY" \
      >/dev/null || fail "le port $PORT est toujours réservé après la destruction"
    pass "le port $PORT est rendu à la réserve"
  else
    NS_LEFT=$(on_k3s "kubectl get ns $NAMESPACE --no-headers 2>/dev/null | wc -l" | tr -d ' ')
    [ "$NS_LEFT" = "0" ] || fail "le namespace $NAMESPACE existe encore"
    pass "le namespace $NAMESPACE a disparu"
  fi

  # Une application détruite n'a plus de gestes : la route le dit.
  code=$(req POST "/api/apps/$DEPLOY_ID/stop")
  [ "$code" = "409" ] || fail "arrêter un déploiement détruit : attendu 409, reçu $code"
  pass "409 — $(jq -r '.error.message' "$BODY")"
done

# ─── 8. RBAC ──────────────────────────────────────────────────────────────────

step "8. RBAC : un observateur ne peut pas arrêter"
code=$(req POST /api/admin/users \
  "{\"name\":\"Vera Viewer\",\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\",\"role\":\"viewer\"}")
case "$code" in
  201|409) : ;;
  *) fail "POST /api/admin/users → HTTP $code : $(cat "$BODY")" ;;
esac

req GET /api/admin/users >/dev/null
VIEWER_ACCOUNT_ID=$(jq -r --arg e "$VIEWER_EMAIL" '.items[] | select(.email == $e) | .id' "$BODY" | head -1)
[ -n "$VIEWER_ACCOUNT_ID" ] || fail "compte « $VIEWER_EMAIL » introuvable"
# Un autre script a pu lui donner un autre rôle : on réaligne, sinon le test ne
# prouve rien.
code=$(req PATCH "/api/admin/users/$VIEWER_ACCOUNT_ID/role" '{"role":"viewer"}')
[ "$code" = "200" ] || fail "réalignement du rôle → HTTP $code : $(cat "$BODY")"

code=$(req POST /api/auth/sign-in/email \
  "{\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\"}" "$VIEWER_JAR")
[ "$code" = "200" ] || fail "connexion viewer → HTTP $code : $(cat "$BODY")"
VIEWER_ID=$(jq -r '.user.id' "$BODY")
pass "connecté en observateur — $VIEWER_ID"

# L'identifiant n'a pas besoin d'exister : le RBAC tranche avant la base.
PROBE_ID="00000000-0000-4000-8000-000000000000"
for path in stop start; do
  code=$(req POST "/api/apps/$PROBE_ID/$path" "" "$VIEWER_JAR")
  [ "$code" = "403" ] || fail "viewer sur /$path : attendu 403, reçu $code — $(cat "$BODY")"
  jq -e '.error.details.permission == "deployment:restart"' "$BODY" >/dev/null \
    || fail "la permission refusée n'est pas `deployment:restart` : $(cat "$BODY")"
  pass "403 sur /$path — permission « deployment:restart »"
done

# En lecture, l'observateur voit l'état : c'est `deployment:read`, comme la page.
code=$(req GET "/api/apps/$PROBE_ID/state" "" "$VIEWER_JAR")
[ "$code" = "404" ] || fail "viewer sur /state : attendu 404 (permission accordée), reçu $code"
pass "l'observateur lit l'état (404 sur un identifiant inconnu, pas 403)"

step "9. Le refus est dans le journal d'activité"
code=$(req GET "/api/audit-logs?action=permission.denied&actorId=$VIEWER_ID&pageSize=1")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
jq -e '.items | length >= 1' "$BODY" >/dev/null || fail "aucun refus tracé pour l'observateur"
pass "permission.denied — $(jq -rc '.items[0] | {actorEmail, action, ip}' "$BODY")"

printf '\n\033[32m✓ tous les contrôles sont passés\033[0m\n'
