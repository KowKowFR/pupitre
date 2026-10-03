#!/usr/bin/env bash
#
# Vérifie les paramètres d'instance et la configuration IA :
#
#   1. lecture des paramètres — défauts complets sur une base vierge
#   2. modification du nom, et sa réapparition dans le HTML de l'accueil
#   3. un fuseau inventé est refusé (422)
#   4. la clé d'API n'apparaît JAMAIS dans une réponse GET, ni dans le HTML
#      d'AUCUNE des pages de réglages — /admin/settings/ia comprise
#   5. poser une clé ; PATCH sans le champ → conservée ; PATCH `null` → effacée
#   6. l'audit contient `settings.updated` et ne contient PAS la clé
#   7. `settings:manage` est requis pour écrire, et un auditeur voit les sections
#      sans pouvoir les modifier
#   8. chaque sous-section est atteignable et rend ses champs
#   9. enregistrer une section ne modifie AUCUNE autre section
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
KEY_SNAPSHOT="$WORK/ai-key.b64"

# La clé d'API de l'instance, mise de côté puis rendue.
#
# L'étape 2 fait `delete from app_settings` — il le faut, c'est ainsi qu'on
# prouve qu'une table vide rend des défauts complets. Mais cette table porte
# `ai_api_key_encrypted`, et **une clé chiffrée effacée est perdue** : ni
# l'audit ni les logs n'en gardent trace, c'est la garantie même du chiffrement.
# Le script rendait ensuite les réglages à leurs défauts et annonçait « clé
# effacée » comme s'il s'agissait d'un état voulu. Sur une instance en service,
# lancer une vérification n'a pas à coûter une clé que l'opérateur devra
# retrouver chez son fournisseur.
#
# On passe par base64 plutôt que par une interpolation directe : la valeur
# chiffrée contient des « : » et de la base64, et une seule apostrophe mal
# placée dans une commande SQL construite à la main suffirait à tout casser.
snapshot_ai_key() {
  psql_q "select coalesce(encode(convert_to(ai_api_key_encrypted, 'UTF8'), 'base64'), '')
          from app_settings where id = 1;" 2>/dev/null | tr -d ' \n\r' > "$KEY_SNAPSHOT" || true
}

restore_ai_key() {
  local encoded
  encoded=$(cat "$KEY_SNAPSHOT" 2>/dev/null || true)
  [ -n "$encoded" ] || return 0
  psql_q "update app_settings
          set ai_api_key_encrypted = convert_from(decode('$encoded', 'base64'), 'UTF8')
          where id = 1;" >/dev/null 2>&1 || true
}

# Sur EXIT, donc y compris après un `fail` en cours de route : une vérification
# qui s'interrompt à l'étape 7 ne doit pas laisser l'instance amputée.
trap 'restore_ai_key; rm -rf "$WORK"' EXIT

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

psql_q() { docker compose exec -T postgres psql -U tp -d "${PGDATABASE:-tp}" -tAc "$1"; }

# Les pages de l'écran de réglages, toutes.
#
# Les paramètres ne sont plus une page unique : chaque domaine a son adresse,
# rangée dans l'un des quatre groupes du rail. Cette liste est ce qui empêche
# une assertion de non-fuite de se contenter de la première page venue.
SETTINGS_PAGES="/admin/settings/identite
/admin/settings/regionalisation
/admin/settings/securite
/admin/settings/connexion
/admin/settings/comptes
/admin/settings/notifications
/admin/settings/ia
/admin/settings/demarrage"

# HTML d'une page dans $2, en exigeant un 200 **franc**.
#
# Volontairement sans `-L` : une sous-section transformée en redirection ferait
# passer tous les `grep` qui suivent sans qu'ils regardent le bon document.
# Exiger le 200 direct, c'est exiger que la page existe vraiment.
page() {
  local path="$1" out="$2" jar="${3:-$JAR}" code
  code=$(curl -s -o "$out" -w '%{http_code}' -b "$jar" -c "$jar" \
    -H "origin: $BASE_URL" "$BASE_URL$path")
  [ "$code" = "200" ] || fail "GET $path → HTTP $code (attendu 200, sans redirection)"
}

