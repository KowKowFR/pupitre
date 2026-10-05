#!/usr/bin/env bash
#
# Checks an application's uploaded code, end to end:
#
#   1. ground: an application whose service is built from a Dockerfile, without
#      a linked repository
#   2. without code, the deployment is refused before being queued (409)
#   3. a booby-trapped archive — a link that would leave the code once the
#      leading folder is removed — is refused by the worker, and so is the
#      deployment
#   4. a sound zip: ready, leading folder removed, Dockerfile found; deployed on
#      the Docker target, it serves its content, the execute bit survived, and
#      the code is under source/ — nothing at the root of the release
#   5. a V2 tar.gz replaces V1; then redeploying version 1 finds the V1 code
#   6. on the K3s target (if given), a new deployment builds the latest
#      archive — V2
#   7. a CI: a token limited to the application uploads; limited to another
#      one, it is refused
#   8. an erased archive: the version it built can no longer be redeployed
#   9. only the latest archives are kept
#  10. the log, without a secret; cleanup: application destroyed everywhere
#
# Usage:
#   ./scripts/verify-source-archive.sh
#   BASE_URL=http://localhost:3200 DOCKER_TARGET=… K3S_TARGET=… ./scripts/verify-source-archive.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
DOCKER_TARGET="${DOCKER_TARGET:-cible-de-verification}"
K3S_TARGET="${K3S_TARGET:-}"
DRIVER_ROOT_PATH="${DRIVER_ROOT_PATH:-/opt/bootstrap}"
SLUG="${SLUG:-archive-verif}"
OTHER_SLUG="${OTHER_SLUG:-archive-verif-autre}"
CLIENT_IP="${CLIENT_IP:-198.51.100.93}"

WORK="$(mktemp -d)"
BODY="$WORK/body.json"
JAR="$WORK/admin.jar"
APP_ID=""
OTHER_ID=""
TOKEN_IDS=()

command -v jq >/dev/null || { echo "jq is required"; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required to make the zip"; exit 1; }

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

# Sends an archive: the body is the file, its name in a header.
upload() {
  local app="$1" file="$2" auth="${3:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X POST "$BASE_URL/api/applications/$app/archives"
              -H 'content-type: application/octet-stream' -H "x-forwarded-for: $CLIENT_IP"
              -H "x-archive-name: $(basename "$file")" --data-binary "@$file")
  if [ -n "$auth" ]; then args+=(-H "authorization: Bearer $auth")
  else args+=(-H "origin: $BASE_URL" -b "$JAR" -c "$JAR"); fi
  curl "${args[@]}"
}

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }
error_code() { jq -r '.error.code // empty' "$BODY"; }

# Waits for the worker to read an archive. Echoes: its status.
wait_archive() {
  local app="$1" id="$2" status=""
  for _ in $(seq 1 60); do
    req GET "/api/applications/$app/archives/$id" >/dev/null
    status=$(jq -r '.archive.status' "$BODY")
    case "$status" in ready|rejected) printf '%s' "$status"; return ;; esac
    sleep 1
  done
  fail "archive $id was not read within a minute (status \"$status\")"
}

# Deploys and waits for the verdict. Echoes: "<deploymentId> <status>".
deploy_and_wait() {
  local app="$1" target="$2" runtime="$3" code id status=""
  code=$(req POST /api/deployments \
    "{\"applicationId\":\"$app\",\"targetId\":\"$target\",\"runtime\":\"$runtime\",\"autoRollback\":false,\"scanConfig\":{\"scanners\":[],\"failOn\":\"NONE\"}}")
  [ "$code" = "202" ] || fail "POST /api/deployments → HTTP $code: $(cat "$BODY")"
  id=$(jq -r .id "$BODY")
  wait_deployment "$id"
}

wait_deployment() {
  local id="$1" status=""
  for _ in $(seq 1 200); do
    sleep 3
    req GET "/api/deployments/$id" >/dev/null
    status=$(jq -r .status "$BODY")
    case "$status" in
      success|failed|rolled_back|destroyed) printf '%s %s' "$id" "$status"; return ;;
    esac
  done
  fail "deployment $id did not complete in 10 minutes (status \"$status\")"
}

# What the application serves, read from the Docker machine itself.
docker_page() {
  local port="$1"
  docker compose exec -T ssh-target sh -c \
    "wget -qO- http://127.0.0.1:$port/ 2>/dev/null || curl -s http://127.0.0.1:$port/"
}

