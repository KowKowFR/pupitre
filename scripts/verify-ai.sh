#!/usr/bin/env bash
#
# Vérifie la génération d'AppSpec par IA, ouverte à plusieurs fournisseurs :
#
#   1. les cas hors ligne — boucle de validation, relance, catalogue
#   2. les trois fournisseurs sont configurables, et le modèle par défaut
#      suit le fournisseur
#   3. sans clé, la route rend 501 avec un message qui dit ce qui manque
#   4. `application:create` est requis pour générer
#   5. la clé n'apparaît jamais : ni dans une réponse, ni dans le HTML, ni dans
#      l'audit, ni dans le JSONB des paramètres, ni dans les logs des conteneurs
#   6. une AppSpec fournie à la main suit tout le parcours, jusqu'à un
#      déploiement réussi et joignable
#
# ⚠ Ce que ce script NE PEUT PAS vérifier : qu'un vrai modèle réponde. Aucune
#   clé d'API n'est configurée sur cette instance, et le script n'en invente
#   pas. Tout ce qui dépend d'un fournisseur est donc joué soit hors ligne avec
#   un modèle simulé (point 1), soit sur son refus propre (point 3).
#
# Usage :
#   ./scripts/verify-ai.sh
#   BASE_URL=http://localhost:3100 TARGET_NAME=ma-vm ./scripts/verify-ai.sh
#
# Relançable : tout ce qui est créé est supprimé, et les paramètres d'instance
# sont restaurés dans l'état où ils ont été trouvés.
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
# ⚠ Jamais la cible « vps » : c'est une vraie machine de production.
TARGET_NAME="${TARGET_NAME:-cible-de-verification}"
CLIENT_IP="${CLIENT_IP:-198.51.100.42}"
ROLE_KEY="${ROLE_KEY:-sans-creation-ia}"
PEON_EMAIL="${PEON_EMAIL:-ia-sans-droit@example.test}"
PEON_PASSWORD="${PEON_PASSWORD:-motdepasse-tres-long}"
APP_SLUG="${APP_SLUG:-verif-ia-manuelle}"

# Sentinelle : une chaîne qu'on peut chercher partout sans risque de faux
# positif. Elle joue le rôle d'une clé d'API, et ne doit jamais ressortir.
SENTINEL="sk-sentinelle-verif-ia-0000000000000000"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
PEON_JAR="$WORK/peon.jar"
BODY="$WORK/body.json"
trap 'rm -rf "$WORK"' EXIT

command -v jq >/dev/null || { echo "jq est requis"; exit 1; }

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

peon_req() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$BASE_URL$path"
              -H 'content-type: application/json' -H "origin: $BASE_URL"
              -H "x-forwarded-for: $CLIENT_IP" -b "$PEON_JAR" -c "$PEON_JAR")
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1"; }

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

assert_admin() {
  local role
  role=$(jq -r '.user.role // empty' "$BODY")
  [ "$role" = "admin" ] && return 0
  fail "« $ADMIN_EMAIL » a le rôle « ${role:-aucun} », pas « admin » — voir /admin/users"
}

# Restaure les paramètres tels qu'ils ont été trouvés, quoi qu'il arrive — y
# compris sur un échec en cours de route. La politique de sécurité est
# brièvement empruntée au point 6 ; elle doit être rendue intacte.
INITIAL_AI=""
INITIAL_SECURITY=""
# 1 uniquement si c'est CE script qui a posé la clé sentinelle. Une clé
# préexistante appartient à l'exploitant : elle est chiffrée et irrécupérable
# une fois écrasée, donc on n'y touche pas — ni pour l'écraser, ni pour
# l'effacer « en faisant le ménage ».
KEY_PLANTED=0
restore_settings() {
  local patch='{'
  [ "$KEY_PLANTED" = "1" ] && patch="$patch\"aiApiKey\":null,"
  [ -n "$INITIAL_AI" ] && patch="$patch\"ai\":$INITIAL_AI,"
  [ -n "$INITIAL_SECURITY" ] && patch="$patch\"security\":$INITIAL_SECURITY,"
  patch="${patch%,}}"
  [ "$patch" = "{}" ] && return 0
  req PATCH /api/settings "$patch" >/dev/null 2>&1 || true
}