# Empreinte des sections AUTRES que celle qu'on vient d'enregistrer.
#
# Les sections sont des intentions, pas des clés du JSONB : « régionalisation »
# recouvre quatre champs de la racine, « IA » recouvre `ai` plus l'état de la
# clé. L'empreinte les regroupe comme l'écran les regroupe, puis retire celle
# qui était visée — ce qui reste doit être identique au bit près.
fingerprint() {
  local skip="$1" file="$2"
  jq -S --arg skip "$skip" '{
    identite: { nom: .settings.instanceName, sous_titre: .settings.instanceTagline },
    regionalisation: {
      tz: .settings.timezone, locale: .settings.locale,
      date: .settings.dateStyle, heure: .settings.timeStyle
    },
    securite: .settings.security,
    ia: (.settings.ai + { cle: .aiApiKeyConfigured, last4: .aiApiKeyLast4 }),
    comptes: .settings.accounts,
    demarrage: .settings.onboarding
  } | del(.[$skip])' "$file"
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
snapshot_ai_key
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
# Le défaut vient de `DEFAULT_APP_SETTINGS` dans `packages/core/src/settings.ts`,
# jamais du défaut de colonne : c'est `mergeAppSettings()` qui comble une table
# vide. Si les deux divergent un jour, c'est ici qu'on le verra.
jq -e '.settings.instanceName == "Pupitre"' "$BODY" >/dev/null \
  || fail "nom par défaut inattendu : $(jq -c .settings.instanceName "$BODY")"
jq -e '.settings.timezone == "Europe/Paris"' "$BODY" >/dev/null \
  || fail "fuseau par défaut inattendu"
jq -e '.aiApiKeyConfigured == false' "$BODY" >/dev/null \
  || fail "une clé est signalée alors que la table est vide"
TZ_COUNT=$(jq -r '.vocabulary.timezones | length' "$BODY")
[ "$TZ_COUNT" -ge 100 ] || fail "vocabulaire de fuseaux suspect : $TZ_COUNT entrée(s)"
pass "objet complet sur base vierge — $(jq -r '.settings.instanceName' "$WORK/defaults.json") / $(jq -r '.settings.timezone' "$WORK/defaults.json")"
info "$TZ_COUNT fuseaux proposés, $(jq -r '.vocabulary.locales | join(", ")' "$BODY")"

# L'assistant de démarrage, soldé immédiatement.
#
# La table vient d'être vidée : l'avancement est reparti de zéro, et le layout
# de `(app)` renvoie alors TOUTE page authentifiée vers /onboarding — un 307.
# Tous les `grep` sur du HTML qui suivent liraient donc un corps de redirection
# vide et réussiraient sans regarder le bon document. C'est précisément le
# genre d'assertion qui ment : on solde le parcours avant de regarder quoi que
# ce soit, et `page()` exige ensuite un 200 franc.
code=$(req PATCH /api/onboarding '{"action":"dismiss"}')
[ "$code" = "200" ] || fail "abandon de l'assistant → HTTP $code : $(cat "$BODY")"
pass "assistant de démarrage soldé — les écrans du panel répondent de nouveau 200"

step "3. Modifier le nom, et le retrouver dans le HTML"
NEW_NAME="Panel de vérification"
code=$(req PATCH /api/settings "{\"instanceName\":\"$NEW_NAME\",\"instanceTagline\":\"accroche de test\"}")
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
jq -e '.settings.instanceTagline == "accroche de test"' "$BODY" >/dev/null \
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

# Le HTML des écrans ne doit pas non plus la contenir.
#
# Cette assertion ne visait qu'/admin/settings. Depuis le découpage, cette
# adresse est un sommaire : elle ne rend aucun champ de clé, et le grep y
# passerait quoi qu'il arrive — une assertion qui réussit en regardant au
# mauvais endroit ment, elle ne protège rien. On balaie donc le sommaire et ses
# six sections, et on prouve séparément que celle qui porte réellement le champ
# a bien été lue.
#
# `notifications` a longtemps manqué à cette liste. C'était la pire des six à
# oublier : c'est la seule autre à porter des secrets chiffrés.
for path in $SETTINGS_PAGES; do
  page "$path" "$WORK/page.html"
  grep -qF "$SECRET_KEY" "$WORK/page.html" && fail "la clé est dans le HTML de $path"