cascade_delete() {
  local app="$1" code
  [ -n "$app" ] || return 0
  code=$(req POST "/api/applications/$app/cascade" '{"force":false}')
  [ "$code" = "202" ] || { info "cascade $app → HTTP $code: $(cat "$BODY")"; return 0; }
  for _ in $(seq 1 120); do
    sleep 2
    code=$(req GET "/api/applications/$app")
    [ "$code" = "404" ] && return 0
  done
  info "application $app is still there after 4 minutes"
}

cleanup() {
  set +e
  # `${t[@]+…}`: bash 3.2 (macOS) refuses an empty array under `set -u`.
  for token in ${TOKEN_IDS[@]+"${TOKEN_IDS[@]}"}; do req DELETE "/api/tokens/$token" >/dev/null; done
  cascade_delete "$APP_ID"
  cascade_delete "$OTHER_ID"
  rm -rf "$WORK"
}
trap cleanup EXIT

# ─── the trial's archives ────────────────────────────────────────────────────

# A busybox site: the page carries a mark, the startup script must stay
# executable — without its bit, the container does not start.
make_tree() {
  local dir="$1" marker="$2"
  mkdir -p "$dir/www"
  printf 'FROM busybox:1.37\nCOPY www/ /www/\nCOPY entry.sh /entry.sh\nEXPOSE 8080\nCMD ["/entry.sh"]\n' > "$dir/Dockerfile"
  printf '#!/bin/sh\nexec httpd -f -p 8080 -h /www\n' > "$dir/entry.sh"
  chmod 755 "$dir/entry.sh"
  printf '<h1>%s</h1>\n' "$marker" > "$dir/www/index.html"
  mkdir -p "$dir/.git" && printf '[core]\n' > "$dir/.git/config"
}

# zip of the `site/` folder (leading folder included), Unix permissions kept.
make_zip() {
  local root="$1" out="$2"
  python3 - "$root" "$out" <<'PY'
import os, sys, zipfile
root, out = sys.argv[1], sys.argv[2]
base = os.path.dirname(root)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
    for folder, dirs, files in os.walk(root):
        for name in sorted(files):
            full = os.path.join(folder, name)
            zf.write(full, os.path.relpath(full, base))
PY
}

COPYFILE_DISABLE=1
export COPYFILE_DISABLE

# ─── 1. Ground ────────────────────────────────────────────────────────────────
step "1. Ground"
for _ in 1 2 3 4 5; do
  code=$(req POST /api/auth/sign-in/email "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
  [ "$code" = "429" ] || break
  sleep 6
done
[ "$code" = "200" ] || fail "sign-in → HTTP $code: $(cat "$BODY")"
[ "$(jq -r '.user.role // empty' "$BODY")" = "admin" ] || fail "\"$ADMIN_EMAIL\" is not an administrator"
pass "signed in as $ADMIN_EMAIL"

req GET /api/targets >/dev/null
DOCKER_ID=$(jq -r --arg n "$DOCKER_TARGET" '.items[] | select(.name == $n) | .id' "$BODY")
[ -n "$DOCKER_ID" ] || fail "Docker target \"$DOCKER_TARGET\" not found"
K3S_ID=""
if [ -n "$K3S_TARGET" ]; then
  K3S_ID=$(jq -r --arg n "$K3S_TARGET" '.items[] | select(.name == $n) | .id' "$BODY")
  [ -n "$K3S_ID" ] || fail "K3s target \"$K3S_TARGET\" not found"
fi
pass "targets: $DOCKER_TARGET${K3S_TARGET:+, $K3S_TARGET}"

# Leftovers from a previous pass.
req GET /api/applications >/dev/null
cp "$BODY" "$WORK/applications.json"
for slug in "$SLUG" "$OTHER_SLUG"; do
  old=$(jq -r --arg s "$slug" '.items[] | select(.slug == $s) | .id' "$WORK/applications.json" | head -1)
  [ -n "$old" ] && { info "leftover from a previous pass: $slug"; cascade_delete "$old"; }
done

spec() {
  jq -n --arg n "$1" '{appSpec: {name: $n, version: "1.0.0", services: [{
      name: "web",
      source: {type: "dockerfile", context: ".", dockerfile: "Dockerfile"},
      port: 8080, exposed: true,
      healthcheck: {path: "/", intervalSec: 3, timeoutSec: 3, retries: 30}
    }]}}'
}
code=$(req POST /api/applications "$(spec "$SLUG")")
[ "$code" = "201" ] || fail "creating the application → HTTP $code: $(cat "$BODY")"
APP_ID=$(jq -r .id "$BODY")
code=$(req POST /api/applications "$(spec "$OTHER_SLUG")")
[ "$code" = "201" ] || fail "creating the second application → HTTP $code"
OTHER_ID=$(jq -r .id "$BODY")
pass "application \"$SLUG\": a service built from ./Dockerfile, without a linked repository"

