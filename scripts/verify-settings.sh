#!/usr/bin/env bash
#
# Vérifie les paramètres d'instance et la configuration IA :
#
#   1. lecture des paramètres — défauts complets sur une base vierge
#   2. modification du nom, et sa réapparition dans le HTML de l'accueil
#   3. un fuseau inventé est refusé (422)
#   4. la clé d'API n'apparaît JAMAIS dans une réponse GET
#   5. poser une clé ; PATCH sans le champ → conservée ; PATCH `null` → effacée
#   6. l'audit contient `settings.updated` et ne contient PAS la clé
#   7. `settings:manage` est requis pour écrire (testé avec un viewer)
#
# Usage :
#   ./scripts/verify-settings.sh
#   BASE_URL=http://localhost:3200 ./scripts/verify-settings.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
VIEWER_EMAIL="${VIEWER_EMAIL:-settings-viewer@example.test}"
VIEWER_PASSWORD="${VIEWER_PASSWORD:-motdepasse-tres-long}"
CLIENT_IP="${CLIENT_IP:-198.51.100.77}"

# Sentinelle : une chaîne qu'aucun autre champ ne peut contenir par accident.
# C'est elle qu'on cherche dans les réponses et dans le journal d'audit.
SECRET_KEY="${SECRET_KEY:-sk-or-v1-SENTINELLE-NE-DOIT-JAMAIS-FUIR-4242}"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
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

step "1. Connexion"
login
pass "connecté en tant que $ADMIN_EMAIL"

step "2. Lecture des paramètres — les défauts sont complets"
# Table remise à zéro : on veut prouver qu'une base vierge rend bien un objet
# complet, pas un `null` ni un objet à trous.
psql_q "delete from app_settings;" >/dev/null
code=$(req GET /api/settings)
[ "$code" = "200" ] || fail "GET /api/settings → HTTP $code : $(cat "$BODY")"
cp "$BODY" "$WORK/defaults.json"

for field in instanceName instanceTagline timezone locale dateStyle timeStyle; do
  jq -e --arg f "$field" '.settings[$f] != null' "$BODY" >/dev/null \
    || fail "champ « $field » absent des paramètres par défaut"
done
for field in provider model enabled temperature maxTokens; do
  jq -e --arg f "$field" '.settings.ai[$f] != null' "$BODY" >/dev/null \
    || fail "champ « ai.$field » absent des paramètres par défaut"
done
jq -e '.settings.instanceName == "Control plane"' "$BODY" >/dev/null \
  || fail "nom par défaut inattendu : $(jq -c .settings.instanceName "$BODY")"
jq -e '.settings.timezone == "Europe/Paris"' "$BODY" >/dev/null \
  || fail "fuseau par défaut inattendu"
jq -e '.aiApiKeyConfigured == false' "$BODY" >/dev/null \
  || fail "une clé est signalée alors que la table est vide"
TZ_COUNT=$(jq -r '.vocabulary.timezones | length' "$BODY")
[ "$TZ_COUNT" -ge 100 ] || fail "vocabulaire de fuseaux suspect : $TZ_COUNT entrée(s)"
pass "objet complet sur base vierge — $(jq -r '.settings.instanceName' "$WORK/defaults.json") / $(jq -r '.settings.timezone' "$WORK/defaults.json")"
info "$TZ_COUNT fuseaux proposés, $(jq -r '.vocabulary.locales | join(", ")' "$BODY")"

step "3. Modifier le nom, et le retrouver dans le HTML"
NEW_NAME="Panel de vérification"
code=$(req PATCH /api/settings "{\"instanceName\":\"$NEW_NAME\",\"instanceTagline\":\"jalon paramètres\"}")
[ "$code" = "200" ] || fail "PATCH → HTTP $code : $(cat "$BODY")"
jq -e --arg n "$NEW_NAME" '.settings.instanceName == $n' "$BODY" >/dev/null \
  || fail "le nom n'a pas été retenu : $(jq -c .settings.instanceName "$BODY")"
pass "nom enregistré : $NEW_NAME"

stored=$(psql_q "select value->>'instanceName' from app_settings where id = 1;")
[ "$stored" = "$NEW_NAME" ] || fail "en base : « $stored »"
rows=$(psql_q "select count(*) from app_settings;")
[ "$rows" = "1" ] || fail "app_settings contient $rows ligne(s), le singleton n'est pas tenu"
pass "une seule ligne en base, id = 1"

