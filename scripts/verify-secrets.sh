#!/usr/bin/env bash
#
# Vérifie le magasin de valeurs de secrets et la règle de sonde des drivers :
#
#   1. une application à deux services — PostgreSQL non exposé, une console qui
#      en dépend — se déploie, saine, base initialisée
#   2. le `.env` déposé sur la cible porte une valeur NON VIDE, générée par le
#      panel sans que personne ne l'ait saisie
#   3. un REDÉPLOIEMENT réutilise le même secret, et la base répond toujours
#   4. la valeur ne ressort ni par l'API, ni dans le HTML, ni dans `audit_logs`,
#      ni dans les logs du panel et du worker
#   5. un secret déclaré mais impossible à résoudre fait échouer le RENDU, avec
#      un message qui le nomme — et un secret délibérément vide reste accepté
#   6. la base non exposée reçoit une sonde TCP, pas une sonde HTTP
#   7. un secret saisi peut être remplacé ; il n'existe aucun moyen de le relire
#
# Puis les ALIAS — un mot de passe que deux images lisent sous deux noms :
#
#   8. une AppSpec ANCIENNE, `secrets: ["NOM"]` en chaînes nues, se relit et se
#      déploie toujours (c'est le scénario 1 à 7 : il n'a pas été réécrit)
#   9. deux noms reliés par `from` reçoivent la MÊME valeur dans le `.env`
#      déposé — comparaison d'empreintes SHA-256, jamais de valeur imprimée
#  10. une SEULE ligne en base pour les deux noms ; l'alias n'en crée pas
#  11. un alias vers un secret inexistant est refusé à la VALIDATION de
#      l'AppSpec, en le nommant, et un cycle d'alias l'est aussi
#  12. une base MariaDB DÉMARRE et WordPress s'y CONNECTE pour de vrai —
#      l'authentification réussit, c'est le seul test qui compte
#  13. le rendu K3s reçoit la même carte complète que le rendu Docker
#
# La cible utilisée est `cible-de-verification` (docker-in-docker), jamais une
# machine de production. Tout ce que le script crée est détruit à la fin.
#
# Usage :
#   ./scripts/verify-secrets.sh
#   BASE_URL=http://localhost:3200 TARGET_NAME=ma-vm ./scripts/verify-secrets.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
TARGET_NAME="${TARGET_NAME:-cible-de-verification}"
CLIENT_IP="${CLIENT_IP:-198.51.100.77}"
SLUG="${SLUG:-verif-secrets}"
SLUG_ALIAS="${SLUG_ALIAS:-verif-alias}"
DEPLOY_TIMEOUT="${DEPLOY_TIMEOUT:-600}"

# Accès SSH à la cible, pour lire ce qui a réellement été déposé.
SSH_KEY="${SSH_KEY:-.test-target-key}"
SSH_HOST="${SSH_HOST:-127.0.0.1}"
SSH_PORT="${SSH_PORT:-2222}"
SSH_USER="${SSH_USER:-tp}"
DRIVER_ROOT_PATH="${DRIVER_ROOT_PATH:-/opt/bootstrap}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
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
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -H "x-forwarded-for: $CLIENT_IP" -b "$JAR" -c "$JAR")
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }

# Exécute sur la CIBLE. Le script lit des fichiers déposés là-bas, mais
# n'imprime jamais leur contenu : seulement des longueurs et des empreintes.
on_target() {
  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o LogLevel=ERROR -i "$ROOT/$SSH_KEY" -p "$SSH_PORT" \
      "$SSH_USER@$SSH_HOST" "$@"
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

# Le compte doit être administrateur. Se contenter d'une connexion réussie
# laisserait le script échouer bien plus loin, sur un 403 énigmatique.
assert_admin() {
  local role
  role=$(jq -r '.user.role // empty' "$BODY")
  [ "$role" = "admin" ] && return 0
  fail "« $ADMIN_EMAIL » a le rôle « ${role:-aucun} », pas « admin » — voir /admin/users"
}

# Enfile un déploiement et attend son état terminal. Identifiant sur stdout.
deploy() {
  local app="${1:-$APP_ID}"
  local code deploy_id status waited=0

  code=$(req POST /api/deployments "$(jq -nc \
    --arg app "$app" --arg target "$TARGET_ID" \
    '{applicationId:$app, targetId:$target, runtime:"docker", proxy:"traefik",
      autoRollback:false, scanConfig:{scanners:[], failOn:"NONE"}}')")
  [ "$code" = "202" ] || fail "POST /api/deployments → HTTP $code : $(cat "$BODY")"

  deploy_id=$(jq -r .id "$BODY")
  info "déploiement $deploy_id enfilé" >&2

  while [ "$waited" -lt "$DEPLOY_TIMEOUT" ]; do
    sleep 5
    waited=$(( waited + 5 ))
    req GET "/api/deployments/$deploy_id" >/dev/null
    status=$(jq -r .status "$BODY")
    case "$status" in
      success|failed|rolled_back|destroyed) printf '%s' "$deploy_id"; return 0 ;;
    esac
  done
  fail "le déploiement $deploy_id n'a pas abouti en ${DEPLOY_TIMEOUT}s (état « $status »)"
}

destroy() {
  local id="$1" code status waited=0
  code=$(req DELETE "/api/deployments/$id")
  case "$code" in
    202) ;;
    409|404) return 0 ;;
    *) info "DELETE /api/deployments/$id → HTTP $code"; return 0 ;;
  esac
  while [ "$waited" -lt 180 ]; do
    sleep 4
    waited=$(( waited + 4 ))
    req GET "/api/deployments/$id" >/dev/null
    status=$(jq -r .status "$BODY")
    [ "$status" = "destroyed" ] && return 0
  done
  info "le déploiement $id n'est pas passé à « destroyed » en 180s"
}