done
pass "clé absente du HTML des $(echo "$SETTINGS_PAGES" | wc -l | tr -d ' ') pages de réglages"

page /admin/settings/ia "$WORK/ia.html"
grep -q 'id="apiKey"' "$WORK/ia.html" \
  || fail "/admin/settings/ia ne rend pas le champ de clé — le grep ci-dessus ne prouverait rien"
grep -qF "$SECRET_KEY" "$WORK/ia.html" && fail "la clé est dans le HTML de /admin/settings/ia"
grep -qF "4242" "$WORK/ia.html" \
  || fail "les 4 derniers caractères devraient être affichés en repère sur la section IA"
pass "/admin/settings/ia rend bien le champ, avec …4242 en repère et sans la clé"

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

# Le lecteur des paramètres est un auditeur : l'observateur ne lit que
# l'exploitation, sans `settings:read`. Les variables gardent le nom « viewer »,
# celui d'un compte en lecture seule.
step "8. settings:manage pour écrire — un auditeur voit, et ne touche à rien"
code=$(req POST /api/admin/users \
  "{\"name\":\"Viewer paramètres\",\"email\":\"$VIEWER_EMAIL\",\"password\":\"$VIEWER_PASSWORD\",\"role\":\"auditor\"}")
case "$code" in
  201) pass "utilisateur viewer créé" ;;
  409) pass "utilisateur viewer déjà présent" ;;
  *)   fail "POST /api/admin/users → HTTP $code : $(cat "$BODY")" ;;
esac

viewer_id=$(psql_q "select id from users where email = '$VIEWER_EMAIL';")
[ -n "$viewer_id" ] || fail "utilisateur viewer introuvable en base"

# Un compte déjà présent a pu garder un autre rôle d'un passage précédent.
code=$(req PATCH "/api/admin/users/$viewer_id/role" '{"role":"auditor"}')
[ "$code" = "200" ] || fail "rôle auditeur → HTTP $code : $(cat "$BODY")"
code=$(req GET /api/admin/roles)
[ "$code" = "200" ] || fail "GET /api/admin/roles → HTTP $code"
jq -e '[.items[] | select(.key == "auditor") | .permissions[]] | index("settings:read") != null
       and index("settings:manage") == null' "$BODY" >/dev/null \
  || fail "le rôle auditor ne porte pas settings:read sans settings:manage — le test ne prouverait rien"
pass "le compte est auditeur : settings:read, sans settings:manage"

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

# Un lecteur doit VOIR les sections — en lecture seule, avec la mention qui
# l'explique. Des champs actifs qui finiraient en 403 à l'enregistrement
# seraient une promesse que l'écran ne peut pas tenir.
for path in $SETTINGS_PAGES; do
  page "$path" "$WORK/viewer-page.html" "$VIEWER_JAR"
  grep -qF "$SECRET_KEY" "$WORK/viewer-page.html" && fail "la clé fuit sur $path pour un viewer"
done
pass "les pages de réglages répondent 200 à un viewer, sans la clé"

page /admin/settings/ia "$WORK/viewer-ia.html" "$VIEWER_JAR"
grep -q 'id="apiKey"' "$WORK/viewer-ia.html" \
  || fail "le viewer ne voit pas la section IA : la lecture seule n'est pas une page vide"
grep -q 'settings:manage' "$WORK/viewer-ia.html" \
  || fail "la mention expliquant la lecture seule est absente"
grep -q 'type="submit"' "$WORK/viewer-ia.html" \
  && fail "un bouton d'enregistrement est offert à un viewer"
grep -q 'disabled=""' "$WORK/viewer-ia.html" \
  || fail "les champs de la section IA ne sont pas désactivés pour un viewer"
pass "viewer : section visible, champs inactifs, aucun bouton d'enregistrement"

page /admin/settings/demarrage "$WORK/viewer-onb.html" "$VIEWER_JAR"
grep -q 'settings:manage' "$WORK/viewer-onb.html" \
  || fail "l'assistant ne dit pas au viewer pourquoi il ne peut pas le relancer"
grep -q 'Relancer l' "$WORK/viewer-onb.html" \
  && fail "le bouton de relance est offert à un viewer"