# La page d'accueil est rendue par le serveur : le nom doit y être.
#
# Les paramètres sont mis en cache quelques secondes, et ce cache est PAR
# PROCESSUS : l'écriture invalide celui du processus qui a traité le PATCH, un
# autre worker Next peut encore servir l'ancienne valeur le temps du TTL. On
# laisse donc au cache le temps d'expirer plutôt que de prétendre à une
# cohérence immédiate qui n'est pas promise.
home_ok=""
for _ in $(seq 1 12); do
  curl -sL -b "$JAR" -c "$JAR" -H "origin: $BASE_URL" "$BASE_URL/" > "$WORK/home.html"
  if grep -q "$NEW_NAME" "$WORK/home.html"; then home_ok="yes"; break; fi
  sleep 1
done
[ -n "$home_ok" ] || fail "« $NEW_NAME » absent du HTML de $BASE_URL/ après 12 s"
pass "le nom apparaît dans le HTML de la page d'accueil"
grep -q "Control plane" "$WORK/home.html" \
  && fail "l'ancien nom en dur « Control plane » est encore dans le HTML"
pass "plus aucune trace du nom en dur"

step "4. Un fuseau inventé est refusé"
code=$(req PATCH /api/settings '{"timezone":"Mars/Olympus_Mons"}')
[ "$code" = "422" ] || fail "fuseau invalide : attendu 422, reçu $code — $(cat "$BODY")"
jq -e '.error.code == "validation_failed"' "$BODY" >/dev/null || fail "code d'erreur inattendu"
pass "Mars/Olympus_Mons → 422 validation_failed"

still=$(psql_q "select value->>'timezone' from app_settings where id = 1;")
[ "$still" = "Europe/Paris" ] || fail "le fuseau en base a bougé : « $still »"
pass "le fuseau en base est intact ($still)"

code=$(req PATCH /api/settings '{"timezone":"Asia/Tokyo","locale":"en-GB"}')
[ "$code" = "200" ] || fail "fuseau valide → HTTP $code : $(cat "$BODY")"
pass "Asia/Tokyo accepté"

# Un patch partiel ne touche QUE ce qu'il nomme. Régression déjà rencontrée :
# `.default(x).optional()` en Zod rend le défaut quand la clé est absente, ce
# qui réinitialisait en silence tous les champs non cités.
jq -e --arg n "$NEW_NAME" '.settings.instanceName == $n' "$BODY" >/dev/null \
  || fail "patch partiel : le nom a été réinitialisé → $(jq -c .settings.instanceName "$BODY")"
jq -e '.settings.instanceTagline == "jalon paramètres"' "$BODY" >/dev/null \
  || fail "patch partiel : le sous-titre a été réinitialisé → $(jq -c .settings.instanceTagline "$BODY")"
pass "patch partiel : les champs non cités sont intacts"

code=$(req PATCH /api/settings '{"ai":{"enabled":false}}')
[ "$code" = "200" ] || fail "patch ai partiel → HTTP $code : $(cat "$BODY")"
jq -e '.settings.ai.enabled == false and .settings.ai.model == "anthropic/claude-sonnet-4.5"' "$BODY" >/dev/null \
  || fail "patch ai partiel : le modèle a sauté → $(jq -c .settings.ai "$BODY")"
pass "patch ai partiel : ai.enabled changé, ai.model conservé"
code=$(req PATCH /api/settings '{"ai":{"enabled":true}}')
[ "$code" = "200" ] || fail "réactivation de l'IA → HTTP $code"

code=$(req PATCH /api/settings '{"timezone":"Europe/Paris","locale":"fr-FR"}')
[ "$code" = "200" ] || fail "restauration du fuseau → HTTP $code"
pass "fuseau restauré à Europe/Paris"

step "5. La clé d'API ne sort jamais"
code=$(req PATCH /api/settings "{\"aiApiKey\":\"$SECRET_KEY\"}")
[ "$code" = "200" ] || fail "pose de la clé → HTTP $code : $(cat "$BODY")"
jq -e '.aiApiKeyConfigured == true' "$BODY" >/dev/null || fail "la clé n'est pas signalée comme posée"
grep -qF "$SECRET_KEY" "$BODY" && fail "la clé figure dans la réponse du PATCH"
pass "clé posée, absente de la réponse du PATCH"