# ─── 0. Contexte ──────────────────────────────────────────────────────────────

step "0. Connexion, cible et état de départ"
login
pass "connecté en tant que $ADMIN_EMAIL"

code=$(req GET /api/settings)
[ "$code" = "200" ] || fail "GET /api/settings → HTTP $code : $(cat "$BODY")"
INITIAL_AI=$(jq -c '.settings.ai' "$BODY")
INITIAL_SECURITY=$(jq -c '.settings.security' "$BODY")
KEY_CONFIGURED=$(jq -r '.aiApiKeyConfigured' "$BODY")
trap 'restore_settings; rm -rf "$WORK"' EXIT
info "section IA de départ : $INITIAL_AI"

if [ "$KEY_CONFIGURED" = "true" ]; then
  warn "une clé d'API est DÉJÀ enregistrée sur cette instance"
  warn "les points 3 et 5 seront sautés : ce script n'écrase jamais une clé qu'il n'a pas posée"
  warn "(une clé est chiffrée et irrécupérable une fois écrasée)"
else
  pass "aucune clé enregistrée — c'est l'état attendu sur cette instance"
fi

req GET /api/targets >/dev/null
TARGET_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY")
[ -n "$TARGET_ID" ] || fail "cible « $TARGET_NAME » introuvable — lancez ./scripts/setup-test-target.sh"
jq -e --arg n "$TARGET_NAME" \
  '.items[] | select(.name == $n) | .runtimesAvailable.docker.available == true' "$BODY" >/dev/null \
  || fail "la cible « $TARGET_NAME » n'a pas de runtime Docker — lancez un preflight"
pass "cible de déploiement : $TARGET_NAME — $TARGET_ID"

# ─── 1. Hors ligne ────────────────────────────────────────────────────────────

step "1. Les cas hors ligne — aucune clé, aucun réseau"
if (cd "$ROOT" && pnpm test:ai > "$WORK/test-ai.log" 2>&1); then
  pass "$(grep -c '✓' "$WORK/test-ai.log") assertions de configuration multi-fournisseur"
  tail -3 "$WORK/test-ai.log" | sed 's/^/    /'
else
  cat "$WORK/test-ai.log"
  fail "pnpm test:ai a échoué"
fi

if (cd "$ROOT" && pnpm --filter @tp/core test > "$WORK/test-core.log" 2>&1); then
  pass "boucle de génération sous modèle simulé : $(grep -E '^ℹ pass' "$WORK/test-core.log")"
  grep -E "relance UNE fois|s'arrête après la relance|enrobe le JSON|tronquée|panne du fournisseur|jamais de shell" \
    "$WORK/test-core.log" | sed 's/^/    /'
else
  tail -40 "$WORK/test-core.log"
  fail "les tests de @tp/core ont échoué"
fi

# ─── 2. Les trois fournisseurs ────────────────────────────────────────────────

step "2. Les trois fournisseurs sont configurables"

