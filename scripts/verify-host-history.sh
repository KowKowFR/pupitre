#!/usr/bin/env bash
#
# Vérifie la MÉMOIRE de la supervision des serveurs :
#
#    1. un relevé n'est plus perdu — il est écrit, quel qu'en soit le déclencheur
#    2. les relevés s'accumulent, et l'historique se lit en SQL (pas en SSH),
#       donc il répond même quand la machine ne répond plus
#    3. les trois couches de seuils : catalogue → défaut d'instance → machine
#    4. un seuil NON franchi ne produit AUCUNE entrée d'audit
#    5. un seuil franchi produit EXACTEMENT UNE entrée — pas une par relevé
#    6. le retour sous le seuil en produit exactement une, et une seule
#    7. deux dépassements ouverts sur la même métrique sont impossibles —
#       une contrainte en base, pas un `if`
#    8. le balayage est une tâche répétable BullMQ, installée par le worker.
#       Pas de cron Linux, et pas de relevé en doublon : une machine relevée
#       il y a moins que la cadence n'est pas due
#    9. la purge purge — exactement au-delà de la rétention, et les
#       dépassements y survivent
#   10. le RBAC : `target:read` pour lire l'historique, `target:update` pour
#       régler un seuil
#
# Prérequis : une cible joignable — `./scripts/setup-test-target.sh` en
# provisionne une. Le script ne crée aucune application et ne déploie rien.
#
# Ce qu'il touche, et qu'il rend : les seuils de la cible d'épreuve, le seuil
# de DISQUE global, les dépassements de cette cible, et les relevés fabriqués
# qu'il marque pour les reconnaître. Les seuils globaux des autres métriques et
# les relevés réels ne sont jamais effacés — c'est l'historique de la machine.
#
# Usage :
#   ./scripts/verify-host-history.sh
#   BASE_URL=http://localhost:3100 TARGET_NAME=ma-vm ./scripts/verify-host-history.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
CLIENT_IP="${CLIENT_IP:-198.51.100.43}"
TARGET_NAME="${TARGET_NAME:-cible-de-verification}"
TARGET_SERVICE="${TARGET_SERVICE:-ssh-target}"

READER_ROLE="${READER_ROLE:-verif-histo-lecteur}"
READER_EMAIL="${READER_EMAIL:-histo-lecteur@example.test}"
BLIND_ROLE="${BLIND_ROLE:-verif-histo-aveugle}"
BLIND_EMAIL="${BLIND_EMAIL:-histo-aveugle@example.test}"
PASSWORD="${PASSWORD:-motdepasse-tres-long}"

# Cadence et rétention, telles que le code les fixe. Le script les recoupe avec
# ce que l'API annonce : deux vérités qui divergeraient se verraient ici.
EXPECTED_INTERVAL=300
EXPECTED_RETENTION=30

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
READER_JAR="$WORK/reader.jar"
BLIND_JAR="$WORK/blind.jar"
BODY="$WORK/body.json"

TARGET_ID=''
FAKE_MARK='verification-purge'

