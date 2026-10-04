#!/usr/bin/env bash
#
# Vérifie le code téléversé d'une application, de bout en bout :
#
#   1. terrain : une application dont le service se construit depuis un
#      Dockerfile, sans dépôt lié
#   2. sans code, le déploiement est refusé avant d'être enfilé (409)
#   3. une archive piégée — un lien qui sortirait du code une fois le dossier
#      de tête retiré — est refusée par le worker, et le déploiement aussi
#   4. un zip sain : prêt, dossier de tête retiré, Dockerfile trouvé ; déployé
#      sur la cible Docker, il sert son contenu, le bit d'exécution a survécu,
#      et le code est sous source/ — rien à la racine de la release
#   5. un tar.gz V2 remplace V1 ; puis redéployer la version 1 retrouve le code V1
#   6. sur la cible K3s (si elle est donnée), un nouveau déploiement construit
#      la dernière archive — V2
#   7. une CI : un jeton limité à l'application téléverse ; limité à une autre,
#      il est refusé
#   8. une archive effacée : la version qu'elle a construite ne se redéploie plus
#   9. on ne garde que les dernières archives
#  10. le journal, sans secret ; ménage : application détruite partout
#
# Usage :
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
command -v python3 >/dev/null || { echo "python3 est requis pour fabriquer le zip"; exit 1; }

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

# Envoie une archive : le corps est le fichier, son nom dans un en-tête.
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

# Attend la lecture d'une archive par le worker. Écho : son statut.
wait_archive() {
  local app="$1" id="$2" status=""
  for _ in $(seq 1 60); do
    req GET "/api/applications/$app/archives/$id" >/dev/null
    status=$(jq -r '.archive.status' "$BODY")
    case "$status" in ready|rejected) printf '%s' "$status"; return ;; esac
    sleep 1
  done
  fail "l'archive $id n'a pas été lue en une minute (statut « $status »)"
}