pass "viewer : l'assistant s'affiche sans son bouton de relance"

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

step "11. Chaque sous-section est atteignable et rend ses champs"
# /admin/settings mène au premier onglet du premier groupe. Chaque section porte
# le rail des quatre groupes, et les onglets du sien.
root=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -b "$JAR" "$BASE_URL/admin/settings")
case "$root" in
  30[78]\ */admin/settings/identite) ;;
  *) fail "/admin/settings : attendu une redirection vers /admin/settings/identite, reçu « $root »" ;;
esac
pass "/admin/settings mène à l'onglet Identité"
page /admin/settings/securite "$WORK/group.html"
for target in identite securite integrations sauvegardes connexion comptes; do
  grep -q "href=\"/admin/settings/$target\"" "$WORK/group.html" \
    || fail "le rail ou les onglets de « Sécurité et accès » ne mènent pas à /admin/settings/$target"
done
pass "le rail mène aux quatre groupes, les onglets aux trois sections du groupe"

# Une section « atteignable » qui ne rendrait pas ses champs serait une page
# morte de plus : on nomme donc, pour chacune, les identifiants qu'elle doit
# porter.
check_page() {
  local path="$1"; shift
  local file="$WORK/section.html" marker
  page "$path" "$file"
  for marker in "$@"; do
    grep -qF "$marker" "$file" || fail "« $marker » absent de $path"
  done
  pass "$path — $# marqueur(s) présents"
}

check_page /admin/settings/identite 'id="instanceName"' 'id="instanceTagline"'
check_page /admin/settings/regionalisation \
  'id="timezone"' 'id="locale"' 'id="dateStyle"' 'id="timeStyle"' 'Europe/Paris'
check_page /admin/settings/securite 'id="failOn"' 'Scanners' 'trivy'
check_page /admin/settings/connexion 'id="sso-issuer"' 'id="sso-client"' '/api/auth/callback/oidc'
check_page /admin/settings/comptes 'name="two-factor-policy"' 'id="session-idle"' 'id="session-max"'
check_page /admin/settings/notifications 'Ajouter un canal' 'Notifications'
check_page /admin/settings/ia 'id="aiProvider"' 'id="aiModel"' 'id="apiKey"' 'type="submit"'
check_page /admin/settings/demarrage 'Relancer l' 'Assistant de d'

step "12. Enregistrer une section ne touche à aucune autre"
# LE piège de ce test : si les autres sections sont restées à leurs valeurs par
# défaut, un écrasement par les défauts est indistinguable d'une conservation,
# et le test réussit alors même que le bug est là. On personnalise donc TOUT
# avant de ne toucher qu'à une seule chose.
code=$(req PATCH /api/settings '{
  "instanceName":"Instance cloisonnée","instanceTagline":"témoin de cloisonnement",
  "timezone":"Asia/Tokyo","locale":"en-GB","dateStyle":"long","timeStyle":"short",
  "security":{"scanningEnabled":true,"disabledScanners":["syft"],"failOn":"HIGH"},
  "ai":{"enabled":false,"provider":"openai","model":"gpt-4.1-mini","temperature":0.65,"maxTokens":1024},
  "accounts":{"sessionIdleHours":8}
}')
[ "$code" = "200" ] || fail "personnalisation préalable → HTTP $code : $(cat "$BODY")"
jq -e '.settings.instanceTagline == "témoin de cloisonnement"
       and .settings.timezone == "Asia/Tokyo" and .settings.dateStyle == "long"
       and .settings.security.disabledScanners == ["syft"]
       and .settings.security.failOn == "HIGH"
       and .settings.ai.temperature == 0.65 and .settings.ai.maxTokens == 1024
       and .settings.accounts.sessionIdleHours == 8
       and .aiApiKeyConfigured == true' "$BODY" >/dev/null \
  || fail "la personnalisation préalable n'a pas pris : $(jq -c .settings "$BODY")"
pass "les sections portent des valeurs distinctes de leurs défauts"

