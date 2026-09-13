#!/usr/bin/env bash
#
# Machines cibles : preflight réel, credential chiffré, jamais rendu par l'API.
#
#   1. Ajouter une cible avec une clé SSH
#   2. Lancer le preflight, voir « Docker ✓ / K3s ✗ » sans recharger la page
#   3. Vérifier en base que le credential est chiffré et illisible
#   4. Vérifier que GET /api/targets/:id ne renvoie jamais le credential
#
# Le script monte une vraie cible SSH (conteneur `ssh-target`, profil `test`)
# équipée d'un client Docker branché sur le socket de l'hôte. Rien n'est simulé :
# `docker info` interroge un daemon réel. `kubectl` est absent, d'où « K3s ✗ ».
#
# Usage :
#   ./scripts/verify-targets-preflight.sh
#   BASE_URL=http://localhost:3100 ./scripts/verify-targets-preflight.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
# Cible dédiée : `setup-test-target.sh` en enregistre d'autres, qui portent les
# déploiements des autres scripts. Une cible qui porte un déploiement vivant ne
# peut pas être supprimée — c'est l'une des règles vérifiées ici.
TARGET_NAME="${TARGET_NAME:-cible-preflight}"
# Clé déjà provisionnée par `setup-test-target.sh`, le cas échéant.
SHARED_KEY="${SHARED_KEY:-.test-target-key}"
CLIENT_IP="${CLIENT_IP:-198.51.100.42}"
# Nom d'hôte de la cible vu depuis le worker.
TARGET_HOST="${TARGET_HOST:-ssh-target}"
TARGET_PORT="${TARGET_PORT:-22}"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
BODY="$WORK/body.json"
trap 'rm -rf "$WORK"' EXIT

