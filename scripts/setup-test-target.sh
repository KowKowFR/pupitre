#!/usr/bin/env bash
#
# Provisionne une cible Docker de test, pour qui n'a pas de VM sous la main.
#
# Démarre le conteneur `ssh-target` (docker-in-docker : il porte son PROPRE
# daemon Docker) et enregistre deux cibles dans le panel, parce que le worker
# et votre poste ne voient pas la machine à la même adresse :
#
#   cible-de-verification   ssh-target:22    vue depuis le worker (UI, preflight)
#   cible-docker-locale     127.0.0.1:2222   vue depuis le poste  (pnpm test:driver)
#
# C'est la même machine, atteinte par deux chemins réseau.
#
# Usage :
#   ./scripts/setup-test-target.sh
#   BASE_URL=http://localhost:3100 ./scripts/setup-test-target.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
KEY_PATH="${KEY_PATH:-.test-target-key}"
# Active UFW sur la cible. Hors tension par défaut : un pare-feu activé sur une
# machine qu'on pilote en SSH est un risque réel, et l'image de test n'en a pas
# besoin par défaut. Mettre à 1 pour exercer le chemin « ufw actif » de
# `verify-ports-rollback.sh` — le port 22 est autorisé avant l'activation.
TEST_TARGET_UFW="${TEST_TARGET_UFW:-0}"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
BODY="$WORK/body.json"
trap 'rm -rf "$WORK"' EXIT

command -v jq >/dev/null || { echo "jq est requis"; exit 1; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

req() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -b "$JAR" -c "$JAR")
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}

step "1. Clé SSH"
if [ ! -f "$KEY_PATH" ]; then
  ssh-keygen -q -t ed25519 -N '' -C 'pupitre-test-target' -f "$KEY_PATH"
  pass "clé générée dans $KEY_PATH (ignorée par git)"
else
  pass "clé existante réutilisée : $KEY_PATH"
fi

step "2. Cible docker-in-docker"
TEST_TARGET_PUBLIC_KEY="$(cat "$KEY_PATH.pub")" \
  docker compose --profile test up -d --build ssh-target >/dev/null 2>&1 \
  || fail "impossible de démarrer ssh-target"

for _ in $(seq 1 90); do
  docker compose logs ssh-target 2>/dev/null | grep -q 'démarrage de sshd' && break
  sleep 1
done
docker compose logs ssh-target 2>/dev/null | grep -q 'démarrage de sshd' \
  || fail "le daemon Docker de la cible n'a pas démarré — docker compose logs ssh-target"
pass "$(docker compose logs ssh-target 2>/dev/null | grep 'daemon prêt' | tail -1 | sed 's/.*\[test-target\] //')"


# Better Auth limite les connexions répétées depuis une même IP. Les scripts de
# vérification s'enchaînent : on patiente plutôt que de retomber par erreur sur
# l'inscription, qui donnerait un message trompeur.
login() {
  local code
  for _ in 1 2 3 4 5; do
    code=$(req POST /api/auth/sign-in/email "$@" \
      "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
    case "$code" in
      200) assert_admin; return 0 ;;
      429) sleep 6 ;;
      *)   break ;;
    esac
  done

  # Pas de compte : amorçage du premier administrateur.
  code=$(req POST /api/auth/sign-up/email "$@" \
    "{\"name\":\"Admin\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
  [ "$code" = "200" ] || fail "connexion impossible (HTTP $code) : $(cat "$BODY")"
  assert_admin
}

# Le compte doit être administrateur. Se contenter d'une connexion réussie
# laisserait le script échouer bien plus loin, sur un 403 énigmatique : c'est
# exactement ce qui arrive quand quelqu'un a déjà créé SON compte (qui devient
# admin), et que l'inscription de repli fabrique un simple viewer.
assert_admin() {
  local role
  role=$(jq -r '.user.role // empty' "$BODY")
  [ "$role" = "admin" ] && return 0

  printf '  \033[31m✗\033[0m %s\n' "« $ADMIN_EMAIL » a le rôle « ${role:-aucun} », pas « admin »."
  printf '    Le premier compte créé sur une base vierge devient administrateur ;\n'
  printf '    les suivants sont de simples viewers.\n\n'
  printf '    Deux issues :\n'
  printf '      1. relancez avec VOTRE compte admin :\n'
  printf '         ADMIN_EMAIL=vous@exemple.fr ADMIN_PASSWORD=... %s\n' "$0"
  printf '      2. ou promouvez « %s » depuis %s/admin/users\n' "$ADMIN_EMAIL" "$BASE_URL"
  exit 1
}