encrypted=$(psql_q "select ai_api_key_encrypted from app_settings where id = 1;")
case "$encrypted" in
  v1:*) pass "en base : chiffrée AES-256-GCM (${encrypted:0:16}…)" ;;
  *)    fail "colonne inattendue : $encrypted" ;;
esac
[ "$encrypted" = "$SECRET_KEY" ] && fail "la clé est stockée en clair"
psql_q "select value::text from app_settings where id = 1;" | grep -qF "$SECRET_KEY" \
  && fail "la clé s'est glissée dans le JSONB de configuration"
pass "absente du JSONB de configuration"

code=$(req GET /api/settings)
[ "$code" = "200" ] || fail "GET → HTTP $code"
grep -qF "$SECRET_KEY" "$BODY" && fail "la clé apparaît dans la réponse GET brute"
pass "grep sur la réponse GET brute : aucune occurrence de la clé"
jq -e '.aiApiKeyConfigured == true' "$BODY" >/dev/null || fail "aiApiKeyConfigured devrait valoir true"
jq -e '.aiApiKeyLast4 == "4242"' "$BODY" >/dev/null \
  || fail "4 derniers caractères attendus « 4242 », reçu $(jq -c .aiApiKeyLast4 "$BODY")"
pass "seuls aiApiKeyConfigured=true et aiApiKeyLast4=\"4242\" sont exposés"

# Le HTML de l'écran ne doit pas non plus la contenir.
curl -s -b "$JAR" -c "$JAR" -H "origin: $BASE_URL" "$BASE_URL/admin/settings" > "$WORK/settings.html"
grep -qF "$SECRET_KEY" "$WORK/settings.html" && fail "la clé est dans le HTML de /admin/settings"
pass "absente aussi du HTML de /admin/settings"

step "6. Les trois cas du champ aiApiKey"
code=$(req PATCH /api/settings '{"instanceTagline":"clé inchangée"}')
[ "$code" = "200" ] || fail "PATCH sans le champ → HTTP $code : $(cat "$BODY")"
jq -e '.aiApiKeyConfigured == true' "$BODY" >/dev/null \
  || fail "champ omis : la clé a disparu alors qu'elle devait rester"
after_omit=$(psql_q "select ai_api_key_encrypted from app_settings where id = 1;")
[ "$after_omit" = "$encrypted" ] || fail "champ omis : la valeur chiffrée a changé"
pass "champ omis → clé inchangée, au chiffré près"

code=$(req PATCH /api/settings '{"aiApiKey":null}')
[ "$code" = "200" ] || fail "PATCH null → HTTP $code : $(cat "$BODY")"
jq -e '.aiApiKeyConfigured == false' "$BODY" >/dev/null || fail "null : la clé est encore signalée"
jq -e '.aiApiKeyLast4 == null' "$BODY" >/dev/null || fail "null : des caractères sont encore exposés"
cleared=$(psql_q "select coalesce(ai_api_key_encrypted, 'NULL') from app_settings where id = 1;")
[ "$cleared" = "NULL" ] || fail "la colonne n'est pas vidée : $cleared"
pass "aiApiKey: null → colonne effacée en base"

code=$(req PATCH /api/settings "{\"aiApiKey\":\"$SECRET_KEY\"}")
[ "$code" = "200" ] || fail "repose de la clé → HTTP $code"
pass "clé reposée (pour la vérification de l'audit)"

step "7. Traçabilité, sans le secret"
code=$(req GET "/api/audit-logs?resourceType=settings&pageSize=50")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"
jq -e '[.items[] | select(.action == "settings.updated")] | length > 0' "$BODY" >/dev/null \
  || fail "action « settings.updated » absente du journal"
COUNT=$(jq -r '[.items[] | select(.action == "settings.updated")] | length' "$BODY")
pass "audit : settings.updated présent ($COUNT entrée(s))"

grep -qF "$SECRET_KEY" "$BODY" && fail "la clé apparaît dans le journal d'audit renvoyé par l'API"
pass "grep sur la réponse d'audit : aucune occurrence de la clé"