command -v jq >/dev/null || { echo "jq est requis"; exit 1; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
info() { printf '    \033[2m%s\033[0m\n' "$1"; }

req() {
  local method="$1" path="$2" jar="${3:-}" data="${4:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -H "x-forwarded-for: $CLIENT_IP")
  [ -n "$jar" ] && args+=(-b "$jar" -c "$jar")
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }

step "0. Cible SSH de test"
if [ -f "$SHARED_KEY" ] && docker compose ps ssh-target 2>/dev/null | grep -q ssh-target; then
  # Reconstruire l'image changerait la clé autorisée et invaliderait les cibles
  # déjà enregistrées par `setup-test-target.sh`. On réutilise l'existant.
  cp "$SHARED_KEY" "$WORK/id_ed25519"
  cp "$SHARED_KEY.pub" "$WORK/id_ed25519.pub"
  chmod 600 "$WORK/id_ed25519"
  pass "clé et conteneur existants réutilisés"
else
  ssh-keygen -q -t ed25519 -N '' -C 'verify-targets-preflight' -f "$WORK/id_ed25519"
  pass "paire de clés ed25519 jetable générée"
  TEST_TARGET_PUBLIC_KEY="$(cat "$WORK/id_ed25519.pub")" \
    docker compose --profile test up -d --build ssh-target >/dev/null 2>&1 \
    || fail "impossible de démarrer le conteneur ssh-target"
fi

for _ in $(seq 1 30); do
  docker compose exec -T ssh-target sh -c 'pgrep sshd >/dev/null' 2>/dev/null && break
  sleep 1
done
docker compose exec -T ssh-target sh -c 'pgrep sshd >/dev/null' \
  || fail "sshd ne démarre pas dans ssh-target"
pass "conteneur ssh-target prêt (docker-cli présent, kubectl absent)"
info "$(docker compose exec -T ssh-target docker version --format '{{.Server.Version}}' 2>/dev/null \
        | sed 's/^/daemon Docker vu par la cible : /' || echo 'daemon Docker non joignable')"

step "1. Connexion administrateur"
code=$(req POST /api/auth/sign-in/email "$JAR" \
  "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
if [ "$code" != "200" ]; then
  code=$(req POST /api/auth/sign-up/email "$JAR" \
    "{\"name\":\"Admin\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
  [ "$code" = "200" ] || fail "connexion et inscription impossibles (HTTP $code) : $(cat "$BODY")"
  pass "administrateur créé (première exécution)"
else
  pass "connecté en tant que $ADMIN_EMAIL"
fi

step "2. Ajouter une cible avec une clé SSH"
# Le corps est fabriqué par jq : la clé privée est multi-ligne.
jq -n --arg name "$TARGET_NAME" --arg host "$TARGET_HOST" \
      --argjson port "$TARGET_PORT" --arg key "$(cat "$WORK/id_ed25519")" \
  '{name:$name, host:$host, port:$port, sshUser:"tp", authMethod:"key",
    sudoMethod:"nopasswd", credential:$key, labels:{env:"test"}}' > "$WORK/create.json"

code=$(req POST /api/targets "$JAR" "@$WORK/create.json")

if [ "$code" = "409" ]; then
  # La contrainte d'unicité `(host, port, ssh_user)` interdit deux cibles vers
  # la même machine, et une cible qui porte un déploiement vivant ne peut pas
  # être supprimée. On réutilise donc la cible existante : on lui réécrit son
  # credential par l'API, ce qui suffit à vérifier chiffrement et non-exposition.
  req GET /api/targets "$JAR" >/dev/null
  TARGET_ID=$(jq -r --arg h "$TARGET_HOST" --argjson p "$TARGET_PORT" \
    '.items[] | select(.host == $h and .port == $p) | .id' "$BODY" | head -1)
  [ -n "$TARGET_ID" ] || fail "conflit signalé mais aucune cible correspondante : $(cat "$BODY")"

  jq '{credential: .credential, labels: .labels}' "$WORK/create.json" > "$WORK/patch.json"
  code=$(req PATCH "/api/targets/$TARGET_ID" "$JAR" "@$WORK/patch.json")
  [ "$code" = "200" ] || fail "PATCH /api/targets/$TARGET_ID → HTTP $code : $(cat "$BODY")"
  pass "cible existante réutilisée, credential réécrit : $TARGET_ID"
else
  [ "$code" = "201" ] || fail "POST /api/targets → HTTP $code : $(cat "$BODY")"
  TARGET_ID=$(jq -r .id "$BODY")
  pass "cible créée : $TARGET_ID"
fi
info "$(jq -c '{name,host,port,sshUser,authMethod,sudoMethod,status}' "$BODY")"

step "3. Le credential n'est jamais renvoyé par l'API"
for path in "/api/targets" "/api/targets/$TARGET_ID"; do
  code=$(req GET "$path" "$JAR")
  [ "$code" = "200" ] || fail "GET $path → HTTP $code"

  # Aucune clé du JSON, à n'importe quelle profondeur, ne doit ressembler à un secret.
  leaked=$(jq -r '[paths(scalars) | join(".")] | map(select(
      test("credential|password|privateKey|secret"; "i"))) | join(", ")' "$BODY")
  [ -z "$leaked" ] || fail "$path expose un champ sensible : $leaked"

  # Et le contenu de la clé privée ne doit apparaître nulle part.
  grep -qF 'BEGIN OPENSSH PRIVATE KEY' "$BODY" && fail "$path renvoie la clé privée"
  grep -qF 'v1:' "$BODY" && fail "$path renvoie la valeur chiffrée"
  pass "$path : aucun champ credential, aucune trace de la clé"
done

step "4. En base, le credential est chiffré et illisible"
stored=$(psql_q "select encrypted_credential from targets where id = '$TARGET_ID';")
[ -n "$stored" ] || fail "aucune ligne en base pour $TARGET_ID"

case "$stored" in
  v1:*) pass "format versionné : $(printf '%s' "$stored" | cut -c1-3)…" ;;
  *)    fail "le credential ne commence pas par « v1: » : $(printf '%s' "$stored" | cut -c1-40)" ;;
esac