# Les défauts sont lus dans le catalogue, pas recopiés : un défaut qui change
# dans le code ne doit pas faire mentir ce script.
DEFAULTS=$(cd "$ROOT" && npx tsx -e '
import { AI_PROVIDERS, aiProviderDescriptor } from "@tp/core/ai";
process.stdout.write(JSON.stringify(Object.fromEntries(
  AI_PROVIDERS.map((p) => [p, aiProviderDescriptor(p)]),
)));
')
PROVIDERS=$(jq -r 'keys[]' <<< "$DEFAULTS")
info "catalogue : $(tr '\n' ' ' <<< "$PROVIDERS")"

for provider in $PROVIDERS; do
  model=$(jq -r --arg p "$provider" '.[$p].defaultModel' <<< "$DEFAULTS")
  code=$(req PATCH /api/settings "{\"ai\":{\"provider\":\"$provider\",\"model\":\"$model\"}}")
  [ "$code" = "200" ] || fail "PATCH ai.provider=$provider → HTTP $code : $(cat "$BODY")"
  jq -e --arg p "$provider" --arg m "$model" \
    '.settings.ai.provider == $p and .settings.ai.model == $m' "$BODY" >/dev/null \
    || fail "fournisseur non retenu : $(jq -c .settings.ai "$BODY")"
  pass "« $provider » retenu, modèle par défaut « $model »"
done

code=$(req PATCH /api/settings '{"ai":{"provider":"skynet"}}')
[ "$code" = "422" ] || fail "fournisseur inventé : attendu 422, reçu $code"
pass "un fournisseur hors catalogue est refusé → 422"

code=$(req PATCH /api/settings '{"ai":{"baseUrl":"pas-une-url"}}')
[ "$code" = "422" ] || fail "URL de base bancale : attendu 422, reçu $code"
pass "une URL de base invalide est refusée → 422"

# Régression : `aiSettingsSchema.partial()` remplissait les défauts, et un PATCH
# ne portant que `enabled` réinitialisait fournisseur, modèle et température.
req PATCH /api/settings '{"ai":{"provider":"anthropic","model":"claude-opus-4-5","temperature":0.35}}' >/dev/null
code=$(req PATCH /api/settings '{"ai":{"enabled":true}}')
[ "$code" = "200" ] || fail "PATCH partiel → HTTP $code"
jq -e '.settings.ai.provider == "anthropic" and .settings.ai.model == "claude-opus-4-5"
       and .settings.ai.temperature == 0.35' "$BODY" >/dev/null \
  || fail "un PATCH partiel a réinitialisé la section IA : $(jq -c .settings.ai "$BODY")"
pass "un PATCH partiel n'efface ni le fournisseur, ni le modèle, ni la température"

# ─── 3. Sans clé, la route refuse proprement ──────────────────────────────────

step "3. Sans clé d'API, la génération rend 501 et dit ce qui manque"
if [ "$KEY_CONFIGURED" = "true" ]; then
  warn "sauté : une clé est enregistrée sur cette instance"
else
  for provider in $PROVIDERS; do
    model=$(jq -r --arg p "$provider" '.[$p].defaultModel' <<< "$DEFAULTS")
    label=$(jq -r --arg p "$provider" '.[$p].label' <<< "$DEFAULTS")
    envvar=$(jq -r --arg p "$provider" '.[$p].envApiKeyVar // ""' <<< "$DEFAULTS")

    req PATCH /api/settings \
      "{\"ai\":{\"provider\":\"$provider\",\"model\":\"$model\",\"enabled\":true}}" >/dev/null

    code=$(req POST /api/applications/generate \
      '{"prompt":"une application GLPI avec sa base de donnees"}')
    [ "$code" = "501" ] || fail "$provider : attendu 501, reçu $code — $(cat "$BODY")"

    message=$(jq -r '.error.message' "$BODY")
    grep -q "$label" <<< "$message" || fail "le message ne nomme pas « $label » : $message"
    if [ -n "$envvar" ]; then
      grep -q "$envvar" <<< "$message" || fail "le message ne nomme pas « $envvar » : $message"
    fi
    pass "$provider → 501 : $message"
  done

  # Une requête mal formée reste mal formée, avec ou sans clé : la validation du
  # corps passe AVANT la configuration.
  code=$(req POST /api/applications/generate '{"prompt":"court"}')
  [ "$code" = "422" ] || fail "prompt trop court : attendu 422, reçu $code"
  pass "un prompt trop court est refusé en 422, pas masqué par le 501"

  # L'interrupteur produit un message différent du manque de clé : les deux
  # causes ne se soignent pas de la même façon.
  req PATCH /api/settings '{"ai":{"enabled":false}}' >/dev/null
  code=$(req POST /api/applications/generate \
    '{"prompt":"une application GLPI avec sa base de donnees"}')
  [ "$code" = "501" ] || fail "IA coupée : attendu 501, reçu $code"
  jq -e '.error.message | test("désactivée dans les paramètres")' "$BODY" >/dev/null \
    || fail "message indistinct de l'absence de clé : $(jq -r .error.message "$BODY")"
  pass "IA coupée dans les paramètres → 501, avec un motif distinct"
  req PATCH /api/settings '{"ai":{"enabled":true}}' >/dev/null
fi

# ─── 4. Permissions ───────────────────────────────────────────────────────────

step "4. « application:create » est requis"
req DELETE "/api/admin/roles/$ROLE_KEY" >/dev/null 2>&1 || true
code=$(req POST /api/admin/roles \
  "{\"key\":\"$ROLE_KEY\",\"label\":\"Sans création\",\"permissions\":[\"application:read\",\"deployment:read\"]}")
case "$code" in
  201) pass "rôle « $ROLE_KEY » créé, sans application:create" ;;
  409) pass "rôle « $ROLE_KEY » déjà présent" ;;
  *)   fail "POST /api/admin/roles → HTTP $code : $(cat "$BODY")" ;;