# ─── 2. Without code ──────────────────────────────────────────────────────────
step "2. Without code, no deployment"
code=$(req POST /api/deployments \
  "{\"applicationId\":\"$APP_ID\",\"targetId\":\"$DOCKER_ID\",\"runtime\":\"docker\",\"scanConfig\":{\"scanners\":[],\"failOn\":\"NONE\"}}")
[ "$code" = "409" ] && [ "$(error_code)" = "source_code_missing" ] || fail "HTTP $code ($(error_code))"
[ "$(psql_q "select count(*) from deployments where application_id = '$APP_ID';")" = "0" ] \
  || fail "a deployment was created despite the refusal"
pass "409 source_code_missing, nothing queued"

code=$(req POST "/api/applications/$APP_ID/archives" '{"pas":"une archive"}')
[ "$code" = "415" ] && [ "$(error_code)" = "unsupported_archive" ] || fail "JSON sent: HTTP $code ($(error_code))"
pass "a body that is not an archive → 415"

# ─── 3. Booby-trapped archive ─────────────────────────────────────────────────
step "3. A booby-trapped archive"
mkdir -p "$WORK/trap/site"
make_tree "$WORK/trap/site" trap
# Inside `site/`, this link stays in the archive; once `site/` is removed, it
# would aim at `compose.yml`, at the root of the release.
ln -s ../compose.yml "$WORK/trap/site/leak"
tar -czf "$WORK/trap.tar.gz" -C "$WORK/trap" site
code=$(upload "$APP_ID" "$WORK/trap.tar.gz")
[ "$code" = "202" ] || fail "sending → HTTP $code: $(cat "$BODY")"
TRAP_ID=$(jq -r .archive.id "$BODY")
[ "$(wait_archive "$APP_ID" "$TRAP_ID")" = "rejected" ] || fail "the booby-trapped archive got through"
[ "$(jq -r .archive.rejection "$BODY")" = "link_outside" ] || fail "refusal: $(jq -c .archive "$BODY")"
info "refusal: $(jq -r '.archive.rejectionDetail' "$BODY")"
[ "$(psql_q "select count(*) from source_archive_chunks where archive_id = '$TRAP_ID';")" = "0" ] \
  || fail "the refused archive's bytes stayed in the database"
pass "refused by the worker (link_outside), its bytes erased"

code=$(req POST /api/deployments \
  "{\"applicationId\":\"$APP_ID\",\"targetId\":\"$DOCKER_ID\",\"runtime\":\"docker\",\"scanConfig\":{\"scanners\":[],\"failOn\":\"NONE\"}}")
[ "$code" = "409" ] && [ "$(error_code)" = "archive_rejected" ] || fail "HTTP $code ($(error_code))"
pass "deploying with the latest archive refused → 409 archive_rejected"

# ─── 4. A sound zip, on Docker ────────────────────────────────────────────────
step "4. A sound zip, deployed on Docker"
mkdir -p "$WORK/v1/site"
make_tree "$WORK/v1/site" "code-v1"
make_zip "$WORK/v1/site" "$WORK/site-v1.zip"
code=$(upload "$APP_ID" "$WORK/site-v1.zip")
[ "$code" = "202" ] || fail "sending → HTTP $code: $(cat "$BODY")"
V1_ID=$(jq -r .archive.id "$BODY")
V1_SHA=$(jq -r .archive.sha256 "$BODY")
LOCAL_SHA=$( (sha256sum "$WORK/site-v1.zip" 2>/dev/null || shasum -a 256 "$WORK/site-v1.zip") | cut -d' ' -f1)
[ "$V1_SHA" = "$LOCAL_SHA" ] || fail "SHA-256: panel $V1_SHA, local $LOCAL_SHA"
pass "received, and the panel's SHA-256 is the file's"
[ "$(wait_archive "$APP_ID" "$V1_ID")" = "ready" ] || fail "refused: $(jq -c .archive "$BODY")"
jq -e '.archive.report.strippedRoot == "site" and .archive.report.dockerfiles == ["Dockerfile"]
       and .archive.report.skippedEntries >= 1' "$BODY" >/dev/null \
  || fail "unexpected report: $(jq -c .archive.report "$BODY")"
pass "ready: leading folder \"site/\" removed, .git/ set aside, Dockerfile found"

