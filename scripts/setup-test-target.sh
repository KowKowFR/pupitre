#!/usr/bin/env bash
#
# Provisions a Docker test target, for whoever has no VM at hand.
#
# Starts the `ssh-target` container (docker-in-docker: it carries its OWN Docker
# daemon) and registers two targets in the panel, because the worker and your
# workstation do not see the machine at the same address:
#
#   cible-de-verification   ssh-target:22    seen from the worker      (UI, preflight)
#   cible-docker-locale     127.0.0.1:2222   seen from the workstation (pnpm test:driver)
#
# It is the same machine, reached through two network paths.
#
# Usage:
#   ./scripts/setup-test-target.sh
#   BASE_URL=http://localhost:3100 ./scripts/setup-test-target.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
KEY_PATH="${KEY_PATH:-.test-target-key}"
# Enables UFW on the target. Off by default: a firewall enabled on a machine
# driven over SSH is a real risk, and the test image does not need it by
# default. Set to 1 to exercise `verify-ports-rollback.sh`'s "ufw active" path —
# port 22 is allowed before enabling.
TEST_TARGET_UFW="${TEST_TARGET_UFW:-0}"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
BODY="$WORK/body.json"
trap 'rm -rf "$WORK"' EXIT

command -v jq >/dev/null || { echo "jq is required"; exit 1; }

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

step "1. SSH key"
if [ ! -f "$KEY_PATH" ]; then
  ssh-keygen -q -t ed25519 -N '' -C 'pupitre-test-target' -f "$KEY_PATH"
  pass "key generated in $KEY_PATH (ignored by git)"
else
  pass "existing key reused: $KEY_PATH"
fi

step "2. Docker-in-docker target"
TEST_TARGET_PUBLIC_KEY="$(cat "$KEY_PATH.pub")" \
  docker compose --profile test up -d --build ssh-target >/dev/null 2>&1 \
  || fail "could not start ssh-target"

for _ in $(seq 1 90); do
  docker compose logs ssh-target 2>/dev/null | grep -q 'starting sshd' && break
  sleep 1
done
docker compose logs ssh-target 2>/dev/null | grep -q 'starting sshd' \
  || fail "the target's Docker daemon did not start — docker compose logs ssh-target"
pass "$(docker compose logs ssh-target 2>/dev/null | grep 'daemon ready' | tail -1 | sed 's/.*\[test-target\] //')"


# Better Auth limits repeated sign-ins from the same IP. The verification
# scripts follow one another: we wait rather than fall back by mistake on the
# sign-up, which would give a misleading message.
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

  # No account: bootstrapping the first administrator.
  code=$(req POST /api/auth/sign-up/email "$@" \
    "{\"name\":\"Admin\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
  [ "$code" = "200" ] || fail "sign-in failed (HTTP $code): $(cat "$BODY")"
  assert_admin
}

# The account must be an administrator. Settling for a successful sign-in would
# let the script fail much further, on a cryptic 403: that is exactly what
# happens when someone already created THEIR account (which becomes admin), and
# the fallback sign-up makes a mere viewer.
assert_admin() {
  local role
  role=$(jq -r '.user.role // empty' "$BODY")
  [ "$role" = "admin" ] && return 0

  printf '  \033[31m✗\033[0m %s\n' "\"$ADMIN_EMAIL\" has the role \"${role:-none}\", not \"admin\"."
  printf '    Le premier compte créé sur une base vierge devient administrateur ;\n'
  printf '    les suivants sont de simples viewers.\n\n'
  printf '    Deux issues :\n'
  printf '      1. relancez avec VOTRE compte admin :\n'
  printf '         ADMIN_EMAIL=vous@exemple.fr ADMIN_PASSWORD=... %s\n' "$0"
  printf '      2. ou promouvez « %s » depuis %s/admin/users\n' "$ADMIN_EMAIL" "$BASE_URL"
  exit 1
}


if [ "$TEST_TARGET_UFW" = "1" ]; then
  step "2 bis. Enabling UFW on the target"
  # The order is not negotiable: allow 22 BEFORE enabling, otherwise the default
  # policy (deny incoming) cuts the SSH session that drives the machine — and
  # there is nobody left to reopen it.
  docker compose exec -T ssh-target sh -lc '
    ufw allow 22/tcp >/dev/null 2>&1
    ufw --force enable >/dev/null 2>&1
    ufw status | head -1
  ' 2>/dev/null | grep -qi 'Status: active' \
    && pass "ufw active on the target, port 22 allowed" \
    || fail "could not enable ufw on the target"