# Et directement dans la table, pas seulement dans ce que l'API veut bien rendre.
leaks=$(psql_q "select count(*) from audit_logs
  where before::text like '%SENTINELLE%' or after::text like '%SENTINELLE%';")
[ "$leaks" = "0" ] || fail "$leaks entrée(s) d'audit contiennent la clé en base"
pass "grep en base sur audit_logs.before/after : aucune occurrence"

jq -e '[.items[] | select(.action == "settings.updated")][0].after.aiApiKey
       | . == "(défini)" or . == "(effacé)"' "$BODY" >/dev/null \
  || fail "le marqueur de clé attendu est absent : $(jq -c '[.items[] | select(.action == "settings.updated")][0].after.aiApiKey' "$BODY")"
pass "la clé est réduite à un marqueur : $(jq -r '[.items[] | select(.action == "settings.updated")][0].after.aiApiKey' "$BODY")"

step "8. settings:manage est requis pour écrire"
code=$(req POST /api/admin/users \
  "{\"name\":\"Viewer paramètres\",\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\",\"role\":\"viewer\"}")
case "$code" in
  201) pass "utilisateur viewer créé" ;;
  409) pass "utilisateur viewer déjà présent" ;;
  *)   fail "POST /api/admin/users → HTTP $code : $(cat "$BODY")" ;;
esac

viewer_id=$(psql_q "select id from users where email = '$VIEWER_EMAIL';")
[ -n "$viewer_id" ] || fail "utilisateur viewer introuvable en base"

# Le rôle « viewer » de cette base est antérieur aux permissions `settings:*` :
# il ne porte donc pas `settings:read`. On le réaligne sur sa définition —
# toutes les permissions en lecture, quelles qu'elles soient — exactement comme
# le fait `verify-roles.sh` en fin de parcours. Le test qui suit porte bien sur
# la frontière read/manage, pas sur un rôle mal provisionné.
code=$(req GET /api/admin/roles)
[ "$code" = "200" ] || fail "GET /api/admin/roles → HTTP $code"
READ_ONLY=$(jq -c '[.vocabulary.permissions[].key | select(endswith(":read"))]' "$BODY")
jq -e 'index("settings:read") != null' <<< "$READ_ONLY" >/dev/null   || fail "« settings:read » absent du vocabulaire des permissions"
code=$(req PATCH /api/admin/roles/viewer "{\"permissions\":$READ_ONLY}")
[ "$code" = "200" ] || fail "réalignement de viewer → HTTP $code : $(cat "$BODY")"
pass "rôle viewer réaligné sur $(jq -r 'length' <<< "$READ_ONLY") permissions en lecture, dont settings:read"

for _ in 1 2 3 4 5; do
  code=$(req POST /api/auth/sign-in/email \
    "{\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\"}" "$VIEWER_JAR")
  [ "$code" = "429" ] || break
  sleep 6
done
[ "$code" = "200" ] || fail "connexion viewer impossible (HTTP $code) : $(cat "$BODY")"
pass "connecté en tant que $VIEWER_EMAIL"

code=$(req GET /api/settings '' "$VIEWER_JAR")
[ "$code" = "200" ] || fail "un viewer doit pouvoir lire les paramètres : HTTP $code"
grep -qF "$SECRET_KEY" "$BODY" && fail "la clé fuit dans la lecture d'un viewer"
pass "lecture autorisée (settings:read), toujours sans la clé"

code=$(req PATCH /api/settings '{"instanceName":"Détourné par un viewer"}' "$VIEWER_JAR")
[ "$code" = "403" ] || fail "écriture par un viewer : attendu 403, reçu $code — $(cat "$BODY")"
jq -e '.error.details.permission == "settings:manage"' "$BODY" >/dev/null \
  || fail "permission manquante mal rapportée : $(jq -c .error "$BODY")"
pass "écriture refusée → 403, permission « settings:manage »"

untouched=$(psql_q "select value->>'instanceName' from app_settings where id = 1;")
[ "$untouched" = "$NEW_NAME" ] || fail "le nom a changé malgré le refus : « $untouched »"
pass "le refus n'a rien écrit"

step "9. Désactiver l'analyse de sécurité, de manière permanente"
# On se reconnecte en administrateur : l'étape précédente a basculé sur un viewer.
login

code=$(req PATCH /api/settings '{"security":{"scanningEnabled":false}}')
[ "$code" = "200" ] || fail "PATCH security → HTTP $code : $(cat "$BODY")"
jq -e '.settings.security.scanningEnabled == false' "$BODY" >/dev/null \
  || fail "le réglage n'a pas été retenu"