read -r DEP1 status <<<"$(deploy_and_wait "$APP_ID" "$DOCKER_ID" docker)"
[ "$status" = "success" ] || fail "V1 deployment: $status — $(jq -r .error "$BODY")"
PORT=$(jq -r .publishedPort "$BODY")
[ "$(jq -r .sourceArchiveName "$BODY")" = "site-v1.zip" ] \
  || fail "the deployment's detail does not name its archive: $(jq -r .sourceArchiveName "$BODY")"
page=$(docker_page "$PORT")
[[ "$page" == *"code-v1"* ]] || fail "the served page does not carry the V1 mark: $page"
pass "deployed (v1), it serves \"code-v1\" on port $PORT — entry.sh kept its execute bit"

RELEASE=$(docker compose exec -T ssh-target sh -c "ls -dt $DRIVER_ROOT_PATH/apps/$SLUG/*/ | head -1" | tr -d '\r')
layout=$(docker compose exec -T ssh-target sh -c "ls -A $RELEASE | tr '\n' ' '; echo; ls -A ${RELEASE}source | tr '\n' ' '")
root=$(printf '%s' "$layout" | sed -n 1p)
code_dir=$(printf '%s' "$layout" | sed -n 2p)
[[ "$code_dir" == *Dockerfile* && "$code_dir" == *www* ]] || fail "source/: $code_dir"
[[ "$root" != *Dockerfile* && "$code_dir" != *site* && "$code_dir" != *.git* ]] \
  || fail "root: $root — source/: $code_dir"
pass "the code is under source/ (without site/ nor .git/), nothing at the root of the release"

# ─── 5. V2, then back to the V1 code ──────────────────────────────────────────
step "5. A new version, then back to the code from before"
mkdir -p "$WORK/v2"
make_tree "$WORK/v2" "code-v2"
tar -czf "$WORK/code-v2.tar.gz" -C "$WORK/v2" .
code=$(upload "$APP_ID" "$WORK/code-v2.tar.gz")
[ "$code" = "202" ] || fail "sending V2 → HTTP $code"
V2_ID=$(jq -r .archive.id "$BODY")
[ "$(wait_archive "$APP_ID" "$V2_ID")" = "ready" ] || fail "V2 refused: $(jq -c .archive "$BODY")"
read -r DEP2 status <<<"$(deploy_and_wait "$APP_ID" "$DOCKER_ID" docker)"
[ "$status" = "success" ] || fail "V2 deployment: $status"
PORT=$(jq -r .publishedPort "$BODY")
[[ "$(docker_page "$PORT")" == *"code-v2"* ]] || fail "the page does not carry the V2 mark"
pass "V2 (tar.gz without a leading folder) deployed, it serves \"code-v2\""

code=$(req POST "/api/applications/$APP_ID/redeploy" "{\"versionId\":\"$DEP1\",\"targetId\":\"$DOCKER_ID\",\"autoRollback\":false}")
[ "$code" = "202" ] || fail "redeploying version 1 → HTTP $code: $(cat "$BODY")"
read -r DEP3 status <<<"$(wait_deployment "$(jq -r .id "$BODY")")"
[ "$status" = "success" ] || fail "redeploying version 1: $status"
PORT=$(jq -r .publishedPort "$BODY")
[[ "$(docker_page "$PORT")" == *"code-v1"* ]] || fail "redeploying version 1 does not serve V1"
[ "$(psql_q "select source_archive_id from deployments where id = '$DEP3';")" = "$V1_ID" ] \
  || fail "the redeployment did not take version 1's archive again"
pass "redeploying version 1 rebuilds its own code: \"code-v1\""

# ─── 6. K3s ───────────────────────────────────────────────────────────────────
if [ -n "$K3S_ID" ]; then
  step "6. On K3s: a new deployment builds the latest archive"
  read -r DEPK status <<<"$(deploy_and_wait "$APP_ID" "$K3S_ID" k3s)"
  [ "$status" = "success" ] || fail "K3s deployment: $status — $(jq -r .error "$BODY")"
  [ "$(jq -r .sourceArchiveName "$BODY")" = "code-v2.tar.gz" ] || fail "archive: $(jq -r .sourceArchiveName "$BODY")"
  page=$(docker compose exec -T k3s-target sh -c \
    "kubectl -n app-$SLUG exec deploy/web -- wget -qO- http://127.0.0.1:8080/ 2>/dev/null || k3s kubectl -n app-$SLUG exec deploy/web -- wget -qO- http://127.0.0.1:8080/")
  [[ "$page" == *"code-v2"* ]] || fail "the pod does not serve the archive's code: $page"
  pass "built on the cluster from code-v2.tar.gz, the pod serves \"code-v2\""
else
  step "6. K3s — not requested (K3S_TARGET empty)"
