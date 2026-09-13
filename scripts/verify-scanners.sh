#!/usr/bin/env bash
#
# Scanners de sécurité : la politique de blocage décide, pas le scanner choisi.
#
#   1. Trivy coché, failOn=CRITICAL   → le déploiement est bloqué à l'étape « scan »
#   2. Trivy DÉCOCHÉ, Grype coché     → même verdict de blocage
#   3. failOn=NONE                    → le déploiement passe, les findings restent visibles
#   4. Syft seul                      → aucun blocage possible, SBOM téléchargeable
#
# L'image `nginx:1.20.0` est volontairement ancienne : quarante et quelques
# vulnérabilités critiques, et un serveur qui répond en HTTP — il faut les deux,
# sinon le point 3 échouerait au healthcheck pour une raison sans rapport.
#
# Le script emprunte exactement les mêmes routes que l'UI. Prérequis :
# une cible Docker déployable — `./scripts/setup-test-target.sh` en provisionne une.
#
# Usage :
#   ./scripts/verify-scanners.sh
#   BASE_URL=http://localhost:3100 TARGET_NAME=ma-vm ./scripts/verify-scanners.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
TARGET_NAME="${TARGET_NAME:-cible-de-verification}"
SPEC="${SPEC:-scripts/fixtures/vulnerable.json}"
CLIENT_IP="${CLIENT_IP:-198.51.100.42}"
# Le premier scan d'une cible neuve télécharge les binaires puis les bases de
# vulnérabilités : plusieurs minutes, une seule fois.
DEPLOY_TIMEOUT="${DEPLOY_TIMEOUT:-900}"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
BODY="$WORK/body.json"
trap 'rm -rf "$WORK"' EXIT

command -v jq >/dev/null || { echo "jq est requis"; exit 1; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
# Sur stderr : `deploy()` est appelée en substitution de commande, et un message
# d'échec écrit sur stdout finirait capturé dans une variable au lieu d'être lu.
fail() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
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

# Better Auth limite les connexions répétées depuis une même IP. Les scripts de
# vérification s'enchaînent : on patiente plutôt que de retomber par erreur sur
# l'inscription, qui donnerait un message trompeur.
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
  printf '      2. ou promouvez ce compte depuis %s/admin/users\n' "$BASE_URL"
  exit 1
}