# ─── Ménage, exécuté aussi en cas d'échec ────────────────────────────────────
# Détruit tous les déploiements d'une application, puis l'application.
remove_app() {
  local app="$1" slug="$2" code ids rows
  req GET "/api/deployments?applicationId=$app&pageSize=50" >/dev/null 2>&1 || true
  ids=$(jq -r '.items[]?.id' "$BODY" 2>/dev/null || true)
  for id in $ids; do destroy "$id"; done
  # Détruire démonte l'application sur la cible ; purger efface la trace en
  # base. Les deux sont nécessaires : `countDeploymentsFor()` compte toutes les
  # lignes, détruites comprises, et refuserait la suppression de l'application.
  for id in $ids; do req DELETE "/api/deployments/$id/purge" >/dev/null 2>&1 || true; done
  code=$(req DELETE "/api/applications/$app")
  case "$code" in
    200) pass "application « $slug » supprimée (secrets effacés par cascade)" ;;
    *)   info "DELETE /api/applications/$app → HTTP $code : $(cat "$BODY")" ;;
  esac
  rows=$(psql_q "select count(*) from application_secrets where application_id = '$app';")
  [ "$rows" = "0" ] && pass "« $slug » : aucune ligne résiduelle dans application_secrets" \
                    || fail "$rows secret(s) survivent à la suppression de « $slug »"
  on_target "test ! -d $DRIVER_ROOT_PATH/apps/$slug" >/dev/null 2>&1 \
    && pass "« $slug » : répertoire de release retiré de la cible" \
    || info "le répertoire $DRIVER_ROOT_PATH/apps/$slug existe encore sur la cible"
}

CLEANED=0
cleanup() {
  [ "$CLEANED" = "1" ] && return 0
  CLEANED=1
  [ -n "${APP_ID:-}${ALIAS_APP_ID:-}" ] || return 0
  printf '\n\033[1m%s\033[0m\n' "Ménage"
  if [ -n "${ALIAS_APP_ID:-}" ]; then remove_app "$ALIAS_APP_ID" "$SLUG_ALIAS"; fi
  if [ -n "${APP_ID:-}" ]; then remove_app "$APP_ID" "$SLUG"; fi
  return 0
}
trap 'cleanup; rm -rf "$WORK"' EXIT

# Supprime ce qu'une exécution précédente aurait laissé sous ce slug.
purge_previous() {
  local slug="$1" old
  req GET /api/applications >/dev/null
  old=$(jq -r --arg s "$slug" '.items[] | select(.slug == $s) | .id' "$BODY")
  [ -n "$old" ] || return 0
  req GET "/api/deployments?applicationId=$old&pageSize=50" >/dev/null
  local ids
  ids=$(jq -r '.items[]?.id' "$BODY")
  for id in $ids; do destroy "$id"; done
  for id in $ids; do req DELETE "/api/deployments/$id/purge" >/dev/null 2>&1 || true; done
  req DELETE "/api/applications/$old" >/dev/null
  info "application « $slug » d'une exécution précédente supprimée"
}

# ─────────────────────────────────────────────────────────────────────────────

step "1. Connexion"
login
pass "connecté en tant que $ADMIN_EMAIL"

step "2. Cible de vérification"
req GET /api/targets >/dev/null
TARGET_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY")
[ -n "$TARGET_ID" ] || fail "cible « $TARGET_NAME » introuvable — lancez ./scripts/setup-test-target.sh"
jq -e --arg n "$TARGET_NAME" \
  '.items[] | select(.name == $n) | .runtimesAvailable.docker.available == true' "$BODY" >/dev/null \
  || fail "la cible « $TARGET_NAME » n'a pas de runtime Docker — lancez un preflight"
pass "cible « $TARGET_NAME » ($TARGET_ID), runtime Docker disponible"
on_target 'echo ok' >/dev/null 2>&1 || fail "SSH vers la cible impossible ($SSH_USER@$SSH_HOST:$SSH_PORT)"
pass "SSH vers la cible opérationnel"

step "3. Application à deux services"
# `postgres:16` est l'image DEBIAN, choisie exprès : elle n'embarque ni `nc`,
# ni `wget`, ni `curl`. C'est elle qui mettait la sonde TCP du driver Docker en
# échec, et donc `depends_on: service_healthy` en attente éternelle.
cat > "$WORK/spec.json" <<JSON
{
  "name": "$SLUG",
  "version": "1.0.0",
  "services": [
    {
      "name": "db",
      "source": { "type": "image", "ref": "postgres:16" },
      "port": 5432,
      "exposed": false,
      "env": { "POSTGRES_DB": "verifdb", "POSTGRES_USER": "verif" },
      "secrets": ["POSTGRES_PASSWORD"],
      "resources": { "cpuMilli": 1000, "memoryMi": 1024 },
      "healthcheck": { "path": "/", "port": 5432, "intervalSec": 5, "timeoutSec": 3, "retries": 40 },
      "volumes": [{ "name": "data", "mountPath": "/var/lib/postgresql/data", "size": "1Gi" }],
      "dependsOn": []
    },
    {
      "name": "console",
      "source": { "type": "image", "ref": "sosedoff/pgweb:0.16.2" },
      "port": 8081,
      "exposed": true,
      "env": {
        "PGHOST": "db", "PGPORT": "5432", "PGUSER": "verif",
        "PGDATABASE": "verifdb", "PGSSLMODE": "disable"
      },
      "secrets": ["POSTGRES_PASSWORD", "CONSOLE_API_TOKEN"],
      "resources": { "cpuMilli": 500, "memoryMi": 256 },
      "healthcheck": { "path": "/", "intervalSec": 5, "timeoutSec": 3, "retries": 30 },
      "dependsOn": ["db"]
    }
  ]
}
JSON