esac

code=$(req POST /api/admin/users \
  "{\"name\":\"Sans droit IA\",\"email\":\"$PEON_EMAIL\",\"password\":\"$PEON_PASSWORD\",\"role\":\"$ROLE_KEY\"}")
case "$code" in
  201|409) PEON_ID=$(psql_q "select id from users where email = '$PEON_EMAIL';") ;;
  *)       fail "POST /api/admin/users → HTTP $code : $(cat "$BODY")" ;;
esac
[ -n "$PEON_ID" ] || fail "identifiant de l'utilisateur de test introuvable"
req PATCH "/api/admin/users/$PEON_ID/role" "{\"role\":\"$ROLE_KEY\"}" >/dev/null
pass "utilisateur « $PEON_EMAIL » — $PEON_ID"

code=$(peon_req POST /api/auth/sign-in/email \
  "{\"email\":\"$PEON_EMAIL\",\"password\":\"$PEON_PASSWORD\"}")
[ "$code" = "200" ] || fail "connexion de l'utilisateur de test → HTTP $code"

code=$(peon_req POST /api/applications/generate \
  '{"prompt":"une application GLPI avec sa base de donnees"}')
[ "$code" = "403" ] || fail "génération sans permission : attendu 403, reçu $code"
pass "POST /api/applications/generate sans application:create → 403"

code=$(peon_req POST /api/applications \
  '{"appSpec":{"name":"interdit","version":"1.0.0","services":[]}}')
[ "$code" = "403" ] || fail "création sans permission : attendu 403, reçu $code"
pass "POST /api/applications sans application:create → 403"

# ─── 5. La clé ne fuit jamais ─────────────────────────────────────────────────

step "5. La clé d'API n'apparaît nulle part"
if [ "$KEY_CONFIGURED" = "true" ]; then
  warn "sauté : une clé est déjà enregistrée, et ce script ne l'écrasera pas"
  warn "  relancez après l'avoir retirée depuis $BASE_URL/admin/settings"
else
SINCE=$(date -u '+%Y-%m-%dT%H:%M:%S')
OR_MODEL=$(jq -r '.openrouter.defaultModel' <<< "$DEFAULTS")
KEY_PLANTED=1
code=$(req PATCH /api/settings \
  "{\"ai\":{\"provider\":\"openrouter\",\"model\":\"$OR_MODEL\",\"enabled\":true},\"aiApiKey\":\"$SENTINEL\"}")