# Enfile un déploiement avec la politique de scan demandée, puis attend son
# état terminal. Écrit l'identifiant sur stdout, les traces sur stderr.
deploy() {
  local scanners="$1" fail_on="$2" code deploy_id status waited=0

  code=$(req POST /api/deployments "$(jq -nc \
    --arg app "$APP_ID" --arg target "$TARGET_ID" \
    --argjson scanners "$scanners" --arg failOn "$fail_on" \
    '{applicationId:$app, targetId:$target, runtime:"docker", proxy:"traefik",
      scanConfig:{scanners:$scanners, failOn:$failOn}}')")
  [ "$code" = "202" ] || fail "POST /api/deployments → HTTP $code : $(cat "$BODY")"

  deploy_id=$(jq -r .id "$BODY")
  info "déploiement $deploy_id — scanners $scanners, failOn $fail_on" >&2

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

# Recharge $BODY avec le déploiement complet.
fetch_deployment() {
  local code
  code=$(req GET "/api/deployments/$1")
  [ "$code" = "200" ] || fail "GET /api/deployments/$1 → HTTP $code"
}

step_status() {
  jq -r --arg k "$2" '.steps[] | select(.key == $k) | .status' "$1"
}

step "1. Connexion"
login
pass "connecté en tant que $ADMIN_EMAIL"

step "2. Application volontairement vulnérable ($SPEC)"
SLUG=$(jq -r .name "$SPEC")
IMAGE=$(jq -r '.services[0].source.ref' "$SPEC")
req GET /api/applications >/dev/null
APP_ID=$(jq -r --arg s "$SLUG" '.items[] | select(.slug == $s) | .id' "$BODY")

if [ -n "$APP_ID" ]; then
  pass "application « $SLUG » déjà présente"
else
  jq '{appSpec: .}' "$SPEC" > "$WORK/app.json"
  code=$(req POST /api/applications "@$WORK/app.json")
  [ "$code" = "201" ] || fail "POST /api/applications → HTTP $code : $(cat "$BODY")"
  APP_ID=$(jq -r .id "$BODY")
  pass "application créée : $SLUG"
fi
info "image analysée : $IMAGE"

step "3. Cible Docker"
req GET /api/targets >/dev/null
TARGET_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY")
[ -n "$TARGET_ID" ] || fail "cible « $TARGET_NAME » introuvable — lancez ./scripts/setup-test-target.sh"
jq -e --arg n "$TARGET_NAME" \
  '.items[] | select(.name == $n) | .runtimesAvailable.docker.available == true' "$BODY" >/dev/null \
  || fail "la cible « $TARGET_NAME » n'a pas de runtime Docker — lancez un preflight"
pass "$TARGET_NAME prête"

# ─── 1. Trivy + failOn CRITICAL ───────────────────────────────────────────────

step "4. Trivy coché, seuil CRITICAL — le déploiement doit être bloqué"
D1=$(deploy '["trivy"]' CRITICAL)
fetch_deployment "$D1"

[ "$(jq -r .status "$BODY")" = "failed" ] \
  || fail "attendu « failed », reçu « $(jq -r .status "$BODY") »"
[ "$(jq -r .failedStep "$BODY")" = "scan" ] \
  || fail "le pipeline devait s'arrêter sur « scan », il s'est arrêté sur « $(jq -r .failedStep "$BODY") »"
pass "déploiement bloqué à l'étape « scan »"

[ "$(step_status "$BODY" scan)" = "failed" ] || fail "l'étape « scan » n'est pas en échec"
[ "$(step_status "$BODY" deploy)" = "skipped" ] \
  || fail "l'étape « deploy » aurait dû être sautée : $(step_status "$BODY" deploy)"
pass "le déploiement n'a pas eu lieu — « deploy » est skipped"
info "$(jq -r '.error' "$BODY" | head -c 160)"

code=$(req GET "/api/deployments/$D1/scans")
[ "$code" = "200" ] || fail "GET /api/deployments/$D1/scans → HTTP $code"
jq -e '[.items[] | select(.scanner == "trivy")] | length == 1' "$BODY" >/dev/null \
  || fail "un seul scan Trivy attendu : $(jq -c '[.items[].scanner]' "$BODY")"
jq -e '.items[0].verdict == "fail"' "$BODY" >/dev/null \
  || fail "verdict attendu « fail », reçu « $(jq -r .items[0].verdict "$BODY") »"
CRIT1=$(jq -r '.items[0].counts.CRITICAL' "$BODY")
[ "$CRIT1" -gt 0 ] || fail "aucune vulnérabilité CRITICAL rapportée par Trivy"
SCAN1=$(jq -r '.items[0].id' "$BODY")
pass "Trivy : verdict « fail », $CRIT1 CRITICAL"
info "$(jq -rc '.items[0].counts' "$BODY")"

# ─── 2. Trivy décoché, Grype coché ────────────────────────────────────────────

step "5. Trivy DÉCOCHÉ, Grype coché — même verdict de blocage"
D2=$(deploy '["grype"]' CRITICAL)
fetch_deployment "$D2"

[ "$(jq -r .failedStep "$BODY")" = "scan" ] \
  || fail "le pipeline devait s'arrêter sur « scan » : $(jq -c '[.steps[]|{key,status}]' "$BODY")"
pass "déploiement bloqué à l'étape « scan », sans Trivy"

req GET "/api/deployments/$D2/scans" >/dev/null
jq -e '[.items[].scanner] == ["grype"]' "$BODY" >/dev/null \
  || fail "Trivy ne devait pas tourner : $(jq -c '[.items[].scanner]' "$BODY")"
jq -e '.items[0].verdict == "fail"' "$BODY" >/dev/null || fail "Grype n'a pas bloqué"
SCAN2=$(jq -r '.items[0].id' "$BODY")
CRIT2=$(jq -r '.items[0].counts.CRITICAL' "$BODY")
[ "$CRIT2" -gt 0 ] || fail "aucune vulnérabilité CRITICAL rapportée par Grype"
pass "Grype seul : verdict « fail », $CRIT2 CRITICAL"

# Les deux scanners parlent la même langue : la CVE la plus grave vue par l'un
# doit se retrouver chez l'autre, avec la même sévérité et le même paquet.
req GET "/api/scans/$SCAN1?severity=CRITICAL&pageSize=200" >/dev/null
jq -r '.findings.items[] | "\(.cveId)|\(.package)|\(.severity)"' "$BODY" | sort > "$WORK/trivy.txt"
req GET "/api/scans/$SCAN2?severity=CRITICAL&pageSize=200" >/dev/null
jq -r '.findings.items[] | "\(.cveId)|\(.package)|\(.severity)"' "$BODY" | sort > "$WORK/grype.txt"

COMMON=$(comm -12 "$WORK/trivy.txt" "$WORK/grype.txt" | wc -l | tr -d ' ')
[ "$COMMON" -gt 0 ] || {
  info "Trivy : $(head -3 "$WORK/trivy.txt" | tr '\n' ' ')"
  info "Grype : $(head -3 "$WORK/grype.txt" | tr '\n' ' ')"
  fail "aucune CVE critique décrite à l'identique par les deux scanners"
}
pass "$COMMON CVE critique(s) décrites à l'identique — CVE, paquet et sévérité"

# ─── 3. failOn NONE ───────────────────────────────────────────────────────────

step "6. Mêmes scanners, seuil NONE — le déploiement doit passer"
D3=$(deploy '["trivy","grype"]' NONE)
fetch_deployment "$D3"

[ "$(jq -r .status "$BODY")" = "success" ] \
  || fail "attendu « success », reçu « $(jq -r .status "$BODY") » ($(jq -r '.error // ""' "$BODY" | head -c 200))"
[ "$(step_status "$BODY" scan)" = "success" ] || fail "l'étape « scan » aurait dû réussir"
pass "déploiement réussi malgré les vulnérabilités"

URL=$(jq -r '.url // empty' "$BODY")
PORT=$(jq -r '.publishedPort // empty' "$BODY")
PROBE="${PROBE_URL:-http://127.0.0.1:$PORT}"
http=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$PROBE" || echo 000)
[ "$http" = "200" ] || fail "$PROBE → HTTP $http"
pass "$PROBE → HTTP 200 ($URL)"

req GET "/api/deployments/$D3/scans" >/dev/null
jq -e '[.items[] | select(.verdict != "pass")] | length == 0' "$BODY" >/dev/null \
  || fail "avec NONE, aucun verdict ne doit être « fail » : $(jq -c '[.items[]|{scanner,verdict}]' "$BODY")"
TOTAL3=$(jq '[.items[].total] | add' "$BODY")
[ "$TOTAL3" -gt 0 ] || fail "les findings devraient rester visibles même sans blocage"
pass "verdict informatif, $TOTAL3 finding(s) tout de même enregistrés"

# La vue transverse voit ce déploiement.
code=$(req GET "/api/findings?deploymentId=$D3&severity=CRITICAL&pageSize=5")
[ "$code" = "200" ] || fail "GET /api/findings → HTTP $code"
jq -e '.total > 0' "$BODY" >/dev/null || fail "GET /api/findings ne remonte rien pour ce déploiement"
pass "GET /api/findings : $(jq -r .total "$BODY") CVE critique(s), filtre par déploiement et sévérité"
info "$(jq -rc '.items[0] | {cveId, severity, package, fixedVersion}' "$BODY")"

# ─── 4. Syft seul ─────────────────────────────────────────────────────────────

step "7. Syft seul, seuil CRITICAL — aucun blocage possible, SBOM téléchargeable"
D4=$(deploy '["syft"]' CRITICAL)
fetch_deployment "$D4"

[ "$(jq -r .status "$BODY")" = "success" ] \
  || fail "un SBOM ne doit jamais bloquer : reçu « $(jq -r .status "$BODY") » ($(jq -r '.error // ""' "$BODY" | head -c 200))"
pass "déploiement réussi — un inventaire ne prononce aucun verdict de blocage"

req GET "/api/deployments/$D4/scans" >/dev/null
jq -e '[.items[].scanner] == ["syft"]' "$BODY" >/dev/null \
  || fail "seul Syft devait tourner : $(jq -c '[.items[].scanner]' "$BODY")"
jq -e '.items[0].kind == "sbom" and .items[0].verdict == "pass" and .items[0].total == 0' "$BODY" >/dev/null \
  || fail "un SBOM ne produit aucun finding : $(jq -c '.items[0]' "$BODY")"
SBOM_ID=$(jq -r '.items[0].id' "$BODY")
jq -e '.items[0].hasSbom == true' "$BODY" >/dev/null || fail "le SBOM n'est pas signalé téléchargeable"
pass "Syft : kind « sbom », aucun finding, verdict « pass »"

code=$(curl -s -o "$WORK/sbom.json" -w '%{http_code}' -b "$JAR" "$BASE_URL/api/scans/$SBOM_ID/sbom")
[ "$code" = "200" ] || fail "GET /api/scans/$SBOM_ID/sbom → HTTP $code"
jq -e '.bomFormat == "CycloneDX" and (.components | length) > 0' "$WORK/sbom.json" >/dev/null \
  || fail "le document téléchargé n'est pas un CycloneDX exploitable"
pass "SBOM téléchargé — $(jq -r '.components | length' "$WORK/sbom.json") composants, $(wc -c < "$WORK/sbom.json" | tr -d ' ') octets"

# Un scanner de vulnérabilités n'a pas de SBOM à offrir : la route doit le dire.
code=$(req GET "/api/scans/$SCAN1/sbom")
[ "$code" = "409" ] || fail "un scan Trivy ne doit pas servir de SBOM (HTTP $code)"
pass "GET /api/scans/<scan Trivy>/sbom → 409, comme attendu"

# ─── 5. Traçabilité ───────────────────────────────────────────────────────────

step "8. Traçabilité"
code=$(req GET "/api/audit-logs?resourceType=deployment&pageSize=100")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"

jq -e --arg id "$D1" \
  '[.items[] | select(.action == "deployment.scan.blocked" and .resourceId == $id)] | length > 0' \
  "$BODY" >/dev/null || fail "« deployment.scan.blocked » absent du journal pour $D1"
pass "audit : deployment.scan.blocked (Trivy, CRITICAL)"

jq -e --arg id "$D3" \
  '[.items[] | select(.action == "deployment.scan.passed" and .resourceId == $id)] | length > 0' \
  "$BODY" >/dev/null || fail "« deployment.scan.passed » absent du journal pour $D3"
pass "audit : deployment.scan.passed (seuil NONE)"

jq -e --arg id "$D1" \
  '[.items[] | select(.action == "deployment.scan.blocked" and .resourceId == $id)][0].after.blocking | length > 0' \
  "$BODY" >/dev/null || fail "le journal ne retient aucun finding bloquant"
pass "audit : les CVE qui ont bloqué sont nommées"
info "$(jq -rc --arg id "$D1" '[.items[] | select(.action == "deployment.scan.blocked" and .resourceId == $id)][0].after | {scanners, failOn, blockingTotal}' "$BODY")"

printf '\n\033[32m✓ Scanners et politique de blocage vérifiés.\033[0m\n'
printf '\033[2m  Bloqué par Trivy : %s/deployments/%s\033[0m\n' "$BASE_URL" "$D1"
printf '\033[2m  Bloqué par Grype : %s/deployments/%s\033[0m\n' "$BASE_URL" "$D2"
printf '\033[2m  Passé (NONE)     : %s/deployments/%s\033[0m\n' "$BASE_URL" "$D3"
printf '\033[2m  SBOM (Syft)      : %s/deployments/%s\033[0m\n' "$BASE_URL" "$D4"
printf '\n'