# Rend le terrain tel qu'il a été trouvé, même en cas de mort en route.
cleanup() {
  if [ -n "$TARGET_ID" ]; then
    docker compose exec -T postgres psql -U tp -d tp -tAc \
      "delete from target_metric_thresholds
         where target_id = '$TARGET_ID' or (target_id is null and metric = 'disk');
       delete from target_metric_breaches where target_id = '$TARGET_ID';
       delete from target_metric_samples where error = '$FAKE_MARK';" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

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

psql_q() { docker compose exec -T postgres psql -U tp -d tp -tAc "$1" | tr -d '\r'; }
redis_cli() { docker compose exec -T redis redis-cli "$@" | tr -d '\r'; }

assert_admin() {
  local role
  role=$(jq -r '.user.role // empty' "$BODY")
  [ "$role" = "admin" ] && return 0
  fail "« $ADMIN_EMAIL » a le rôle « ${role:-aucun} », pas « admin »"
}

# Better Auth limite les connexions répétées depuis une même IP : on patiente
# plutôt que de retomber sur l'inscription, qui donnerait un message trompeur.
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

# Un relevé, par la route existante. Il traverse la file, le worker, SSH — et,
# depuis ce chantier, la base.
probe() {
  local code
  code=$(req GET "/api/targets/$TARGET_ID/metrics")
  [ "$code" = "200" ] || fail "GET metrics → HTTP $code : $(cat "$BODY")"
}

samples_of() { psql_q "select count(*) from target_metric_samples where target_id = '$TARGET_ID';"; }

# Entrées d'audit de seuil pour CETTE cible et CETTE métrique. Le filtre sur la
# métrique est essentiel : la mémoire de la machine hôte peut légitimement
# franchir son propre seuil pendant le test, et fausserait un comptage global.
audit_count() {
  psql_q "select count(*) from audit_logs
           where action = '$1' and resource_id = '$TARGET_ID'
             and after->>'metric' = '$2';"
}

# Pose un seuil de disque pour la cible. Écho : rien, échoue si l'API refuse.
set_disk_limit() {
  local code
  code=$(req PUT /api/supervision/thresholds \
    "{\"targetId\":\"$TARGET_ID\",\"metric\":\"disk\",\"limitPercent\":$1}")
  [ "$code" = "200" ] || fail "PUT seuil disque $1 % → HTTP $code : $(cat "$BODY")"
}

step "1. Connexion"
login
pass "connecté en tant que $ADMIN_EMAIL"

step "2. Prérequis"
RUNNING=$(docker compose ps --format '{{.Service}}' 2>/dev/null || true)
printf '%s\n' "$RUNNING" | grep -qx "$TARGET_SERVICE" \
  || fail "le conteneur « $TARGET_SERVICE » ne tourne pas — lancez ./scripts/setup-test-target.sh"

code=$(req GET /api/targets)
[ "$code" = "200" ] || fail "GET /api/targets → HTTP $code"
TARGET_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY" | head -1)
[ -n "$TARGET_ID" ] || fail "cible « $TARGET_NAME » introuvable"
pass "cible « $TARGET_NAME » — $TARGET_ID"

# Terrain propre : ni seuil, ni dépassement hérités d'une exécution précédente.
psql_q "delete from target_metric_thresholds
          where target_id = '$TARGET_ID' or (target_id is null and metric = 'disk');
        delete from target_metric_breaches where target_id = '$TARGET_ID';" >/dev/null
pass "seuils et dépassements de cette cible remis à zéro"

step "3. Un relevé n'est plus perdu"
BEFORE=$(samples_of)
info "relevés déjà en mémoire pour cette cible : $BEFORE"

probe
DISK_NOW=$(jq -r '.disk.usePercent' "$BODY")
MEM_NOW=$(jq -r '.memory.usedPercent' "$BODY")
CORES=$(jq -r '.load.cores' "$BODY")
AFTER=$(samples_of)
[ "$AFTER" = "$((BEFORE + 1))" ] \
  || fail "un relevé aurait dû écrire une ligne : $BEFORE → $AFTER"
pass "un appel à /metrics écrit exactement une ligne ($BEFORE → $AFTER)"

ROW=$(psql_q "select source || '|' || round(disk_percent::numeric, 4) || '|' || cores || '|' || reachable
                from target_metric_samples
               where target_id = '$TARGET_ID' order by sampled_at desc limit 1;")
SRC=$(printf '%s' "$ROW" | cut -d'|' -f1)
ROW_DISK=$(printf '%s' "$ROW" | cut -d'|' -f2)
ROW_CORES=$(printf '%s' "$ROW" | cut -d'|' -f3)
[ "$SRC" = "manual" ] || fail "la ligne devrait porter source = manual, elle porte « $SRC »"
[ "$ROW_CORES" = "$CORES" ] || fail "cœurs : la base dit $ROW_CORES, l'API a répondu $CORES"
awk -v a="$ROW_DISK" -v b="$DISK_NOW" 'BEGIN { d = a - b; if (d < 0) d = -d; exit !(d < 0.01) }' \
  || fail "disque : la base dit $ROW_DISK %, l'API a répondu $DISK_NOW %"
pass "la ligne écrite est bien celle rendue : disque $ROW_DISK %, $ROW_CORES cœurs, source « manual »"
info "mémoire au même instant : $MEM_NOW % — la ligne porte les trois dimensions, en colonnes"


step "4. Les relevés s'accumulent, et l'historique se lit en SQL"
for _ in 1 2 3; do probe; done
COUNT=$(samples_of)
[ "$COUNT" = "$((BEFORE + 4))" ] || fail "4 relevés attendus, $((COUNT - BEFORE)) écrits"
pass "4 relevés d'affilée → 4 lignes ($BEFORE → $COUNT)"

code=$(req GET "/api/targets/$TARGET_ID/metrics/history?hours=24&buckets=48")
[ "$code" = "200" ] || fail "GET metrics/history → HTTP $code : $(cat "$BODY")"
API_INTERVAL=$(jq -r '.intervalSeconds' "$BODY")
API_RETENTION=$(jq -r '.retentionDays' "$BODY")
[ "$API_INTERVAL" = "$EXPECTED_INTERVAL" ] \
  || fail "cadence annoncée $API_INTERVAL s, attendue $EXPECTED_INTERVAL s"
[ "$API_RETENTION" = "$EXPECTED_RETENTION" ] \
  || fail "rétention annoncée $API_RETENTION j, attendue $EXPECTED_RETENTION j"
pass "l'historique s'annonce : cadence $API_INTERVAL s, rétention $API_RETENTION jours"

HIST_SAMPLES=$(jq -r '.samples' "$BODY")
[ "$HIST_SAMPLES" -ge 4 ] || fail "la fenêtre 24 h ne compte que $HIST_SAMPLES relevés"
POINTS=$(jq -r '.points | length' "$BODY")
WORST=$(jq -r '.summary.disk.worst' "$BODY")
SQL_WORST=$(psql_q "select round(max(disk_percent)::numeric, 4) from target_metric_samples
                     where target_id = '$TARGET_ID' and sampled_at >= now() - interval '24 hours';")
awk -v a="$WORST" -v b="$SQL_WORST" 'BEGIN { d = a - b; if (d < 0) d = -d; exit !(d < 0.01) }' \
  || fail "pire relevé : l'API dit $WORST, la base dit $SQL_WORST"
pass "$HIST_SAMPLES relevés agrégés en $POINTS intervalles — pire disque $WORST % (= max en base)"

# L'agrégation est un `max()`, pas une moyenne : c'est le pic qui intéresse.
[ "$POINTS" -le 48 ] || fail "$POINTS points rendus pour 48 intervalles demandés"
pass "au plus 48 points transportés, quelle que soit la densité des relevés"

# Quatre relevés d'affilée tiennent dans un seul intervalle : ça ne prouve pas
# qu'une COURBE se lit. On en fabrique une, sur 24 h, marquée pour être retirée
# tout de suite après : un disque qui monte de 16 % à 85 % en une journée.
psql_q "insert into target_metric_samples
          (target_id, sampled_at, source, reachable, error, disk_percent, memory_percent, load_percent)
        select '$TARGET_ID',
               now() - interval '1 minute' - ((n - 1) * 60 || ' minutes')::interval,
               'sweep', true, '$FAKE_MARK', 85 - (n - 1) * 3, 40, 25
          from generate_series(1, 24) as n;" >/dev/null

req GET "/api/targets/$TARGET_ID/metrics/history?hours=24&buckets=48" >/dev/null
CURVE_POINTS=$(jq -r '.points | length' "$BODY")
CURVE_WORST=$(jq -r '.summary.disk.worst' "$BODY")
CURVE_TREND=$(jq -r '.summary.disk.trend' "$BODY")
CURVE_FIRST=$(jq -r '[.points[] | select(.diskPercent != null)] | .[0].diskPercent' "$BODY")

[ "$CURVE_POINTS" -ge 20 ] || fail "une journée de relevés horaires devrait faire ≥ 20 points, il y en a $CURVE_POINTS"
awk -v w="$CURVE_WORST" 'BEGIN { exit !(w > 84.9 && w < 85.1) }' \
  || fail "le pire relevé de la fenêtre devrait être 85 %, il vaut $CURVE_WORST"
awk -v t="$CURVE_TREND" 'BEGIN { exit !(t > 60) }' \
  || fail "la tendance devrait être franchement montante, elle vaut $CURVE_TREND"
pass "courbe sur 24 h : $CURVE_POINTS points, de $CURVE_FIRST % à $CURVE_WORST % — tendance +$CURVE_TREND pt"
info "c'est exactement la question à laquelle un chiffre seul ne répond pas :"
info "85 % après une semaine à 85 %, ou 85 % après une journée à 16 % ?"

psql_q "delete from target_metric_samples where error = '$FAKE_MARK';" >/dev/null
req GET "/api/targets/$TARGET_ID/metrics/history?hours=24&buckets=48" >/dev/null
BACK_WORST=$(jq -r '.summary.disk.worst' "$BODY")
awk -v w="$BACK_WORST" 'BEGIN { exit !(w < 84) }' \
  || fail "les relevés fabriqués n'ont pas été retirés (pire encore à $BACK_WORST %)"
pass "relevés fabriqués retirés — la fenêtre retombe à $BACK_WORST %, la mesure réelle"

step "5. Les trois couches de seuils"
code=$(req GET /api/supervision/thresholds)
[ "$code" = "200" ] || fail "GET /api/supervision/thresholds → HTTP $code"
CATALOG=$(jq -r '[.catalog[] | "\(.metric)=\(.defaultLimitPercent)%/\(.defaultBreachSamples)"] | join(" ")' "$BODY")
pass "catalogue servi : $CATALOG"
jq -e '[.catalog[] | select(.metric == "disk")] | .[0].defaultBreachSamples == 1' "$BODY" >/dev/null \
  || fail "le disque devrait ouvrir dès le premier relevé"
jq -e '[.catalog[] | select(.metric == "load")] | .[0].defaultBreachSamples == 3' "$BODY" >/dev/null \
  || fail "la charge devrait exiger trois relevés consécutifs"
pass "le nombre de relevés confirmants est propre à la métrique : disque 1, charge 3"

origin_of() {
  req GET "/api/targets/$TARGET_ID/metrics/history?hours=1" >/dev/null
  jq -r '.thresholds.disk | "\(.origin)@\(.limitPercent)"' "$BODY"
}

[ "$(origin_of)" = "default@90" ] || fail "sans réglage, le seuil devrait être « default@90 », il est « $(origin_of) »"
pass "aucun réglage → le catalogue s'applique : default@90"

code=$(req PUT /api/supervision/thresholds '{"targetId":null,"metric":"disk","limitPercent":80}')
[ "$code" = "200" ] || fail "PUT seuil global → HTTP $code : $(cat "$BODY")"
[ "$(origin_of)" = "global@80" ] || fail "le défaut d'instance ne s'applique pas : « $(origin_of) »"
pass "un défaut d'instance → global@80, il écrase le catalogue"

set_disk_limit 70
[ "$(origin_of)" = "target@70" ] || fail "le seuil de la machine ne s'applique pas : « $(origin_of) »"
pass "un seuil de machine → target@70, il écrase le défaut d'instance"

# Deux lignes globales pour la même métrique : impossible, par index unique
# partiel. Sans lui, `unique(target_id, metric)` les laisserait passer — deux
# NULL ne sont jamais égaux en SQL.
DUP=$(psql_q "insert into target_metric_thresholds (target_id, metric, limit_percent)
              values (null, 'disk', 55);" 2>&1 || true)
printf '%s' "$DUP" | grep -qi 'duplicate key\|unique' \
  || fail "une seconde ligne globale a été acceptée : $DUP"
pass "un second défaut d'instance est refusé par la base : $(printf '%s' "$DUP" | head -1 | cut -c1-90)"

code=$(req DELETE "/api/supervision/thresholds?targetId=$TARGET_ID&metric=disk")
[ "$code" = "200" ] || fail "DELETE seuil machine → HTTP $code"
[ "$(origin_of)" = "global@80" ] || fail "retirer le seuil machine devrait rendre la main au global"
pass "retirer le seuil de la machine rend la main à la couche du dessous"

code=$(req DELETE "/api/supervision/thresholds?metric=disk")
[ "$code" = "200" ] || fail "DELETE seuil global → HTTP $code"
[ "$(origin_of)" = "default@90" ] || fail "retirer le global devrait rendre la main au catalogue"
pass "retirer le défaut d'instance rend la main au catalogue"

step "6. Un seuil NON franchi ne produit aucune entrée d'audit"
OVER=$(awk -v d="$DISK_NOW" 'BEGIN { printf "%d", d + 5 }')
set_disk_limit "$OVER"
info "disque mesuré : $DISK_NOW % — seuil posé volontairement au-dessus : $OVER %"

A0=$(audit_count 'target.threshold.breached' 'disk')
for _ in 1 2 3; do probe; done
A1=$(audit_count 'target.threshold.breached' 'disk')
[ "$A1" = "$A0" ] || fail "3 relevés sous le seuil ont produit $((A1 - A0)) entrée(s)"
OPEN=$(psql_q "select count(*) from target_metric_breaches
                where target_id = '$TARGET_ID' and metric = 'disk' and resolved_at is null;")
[ "$OPEN" = "0" ] || fail "un dépassement est ouvert alors que rien n'a été franchi"
pass "3 relevés à $DISK_NOW % sous un seuil à $OVER % → 0 entrée d'audit, 0 dépassement"

step "7. Un seuil FRANCHI produit exactement UNE entrée — pas une par relevé"
UNDER=$(awk -v d="$DISK_NOW" 'BEGIN { v = d - 5; if (v < 1) v = 1; printf "%d", v }')
set_disk_limit "$UNDER"
info "seuil abaissé sous la mesure : $UNDER % (disque à $DISK_NOW %)"

S0=$(samples_of)
for _ in 1 2 3 4; do probe; done
S1=$(samples_of)
A2=$(audit_count 'target.threshold.breached' 'disk')

[ "$((S1 - S0))" = "4" ] || fail "4 relevés attendus, $((S1 - S0)) écrits"
[ "$((A2 - A1))" = "1" ] \
  || fail "4 relevés au-dessus du seuil ont produit $((A2 - A1)) entrées d'audit — attendu : 1"
pass "4 relevés au-dessus du seuil → 4 lignes de série, et EXACTEMENT 1 entrée d'audit"

BREACH=$(psql_q "select id || '|' || samples || '|' || round(peak_value::numeric,2) || '|' || round(limit_percent::numeric,2)
                   from target_metric_breaches
                  where target_id = '$TARGET_ID' and metric = 'disk' and resolved_at is null;")
[ -n "$BREACH" ] || fail "aucun dépassement ouvert alors que le seuil est franchi"
B_SAMPLES=$(printf '%s' "$BREACH" | cut -d'|' -f2)
B_PEAK=$(printf '%s' "$BREACH" | cut -d'|' -f3)
B_LIMIT=$(printf '%s' "$BREACH" | cut -d'|' -f4)
[ "$B_SAMPLES" = "4" ] \
  || fail "l'épisode devrait avoir suivi les 4 relevés, il en compte $B_SAMPLES"
pass "l'épisode a suivi les 4 relevés sans rien annoncer de plus : samples=$B_SAMPLES, pire=$B_PEAK %"

# Le seuil est RECOPIÉ dans l'épisode : il dit sous quelle règle il a été décidé.
awk -v a="$B_LIMIT" -v b="$UNDER" 'BEGIN { exit !(a == b) }' \
  || fail "l'épisode porte le seuil $B_LIMIT %, il a été ouvert sous $UNDER %"
pass "l'épisode recopie le seuil qui l'a ouvert ($B_LIMIT %) — il ne le relit jamais"

AUDIT=$(psql_q "select after->>'detail' from audit_logs
                 where action = 'target.threshold.breached' and resource_id = '$TARGET_ID'
                   and after->>'metric' = 'disk' order by created_at desc limit 1;")
[ -n "$AUDIT" ] || fail "l'entrée d'audit ne dit rien de lisible"
pass "l'entrée d'audit se lit : « $AUDIT »"
info "action : target.threshold.breached — resource_type « target », resource_id la cible"

step "8. Deux dépassements ouverts sur la même métrique : impossible"
DUP=$(psql_q "insert into target_metric_breaches
                (target_id, metric, limit_percent, opened_value, peak_value, last_value)
              values ('$TARGET_ID', 'disk', 50, 99, 99, 99);" 2>&1 || true)
printf '%s' "$DUP" | grep -qi 'duplicate key\|unique' \
  || fail "un second dépassement ouvert a été accepté : $DUP"
pass "refusé par l'index unique partiel — une contrainte, pas un « if »"

step "9. La règle de franchissement, à nu"
# Le nombre de relevés consécutifs ne se démontre pas en bougeant un seuil :
# les compteurs sont DÉRIVÉS de la série (voir `decideBreach`), donc un seuil
# déplacé s'applique rétroactivement — c'est voulu, et c'est prouvé à l'étape
# suivante. La règle elle-même s'éprouve donc là où elle vit : la fonction pure.
# Le module est chargé par son chemin absolu : le script écrit son fichier
# d'épreuve dans un dossier temporaire, hors de l'arbre, où « @pupitre/db » ne
# se résout pas.
DB_DIST="$REPO_ROOT/packages/db/dist/index.js"
[ -f "$DB_DIST" ] || fail "« $DB_DIST » absent — lancez d'abord « pnpm build:packages »"

cat > "$WORK/rule.mjs" <<NODE
import { decideBreach } from 'file://$DB_DIST';
NODE
cat >> "$WORK/rule.mjs" <<'NODE'

const seuil = (breach, clear) => ({
  metric: 'disk', limitPercent: 90, breachSamples: breach, clearSamples: clear,
  enabled: true, origin: 'default',
});

// [ intitulé, valeurs (la plus récente d'abord), seuil, épisode ouvert ?, verdict attendu ]
const cas = [
  ['disque : un seul relevé au-dessus suffit',        [95],               seuil(1, 2), false, 'open'],
  ['charge : deux relevés ne suffisent pas',          [95, 95],           seuil(3, 3), false, null],
  ['charge : trois d\u2019affilée, et seulement là',      [95, 95, 95],       seuil(3, 3), false, 'open'],
  ['charge : un pic isolé n\u2019ouvre rien',             [95, 50, 95],       seuil(3, 3), false, null],
  ['retour : un relevé sous le seuil ne referme pas', [50],               seuil(1, 2), true,  null],
  ['retour : deux relevés sous le seuil referment',   [50, 50],           seuil(1, 2), true,  'clear'],
  ['pile sur le seuil, ce n\u2019est pas au-dessus',      [90],               seuil(1, 2), false, null],
  ['relevé sans mesure : sauté, pas compté',          [null, 50, null, 50], seuil(1, 2), true, 'clear'],
  ['machine muette : rien ne referme tout seul',      [null, null, null], seuil(1, 2), true,  null],
];

let echecs = 0;
for (const [intitule, valeurs, regle, ouvert, attendu] of cas) {
  const obtenu = decideBreach(valeurs, regle, ouvert);
  const ok = obtenu === attendu;
  if (!ok) echecs += 1;
  console.log(
    `${ok ? 'ok  ' : 'KO  '}${intitule} → ${obtenu === null ? 'rien' : obtenu}` +
      (ok ? '' : ` (attendu ${attendu === null ? 'rien' : attendu})`),
  );
}
process.exit(echecs === 0 ? 0 : 1);
NODE

RULE_OUT=$(node "$WORK/rule.mjs" 2>&1) || fail "la règle de franchissement ne tient pas :
$RULE_OUT"
printf '%s\n' "$RULE_OUT" | while IFS= read -r line; do info "$line"; done
pass "les 9 cas de la règle passent — hystérésis, pic isolé, égalité, relevés muets"

step "10. Le retour sous le seuil produit exactement une entrée, et une seule"
C0=$(audit_count 'target.threshold.cleared' 'disk')
set_disk_limit "$OVER"
info "seuil relevé à $OVER % : la machine repasse sous le seuil sans avoir bougé"

probe
C1=$(audit_count 'target.threshold.cleared' 'disk')
[ "$((C1 - C0))" = "1" ] || fail "le rétablissement a produit $((C1 - C0)) entrées — attendu : 1"
pass "l'épisode se referme et écrit EXACTEMENT 1 entrée « target.threshold.cleared »"
info "remonter un seuil referme tout de suite, sans attendre deux relevés : les compteurs"
info "sont dérivés de la série, donc un réglage s'applique au passé — symétrique du cas"
info "inverse, où baisser un seuil alerte immédiatement au lieu d'attendre un quart d'heure."

RESOLVED=$(psql_q "select count(*) from target_metric_breaches
                    where target_id = '$TARGET_ID' and metric = 'disk' and resolved_at is not null;")
[ "$RESOLVED" -ge 1 ] || fail "l'épisode n'a pas été refermé en base"
DURATION=$(psql_q "select after->>'durationSeconds' from audit_logs
                    where action = 'target.threshold.cleared' and resource_id = '$TARGET_ID'
                      and after->>'metric' = 'disk' order by created_at desc limit 1;")
pass "épisode refermé en base, et l'annonce dit combien de temps il a duré : ${DURATION} s"

probe; probe
C2=$(audit_count 'target.threshold.cleared' 'disk')
[ "$C2" = "$C1" ] || fail "des relevés sous le seuil continuent d'écrire des entrées"
pass "les relevés suivants, toujours sous le seuil, n'écrivent plus rien"

step "11. Le balayage : une tâche répétable BullMQ, pas un cron"
SCHED=$(redis_cli --scan --pattern 'bull:supervision:repeat:*' | sort -u | paste -sd' ' -)
printf '%s' "$SCHED" | grep -q 'target-metrics-sweep' \
  || fail "aucun scheduler « target-metrics-sweep » dans Redis (vu : $SCHED)"
pass "scheduler BullMQ présent : target-metrics-sweep"

EVERY=$(redis_cli HGET 'bull:supervision:repeat:target-metrics-sweep' every)
JOB_NAME=$(redis_cli HGET 'bull:supervision:repeat:target-metrics-sweep' name)
[ "$EVERY" = "60000" ] || fail "cadence du scheduler : $EVERY ms, attendu 60000"
[ "$JOB_NAME" = "target:metrics_sweep" ] \
  || fail "le scheduler enfile « $JOB_NAME », attendu « target:metrics_sweep »"
pass "il enfile « $JOB_NAME » toutes les $EVERY ms — la cadence est dans Redis, pas dans un fichier"

# Aucun cron sur le worker : la décision du projet est tenue.
CRON=$(docker compose exec -T worker sh -lc 'crontab -l 2>&1 || true; ls -1 /etc/cron* 2>&1 || true' || true)
printf '%s' "$CRON" | grep -qi 'target\|metrics\|sweep' \
  && fail "quelque chose ressemblant à un cron parle de relevés : $CRON"
pass "rien dans le cron du worker — BullMQ est la seule horloge"

# Le balayage écrit-il tout seul ? Deux choses distinctes à prouver, et il faut
# les séparer : qu'il TOURNE, et qu'il ÉCRIT.
#
# Qu'il écrive ne se prouve pas en attendant une ligne de plus : une occurrence
# qui ne trouve aucune machine due n'en écrit aucune, et c'est précisément le
# comportement voulu (prouvé juste après). On regarde donc les lignes déjà
# écrites par le balayage, qu'aucun humain n'a demandées.
SWEEP_ROWS=$(psql_q "select count(*) from target_metric_samples where source = 'sweep';")
[ "$SWEEP_ROWS" -ge 1 ] \
  || fail "aucune ligne « sweep » en base — le balayage n'a jamais rien écrit"
SWEEP_LAST=$(psql_q "select to_char(max(sampled_at), 'YYYY-MM-DD HH24:MI:SS')
                       from target_metric_samples where source = 'sweep';")
pass "$SWEEP_ROWS relevés écrits par le balayage, sans que personne les demande (dernier : $SWEEP_LAST)"

# Qu'il TOURNE se lit sur le compteur d'itérations que BullMQ tient sur le
# scheduler lui-même (`ic`). C'est la seule source fiable : la liste des tâches
# terminées est plafonnée à cent entrées, et le balayage des sondes — deux fois
# plus fréquent — l'a déjà remplie.
sweep_iterations() { redis_cli HGET 'bull:supervision:repeat:target-metrics-sweep' ic; }
IC_BEFORE=$(sweep_iterations)
info "itérations du scheduler à cet instant : $IC_BEFORE — attente d'une de plus (≤ 90 s)"
IC_AFTER="$IC_BEFORE"
for _ in $(seq 1 18); do
  sleep 5
  IC_AFTER=$(sweep_iterations)
  [ "$IC_AFTER" -gt "$IC_BEFORE" ] && break
done
[ "$IC_AFTER" -gt "$IC_BEFORE" ] \
  || fail "le compteur d'itérations n'a pas bougé en 90 s — l'horloge ne tourne pas"
pass "l'horloge tourne : itération $IC_BEFORE → $IC_AFTER, sans que personne déclenche rien"

# … et il ne redouble pas une machine relevée à l'instant : la cadence est la
# donnée elle-même (`sampled_at`), pas une colonne d'échéance parallèle.
MINE_BEFORE=$(psql_q "select count(*) from target_metric_samples
                       where target_id = '$TARGET_ID' and source = 'sweep'
                         and sampled_at >= now() - make_interval(secs => $EXPECTED_INTERVAL);")
[ "$MINE_BEFORE" = "0" ] \
  || fail "la cible vient d'être relevée à la main, le balayage l'a pourtant reprise"
pass "la cible relevée à la main n'a pas été reprise par le balayage — pas de doublon"

# Une machine injoignable est enregistrée elle aussi : un trou ne dit pas s'il
# y avait une panne ou pas de superviseur.
DEAD=$(psql_q "select count(*) from target_metric_samples where reachable = false;")
if [ "$DEAD" -gt 0 ]; then
  DEAD_ERR=$(psql_q "select error from target_metric_samples where reachable = false
                      order by sampled_at desc limit 1;")
  pass "les machines injoignables sont enregistrées aussi ($DEAD lignes) : « $(printf '%s' "$DEAD_ERR" | cut -c1-70) »"
else
  info "aucune machine injoignable dans le parc — le chemin n'a pas pu être observé"
fi

step "12. La purge purge"
psql_q "insert into target_metric_samples (target_id, sampled_at, source, reachable, error, disk_percent)
        select '$TARGET_ID', now() - interval '40 days' - (n || ' minutes')::interval,
               'sweep', true, '$FAKE_MARK', 42
          from generate_series(1, 25) as n;" >/dev/null
OLD=$(psql_q "select count(*) from target_metric_samples
               where target_id = '$TARGET_ID' and sampled_at < now() - interval '$EXPECTED_RETENTION days';")
[ "$OLD" = "25" ] || fail "25 vieux relevés attendus, $OLD insérés"
TOTAL_BEFORE=$(samples_of)
BREACHES_BEFORE=$(psql_q "select count(*) from target_metric_breaches where target_id = '$TARGET_ID';")
info "$TOTAL_BEFORE relevés au total, dont $OLD au-delà de la rétention de $EXPECTED_RETENTION jours"

# La purge est limitée à une fois l'heure : on retire son marqueur pour la forcer.
redis_cli DEL 'target:metrics:prune:last' >/dev/null
TOTAL_AFTER="$TOTAL_BEFORE"
for _ in $(seq 1 18); do
  sleep 5
  TOTAL_AFTER=$(samples_of)
  [ "$TOTAL_AFTER" -lt "$TOTAL_BEFORE" ] && break
done
AFTER_OLD=$(psql_q "select count(*) from target_metric_samples
                     where target_id = '$TARGET_ID' and sampled_at < now() - interval '$EXPECTED_RETENTION days';")
[ "$AFTER_OLD" = "0" ] || fail "la purge a laissé $AFTER_OLD relevés au-delà de la rétention"
REMOVED=$((TOTAL_BEFORE - TOTAL_AFTER))
# Le balayage peut avoir ajouté une ligne entre-temps : on vérifie que ce sont
# bien les 25 vieilles qui sont parties, pas un compte exact au relevé près.
[ "$REMOVED" -ge 24 ] && [ "$REMOVED" -le 25 ] \
  || fail "la purge a retiré $REMOVED lignes, attendu 25 (± un relevé concurrent)"
pass "purge : $TOTAL_BEFORE → $TOTAL_AFTER relevés — exactement les 25 au-delà de $EXPECTED_RETENTION jours"

BREACHES_AFTER=$(psql_q "select count(*) from target_metric_breaches where target_id = '$TARGET_ID';")
[ "$BREACHES_AFTER" = "$BREACHES_BEFORE" ] \
  || fail "la purge a emporté des dépassements : $BREACHES_BEFORE → $BREACHES_AFTER"
pass "les dépassements survivent à la purge ($BREACHES_AFTER conservés) — ils racontent l'histoire"

step "13. RBAC"
req DELETE "/api/admin/roles/$BLIND_ROLE" >/dev/null 2>&1 || true
req DELETE "/api/admin/roles/$READER_ROLE" >/dev/null 2>&1 || true

code=$(req POST /api/admin/roles \
  "{\"key\":\"$BLIND_ROLE\",\"label\":\"Histo sans cible\",\"permissions\":[\"deployment:read\"]}")
[ "$code" = "201" ] || fail "POST rôle aveugle → HTTP $code : $(cat "$BODY")"
code=$(req POST /api/admin/roles \
  "{\"key\":\"$READER_ROLE\",\"label\":\"Histo lecteur\",\"permissions\":[\"deployment:read\",\"target:read\"]}")
[ "$code" = "201" ] || fail "POST rôle lecteur → HTTP $code : $(cat "$BODY")"
pass "deux rôles : l'un sans « target:read », l'autre avec mais sans « target:update »"

for pair in "$BLIND_EMAIL|$BLIND_ROLE" "$READER_EMAIL|$READER_ROLE"; do
  email="${pair%%|*}"; role="${pair#*|}"
  code=$(req POST /api/admin/users \
    "{\"name\":\"$role\",\"email\":\"$email\",\"password\":\"$PASSWORD\",\"role\":\"$role\"}")
  case "$code" in 201|409) ;; *) fail "POST /api/admin/users ($email) → HTTP $code : $(cat "$BODY")" ;; esac
done
BLIND_ID=$(psql_q "select id from users where email = '$BLIND_EMAIL';")
READER_ID=$(psql_q "select id from users where email = '$READER_EMAIL';")

code=$(req POST /api/auth/sign-in/email "{\"email\":\"$BLIND_EMAIL\",\"password\":\"$PASSWORD\"}" "$BLIND_JAR")
[ "$code" = "200" ] || fail "connexion aveugle → HTTP $code"
code=$(req GET "/api/targets/$TARGET_ID/metrics/history" '' "$BLIND_JAR")
[ "$code" = "403" ] || fail "historique sans target:read : attendu 403, reçu $code"
jq -e '.error.details.permission == "target:read"' "$BODY" >/dev/null \
  || fail "le refus ne nomme pas la permission : $(cat "$BODY")"
pass "historique sans « target:read » → 403, permission nommée"

DENIED=$(psql_q "select count(*) from audit_logs where action = 'permission.denied'
                  and resource_id = 'target:read' and actor_id = '$BLIND_ID';")
[ "$DENIED" -ge 1 ] || fail "le refus n'a pas été journalisé"
pass "refus tracé au journal d'audit ($DENIED ligne(s))"

code=$(req POST /api/auth/sign-in/email "{\"email\":\"$READER_EMAIL\",\"password\":\"$PASSWORD\"}" "$READER_JAR")
[ "$code" = "200" ] || fail "connexion lecteur → HTTP $code"
code=$(req GET "/api/targets/$TARGET_ID/metrics/history" '' "$READER_JAR")
[ "$code" = "200" ] || fail "historique avec target:read → HTTP $code"
pass "avec « target:read », l'historique se lit ($(jq -r '.samples' "$BODY") relevés)"

code=$(req PUT /api/supervision/thresholds \
  "{\"targetId\":\"$TARGET_ID\",\"metric\":\"disk\",\"limitPercent\":50}" "$READER_JAR")
[ "$code" = "403" ] || fail "réglage sans target:update : attendu 403, reçu $code"
jq -e '.error.details.permission == "target:update"' "$BODY" >/dev/null \
  || fail "le refus ne nomme pas « target:update » : $(cat "$BODY")"
pass "régler un seuil sans « target:update » → 403, permission nommée"

# Et le seuil n'a pas bougé : un refus qui écrirait quand même serait pire que tout.
STILL=$(psql_q "select round(limit_percent::numeric) from target_metric_thresholds
                 where target_id = '$TARGET_ID' and metric = 'disk';")
[ "$STILL" = "$OVER" ] || fail "le seuil a changé malgré le refus : $STILL % au lieu de $OVER %"
pass "le seuil est resté à $STILL % — le refus n'a rien écrit"

step "14. Ménage"
for id in "$BLIND_ID" "$READER_ID"; do
  [ -n "$id" ] && req DELETE "/api/admin/users/$id" >/dev/null
done
req DELETE "/api/admin/roles/$BLIND_ROLE" >/dev/null
req DELETE "/api/admin/roles/$READER_ROLE" >/dev/null
pass "utilisateurs et rôles de test supprimés"

psql_q "delete from target_metric_thresholds
          where target_id = '$TARGET_ID' or (target_id is null and metric = 'disk');
        delete from target_metric_breaches where target_id = '$TARGET_ID';
        delete from target_metric_samples where error = '$FAKE_MARK';" >/dev/null
TARGET_ID=''
pass "seuils, dépassements et faux relevés du test retirés"
info "les relevés réels, eux, sont conservés : ils sont l'historique de la machine"

printf '\n\033[32m✓ La supervision des serveurs a une mémoire.\033[0m\n'
printf '\033[2m  Écran : %s/apps — journal : %s/admin/audit\033[0m\n\n' "$BASE_URL" "$BASE_URL"