[ "$code" = "200" ] || fail "PATCH avec clé → HTTP $code : $(cat "$BODY")"
if grep -q "$SENTINEL" "$BODY"; then fail "la clé est revenue dans la réponse du PATCH"; fi
jq -e '.aiApiKeyConfigured == true' "$BODY" >/dev/null || fail "la clé n'a pas été enregistrée"
pass "clé enregistrée — la réponse ne la contient pas, seulement …$(jq -r .aiApiKeyLast4 "$BODY")"

code=$(req GET /api/settings)
if grep -q "$SENTINEL" "$BODY"; then fail "la clé fuit par GET /api/settings"; fi
pass "GET /api/settings ne la contient pas"

curl -s -b "$JAR" -H "origin: $BASE_URL" "$BASE_URL/admin/settings" > "$WORK/settings.html" || true
if grep -q "$SENTINEL" "$WORK/settings.html"; then fail "la clé fuit dans le HTML de /admin/settings"; fi
pass "le HTML de /admin/settings ne la contient pas ($(wc -c < "$WORK/settings.html") octets)"

curl -s -b "$JAR" -H "origin: $BASE_URL" "$BASE_URL/applications/new" > "$WORK/new.html" || true
if grep -q "$SENTINEL" "$WORK/new.html"; then fail "la clé fuit dans le HTML de /applications/new"; fi
pass "le HTML de /applications/new ne la contient pas"

req GET "/api/audit-logs?pageSize=50" >/dev/null
if grep -q "$SENTINEL" "$BODY"; then fail "la clé fuit dans le journal d'audit"; fi
jq -e '[.items[] | select(.action == "settings.updated")] | length > 0' "$BODY" >/dev/null \
  || fail "aucune entrée settings.updated dans l'audit"
pass "le journal d'audit porte settings.updated, sans la clé"

psql_q "select coalesce(value::text,'') from app_settings;" > "$WORK/settings.sql" 2>/dev/null || true
if grep -q "$SENTINEL" "$WORK/settings.sql"; then fail "la clé fuit dans le JSONB des paramètres"; fi
ENCRYPTED=$(psql_q "select coalesce(ai_api_key_encrypted,'') from app_settings;" 2>/dev/null || echo '')
[ -n "$ENCRYPTED" ] || fail "la colonne chiffrée est vide alors qu'une clé vient d'être posée"
if [ "$ENCRYPTED" = "$SENTINEL" ]; then fail "la clé est stockée EN CLAIR dans ai_api_key_encrypted"; fi
if grep -q "$SENTINEL" <<< "$ENCRYPTED"; then fail "la clé apparaît dans la colonne chiffrée"; fi
pass "en base : JSONB sans la clé, colonne chiffrée illisible ($(wc -c <<< "$ENCRYPTED") octets)"

# Un appel RÉEL contre chaque fournisseur, avec une clé bidon. Quoi qu'il
# arrive — refus du fournisseur, réseau coupé, délai dépassé — ni la clé ni un
# fragment de clé ne doit ressortir.
#
# Ce n'est pas théorique : OpenAI répond « Incorrect API key provided:
# sk-senti***…***0000 », soit douze caractères de la clé en clair. On cherche
# donc aussi le préfixe, pas seulement la chaîne entière.
PREFIX="${SENTINEL:0:8}"

# La route est limitée en débit — c'est voulu, elle coûte de l'argent. Le script,
# lui, doit quand même atteindre les trois fournisseurs : il attend le délai que
# la réponse annonce plutôt que de conclure sur un 429.
generate_once() {
  local code
  code=$(req POST /api/applications/generate \
    '{"prompt":"une application GLPI avec sa base de donnees"}')
  if [ "$code" = "429" ]; then
    local wait_s
    wait_s=$(jq -r '.error.message' "$BODY" | grep -oE '[0-9]+ s' | grep -oE '[0-9]+' | head -1)
    wait_s=$(( ${wait_s:-60} + 3 ))
    [ "$wait_s" -gt 180 ] && wait_s=180
    warn "limite de débit atteinte, attente de ${wait_s} s"
    sleep "$wait_s"
    code=$(req POST /api/applications/generate \
      '{"prompt":"une application GLPI avec sa base de donnees"}')
  fi
  printf '%s' "$code"
}