# Ménage d'une exécution précédente.
purge_previous "$SLUG"
purge_previous "$SLUG_ALIAS"

jq '{appSpec: .}' "$WORK/spec.json" > "$WORK/create.json"
code=$(req POST /api/applications "@$WORK/create.json")
[ "$code" = "201" ] || fail "POST /api/applications → HTTP $code : $(cat "$BODY")"
APP_ID=$(jq -r .id "$BODY")
pass "application « $SLUG » créée ($APP_ID)"

step "4. Les secrets déclarés sont générés, pas demandés"
code=$(req GET "/api/applications/$APP_ID/secrets")
[ "$code" = "200" ] || fail "GET .../secrets → HTTP $code : $(cat "$BODY")"
jq -e '[.items[] | select(.isSet)] | length == 2' "$BODY" >/dev/null \
  || fail "deux secrets définis attendus, reçu $(jq -c '[.items[].name]' "$BODY")"
jq -e '.items[] | select(.name == "POSTGRES_PASSWORD") | .origin == "generated"' "$BODY" >/dev/null \
  || fail "POSTGRES_PASSWORD n'est pas marqué « generated »"
jq -e '[.items[] | select(.name == "POSTGRES_PASSWORD") | .services] | flatten | sort == ["console","db"]' \
  "$BODY" >/dev/null || fail "POSTGRES_PASSWORD devrait être réclamé par db ET console"
pass "$(jq -r '[.items[] | "\(.name) (\(.origin))"] | join(", ")' "$BODY")"

# Rien dans cette réponse ne ressemble à une valeur.
jq -e '[.items[] | keys] | flatten | unique | index("value") == null' "$BODY" >/dev/null \
  || fail "la réponse de l'API porte un champ « value »"
pass "aucun champ « value » dans la réponse de l'API"

step "5. Un secret externe se SAISIT, et se remplace"
TOKEN="jeton-externe-de-verification-8f3a2b"
code=$(req PUT "/api/applications/$APP_ID/secrets/CONSOLE_API_TOKEN" \
  "{\"value\":\"$TOKEN\"}")
[ "$code" = "200" ] || fail "PUT .../CONSOLE_API_TOKEN → HTTP $code : $(cat "$BODY")"
jq -e '.origin == "provided" and .isSet == true' "$BODY" >/dev/null \
  || fail "le secret saisi n'est pas marqué « provided »"
grep -q "$TOKEN" "$BODY" && fail "la réponse du PUT renvoie la valeur saisie"
pass "CONSOLE_API_TOKEN saisi → origine « provided », réponse sans la valeur"

# Il n'existe aucun GET qui rende la valeur.
req GET "/api/applications/$APP_ID/secrets" >/dev/null
grep -q "$TOKEN" "$BODY" && fail "la liste des secrets contient la valeur saisie"
pass "aucune route ne rend la valeur — un secret se pose, il ne se lit pas"

step "6. Premier déploiement"
D1=$(deploy)
req GET "/api/deployments/$D1" >/dev/null
STATUS=$(jq -r .status "$BODY")
[ "$STATUS" = "success" ] || {
  info "étapes : $(jq -rc '[.steps[] | "\(.key)=\(.status)"] | join(" ")' "$BODY")"
  info "erreur : $(jq -r '.error // "(aucune)"' "$BODY")"
  fail "le déploiement a fini en « $STATUS »"
}
PORT=$(jq -r '.publishedPort // empty' "$BODY")
pass "déploiement $D1 réussi — port publié $PORT"
jq -e '[.steps[] | select(.status == "failed")] | length == 0' "$BODY" >/dev/null \
  || fail "des étapes ont échoué"
pass "toutes les étapes : $(jq -rc '[.steps[] | "\(.key)=\(.status)"] | join(" ")' "$BODY")"

step "7. Conteneurs sains, base initialisée"
PS=$(on_target "docker ps --filter label=tp.app=$SLUG --format '{{.Names}} {{.Status}}'")
printf '%s\n' "$PS" | while IFS= read -r line; do [ -n "$line" ] && info "$line"; done
printf '%s' "$PS" | grep -q 'app-'"$SLUG"'-db-1 .*healthy' \
  || fail "le conteneur de base n'est pas sain : $PS"
printf '%s' "$PS" | grep -q 'app-'"$SLUG"'-console-1 .*healthy' \
  || fail "le conteneur console n'est pas sain : $PS"
pass "les deux conteneurs sont « healthy »"

# La preuve que le mot de passe n'est pas vide et qu'il est CELUI avec lequel la
# base s'est initialisée : on s'authentifie avec, depuis le conteneur, sans
# jamais faire sortir la valeur.
AUTH=$(on_target "docker exec app-$SLUG-db-1 sh -c 'PGPASSWORD=\$POSTGRES_PASSWORD psql -h 127.0.0.1 -U verif -d verifdb -tAc \"select 42\"'" 2>&1 | tr -d ' \r')
[ "$AUTH" = "42" ] || fail "la base n'accepte pas le mot de passe du .env : $AUTH"
pass "authentification PostgreSQL réussie avec la valeur du .env (select 42 → 42)"