# $1 nom de la section enregistrée, $2 corps du PATCH (ses seuls champs),
# $3 expression jq prouvant que la section visée a bien changé — et que ce
# qu'elle contient d'autre a survécu.
isolate() {
  local name="$1" body="$2" probe="$3" before after
  req GET /api/settings >/dev/null
  before=$(fingerprint "$name" "$BODY")
  code=$(req PATCH /api/settings "$body")
  [ "$code" = "200" ] || fail "PATCH « $name » → HTTP $code : $(cat "$BODY")"
  jq -e "$probe" "$BODY" >/dev/null \
    || fail "« $name » : la section n'a pas pris la valeur attendue → $(jq -c .settings "$BODY")"
  after=$(fingerprint "$name" "$BODY")
  if [ "$before" != "$after" ]; then
    diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | head -20
    fail "enregistrer « $name » a modifié d'autres sections (voir le diff ci-dessus)"
  fi
  pass "« $name » enregistrée seule — les autres sections sont intactes au bit près"
}

isolate identite \
  '{"instanceName":"Renommée depuis sa section"}' \
  '.settings.instanceName == "Renommée depuis sa section"
   and .settings.instanceTagline == "témoin de cloisonnement"'

isolate regionalisation \
  '{"timezone":"Europe/Lisbon"}' \
  '.settings.timezone == "Europe/Lisbon" and .settings.locale == "en-GB"
   and .settings.dateStyle == "long" and .settings.timeStyle == "short"'

isolate securite \
  '{"security":{"failOn":"NONE"}}' \
  '.settings.security == {"scanningEnabled":true,"disabledScanners":["syft"],"failOn":"NONE"}'

isolate ia \
  '{"ai":{"temperature":0.15}}' \
  '.settings.ai.temperature == 0.15 and .settings.ai.model == "gpt-4.1-mini"
   and .settings.ai.maxTokens == 1024 and .settings.ai.enabled == false
   and .aiApiKeyConfigured == true'

isolate comptes \
  '{"accounts":{"sessionMaxHours":168}}' \
  '.settings.accounts == {"twoFactorPolicy":"off","sessionIdleHours":8,"sessionMaxHours":168}'

step "13. Ménage"
req PATCH /api/settings '{"aiApiKey":null}' >/dev/null
# Réglage de sécurité rendu à son défaut : les autres scripts en dépendent.
req PATCH /api/settings '{"security":{"scanningEnabled":true,"disabledScanners":[],"failOn":"NONE"}}' >/dev/null
req PATCH /api/settings '{"accounts":{"twoFactorPolicy":"off","sessionIdleHours":168,"sessionMaxHours":null}}' >/dev/null
# L'étape 12 a personnalisé l'IA pour que le cloisonnement se voie : on la rend.
req PATCH /api/settings \
  '{"ai":{"enabled":true,"provider":"openrouter","model":"anthropic/claude-sonnet-4.5","baseUrl":"","temperature":0.2,"maxTokens":8192}}' >/dev/null
code=$(req PATCH /api/settings \
  '{"instanceName":"Pupitre","instanceTagline":"Plan de contrôle de déploiement","timezone":"Europe/Paris","locale":"fr-FR","dateStyle":"short","timeStyle":"medium"}')
[ "$code" = "200" ] || fail "restauration → HTTP $code : $(cat "$BODY")"
if [ -s "$KEY_SNAPSHOT" ]; then
  pass "paramètres restaurés ; la clé d'instance sera remise en place en sortant"
else
  pass "paramètres restaurés, clé de test effacée (aucune clé d'instance au départ)"
fi
req DELETE "/api/admin/users/$viewer_id" >/dev/null
pass "utilisateur viewer supprimé"
# L'assistant a été abandonné à l'étape 2 pour rendre les pages consultables.
# On le laisse « terminé » plutôt qu'« abandonné » : c'est l'état d'une
# instance en service, et celui que les autres scripts trouvent.
req PATCH /api/onboarding '{"action":"finish"}' >/dev/null
pass "assistant de démarrage marqué terminé"

printf '\n\033[32m✓ Paramètres d'"'"'instance vérifiés.\033[0m\n'
printf '\033[2m  Écrans : %s/admin/settings — et ses %s sous-sections\033[0m\n\n' \
  "$BASE_URL" "$(echo "$SETTINGS_PAGES" | wc -l | tr -d ' ')"