fields=$(printf '%s' "$stored" | awk -F: '{print NF}')
[ "$fields" = "4" ] || fail "format attendu version:iv:authTag:ciphertext, $fields champ(s)"
pass "quatre champs : version:iv:authTag:ciphertext"

printf '%s' "$stored" | grep -qF 'BEGIN OPENSSH PRIVATE KEY' \
  && fail "la clé privée apparaît en clair en base"
printf '%s' "$stored" | grep -qiE 'ssh-ed25519|PRIVATE KEY' \
  && fail "des fragments de la clé apparaissent en base"
pass "aucun fragment lisible de la clé privée"
info "longueur stockée : $(printf '%s' "$stored" | wc -c | tr -d ' ') octets"
info "$(printf '%s' "$stored" | cut -c1-72)…"

step "5. Lancer le preflight"
code=$(req POST "/api/targets/$TARGET_ID/preflight" "$JAR" '{}')
[ "$code" = "202" ] || fail "POST preflight → HTTP $code : $(cat "$BODY")"
JOB_ID=$(jq -r .jobId "$BODY")
pass "tâche enfilée : $JOB_ID"

deadline=$(( $(date +%s) + 120 ))
state=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep 1
  code=$(req GET "/api/queue/jobs/$JOB_ID" "$JAR")
  [ "$code" = "200" ] || fail "GET /api/queue/jobs/$JOB_ID → HTTP $code"
  state=$(jq -r .state "$BODY")
  case "$state" in
    completed) break ;;
    failed)    fail "preflight en échec : $(jq -r .failedReason "$BODY")" ;;
  esac
done
[ "$state" = "completed" ] || fail "le preflight n'a pas abouti (état « $state »)"
pass "tâche terminée — $(jq -c '.result | {status, reachable, runtimes}' "$BODY")"

step "6. Docker ✓ / K3s ✗"
code=$(req GET "/api/targets/$TARGET_ID" "$JAR")
[ "$code" = "200" ] || fail "GET /api/targets/$TARGET_ID → HTTP $code"

jq -e '.runtimesAvailable.docker.available == true' "$BODY" >/dev/null \
  || fail "Docker n'a pas été détecté : $(jq -c '.runtimesAvailable' "$BODY")"
docker_version=$(jq -r '.runtimesAvailable.docker.version' "$BODY")
[ "$docker_version" != "null" ] || fail "Docker détecté mais sans version"
pass "Docker ✓ $docker_version"

jq -e '.runtimesAvailable.k3s.available == false' "$BODY" >/dev/null \
  || fail "K3s ne devrait pas être disponible : $(jq -c '.runtimesAvailable.k3s' "$BODY")"
pass "K3s ✗ (kubectl absent de la cible)"

jq -e '.status == "ok"' "$BODY" >/dev/null \
  || fail "statut attendu « ok », reçu « $(jq -r .status "$BODY")»"
pass "statut : ok"
info "OS      : $(jq -r '.preflightReport.os.prettyName // "—"' "$BODY")"
info "latence : $(jq -r '.preflightReport.latencyMs' "$BODY") ms"
info "sudo    : $(jq -r 'if .preflightReport.sudo.nopasswd then "sans mot de passe" else "mot de passe requis" end' "$BODY")"
info "disque  : $(jq -r '(.preflightReport.disk.availableKb / 1048576 * 10 | floor / 10 | tostring) + " Gio libres"' "$BODY")"
info "outils  : $(jq -r '.preflightReport.tools | to_entries | map(select(.value) | .key) | join(", ")' "$BODY")"

step "7. Mise à jour sans rechargement de page"
# Rejoue la séquence exacte du hook client (`use-preflight.ts`) : remise à zéro
# du statut, POST preflight, polling de la tâche, relecture des données.
# Aucun chargement de page entre les deux — c'est ce que fait `router.refresh()`.
psql_q "update targets set status = 'unknown',
          runtimes_available = '{\"docker\":{\"available\":false,\"version\":null,\"composeVersion\":null},\"k3s\":{\"available\":false,\"version\":null,\"nodes\":null,\"readyNodes\":null,\"clusterReady\":false}}'::jsonb
        where id = '$TARGET_ID';" >/dev/null