# Deploys and waits for the verdict. Echoes: "<deploymentId> <status>".
deploy_and_wait() {
  local app="$1" target="$2" runtime="$3" code id status=""
  code=$(req POST /api/deployments \
    "{\"applicationId\":\"$app\",\"targetId\":\"$target\",\"runtime\":\"$runtime\",\"autoRollback\":false,\"scanConfig\":{\"scanners\":[],\"failOn\":\"NONE\"}}")
  [ "$code" = "202" ] || fail "POST /api/deployments → HTTP $code : $(cat "$BODY")"
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

# Ce que l'application sert, lu depuis la machine Docker elle-même.
docker_page() {
  local port="$1"
  docker compose exec -T ssh-target sh -c \
    "wget -qO- http://127.0.0.1:$port/ 2>/dev/null || curl -s http://127.0.0.1:$port/"
}

cascade_delete() {
  local app="$1" code
  [ -n "$app" ] || return 0
  code=$(req POST "/api/applications/$app/cascade" '{"force":false}')
  [ "$code" = "202" ] || { info "cascade $app → HTTP $code : $(cat "$BODY")"; return 0; }
  for _ in $(seq 1 120); do
    sleep 2
    code=$(req GET "/api/applications/$app")
    [ "$code" = "404" ] && return 0
  done
  info "l'application $app est encore là après 4 minutes"
}

cleanup() {
  set +e
  # `${t[@]+…}` : bash 3.2 (macOS) refuse un tableau vide sous `set -u`.
  for token in ${TOKEN_IDS[@]+"${TOKEN_IDS[@]}"}; do req DELETE "/api/tokens/$token" >/dev/null; done
  cascade_delete "$APP_ID"
  cascade_delete "$OTHER_ID"
  rm -rf "$WORK"
}
trap cleanup EXIT

# ─── les archives de l'essai ─────────────────────────────────────────────────

# Un site busybox : la page porte une marque, le script de démarrage doit
# rester exécutable — sans son bit, le conteneur ne démarre pas.
make_tree() {
  local dir="$1" marker="$2"
  mkdir -p "$dir/www"
  printf 'FROM busybox:1.37\nCOPY www/ /www/\nCOPY entree.sh /entree.sh\nEXPOSE 8080\nCMD ["/entree.sh"]\n' > "$dir/Dockerfile"
  printf '#!/bin/sh\nexec httpd -f -p 8080 -h /www\n' > "$dir/entree.sh"
  chmod 755 "$dir/entree.sh"
  printf '<h1>%s</h1>\n' "$marker" > "$dir/www/index.html"
  mkdir -p "$dir/.git" && printf '[core]\n' > "$dir/.git/config"
}

# zip du dossier `site/` (dossier de tête compris), droits Unix conservés.
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

# ─── 1. Terrain ───────────────────────────────────────────────────────────────
step "1. Terrain"
for _ in 1 2 3 4 5; do
  code=$(req POST /api/auth/sign-in/email "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
  [ "$code" = "429" ] || break
  sleep 6
done
[ "$code" = "200" ] || fail "connexion → HTTP $code : $(cat "$BODY")"
[ "$(jq -r '.user.role // empty' "$BODY")" = "admin" ] || fail "\"$ADMIN_EMAIL\" is not an administrator"
pass "signed in as $ADMIN_EMAIL"

req GET /api/targets >/dev/null
DOCKER_ID=$(jq -r --arg n "$DOCKER_TARGET" '.items[] | select(.name == $n) | .id' "$BODY")
[ -n "$DOCKER_ID" ] || fail "cible Docker « $DOCKER_TARGET » introuvable"
K3S_ID=""
if [ -n "$K3S_TARGET" ]; then
  K3S_ID=$(jq -r --arg n "$K3S_TARGET" '.items[] | select(.name == $n) | .id' "$BODY")
  [ -n "$K3S_ID" ] || fail "cible K3s « $K3S_TARGET » introuvable"
fi
pass "cibles : $DOCKER_TARGET${K3S_TARGET:+, $K3S_TARGET}"

# Leftovers from a previous pass.
req GET /api/applications >/dev/null
cp "$BODY" "$WORK/applications.json"
for slug in "$SLUG" "$OTHER_SLUG"; do
  old=$(jq -r --arg s "$slug" '.items[] | select(.slug == $s) | .id' "$WORK/applications.json" | head -1)
  [ -n "$old" ] && { info "reste d'un passage précédent : $slug"; cascade_delete "$old"; }
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
[ "$code" = "201" ] || fail "création de l'application → HTTP $code : $(cat "$BODY")"
APP_ID=$(jq -r .id "$BODY")
code=$(req POST /api/applications "$(spec "$OTHER_SLUG")")
[ "$code" = "201" ] || fail "création de la seconde application → HTTP $code"
OTHER_ID=$(jq -r .id "$BODY")
pass "application « $SLUG » : un service construit depuis ./Dockerfile, sans dépôt lié"

# ─── 2. Sans code ─────────────────────────────────────────────────────────────
step "2. Sans code, pas de déploiement"
code=$(req POST /api/deployments \
  "{\"applicationId\":\"$APP_ID\",\"targetId\":\"$DOCKER_ID\",\"runtime\":\"docker\",\"scanConfig\":{\"scanners\":[],\"failOn\":\"NONE\"}}")
[ "$code" = "409" ] && [ "$(error_code)" = "source_code_missing" ] || fail "HTTP $code ($(error_code))"
[ "$(psql_q "select count(*) from deployments where application_id = '$APP_ID';")" = "0" ] \
  || fail "un déploiement a été créé malgré le refus"
pass "409 source_code_missing, rien d'enfilé"

code=$(req POST "/api/applications/$APP_ID/archives" '{"pas":"une archive"}')
[ "$code" = "415" ] && [ "$(error_code)" = "unsupported_archive" ] || fail "JSON envoyé : HTTP $code ($(error_code))"
pass "un corps qui n'est pas une archive → 415"

# ─── 3. Archive piégée ────────────────────────────────────────────────────────
step "3. Une archive piégée"
mkdir -p "$WORK/piege/site"
make_tree "$WORK/piege/site" piege
# Dans `site/`, ce lien reste dans l'archive ; une fois `site/` retiré, il
# viserait `compose.yml`, à la racine de la release.
ln -s ../compose.yml "$WORK/piege/site/fuite"
tar -czf "$WORK/piege.tar.gz" -C "$WORK/piege" site
code=$(upload "$APP_ID" "$WORK/piege.tar.gz")
[ "$code" = "202" ] || fail "envoi → HTTP $code : $(cat "$BODY")"
TRAP_ID=$(jq -r .archive.id "$BODY")
[ "$(wait_archive "$APP_ID" "$TRAP_ID")" = "rejected" ] || fail "l'archive piégée est passée"
[ "$(jq -r .archive.rejection "$BODY")" = "link_outside" ] || fail "refus : $(jq -c .archive "$BODY")"
info "refus : $(jq -r '.archive.rejectionDetail' "$BODY")"
[ "$(psql_q "select count(*) from source_archive_chunks where archive_id = '$TRAP_ID';")" = "0" ] \
  || fail "les octets de l'archive refusée sont restés en base"
pass "refusée par le worker (link_outside), ses octets effacés"

code=$(req POST /api/deployments \
  "{\"applicationId\":\"$APP_ID\",\"targetId\":\"$DOCKER_ID\",\"runtime\":\"docker\",\"scanConfig\":{\"scanners\":[],\"failOn\":\"NONE\"}}")
[ "$code" = "409" ] && [ "$(error_code)" = "archive_rejected" ] || fail "HTTP $code ($(error_code))"
pass "déployer avec la dernière archive refusée → 409 archive_rejected"

# ─── 4. Un zip sain, sur Docker ───────────────────────────────────────────────
step "4. Un zip sain, déployé sur Docker"
mkdir -p "$WORK/v1/site"
make_tree "$WORK/v1/site" "code-v1"
make_zip "$WORK/v1/site" "$WORK/site-v1.zip"
code=$(upload "$APP_ID" "$WORK/site-v1.zip")
[ "$code" = "202" ] || fail "envoi → HTTP $code : $(cat "$BODY")"
V1_ID=$(jq -r .archive.id "$BODY")
V1_SHA=$(jq -r .archive.sha256 "$BODY")
LOCAL_SHA=$( (sha256sum "$WORK/site-v1.zip" 2>/dev/null || shasum -a 256 "$WORK/site-v1.zip") | cut -d' ' -f1)
[ "$V1_SHA" = "$LOCAL_SHA" ] || fail "SHA-256 : panel $V1_SHA, local $LOCAL_SHA"
pass "reçu, et le SHA-256 du panel est celui du fichier"
[ "$(wait_archive "$APP_ID" "$V1_ID")" = "ready" ] || fail "refusée : $(jq -c .archive "$BODY")"
jq -e '.archive.report.strippedRoot == "site" and .archive.report.dockerfiles == ["Dockerfile"]
       and .archive.report.skippedEntries >= 1' "$BODY" >/dev/null \
  || fail "rapport inattendu : $(jq -c .archive.report "$BODY")"
pass "prête : dossier de tête « site/ » retiré, .git/ écarté, Dockerfile trouvé"

read -r DEP1 status <<<"$(deploy_and_wait "$APP_ID" "$DOCKER_ID" docker)"
[ "$status" = "success" ] || fail "déploiement V1 : $status — $(jq -r .error "$BODY")"
PORT=$(jq -r .publishedPort "$BODY")
[ "$(jq -r .sourceArchiveName "$BODY")" = "site-v1.zip" ] \
  || fail "le détail du déploiement ne nomme pas son archive : $(jq -r .sourceArchiveName "$BODY")"
page=$(docker_page "$PORT")
[[ "$page" == *"code-v1"* ]] || fail "la page servie ne porte pas la marque V1 : $page"
pass "déployé (v1), il sert « code-v1 » sur le port $PORT — entree.sh a gardé son bit d'exécution"

RELEASE=$(docker compose exec -T ssh-target sh -c "ls -dt $DRIVER_ROOT_PATH/apps/$SLUG/*/ | head -1" | tr -d '\r')
layout=$(docker compose exec -T ssh-target sh -c "ls -A $RELEASE | tr '\n' ' '; echo; ls -A ${RELEASE}source | tr '\n' ' '")
root=$(printf '%s' "$layout" | sed -n 1p)
code_dir=$(printf '%s' "$layout" | sed -n 2p)
[[ "$code_dir" == *Dockerfile* && "$code_dir" == *www* ]] || fail "source/ : $code_dir"
[[ "$root" != *Dockerfile* && "$code_dir" != *site* && "$code_dir" != *.git* ]] \
  || fail "racine : $root — source/ : $code_dir"
pass "le code est sous source/ (sans site/ ni .git/), rien à la racine de la release"

# ─── 5. V2, puis retour au code de V1 ─────────────────────────────────────────
step "5. Une nouvelle version, puis le retour au code d'avant"
mkdir -p "$WORK/v2"
make_tree "$WORK/v2" "code-v2"
tar -czf "$WORK/code-v2.tar.gz" -C "$WORK/v2" .
code=$(upload "$APP_ID" "$WORK/code-v2.tar.gz")
[ "$code" = "202" ] || fail "envoi V2 → HTTP $code"
V2_ID=$(jq -r .archive.id "$BODY")
[ "$(wait_archive "$APP_ID" "$V2_ID")" = "ready" ] || fail "V2 refusée : $(jq -c .archive "$BODY")"
read -r DEP2 status <<<"$(deploy_and_wait "$APP_ID" "$DOCKER_ID" docker)"
[ "$status" = "success" ] || fail "déploiement V2 : $status"
PORT=$(jq -r .publishedPort "$BODY")
[[ "$(docker_page "$PORT")" == *"code-v2"* ]] || fail "la page ne porte pas la marque V2"
pass "V2 (tar.gz sans dossier de tête) déployée, elle sert « code-v2 »"

code=$(req POST "/api/applications/$APP_ID/redeploy" "{\"versionId\":\"$DEP1\",\"targetId\":\"$DOCKER_ID\",\"autoRollback\":false}")
[ "$code" = "202" ] || fail "redéploiement de la version 1 → HTTP $code : $(cat "$BODY")"
read -r DEP3 status <<<"$(wait_deployment "$(jq -r .id "$BODY")")"
[ "$status" = "success" ] || fail "redéploiement de la version 1 : $status"
PORT=$(jq -r .publishedPort "$BODY")
[[ "$(docker_page "$PORT")" == *"code-v1"* ]] || fail "le redéploiement de la version 1 ne sert pas V1"
[ "$(psql_q "select source_archive_id from deployments where id = '$DEP3';")" = "$V1_ID" ] \
  || fail "le redéploiement n'a pas repris l'archive de la version 1"
pass "redéployer la version 1 reconstruit son code à elle : « code-v1 »"

# ─── 6. K3s ───────────────────────────────────────────────────────────────────
if [ -n "$K3S_ID" ]; then
  step "6. Sur K3s : un nouveau déploiement construit la dernière archive"
  read -r DEPK status <<<"$(deploy_and_wait "$APP_ID" "$K3S_ID" k3s)"
  [ "$status" = "success" ] || fail "déploiement K3s : $status — $(jq -r .error "$BODY")"
  [ "$(jq -r .sourceArchiveName "$BODY")" = "code-v2.tar.gz" ] || fail "archive : $(jq -r .sourceArchiveName "$BODY")"
  page=$(docker compose exec -T k3s-target sh -c \
    "kubectl -n app-$SLUG exec deploy/web -- wget -qO- http://127.0.0.1:8080/ 2>/dev/null || k3s kubectl -n app-$SLUG exec deploy/web -- wget -qO- http://127.0.0.1:8080/")
  [[ "$page" == *"code-v2"* ]] || fail "le pod ne sert pas le code de l'archive : $page"
  pass "construite sur le cluster depuis code-v2.tar.gz, le pod sert « code-v2 »"
else
  step "6. K3s — non demandé (K3S_TARGET vide)"
fi

# ─── 7. Une CI, par jeton ─────────────────────────────────────────────────────
step "7. Une CI téléverse avec un jeton limité à l'application"
# Pas de `$(mk_token …)` : un sous-shell perdrait l'identifiant, et le ménage
# ne révoquerait rien. Le jeton revient dans `NEW_TOKEN`.
mk_token() {
  local scope="$1" code
  code=$(req POST /api/tokens "{\"name\":\"verif-archive\",\"permissions\":[\"application:read\",\"application:update\"],\"applicationIds\":[\"$scope\"],\"expiresInDays\":30}")
  [ "$code" = "201" ] || fail "jeton → HTTP $code : $(cat "$BODY")"
  TOKEN_IDS+=("$(jq -r .item.id "$BODY")")
  NEW_TOKEN=$(jq -r .token "$BODY")
}
mk_token "$APP_ID"
TOKEN="$NEW_TOKEN"
mk_token "$OTHER_ID"
OTHER_TOKEN="$NEW_TOKEN"
code=$(upload "$APP_ID" "$WORK/code-v2.tar.gz" "$OTHER_TOKEN")
[ "$code" = "403" ] || fail "jeton d'une autre application : HTTP $code"
pass "un jeton limité à une autre application → 403"
code=$(upload "$APP_ID" "$WORK/code-v2.tar.gz" "$TOKEN")
[ "$code" = "202" ] || fail "jeton de l'application : HTTP $code : $(cat "$BODY")"
CI_ID=$(jq -r .archive.id "$BODY")
[ "$(wait_archive "$APP_ID" "$CI_ID")" = "ready" ] || fail "archive de la CI refusée"
pass "un jeton limité à l'application téléverse (202), l'archive est prête"

# ─── 8. Une archive effacée ───────────────────────────────────────────────────
step "8. Une archive effacée ne se redéploie plus"
code=$(req DELETE "/api/applications/$APP_ID/archives/$V1_ID")
[ "$code" = "200" ] || fail "suppression de V1 → HTTP $code : $(cat "$BODY")"
code=$(req POST "/api/applications/$APP_ID/redeploy" "{\"versionId\":\"$DEP1\",\"targetId\":\"$DOCKER_ID\",\"autoRollback\":false}")
[ "$code" = "409" ] && [ "$(error_code)" = "archive_gone" ] || fail "HTTP $code ($(error_code))"
[ "$(psql_q "select source_archive_name from deployments where id = '$DEP1';")" = "site-v1.zip" ] \
  || fail "l'historique a perdu le nom de l'archive"
pass "409 archive_gone — l'historique garde son nom et son empreinte"

# ─── 9. Rétention ─────────────────────────────────────────────────────────────
step "9. On ne garde que les dernières"
for n in 1 2 3 4; do
  mkdir -p "$WORK/r$n" && make_tree "$WORK/r$n" "r$n"
  tar -czf "$WORK/r$n.tar.gz" -C "$WORK/r$n" .
  code=$(upload "$APP_ID" "$WORK/r$n.tar.gz")
  [ "$code" = "202" ] || fail "envoi r$n → HTTP $code"
  wait_archive "$APP_ID" "$(jq -r .archive.id "$BODY")" >/dev/null
done
kept=$(psql_q "select count(*) from source_archives where application_id = '$APP_ID';")
[ "$kept" -le 5 ] || fail "$kept archives gardées"
[ "$(psql_q "select count(*) from source_archives where id = '$TRAP_ID';")" = "0" ] \
  || fail "la plus ancienne (l'archive piégée) est restée"
pass "$kept archives gardées, les plus anciennes effacées"

# ─── 10. Journal et ménage ────────────────────────────────────────────────────
step "10. Le journal"
for action in source_archive.uploaded source_archive.ready source_archive.rejected source_archive.deleted source_archive.pruned; do
  n=$(psql_q "select count(*) from audit_logs where action = '$action' and created_at > now() - interval '1 hour' and (after->>'applicationId' = '$APP_ID' or before->>'applicationId' = '$APP_ID' or resource_id = '$APP_ID');")
  [ "$n" -ge 1 ] || fail "aucune entrée $action"
done
pass "uploaded, ready, rejected, deleted, pruned : tout est au journal"
# `strpos` et non `LIKE` : dans un motif, `_` est un joker — et les jetons en portent.
leak=$(psql_q "select count(*) from audit_logs where created_at > now() - interval '1 hour' and (strpos(coalesce(after::text,''), '$TOKEN') > 0 or strpos(coalesce(after::text,''), '$OTHER_TOKEN') > 0);")
[ "$leak" = "0" ] || fail "un jeton apparaît au journal"
pass "aucun jeton au journal"

printf '\n\033[32mCode téléversé : tout est conforme.\033[0m\n'