REACHED=0
for provider in $PROVIDERS; do
  model=$(jq -r --arg p "$provider" '.[$p].defaultModel' <<< "$DEFAULTS")
  req PATCH /api/settings \
    "{\"ai\":{\"provider\":\"$provider\",\"model\":\"$model\",\"enabled\":true},\"aiApiKey\":\"$SENTINEL\"}" >/dev/null
  code=$(generate_once)
  if grep -q "$SENTINEL" "$BODY"; then fail "$provider : la clé fuit dans la réponse d'erreur"; fi
  if grep -q "$PREFIX" "$BODY"; then
    fail "$provider : un fragment de clé fuit — $(jq -r .error.message "$BODY")"
  fi
  [ "$code" = "502" ] && REACHED=$((REACHED + 1))
  info "$provider → HTTP $code : $(jq -r '.error.message // "—"' "$BODY" | head -c 110)"
done
[ "$REACHED" = "3" ] \
  || fail "seuls $REACHED fournisseur(s) sur 3 ont été joints — les autres n'ont rien prouvé"
pass "les trois fournisseurs ont été appelés pour de vrai : aucun fragment de clé dans la réponse"

# Bornée à cette exécution : une entrée écrite AVANT le correctif de masquage
# porte légitimement l'ancien message, et n'a rien à dire sur le code d'aujourd'hui.
req GET "/api/audit-logs?resourceType=application&pageSize=50&from=${SINCE}Z" >/dev/null
if grep -q "$PREFIX" "$BODY"; then fail "un fragment de clé fuit dans le journal d'audit"; fi
GENERATED=$(jq -r '[.items[] | select(.action == "application.generation.failed")] | length' "$BODY")
[ "$GENERATED" -ge "$REACHED" ] \
  || fail "$REACHED appels joints, mais seulement $GENERATED entrée(s) d'audit"
pass "$GENERATED entrées application.generation.failed, aucune ne porte de fragment de clé"

for service in panel worker; do
  docker compose logs --no-color --since "${SINCE}Z" "$service" > "$WORK/$service.log" 2>/dev/null || true
  if grep -q "$SENTINEL" "$WORK/$service.log"; then
    fail "la clé apparaît dans les logs du conteneur « $service »"
  fi
  if grep -q "$PREFIX" "$WORK/$service.log"; then
    fail "un fragment de clé apparaît dans les logs du conteneur « $service »"
  fi
  pass "logs de « $service » : aucune trace de la clé ($(wc -l < "$WORK/$service.log") lignes)"
done

# Changer de fournisseur sans changer de modèle doit être SIGNALÉ, pas découvert
# une minute plus tard dans un 404 du fournisseur. La clé est encore posée : la
# génération est donc active, et l'écran doit porter l'avertissement.
req PATCH /api/settings \
  '{"ai":{"provider":"anthropic","model":"anthropic/claude-sonnet-4.5","enabled":true}}' >/dev/null
curl -s -b "$JAR" -H "origin: $BASE_URL" "$BASE_URL/applications/new" > "$WORK/mismatch.html" || true
if grep -q "identifiant OpenRouter" "$WORK/mismatch.html"; then
  pass "modèle incohérent avec le fournisseur → signalé sur /applications/new"
else
  fail "aucun avertissement sur /applications/new pour anthropic + anthropic/claude-sonnet-4.5"
fi

req PATCH /api/settings '{"aiApiKey":null}' >/dev/null
jq -e '.aiApiKeyConfigured == false' "$BODY" >/dev/null || fail "la clé n'a pas été effacée"
KEY_PLANTED=0
pass "clé de test effacée"
fi