else
  step "2 bis. UFW"
  pass "ufw left inactive — TEST_TARGET_UFW=1 to exercise the \"active\" path"
fi

step "3. Signing in to the panel"
login
pass "signed in as $ADMIN_EMAIL"

step "4. Registering the two targets"
register() {
  local name="$1" host="$2" port="$3"

  jq -n --arg name "$name" --arg host "$host" --argjson port "$port" \
        --arg key "$(cat "$KEY_PATH")" \
    '{name:$name, host:$host, port:$port, sshUser:"tp", authMethod:"key",
      sudoMethod:"nopasswd", credential:$key, labels:{env:"test"},
      portRangeStart:30000, portRangeEnd:30009}' > "$WORK/create.json"
  # The range matches what the container really publishes (see
  # docker-compose.yml): a target must declare what it can open, not what the
  # default value assumes.

  # An existing target cannot necessarily be deleted: the one carrying a live
  # deployment is protected by the guard on targets. So it is updated in place.
  #
  # The lookup accepts the name **or** the endpoint: both are unique, and an
  # earlier run may have left a row with the right name but the wrong port.
  # Looking up by endpoint only would lead to a creation, refused for a name
  # conflict, and the script would stop on a row it knows how to repair.
  req GET /api/targets >/dev/null
  local existing
  existing=$(jq -r --arg n "$name" --arg h "$host" --argjson p "$port" \
    '.items[] | select(.name == $n or (.host == $h and .port == $p)) | .id' "$BODY" | head -1)

  local code
  if [ -n "$existing" ]; then
    jq '{name, host, port, sshUser, credential, labels, portRangeStart, portRangeEnd}' \
      "$WORK/create.json" > "$WORK/patch.json"
    code=$(req PATCH "/api/targets/$existing" "@$WORK/patch.json")
    # `fail` writes to stdout, captured by the calling command substitution: we
    # double the message on stderr so that it stays visible.
    if [ "$code" != "200" ]; then
      echo "updating \"$name\" → HTTP $code: $(cat "$BODY")" >&2
      fail "updating \"$name\" → HTTP $code"
    fi
    printf '%s' "$existing"
    return
  fi

  code=$(req POST /api/targets "@$WORK/create.json")
  if [ "$code" != "201" ]; then
    echo "creating \"$name\" → HTTP $code: $(cat "$BODY")" >&2
    fail "creating \"$name\" → HTTP $code"
  fi
  jq -r .id "$BODY"
}

WORKER_TARGET=$(register 'cible-de-verification' 'ssh-target' 22)
pass "cible-de-verification  ssh-target:22   (worker, UI)  $WORKER_TARGET"

HOST_TARGET=$(register 'cible-docker-locale' '127.0.0.1' 2222)
pass "cible-docker-locale    127.0.0.1:2222  (workstation) $HOST_TARGET"

step "5. Preflight from the worker"
JOB=$(req POST "/api/targets/$WORKER_TARGET/preflight" '{}' >/dev/null; jq -r .jobId "$BODY")
for _ in $(seq 1 60); do
  sleep 1
  req GET "/api/queue/jobs/$JOB" >/dev/null
  [ "$(jq -r .state "$BODY")" = "completed" ] && break
done
req GET "/api/targets/$WORKER_TARGET" >/dev/null
jq -e '.runtimesAvailable.docker.available == true' "$BODY" >/dev/null \
  || fail "the preflight does not see Docker: $(jq -c '.runtimesAvailable' "$BODY")"
pass "Docker ✓ $(jq -r '.runtimesAvailable.docker.version' "$BODY") — K3s ✗"

printf '\n\033[32m✓ Cible de test prête.\033[0m\n'
printf '\033[2m  Déployer :  DRIVER_PORT_RANGE=30000-30009 pnpm test:driver cible-docker-locale\033[0m\n'
printf '\033[2m  UFW actif : TEST_TARGET_UFW=1 ./scripts/setup-test-target.sh\033[0m\n'
printf '\033[2m  Nettoyer :  docker compose --profile test down -v ssh-target\033[0m\n\n'