pass "analyse désactivée"

persisted=$(psql_q "select value->'security'->>'scanningEnabled' from app_settings where id = 1;")
[ "$persisted" = "false" ] || fail "réglage non persisté : « $persisted »"
pass "persisté en base — le réglage survit à un redémarrage"

# Le vrai test : un déploiement qui DEMANDE des scanners ne doit pas en obtenir.
APP_ID=$(req GET "/api/applications?pageSize=1" >/dev/null; jq -r '.items[0].id // empty' "$BODY")
TARGET_ID=$(req GET /api/targets >/dev/null; jq -r '[.items[] | select(.status != "unreachable")][0].id // empty' "$BODY")

if [ -n "$APP_ID" ] && [ -n "$TARGET_ID" ]; then
  code=$(req POST /api/deployments \
    "{\"applicationId\":\"$APP_ID\",\"targetId\":\"$TARGET_ID\",\"runtime\":\"docker\",\"proxy\":\"traefik\",\"scanConfig\":{\"scanners\":[\"trivy\",\"grype\"],\"failOn\":\"CRITICAL\"},\"autoRollback\":false}")
  [ "$code" = "201" ] || [ "$code" = "202" ] || [ "$code" = "200" ] \
    || fail "création du déploiement → HTTP $code : $(cat "$BODY")"

  DEPLOY_ID=$(jq -r '.id' "$BODY")
  jq -e '.scanConfig.scanners == [] and .scanConfig.disabledBy == "settings"' "$BODY" >/dev/null \
    || fail "les scanners demandés ont survécu : $(jq -c .scanConfig "$BODY")"
  pass "trivy+grype demandés, aucun retenu — motif « settings »"

  # Ce qui est gelé en base doit décrire ce qui tournera, pas ce qui a été demandé :
  # sinon l'historique garderait la trace d'un scanner qui n'a jamais été lancé.
  frozen=$(psql_q "select scan_config->>'disabledBy' from deployments where id = '$DEPLOY_ID';")
  [ "$frozen" = "settings" ] || fail "configuration gelée trompeuse : « $frozen »"
  pass "la configuration gelée dit la vérité"

  # L'intention doit rester lisible quelque part : c'est le rôle de l'audit.
  req GET "/api/audit-logs?resourceType=deployment&pageSize=10" >/dev/null
  jq -e --arg id "$DEPLOY_ID" \
    '[.items[] | select(.resourceId == $id and .after.scanRequested != null)] | length > 0' \
    "$BODY" >/dev/null || fail "l'audit ne garde pas trace des scanners demandés"
  pass "audit : les scanners demandés et le motif du refus sont consignés"
else
  info "aucune application ou cible exploitable — effet sur un déploiement non exercé"
fi

step "10. Écarter un seul scanner"
code=$(req PATCH /api/settings '{"security":{"scanningEnabled":true,"disabledScanners":["trivy"]}}')
[ "$code" = "200" ] || fail "PATCH → HTTP $code"
jq -e '.settings.security.disabledScanners == ["trivy"]' "$BODY" >/dev/null \
  || fail "l'exclusion n'a pas été retenue"
pass "trivy écarté, analyse toujours active"

code=$(req PATCH /api/settings '{"security":{"disabledScanners":["monde:dominer"]}}')
[ "$code" = "422" ] || fail "scanner inventé : attendu 422, reçu $code"
pass "un scanner hors vocabulaire est refusé"

step "11. Ménage"
req PATCH /api/settings '{"aiApiKey":null}' >/dev/null
# Réglage de sécurité rendu à son défaut : les autres scripts en dépendent.
req PATCH /api/settings '{"security":{"scanningEnabled":true,"disabledScanners":[]}}' >/dev/null
code=$(req PATCH /api/settings \
  '{"instanceName":"Control plane","instanceTagline":"Bootstrap TP v2","timezone":"Europe/Paris","locale":"fr-FR"}')
[ "$code" = "200" ] || fail "restauration → HTTP $code : $(cat "$BODY")"
pass "paramètres restaurés, clé effacée"
req DELETE "/api/admin/users/$viewer_id" >/dev/null
pass "utilisateur viewer supprimé"

printf '\n\033[32m✓ Paramètres d'"'"'instance vérifiés.\033[0m\n'
printf '\033[2m  Écran : %s/admin/settings\033[0m\n\n' "$BASE_URL"