if [ "$TEST_TARGET_UFW" = "1" ]; then
  step "2 bis. Activation d'UFW sur la cible"
  # L'ordre n'est pas négociable : autoriser 22 AVANT d'activer, sinon la
  # politique par défaut (deny incoming) coupe la session SSH qui pilote la
  # machine — et il n'y a plus personne pour la rouvrir.
  docker compose exec -T ssh-target sh -lc '
    ufw allow 22/tcp >/dev/null 2>&1
    ufw --force enable >/dev/null 2>&1
    ufw status | head -1
  ' 2>/dev/null | grep -qi 'Status: active' \
    && pass "ufw actif sur la cible, port 22 autorisé" \
    || fail "impossible d'activer ufw sur la cible"
else
  step "2 bis. UFW"
  pass "ufw laissé inactif — TEST_TARGET_UFW=1 pour exercer le chemin « actif »"
fi

step "3. Connexion au panel"
login
pass "connecté en tant que $ADMIN_EMAIL"

step "4. Enregistrement des deux cibles"
register() {
  local name="$1" host="$2" port="$3"

  jq -n --arg name "$name" --arg host "$host" --argjson port "$port" \
        --arg key "$(cat "$KEY_PATH")" \
    '{name:$name, host:$host, port:$port, sshUser:"tp", authMethod:"key",
      sudoMethod:"nopasswd", credential:$key, labels:{env:"test"},
      portRangeStart:30000, portRangeEnd:30009}' > "$WORK/create.json"
  # La plage colle à ce que le conteneur publie réellement (voir
  # docker-compose.yml) : une cible doit déclarer ce qu'elle sait ouvrir, pas
  # ce que la valeur par défaut suppose.

  # Une cible existante n'est pas forcément supprimable : celle qui porte un
  # déploiement vivant est protégée par la garde sur les cibles. On la met donc à
  # jour sur place.
  #
  # La recherche accepte le nom **ou** l'endpoint : les deux sont uniques, et
  # une exécution antérieure a pu laisser une ligne au bon nom mais au mauvais
  # port. Ne chercher que par endpoint mènerait à une création, refusée pour
  # conflit de nom, et le script s'arrêterait sur une ligne qu'il sait réparer.
  req GET /api/targets >/dev/null
  local existing
  existing=$(jq -r --arg n "$name" --arg h "$host" --argjson p "$port" \
    '.items[] | select(.name == $n or (.host == $h and .port == $p)) | .id' "$BODY" | head -1)

  local code
  if [ -n "$existing" ]; then
    jq '{name, host, port, sshUser, credential, labels, portRangeStart, portRangeEnd}' \
      "$WORK/create.json" > "$WORK/patch.json"
    code=$(req PATCH "/api/targets/$existing" "@$WORK/patch.json")
    # `fail` écrit sur stdout, capturé par la substitution de commande appelante :
    # on double le message sur stderr pour qu'il reste visible.
    if [ "$code" != "200" ]; then
      echo "mise à jour de « $name » → HTTP $code : $(cat "$BODY")" >&2
      fail "mise à jour de « $name » → HTTP $code"
    fi
    printf '%s' "$existing"
    return
  fi

  code=$(req POST /api/targets "@$WORK/create.json")
  if [ "$code" != "201" ]; then
    echo "création de « $name » → HTTP $code : $(cat "$BODY")" >&2
    fail "création de « $name » → HTTP $code"
  fi
  jq -r .id "$BODY"
}

WORKER_TARGET=$(register 'cible-de-verification' 'ssh-target' 22)
pass "cible-de-verification  ssh-target:22   (worker, UI)  $WORKER_TARGET"

HOST_TARGET=$(register 'cible-docker-locale' '127.0.0.1' 2222)
pass "cible-docker-locale    127.0.0.1:2222  (poste)       $HOST_TARGET"

step "5. Preflight depuis le worker"
JOB=$(req POST "/api/targets/$WORKER_TARGET/preflight" '{}' >/dev/null; jq -r .jobId "$BODY")
for _ in $(seq 1 60); do
  sleep 1
  req GET "/api/queue/jobs/$JOB" >/dev/null
  [ "$(jq -r .state "$BODY")" = "completed" ] && break
done
req GET "/api/targets/$WORKER_TARGET" >/dev/null
jq -e '.runtimesAvailable.docker.available == true' "$BODY" >/dev/null \
  || fail "le preflight ne voit pas Docker : $(jq -c '.runtimesAvailable' "$BODY")"
pass "Docker ✓ $(jq -r '.runtimesAvailable.docker.version' "$BODY") — K3s ✗"

printf '\n\033[32m✓ Cible de test prête.\033[0m\n'
printf '\033[2m  Déployer :  DRIVER_PORT_RANGE=30000-30009 pnpm test:driver cible-docker-locale\033[0m\n'
printf '\033[2m  UFW actif : TEST_TARGET_UFW=1 ./scripts/setup-test-target.sh\033[0m\n'
printf '\033[2m  Nettoyer :  docker compose --profile test down -v ssh-target\033[0m\n\n'