req GET "/api/targets/$TARGET_ID" "$JAR" >/dev/null
before=$(jq -r '"\(.status) · Docker \(if .runtimesAvailable.docker.available then "✓" else "✗" end)"' "$BODY")
info "avant : $before"

code=$(req POST "/api/targets/$TARGET_ID/preflight" "$JAR" '{}')
[ "$code" = "202" ] || fail "POST preflight → HTTP $code"
job2=$(jq -r .jobId "$BODY")

polls=0
deadline=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep 1
  polls=$((polls + 1))
  req GET "/api/queue/jobs/$job2" "$JAR" >/dev/null
  [ "$(jq -r .state "$BODY")" = "completed" ] && break
done

req GET "/api/targets/$TARGET_ID" "$JAR" >/dev/null
after=$(jq -r '"\(.status) · Docker \(if .runtimesAvailable.docker.available then "✓" else "✗" end) \(.runtimesAvailable.docker.version // "")"' "$BODY")
info "après : $after"

[ "$before" != "$after" ] || fail "les données n'ont pas changé après le preflight"
jq -e '.runtimesAvailable.docker.available == true' "$BODY" >/dev/null \
  || fail "Docker n'est pas revenu disponible"
pass "données rafraîchies après $polls sondage(s) de /api/queue/jobs/$job2, sans rechargement de page"

step "8. Chaque contrôle est indépendant"
jq -e '[.preflightReport.checks[] | select(.key == "k3s")] | length == 1' "$BODY" >/dev/null \
  || fail "le contrôle k3s est absent du rapport"
jq -e '.preflightReport.checks | map(select(.status == "success")) | length >= 6' "$BODY" >/dev/null \
  || fail "trop peu de contrôles réussis : $(jq -c '[.preflightReport.checks[] | {key,status}]' "$BODY")"
pass "$(jq -r '.preflightReport.checks | length' "$BODY") contrôles exécutés, kubectl absent n'a rien fait échouer"

step "9. Traçabilité"
# Un filtre par action plutôt qu'une page unique : le script est relançable, et
# la création de la cible finit par sortir des vingt entrées les plus récentes
# une fois quelques preflights enchaînés. L'assertion, elle, ne change pas.
for action in target.created target.preflight.requested target.preflight.completed; do
  code=$(req GET "/api/audit-logs?resourceType=target&action=$action&pageSize=50" "$JAR")
  [ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
  jq -e --arg a "$action" --arg id "$TARGET_ID" \
    '[.items[] | select(.action == $a and .resourceId == $id)] | length > 0' "$BODY" >/dev/null \
    || fail "action « $action » absente du journal d'audit"
  pass "audit : $action"
done

code=$(req GET "/api/audit-logs?resourceType=target&pageSize=50" "$JAR")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
grep -qF 'BEGIN OPENSSH PRIVATE KEY' "$BODY" && fail "le journal d'audit contient la clé privée"
grep -qE '"v1:[A-Za-z0-9+/]' "$BODY" && fail "le journal d'audit contient la valeur chiffrée"
pass "aucun credential dans le journal d'audit"

step "10. Aucun credential dans les logs du worker"
if docker compose logs worker 2>/dev/null | grep -qF 'BEGIN OPENSSH PRIVATE KEY'; then
  fail "la clé privée apparaît dans les logs du worker"
fi
pass "aucune clé privée dans les logs du worker"

step "11. Les permissions RBAC s'appliquent aussi aux cibles"
code=$(req GET /api/targets "")
[ "$code" = "401" ] || fail "sans session, attendu 401, reçu $code"
pass "sans session → 401"

printf '\n\033[32m✓ Cibles et preflight vérifiés.\033[0m\n'
printf '\033[2m  Cible conservée pour inspection dans l'"'"'UI : %s/targets/%s\033[0m\n' "$BASE_URL" "$TARGET_ID"
printf '\033[2m  Nettoyage : docker compose --profile test down ssh-target\033[0m\n\n'