if [ -n "$PORT" ]; then
  HTTP=$(curl -s -o "$WORK/app.html" -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
  [ "$HTTP" = "200" ] || info "la console répond HTTP $HTTP sur 127.0.0.1:$PORT (non bloquant)"
  [ "$HTTP" = "200" ] && pass "la console exposée répond HTTP 200 sur 127.0.0.1:$PORT"
fi

step "8. Le .env déposé sur la cible porte une valeur non vide"
RELEASE="$DRIVER_ROOT_PATH/apps/$SLUG/current"
ENV_MODE=$(on_target "stat -c %a $RELEASE/.env")
[ "$ENV_MODE" = "600" ] || fail ".env en mode $ENV_MODE, 600 attendu"
pass ".env déposé en 0600"

LEN=$(on_target "awk -F= '\$1==\"POSTGRES_PASSWORD\"{print length(\$0) - length(\$1) - 1}' $RELEASE/.env")
[ -n "$LEN" ] || fail "POSTGRES_PASSWORD absent du .env"
[ "$LEN" -ge 16 ] || fail "POSTGRES_PASSWORD fait $LEN caractère(s) — c'était exactement la panne d'origine"
pass "POSTGRES_PASSWORD présent, $LEN caractères (jamais imprimés)"

on_target "grep -q '^CONSOLE_API_TOKEN=' $RELEASE/.env" \
  || fail "CONSOLE_API_TOKEN absent du .env"
pass "CONSOLE_API_TOKEN, saisi par l'opérateur, est lui aussi dans le .env"

# Empreinte, pas valeur : c'est elle qu'on comparera après redéploiement.
FP1=$(on_target "grep '^POSTGRES_PASSWORD=' $RELEASE/.env | sha256sum | cut -c1-16")
info "empreinte du secret (sha256, 16 premiers caractères) : $FP1"

step "9. La base non exposée reçoit une sonde TCP, pas HTTP"
DB_PROBE=$(on_target "sed -n '/^  db:/,/^  console:/p' $RELEASE/compose.yml | grep -A2 'test:' | tr -d '\n'")
info "sonde db : $(printf '%s' "$DB_PROBE" | sed 's/^ *//')"
printf '%s' "$DB_PROBE" | grep -q 'nc -z' || fail "la sonde de db n'est pas un test de port ouvert"
printf '%s' "$DB_PROBE" | grep -q 'dev/tcp' \
  || fail "la sonde de db ne se replie pas sur /dev/tcp — inutilisable sur une image Debian"
printf '%s' "$DB_PROBE" | grep -qE 'wget|curl|http://' \
  && fail "la sonde de db contient encore un appel HTTP"
pass "db : sonde TCP (nc, puis /dev/tcp de bash), aucun HTTP"

CONSOLE_PROBE=$(on_target "sed -n '/^  console:/,\$p' $RELEASE/compose.yml | grep -A2 'test:' | tr -d '\n'")
printf '%s' "$CONSOLE_PROBE" | grep -q 'http://127.0.0.1:8081/' \
  || fail "la console exposée devrait être sondée en HTTP : $CONSOLE_PROBE"
pass "console : sonde HTTP sur le chemin de l'AppSpec"

on_target "grep -q 'service_healthy' $RELEASE/compose.yml" \
  || fail "depends_on: service_healthy absent — le scénario de blocage n'est pas reproduit"
pass "console attend db en « service_healthy » — la condition qui bloquait"

step "10. Un redéploiement réutilise le MÊME secret"
D2=$(deploy)
req GET "/api/deployments/$D2" >/dev/null
STATUS=$(jq -r .status "$BODY")
[ "$STATUS" = "success" ] || fail "le redéploiement a fini en « $STATUS »"
pass "redéploiement $D2 réussi"

FP2=$(on_target "grep '^POSTGRES_PASSWORD=' $RELEASE/.env | sha256sum | cut -c1-16")
[ "$FP1" = "$FP2" ] || fail "le secret a changé au redéploiement ($FP1 → $FP2) : la base serait inaccessible"
pass "même empreinte qu'au premier déploiement : $FP2"

ROWS=$(psql_q "select count(*) from application_secrets where application_id = '$APP_ID' and name = 'POSTGRES_PASSWORD';")
[ "$ROWS" = "1" ] || fail "$ROWS ligne(s) pour POSTGRES_PASSWORD, une seule attendue"
pass "une seule ligne en base : la valeur est attachée à l'application, pas au déploiement"

# La preuve qui compte : le volume de la base a survécu, et le mot de passe
# qu'il porte est toujours celui du .env.
AUTH=$(on_target "docker exec app-$SLUG-db-1 sh -c 'PGPASSWORD=\$POSTGRES_PASSWORD psql -h 127.0.0.1 -U verif -d verifdb -tAc \"select 42\"'" 2>&1 | tr -d ' \r')
[ "$AUTH" = "42" ] || fail "après redéploiement, la base refuse le mot de passe : $AUTH"
pass "la base répond toujours — le volume existant reconnaît le mot de passe"

step "11. La valeur ne ressort nulle part"
# Lue ici, et ici seulement : le script en a besoin pour chercher des fuites.
# Elle n'est jamais imprimée.
SECRET=$(on_target "grep '^POSTGRES_PASSWORD=' $RELEASE/.env | cut -d= -f2-")
[ -n "$SECRET" ] || fail "valeur illisible sur la cible"

req GET "/api/applications/$APP_ID" >/dev/null
grep -qF "$SECRET" "$BODY" && fail "GET /api/applications/:id contient la valeur"
req GET "/api/applications/$APP_ID/secrets" >/dev/null
grep -qF "$SECRET" "$BODY" && fail "GET .../secrets contient la valeur"
req GET "/api/deployments/$D2" >/dev/null
grep -qF "$SECRET" "$BODY" && fail "le déploiement expose la valeur"
pass "aucune réponse d'API ne porte la valeur"

curl -s -b "$JAR" -c "$JAR" -H "origin: $BASE_URL" "$BASE_URL/applications/$APP_ID" \
  -o "$WORK/page.html" -w '' || true
grep -qF "$SECRET" "$WORK/page.html" && fail "la page HTML contient la valeur"
grep -q 'Secrets' "$WORK/page.html" || info "section « Secrets » non trouvée dans le HTML rendu"
pass "la page HTML de l'application ne contient pas la valeur"

HITS=$(psql_q "select count(*) from audit_logs where coalesce(before::text,'') like '%$SECRET%' or coalesce(after::text,'') like '%$SECRET%';")
[ "$HITS" = "0" ] || fail "$HITS ligne(s) d'audit portent la valeur"
pass "audit_logs : aucune occurrence"

psql_q "select count(*) from audit_logs where action = 'application.secret.set' and resource_id = '$APP_ID';" \
  | grep -qv '^0$' || fail "l'action « application.secret.set » n'a pas été journalisée"
pass "audit : application.secret.set journalisé (nom et origine, sans valeur)"

for svc in panel worker; do
  if docker compose logs --no-log-prefix "$svc" 2>/dev/null | grep -qF "$SECRET"; then
    fail "la valeur apparaît dans « docker compose logs $svc »"
  fi
done
pass "docker compose logs panel / worker : aucune occurrence"

# Les logs de déploiement, relayés en SSE puis archivés, non plus.
HITS=$(psql_q "select count(*) from deployment_steps where coalesce(log,'') like '%$SECRET%';" 2>/dev/null || echo 0)
[ "$HITS" = "0" ] || fail "$HITS étape(s) de déploiement portent la valeur dans leurs logs"
pass "logs d'étapes : aucune occurrence"

step "12. Un secret non résolu fait échouer le RENDU, en le nommant"
req GET "/api/applications/$APP_ID" >/dev/null
jq -r '.appSpec' "$BODY" > "$WORK/appspec.json"

cat > "$WORK/render-check.mjs" <<'MJS'
import { readFileSync } from 'node:fs';

const { renderFiles } = await import(process.env.RENDER_MODULE);
const spec = JSON.parse(readFileSync(process.env.SPEC_FILE, 'utf8'));

// 1. Aucune valeur résolue → le rendu doit échouer, et nommer le coupable.
let message = null;
try {
  renderFiles({ spec, appSlug: spec.name, publishedPort: null });
} catch (error) {
  message = error.message;
}
if (message === null) {
  console.error('AUCUNE_ERREUR');
  process.exit(2);
}
if (!message.includes('POSTGRES_PASSWORD')) {
  console.error(`MESSAGE_SANS_NOM: ${message}`);
  process.exit(3);
}
console.log(`THROWS ${message}`);

// 2. Un secret DÉLIBÉRÉMENT vide reste légitime : absent n'est pas vide.
const values = {};
for (const service of spec.services) for (const name of service.secrets) values[name] = '';
const files = renderFiles({ spec, appSlug: spec.name, publishedPort: null, secretValues: values });
const env = files.find((file) => file.path === '.env');
if (!env || !/^POSTGRES_PASSWORD=$/m.test(env.content)) {
  console.error('VIDE_REFUSE');
  process.exit(4);
}
console.log('VIDE_ACCEPTE');
MJS

RENDER_MODULE="file://$ROOT/packages/core/dist/drivers/docker/render.js" \
SPEC_FILE="$WORK/appspec.json" \
  node "$WORK/render-check.mjs" > "$WORK/render.out" 2>"$WORK/render.err" \
  || fail "le contrôle de rendu a échoué : $(cat "$WORK/render.err")"

grep -q '^THROWS .*POSTGRES_PASSWORD' "$WORK/render.out" \
  || fail "le rendu n'a pas échoué en nommant POSTGRES_PASSWORD"
info "$(grep '^THROWS ' "$WORK/render.out" | cut -c8-)"
pass "un secret déclaré sans valeur fait échouer le rendu, en le nommant"

grep -q '^VIDE_ACCEPTE$' "$WORK/render.out" \
  || fail "un secret délibérément vide a été refusé"
pass "un secret délibérément vide reste accepté — absent n'est pas vide"

step "13. Le magasin est chiffré en base"
STORED=$(psql_q "select encrypted_value from application_secrets where application_id = '$APP_ID' and name = 'POSTGRES_PASSWORD';")
printf '%s' "$STORED" | grep -q "^v1:" || fail "l'enveloppe de chiffrement n'est pas au format « v1:iv:tag:ciphertext »"
printf '%s' "$STORED" | grep -qF "$SECRET" && fail "la valeur en clair est lisible en base"
pass "stocké en AES-256-GCM sous MASTER_KEY, même enveloppe que les credentials SSH"

# ═════════════════════════════════════════════════════════════════════════════
#  ALIAS — un mot de passe, deux noms
#
#  Tout ce qui précède portait sur une AppSpec en chaînes nues : elle vient de
#  se relire, de se déployer, de se redéployer. C'est la preuve de
#  compatibilité ascendante, et elle est faite. Ce qui suit ajoute `from`.
# ═════════════════════════════════════════════════════════════════════════════

step "14. Compatibilité ascendante : la spec précédente est bien en chaînes nues"
req GET "/api/applications/$APP_ID" >/dev/null
jq -e '[.appSpec.services[].secrets[]] | all(type == "string")' "$BODY" >/dev/null \
  || fail "la spec du premier scénario n'est plus en chaînes nues — la preuve ne vaut rien"
pass "$(jq -rc '[.appSpec.services[].secrets[]] | unique' "$BODY") : chaînes nues, relues et déployées deux fois"

step "15. Un alias est refusé à la VALIDATION quand sa cible n'existe pas"
# L'exemple § 7.3 de l'invite, mais l'alias pointe à côté. La spec ne doit
# jamais atteindre la base : c'est `appSpecSchema` qui la refuse, pas le rendu.
mk_alias_spec() {
  local app_secret="$1"
  cat <<JSON
{
  "name": "$SLUG_ALIAS",
  "version": "1.0.0",
  "services": [
    {
      "name": "web",
      "source": { "type": "image", "ref": "wordpress:6-apache" },
      "port": 80,
      "exposed": true,
      "env": {
        "WORDPRESS_DB_HOST": "mariadb:3306",
        "WORDPRESS_DB_NAME": "verifdb",
        "WORDPRESS_DB_USER": "verif"
      },
      "secrets": [$app_secret],
      "resources": { "cpuMilli": 500, "memoryMi": 512 },
      "healthcheck": { "path": "/wp-admin/install.php", "intervalSec": 5, "timeoutSec": 5, "retries": 40 },
      "dependsOn": ["mariadb"]
    },
    {
      "name": "mariadb",
      "source": { "type": "image", "ref": "mariadb:11" },
      "port": 3306,
      "exposed": false,
      "env": { "MARIADB_DATABASE": "verifdb", "MARIADB_USER": "verif" },
      "secrets": ["MARIADB_PASSWORD", "MARIADB_ROOT_PASSWORD"],
      "resources": { "cpuMilli": 1000, "memoryMi": 1024 },
      "healthcheck": { "path": "/", "port": 3306, "intervalSec": 5, "timeoutSec": 3, "retries": 40 },
      "volumes": [{ "name": "donnees", "mountPath": "/var/lib/mysql", "size": "1Gi" }]
    }
  ]
}
JSON
}

mk_alias_spec '{ "name": "WORDPRESS_DB_PASSWORD", "from": "MOT_DE_PASSE_FANTOME" }' \
  | jq '{appSpec: .}' > "$WORK/ghost.json"
code=$(req POST /api/applications "@$WORK/ghost.json")
[ "$code" = "422" ] || fail "une AppSpec avec alias fantôme a été acceptée (HTTP $code)"
grep -qF 'MOT_DE_PASSE_FANTOME' "$BODY" \
  || fail "le refus ne nomme pas le secret manquant : $(cat "$BODY")"
pass "alias vers un secret inexistant → HTTP 422, et le message le nomme"
info "$(jq -r '[.error.details.fieldErrors.appSpec[]?] | join(" | ")' "$BODY" 2>/dev/null | cut -c1-160)"

ROWS=$(psql_q "select count(*) from applications where slug = '$SLUG_ALIAS';")
[ "$ROWS" = "0" ] || fail "la spec refusée a tout de même créé une application"
pass "rien n'a été écrit en base : le refus a lieu avant, pas au déploiement"

step "16. Un cycle d'alias est refusé lui aussi"
mk_alias_spec '{ "name": "WORDPRESS_DB_PASSWORD", "from": "MARIADB_PASSWORD" }' \
  | jq '(.services[1].secrets) = [{"name":"MARIADB_PASSWORD","from":"WORDPRESS_DB_PASSWORD"}, "MARIADB_ROOT_PASSWORD"] | {appSpec: .}' \
  > "$WORK/cycle.json"
code=$(req POST /api/applications "@$WORK/cycle.json")
[ "$code" = "422" ] || fail "un cycle d'alias a été accepté (HTTP $code)"
grep -qF "cycle d'alias" "$BODY" || fail "le refus ne parle pas d'un cycle : $(cat "$BODY")"
pass "A ← B et B ← A → HTTP 422, « cycle d'alias de secrets »"
info "$(jq -r '[.error.details.fieldErrors.appSpec[]?] | join(" | ")' "$BODY" 2>/dev/null | cut -c1-160)"

step "17. L'exemple canonique de l'invite, cette fois relié par « from »"
mk_alias_spec '{ "name": "WORDPRESS_DB_PASSWORD", "from": "MARIADB_PASSWORD" }' \
  | jq '{appSpec: .}' > "$WORK/alias.json"
code=$(req POST /api/applications "@$WORK/alias.json")
[ "$code" = "201" ] || fail "POST /api/applications → HTTP $code : $(cat "$BODY")"
ALIAS_APP_ID=$(jq -r .id "$BODY")
pass "application « $SLUG_ALIAS » créée ($ALIAS_APP_ID)"

step "18. Une seule ligne en base pour les deux noms"
ROWS=$(psql_q "select count(*) from application_secrets where application_id = '$ALIAS_APP_ID';")
[ "$ROWS" = "2" ] || fail "$ROWS ligne(s) en base, 2 attendues (MARIADB_PASSWORD et MARIADB_ROOT_PASSWORD)"
NAMES=$(psql_q "select name from application_secrets where application_id = '$ALIAS_APP_ID' order by name;" | tr '\n' ' ')
pass "lignes en base : $NAMES"
ROWS=$(psql_q "select count(*) from application_secrets where application_id = '$ALIAS_APP_ID' and name = 'WORDPRESS_DB_PASSWORD';")
[ "$ROWS" = "0" ] || fail "l'alias WORDPRESS_DB_PASSWORD a sa propre ligne : c'est la panne d'origine avec une étape de plus"
pass "WORDPRESS_DB_PASSWORD n'a AUCUNE ligne : il n'y a qu'un secret, lu sous deux noms"

step "19. L'écran des secrets dit qu'un nom est un alias"
code=$(req GET "/api/applications/$ALIAS_APP_ID/secrets")
[ "$code" = "200" ] || fail "GET .../secrets → HTTP $code"
jq -e '.items[] | select(.name == "WORDPRESS_DB_PASSWORD") | .aliasOf == "MARIADB_PASSWORD"' "$BODY" >/dev/null \
  || fail "l'API ne signale pas WORDPRESS_DB_PASSWORD comme alias : $(jq -c '.items' "$BODY")"
jq -e '.items[] | select(.name == "WORDPRESS_DB_PASSWORD") | .isSet == true' "$BODY" >/dev/null \
  || fail "l'alias est affiché comme sans valeur — l'écran inviterait à lui en poser une"
jq -e '.items[] | select(.name == "MARIADB_PASSWORD") | .readAs == ["WORDPRESS_DB_PASSWORD"]' "$BODY" >/dev/null \
  || fail "MARIADB_PASSWORD ne dit pas qu'il est lu sous un autre nom"
pass "$(jq -rc '[.items[] | "\(.name)\(if .aliasOf then " ← " + .aliasOf else "" end)"] | join(", ")' "$BODY")"

# Poser une valeur sur l'alias créerait la seconde ligne. C'est refusé.
code=$(req PUT "/api/applications/$ALIAS_APP_ID/secrets/WORDPRESS_DB_PASSWORD" '{"generate":true}')
[ "$code" = "409" ] || fail "l'API a accepté de poser une valeur sur un alias (HTTP $code)"
grep -qF 'MARIADB_PASSWORD' "$BODY" || fail "le refus ne renvoie pas vers le secret qui porte la valeur"
pass "PUT sur un alias → HTTP 409, renvoyé vers « MARIADB_PASSWORD »"

step "20. Déploiement : MariaDB démarre, WordPress s'y connecte"
DA=$(deploy "$ALIAS_APP_ID")
req GET "/api/deployments/$DA" >/dev/null
STATUS=$(jq -r .status "$BODY")
[ "$STATUS" = "success" ] || {
  info "étapes : $(jq -rc '[.steps[] | "\(.key)=\(.status)"] | join(" ")' "$BODY")"
  info "erreur : $(jq -r '.error // "(aucune)"' "$BODY")"
  fail "le déploiement de « $SLUG_ALIAS » a fini en « $STATUS »"
}
ALIAS_PORT=$(jq -r '.publishedPort // empty' "$BODY")
pass "déploiement $DA réussi — port publié $ALIAS_PORT"

PS=$(on_target "docker ps --filter label=tp.app=$SLUG_ALIAS --format '{{.Names}} {{.Status}}'")
printf '%s\n' "$PS" | while IFS= read -r line; do [ -n "$line" ] && info "$line"; done
printf '%s' "$PS" | grep -q 'app-'"$SLUG_ALIAS"'-mariadb-1 .*healthy' \
  || fail "MariaDB n'est pas saine : $PS"
pass "MariaDB est « healthy » — MARIADB_ROOT_PASSWORD lui a permis de s'initialiser"

# La preuve qui compte. `healthy` sur WordPress veut dire que
# /wp-admin/install.php a répondu 200 ; sur une connexion refusée, cette page
# rend un 500 « Error establishing a database connection ». C'est donc bien
# l'authentification MySQL qui a réussi, pas un conteneur qui tourne.
printf '%s' "$PS" | grep -q 'app-'"$SLUG_ALIAS"'-web-1 .*healthy' \
  || fail "WordPress n'est pas sain : il n'a pas su joindre sa base — $PS"
pass "WordPress est « healthy » : /wp-admin/install.php répond 200, donc la base l'a authentifié"

# Et on le redemande explicitement, depuis la cible, sans passer par la sonde.
INSTALL=$(on_target "docker exec app-$SLUG_ALIAS-web-1 curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/wp-admin/install.php")
[ "$INSTALL" = "200" ] || fail "/wp-admin/install.php répond $INSTALL — la connexion à la base a échoué"
pass "GET /wp-admin/install.php → 200 (une connexion refusée rendrait 500)"

# Dernière preuve, côté base : le compte applicatif accepte le mot de passe
# qu'il a reçu par l'alias. On l'utilise, on ne l'imprime pas.
AUTH=$(on_target "docker exec app-$SLUG_ALIAS-mariadb-1 sh -c 'mariadb -h 127.0.0.1 -u verif -p\"\$MARIADB_PASSWORD\" -D verifdb -N -B -e \"select 42\"'" 2>&1 | tr -d ' \r')
[ "$AUTH" = "42" ] || fail "MariaDB refuse le mot de passe du compte applicatif : $AUTH"
pass "authentification MariaDB réussie avec la valeur du .env (select 42 → 42)"

ERRORS=$(on_target "docker logs app-$SLUG_ALIAS-mariadb-1 2>&1 | grep -c 'Access denied' || true")
[ "$ERRORS" = "0" ] || fail "$ERRORS refus d'authentification dans les logs de MariaDB — les deux noms ne portent pas la même valeur"
pass "aucun « Access denied » dans les logs de MariaDB"

step "21. Les deux noms portent la MÊME valeur dans le .env déposé"
ALIAS_RELEASE="$DRIVER_ROOT_PATH/apps/$SLUG_ALIAS/current"
on_target "test -d $ALIAS_RELEASE" 2>/dev/null || ALIAS_RELEASE="$DRIVER_ROOT_PATH/apps/$SLUG_ALIAS/1.0.0"
FP_APP=$(on_target "grep '^WORDPRESS_DB_PASSWORD=' $ALIAS_RELEASE/.env | cut -d= -f2- | sha256sum | cut -c1-16")
FP_DB=$(on_target "grep '^MARIADB_PASSWORD=' $ALIAS_RELEASE/.env | cut -d= -f2- | sha256sum | cut -c1-16")
FP_ROOT=$(on_target "grep '^MARIADB_ROOT_PASSWORD=' $ALIAS_RELEASE/.env | cut -d= -f2- | sha256sum | cut -c1-16")
[ -n "$FP_APP" ] || fail "WORDPRESS_DB_PASSWORD absent du .env — l'alias n'a rien produit"
info "WORDPRESS_DB_PASSWORD  sha256[0:16] = $FP_APP"
info "MARIADB_PASSWORD       sha256[0:16] = $FP_DB"
info "MARIADB_ROOT_PASSWORD  sha256[0:16] = $FP_ROOT"
[ "$FP_APP" = "$FP_DB" ] || fail "les deux noms portent des valeurs DIFFÉRENTES ($FP_APP ≠ $FP_DB) : c'est la panne d'origine"
pass "même empreinte des deux côtés : une seule valeur, lue sous deux noms"
[ "$FP_ROOT" != "$FP_DB" ] || fail "le mot de passe root est le même que l'applicatif — ce sont deux secrets distincts"
pass "MARIADB_ROOT_PASSWORD est bien un SECOND secret, pas un alias du premier"

step "22. Un redéploiement ne change rien"
DA2=$(deploy "$ALIAS_APP_ID")
req GET "/api/deployments/$DA2" >/dev/null
[ "$(jq -r .status "$BODY")" = "success" ] || fail "le redéploiement de « $SLUG_ALIAS » a échoué"
FP_APP2=$(on_target "grep '^WORDPRESS_DB_PASSWORD=' $ALIAS_RELEASE/.env | cut -d= -f2- | sha256sum | cut -c1-16")
[ "$FP_APP2" = "$FP_APP" ] || fail "l'alias a changé de valeur au redéploiement ($FP_APP → $FP_APP2)"
pass "redéploiement $DA2 : même empreinte, et le volume MariaDB reconnaît toujours le compte"
AUTH=$(on_target "docker exec app-$SLUG_ALIAS-mariadb-1 sh -c 'mariadb -h 127.0.0.1 -u verif -p\"\$MARIADB_PASSWORD\" -D verifdb -N -B -e \"select 42\"'" 2>&1 | tr -d ' \r')
[ "$AUTH" = "42" ] || fail "après redéploiement, MariaDB refuse le mot de passe : $AUTH"
pass "authentification toujours bonne après redéploiement"

step "23. Le rendu K3s reçoit la même carte que le rendu Docker"
# La question que ce contrôle tranche : l'alias est-il résolu AVANT le rendu,
# dans le code neutre ? Si la résolution passait par l'interpolation `${…}` du
# `.env` de Compose, Kubernetes — qui n'interpole rien — recevrait un Secret
# amputé, et la même AppSpec marcherait sur un runtime et pas sur l'autre.
req GET "/api/applications/$ALIAS_APP_ID" >/dev/null
jq -r '.appSpec' "$BODY" > "$WORK/alias-spec.json"

cat > "$WORK/parity.mjs" <<'MJS'
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const docker = await import(`${process.env.DIST}/drivers/docker/render.js`);
const k3s = await import(`${process.env.DIST}/drivers/k3s/render.js`);
const { storedSecretNames } = await import(`${process.env.DIST}/spec/index.js`);
const spec = JSON.parse(readFileSync(process.env.SPEC_FILE, 'utf8'));

// Ce que le driver demanderait au magasin : les racines seulement.
const roots = storedSecretNames(spec);
console.log(`ROOTS ${roots.sort().join(',')}`);

const secretValues = Object.fromEntries(roots.map((name) => [name, `valeur-de-${name}`]));

const env = docker
  .renderFiles({ spec, appSlug: spec.name, publishedPort: null, secretValues })
  .find((file) => file.path === '.env');
const composeMap = Object.fromEntries(
  env.content.trim().split('\n').map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }),
);