# ─── 6. Le parcours complet, jusqu'au déploiement ─────────────────────────────

step "6. Une AppSpec fournie à la main va jusqu'au déploiement"

# Mono-service à dessein : une base de données déclarerait des secrets, dont le
# panel ne stocke pas encore les valeurs — elle démarrerait sans mot de passe.
cat > "$WORK/spec.json" <<JSON
{
  "appSpec": {
    "name": "$APP_SLUG",
    "version": "1.0.0",
    "services": [
      {
        "name": "web",
        "source": { "type": "image", "ref": "docker.io/library/nginx:1.29-alpine" },
        "port": 80,
        "exposed": true,
        "resources": { "cpuMilli": 250, "memoryMi": 256 },
        "healthcheck": { "path": "/", "intervalSec": 5, "timeoutSec": 3, "retries": 10 }
      }
    ]
  }
}
JSON

req GET /api/applications >/dev/null
APP_ID=$(jq -r --arg s "$APP_SLUG" '.items[] | select(.slug == $s) | .id' "$BODY" | head -1)
if [ -n "$APP_ID" ]; then
  code=$(req PATCH "/api/applications/$APP_ID" "@$WORK/spec.json")
  [ "$code" = "200" ] || fail "PATCH /api/applications → HTTP $code : $(cat "$BODY")"
  pass "application « $APP_SLUG » remplacée — $APP_ID"
else
  code=$(req POST /api/applications "@$WORK/spec.json")
  [ "$code" = "201" ] || fail "POST /api/applications → HTTP $code : $(cat "$BODY")"
  APP_ID=$(jq -r .id "$BODY")
  pass "application « $APP_SLUG » créée — $APP_ID"
fi

# `scanConfig` volontairement absent : c'est la politique de sécurité de
# l'instance qui s'applique, et la choisir ici exigerait `scan:configure`.
deploy_and_wait() {
  code=$(req POST /api/deployments \
    "{\"applicationId\":\"$APP_ID\",\"targetId\":\"$TARGET_ID\",\"runtime\":\"docker\",\"proxy\":\"traefik\",\"autoRollback\":true}")
  [ "$code" = "202" ] || fail "POST /api/deployments → HTTP $code : $(cat "$BODY")"
  DEPLOY_ID=$(jq -r .id "$BODY")
  STATUS=""
  for _ in $(seq 1 150); do
    sleep 2
    req GET "/api/deployments/$DEPLOY_ID" >/dev/null
    STATUS=$(jq -r .status "$BODY")
    case "$STATUS" in success|failed|rolled_back|destroyed) break ;; esac
  done
}

destroy_deployment() {
  [ -n "${1:-}" ] || return 0
  req DELETE "/api/deployments/$1" >/dev/null 2>&1 || true
  for _ in $(seq 1 90); do
    sleep 2
    req GET "/api/deployments/$1" >/dev/null
    [ "$(jq -r .status "$BODY")" = "destroyed" ] && break
  done
}

deploy_and_wait
pass "déploiement enfilé — $DEPLOY_ID (sans scanConfig : politique d'instance)"
info "politique appliquée : $(jq -rc '{scanners:.scanConfig.scanners, failOn:.scanConfig.failOn}' "$BODY")"