fi

# ─── 7. A CI, through a token ─────────────────────────────────────────────────
step "7. A CI uploads with a token limited to the application"
# No `$(mk_token …)`: a subshell would lose the identifier, and the cleanup
# would revoke nothing. The token comes back in `NEW_TOKEN`.
mk_token() {
  local scope="$1" code
  code=$(req POST /api/tokens "{\"name\":\"verif-archive\",\"permissions\":[\"application:read\",\"application:update\"],\"applicationIds\":[\"$scope\"],\"expiresInDays\":30}")
  [ "$code" = "201" ] || fail "token → HTTP $code: $(cat "$BODY")"
  TOKEN_IDS+=("$(jq -r .item.id "$BODY")")
  NEW_TOKEN=$(jq -r .token "$BODY")
}
mk_token "$APP_ID"
TOKEN="$NEW_TOKEN"
mk_token "$OTHER_ID"
OTHER_TOKEN="$NEW_TOKEN"
code=$(upload "$APP_ID" "$WORK/code-v2.tar.gz" "$OTHER_TOKEN")
[ "$code" = "403" ] || fail "token of another application: HTTP $code"
pass "a token limited to another application → 403"
code=$(upload "$APP_ID" "$WORK/code-v2.tar.gz" "$TOKEN")
[ "$code" = "202" ] || fail "the application's token: HTTP $code: $(cat "$BODY")"
CI_ID=$(jq -r .archive.id "$BODY")
[ "$(wait_archive "$APP_ID" "$CI_ID")" = "ready" ] || fail "the CI's archive was refused"
pass "a token limited to the application uploads (202), the archive is ready"

# ─── 8. An erased archive ─────────────────────────────────────────────────────
step "8. An erased archive can no longer be redeployed"
code=$(req DELETE "/api/applications/$APP_ID/archives/$V1_ID")
[ "$code" = "200" ] || fail "deleting V1 → HTTP $code: $(cat "$BODY")"
code=$(req POST "/api/applications/$APP_ID/redeploy" "{\"versionId\":\"$DEP1\",\"targetId\":\"$DOCKER_ID\",\"autoRollback\":false}")
[ "$code" = "409" ] && [ "$(error_code)" = "archive_gone" ] || fail "HTTP $code ($(error_code))"
[ "$(psql_q "select source_archive_name from deployments where id = '$DEP1';")" = "site-v1.zip" ] \
  || fail "the history lost the archive's name"
pass "409 archive_gone — the history keeps its name and its fingerprint"

# ─── 9. Retention ─────────────────────────────────────────────────────────────
step "9. Only the latest ones are kept"
for n in 1 2 3 4; do
  mkdir -p "$WORK/r$n" && make_tree "$WORK/r$n" "r$n"
  tar -czf "$WORK/r$n.tar.gz" -C "$WORK/r$n" .
  code=$(upload "$APP_ID" "$WORK/r$n.tar.gz")
  [ "$code" = "202" ] || fail "sending r$n → HTTP $code"
  wait_archive "$APP_ID" "$(jq -r .archive.id "$BODY")" >/dev/null
done
kept=$(psql_q "select count(*) from source_archives where application_id = '$APP_ID';")
[ "$kept" -le 5 ] || fail "$kept archives kept"
[ "$(psql_q "select count(*) from source_archives where id = '$TRAP_ID';")" = "0" ] \
  || fail "the oldest one (the booby-trapped archive) stayed"
pass "$kept archives kept, the oldest ones erased"

# ─── 10. Log and cleanup ──────────────────────────────────────────────────────
step "10. The log"
for action in source_archive.uploaded source_archive.ready source_archive.rejected source_archive.deleted source_archive.pruned; do
  n=$(psql_q "select count(*) from audit_logs where action = '$action' and created_at > now() - interval '1 hour' and (after->>'applicationId' = '$APP_ID' or before->>'applicationId' = '$APP_ID' or resource_id = '$APP_ID');")
  [ "$n" -ge 1 ] || fail "no $action entry"
done
pass "uploaded, ready, rejected, deleted, pruned: everything is in the log"
# `strpos` and not `LIKE`: in a pattern, `_` is a wildcard — and tokens carry some.
leak=$(psql_q "select count(*) from audit_logs where created_at > now() - interval '1 hour' and (strpos(coalesce(after::text,''), '$TOKEN') > 0 or strpos(coalesce(after::text,''), '$OTHER_TOKEN') > 0);")
[ "$leak" = "0" ] || fail "a token appears in the log"
pass "no token in the log"

printf '\n\033[32mUploaded code: everything complies.\033[0m\n'