const kubeMap = {};
for (const manifest of k3s.renderManifests({ spec, appSlug: spec.name, secretValues })) {
  if (manifest.kind !== 'Secret') continue;
  Object.assign(kubeMap, manifest.stringData);
}

const digest = (map) =>
  createHash('sha256')
    .update(JSON.stringify(Object.entries(map).sort()))
    .digest('hex')
    .slice(0, 16);

console.log(`COMPOSE ${Object.keys(composeMap).sort().join(',')} ${digest(composeMap)}`);
console.log(`KUBE    ${Object.keys(kubeMap).sort().join(',')} ${digest(kubeMap)}`);
if (digest(composeMap) !== digest(kubeMap)) {
  console.error('CARTES_DIFFERENTES');
  process.exit(2);
}
if (composeMap.WORDPRESS_DB_PASSWORD !== composeMap.MARIADB_PASSWORD) {
  console.error('ALIAS_NON_RESOLU_DOCKER');
  process.exit(3);
}
if (kubeMap.WORDPRESS_DB_PASSWORD !== kubeMap.MARIADB_PASSWORD) {
  console.error('ALIAS_NON_RESOLU_K3S');
  process.exit(4);
}
// Aucune interpolation ne doit subsister : une carte complète, pas un renvoi.
if (/\$\{/.test(env.content)) {
  console.error('INTERPOLATION_DANS_ENV');
  process.exit(5);
}
console.log('PARITE_OK');
MJS

DIST="file://$ROOT/packages/core/dist" SPEC_FILE="$WORK/alias-spec.json" \
  node "$WORK/parity.mjs" > "$WORK/parity.out" 2>"$WORK/parity.err" \
  || fail "le contrôle de parité a échoué : $(cat "$WORK/parity.err") $(cat "$WORK/parity.out")"

info "$(grep '^ROOTS ' "$WORK/parity.out")"
info "$(grep '^COMPOSE ' "$WORK/parity.out")"
info "$(grep '^KUBE' "$WORK/parity.out")"
grep -q '^PARITE_OK$' "$WORK/parity.out" || fail "les deux rendus ne reçoivent pas la même carte"
pass "Docker et K3s reçoivent la même carte complète, alias résolu, sans interpolation"

printf '\n\033[32m✓ Magasin de secrets, alias et règle de sonde vérifiés.\033[0m\n'
printf '\033[2m  Écrans : %s/applications/%s\033[0m\n' "$BASE_URL" "$APP_ID"
printf '\033[2m           %s/applications/%s\033[0m\n' "$BASE_URL" "$ALIAS_APP_ID"