if [ "$STATUS" != "success" ]; then
  BLOCKED=$(jq -r '[.steps[] | select(.key == "scan") | .log, .error] | join(" ")' "$BODY" | tail -c 400)
  if grep -qi "déploiement bloqué" <<< "$BLOCKED"; then
    # Ce n'est PAS un défaut du parcours : la politique de l'instance
    # (failOn=CRITICAL, tous scanners) bloque toute image publique dont la base
    # de vulnérabilités signale un CRITICAL — ce qui est le cas de nginx:alpine
    # aujourd'hui. On le dit, puis on rejoue avec la politique desserrée le
    # temps de la preuve, et on la remet ensuite.
    warn "la politique de sécurité de l'instance a bloqué la mise en ligne — c'est elle qui parle"
    info "$(tr -d '\n' <<< "$BLOCKED" | tail -c 220)"
    pass "la politique d'instance s'applique bien aux appels qui omettent scanConfig"

    destroy_deployment "$DEPLOY_ID"
    req PATCH /api/settings '{"security":{"failOn":"NONE"}}' >/dev/null
    warn "politique desserrée temporairement (failOn=NONE) pour prouver le reste du parcours"
    deploy_and_wait
  fi
fi

[ "$STATUS" = "success" ] \
  || fail "déploiement en « $STATUS » — $(jq -r '[.steps[].log] | join("")' "$BODY" | tail -c 600)"

PORT=$(jq -r '.publishedPort // empty' "$BODY")
[ -n "$PORT" ] || fail "le déploiement n'a publié aucun port"
http=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://127.0.0.1:$PORT" || echo 000)
[ "$http" = "200" ] || fail "http://127.0.0.1:$PORT → HTTP $http"
pass "déployée et joignable — HTTP 200 sur le port $PORT"

SCANNERS=$(jq -rc '.scanConfig.scanners // []' "$BODY")
info "politique de scan héritée de l'instance : $SCANNERS"

# ─── 7. Ménage ────────────────────────────────────────────────────────────────

step "7. Ménage"
destroy_deployment "$DEPLOY_ID"
pass "déploiement détruit"

# L'application ne se supprime qu'une fois ses déploiements purgés du journal —
# un déploiement « destroyed » reste une trace, et c'est voulu. On la garde
# donc, comme le font les autres scripts de vérification : le prochain passage
# la remplace par PATCH plutôt que de la recréer.
code=$(req DELETE "/api/applications/$APP_ID")
case "$code" in
  200|204) pass "application « $APP_SLUG » supprimée" ;;
  409)     info "application « $APP_SLUG » conservée : $(jq -r .error.message "$BODY")" ;;
  *)       warn "DELETE /api/applications → HTTP $code" ;;
esac

req PATCH "/api/admin/users/$PEON_ID/role" '{"role":"viewer"}' >/dev/null 2>&1 || true
req DELETE "/api/admin/users/$PEON_ID" >/dev/null 2>&1 || true
req DELETE "/api/admin/roles/$ROLE_KEY" >/dev/null 2>&1 || true
pass "utilisateur et rôle de test supprimés"

restore_settings
req GET /api/settings >/dev/null
jq -e --argjson expected "$INITIAL_AI" '.settings.ai == $expected' "$BODY" >/dev/null \
  || fail "section IA non restaurée : $(jq -c .settings.ai "$BODY")"
jq -e --argjson expected "$INITIAL_SECURITY" '.settings.security == $expected' "$BODY" >/dev/null \
  || fail "politique de sécurité non restaurée : $(jq -c .settings.security "$BODY")"
if [ "$KEY_CONFIGURED" != "true" ]; then
  jq -e '.aiApiKeyConfigured == false' "$BODY" >/dev/null \
    || fail "une clé de test est restée enregistrée"
fi
pass "paramètres restaurés — IA : $(jq -c .settings.ai "$BODY")"
pass "paramètres restaurés — sécurité : $(jq -c .settings.security "$BODY")"

printf '\n\033[32m✓ Génération multi-fournisseur vérifiée.\033[0m\n'
printf '\033[33m  ! NON VÉRIFIÉ faute de clé : qu’un vrai modèle produise une AppSpec.\n'
printf '    La boucle est couverte hors ligne (modèle simulé) ; l’appel réseau ne l’est pas.\033[0m\n'
printf '\033[2m  Écrans : %s/applications/new — %s/admin/settings\033[0m\n\n' "$BASE_URL" "$BASE_URL"
