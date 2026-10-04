#!/usr/bin/env bash
#
# Security scanners: the blocking policy decides, not the scanner chosen.
#
#   1. Trivy checked, failOn=CRITICAL   → the deployment is blocked at the "scan" step
#   2. Trivy UNCHECKED, Grype checked   → same blocking verdict
#   3. failOn=NONE                      → the deployment goes through, the findings stay visible
#   4. Syft alone                       → no blocking possible, downloadable SBOM
#
# The `nginx:1.20.0` image is deliberately old: forty-odd critical
# vulnerabilities, and a server that answers over HTTP — both are needed,
# otherwise point 3 would fail at the healthcheck for an unrelated reason.
#
# The script takes exactly the same routes as the UI. Prerequisite: a
# deployable Docker target — `./scripts/setup-test-target.sh` provisions one.
#
# Usage:
#   ./scripts/verify-scanners.sh
#   BASE_URL=http://localhost:3100 TARGET_NAME=my-vm ./scripts/verify-scanners.sh
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-motdepasse-tres-long}"
TARGET_NAME="${TARGET_NAME:-cible-de-verification}"
SPEC="${SPEC:-scripts/fixtures/vulnerable.json}"
CLIENT_IP="${CLIENT_IP:-198.51.100.42}"
# A new target's first scan downloads the binaries then the vulnerability
# databases: several minutes, only once.
DEPLOY_TIMEOUT="${DEPLOY_TIMEOUT:-900}"

WORK="$(mktemp -d)"
JAR="$WORK/admin.jar"
BODY="$WORK/body.json"
trap 'rm -rf "$WORK"' EXIT

command -v jq >/dev/null || { echo "jq is required"; exit 1; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
# On stderr: `deploy()` is called in a command substitution, and a failure
# message written on stdout would end up captured in a variable instead of read.
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

# Better Auth limits repeated sign-ins from the same IP. The verification
# scripts follow one another: we wait rather than fall back by mistake on the
# sign-up, which would give a misleading message.
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
  printf '    The first account created on a blank database becomes administrator;\n'
  printf '    the following ones are mere viewers.\n\n'
  printf '    Two ways out:\n'
  printf '      1. rerun with YOUR admin account:\n'
  printf '         ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=... %s\n' "$0"
  printf '      2. or promote this account from %s/admin/users\n' "$BASE_URL"
  exit 1
}

# Queues a deployment with the requested scan policy, then waits for its
# terminal state. Writes the identifier on stdout, the traces on stderr.
deploy() {
  local scanners="$1" fail_on="$2" code deploy_id status waited=0

  code=$(req POST /api/deployments "$(jq -nc \
    --arg app "$APP_ID" --arg target "$TARGET_ID" \
    --argjson scanners "$scanners" --arg failOn "$fail_on" \
    '{applicationId:$app, targetId:$target, runtime:"docker", proxy:"traefik",
      scanConfig:{scanners:$scanners, failOn:$failOn}}')")
  [ "$code" = "202" ] || fail "POST /api/deployments → HTTP $code: $(cat "$BODY")"

  deploy_id=$(jq -r .id "$BODY")
  info "deployment $deploy_id — scanners $scanners, failOn $fail_on" >&2

  while [ "$waited" -lt "$DEPLOY_TIMEOUT" ]; do
    sleep 5
    waited=$(( waited + 5 ))
    req GET "/api/deployments/$deploy_id" >/dev/null
    status=$(jq -r .status "$BODY")
    case "$status" in
      success|failed|rolled_back|destroyed) printf '%s' "$deploy_id"; return 0 ;;
    esac
  done

  fail "deployment $deploy_id did not complete in ${DEPLOY_TIMEOUT}s (state \"$status\")"
}

# Reloads $BODY with the complete deployment.
fetch_deployment() {
  local code
  code=$(req GET "/api/deployments/$1")
  [ "$code" = "200" ] || fail "GET /api/deployments/$1 → HTTP $code"
}

step_status() {
  jq -r --arg k "$2" '.steps[] | select(.key == $k) | .status' "$1"
}

step "1. Sign-in"
login
pass "signed in as $ADMIN_EMAIL"

step "2. Deliberately vulnerable application ($SPEC)"
SLUG=$(jq -r .name "$SPEC")
IMAGE=$(jq -r '.services[0].source.ref' "$SPEC")
req GET /api/applications >/dev/null
APP_ID=$(jq -r --arg s "$SLUG" '.items[] | select(.slug == $s) | .id' "$BODY")

if [ -n "$APP_ID" ]; then
  pass "application \"$SLUG\" already present"
else
  jq '{appSpec: .}' "$SPEC" > "$WORK/app.json"
  code=$(req POST /api/applications "@$WORK/app.json")
  [ "$code" = "201" ] || fail "POST /api/applications → HTTP $code: $(cat "$BODY")"
  APP_ID=$(jq -r .id "$BODY")
  pass "application created: $SLUG"
fi
info "image analyzed: $IMAGE"

step "3. Docker target"
req GET /api/targets >/dev/null
TARGET_ID=$(jq -r --arg n "$TARGET_NAME" '.items[] | select(.name == $n) | .id' "$BODY")
[ -n "$TARGET_ID" ] || fail "target \"$TARGET_NAME\" not found — run ./scripts/setup-test-target.sh"
jq -e --arg n "$TARGET_NAME" \
  '.items[] | select(.name == $n) | .runtimesAvailable.docker.available == true' "$BODY" >/dev/null \
  || fail "the target \"$TARGET_NAME\" has no Docker runtime — run a preflight"
pass "$TARGET_NAME ready"

# ─── 1. Trivy + failOn CRITICAL ───────────────────────────────────────────────

step "4. Trivy checked, CRITICAL threshold — the deployment must be blocked"
D1=$(deploy '["trivy"]' CRITICAL)
fetch_deployment "$D1"

[ "$(jq -r .status "$BODY")" = "failed" ] \
  || fail "expected \"failed\", got \"$(jq -r .status "$BODY")\""
[ "$(jq -r .failedStep "$BODY")" = "scan" ] \
  || fail "the pipeline was supposed to stop at \"scan\", it stopped at \"$(jq -r .failedStep "$BODY")\""
pass "deployment blocked at the \"scan\" step"

[ "$(step_status "$BODY" scan)" = "failed" ] || fail "the \"scan\" step did not fail"
[ "$(step_status "$BODY" deploy)" = "skipped" ] \
  || fail "the \"deploy\" step should have been skipped: $(step_status "$BODY" deploy)"
pass "the deployment did not take place — \"deploy\" is skipped"
info "$(jq -r '.error' "$BODY" | head -c 160)"

code=$(req GET "/api/deployments/$D1/scans")
[ "$code" = "200" ] || fail "GET /api/deployments/$D1/scans → HTTP $code"
jq -e '[.items[] | select(.scanner == "trivy")] | length == 1' "$BODY" >/dev/null \
  || fail "a single Trivy scan expected: $(jq -c '[.items[].scanner]' "$BODY")"
jq -e '.items[0].verdict == "fail"' "$BODY" >/dev/null \
  || fail "expected verdict \"fail\", got \"$(jq -r .items[0].verdict "$BODY")\""
CRIT1=$(jq -r '.items[0].counts.CRITICAL' "$BODY")
[ "$CRIT1" -gt 0 ] || fail "no CRITICAL vulnerability reported by Trivy"
SCAN1=$(jq -r '.items[0].id' "$BODY")
pass "Trivy: verdict \"fail\", $CRIT1 CRITICAL"
info "$(jq -rc '.items[0].counts' "$BODY")"

# ─── 2. Trivy unchecked, Grype checked ────────────────────────────────────────

step "5. Trivy UNCHECKED, Grype checked — same blocking verdict"
D2=$(deploy '["grype"]' CRITICAL)
fetch_deployment "$D2"

[ "$(jq -r .failedStep "$BODY")" = "scan" ] \
  || fail "the pipeline was supposed to stop at \"scan\": $(jq -c '[.steps[]|{key,status}]' "$BODY")"
pass "deployment blocked at the \"scan\" step, without Trivy"

req GET "/api/deployments/$D2/scans" >/dev/null
jq -e '[.items[].scanner] == ["grype"]' "$BODY" >/dev/null \
  || fail "Trivy was not supposed to run: $(jq -c '[.items[].scanner]' "$BODY")"
jq -e '.items[0].verdict == "fail"' "$BODY" >/dev/null || fail "Grype did not block"
SCAN2=$(jq -r '.items[0].id' "$BODY")
CRIT2=$(jq -r '.items[0].counts.CRITICAL' "$BODY")
[ "$CRIT2" -gt 0 ] || fail "no CRITICAL vulnerability reported by Grype"
pass "Grype alone: verdict \"fail\", $CRIT2 CRITICAL"

# The two scanners speak the same language: the most severe CVE seen by one
# must be found at the other's, with the same severity and the same package.
req GET "/api/scans/$SCAN1?severity=CRITICAL&pageSize=200" >/dev/null
jq -r '.findings.items[] | "\(.cveId)|\(.package)|\(.severity)"' "$BODY" | sort > "$WORK/trivy.txt"
req GET "/api/scans/$SCAN2?severity=CRITICAL&pageSize=200" >/dev/null
jq -r '.findings.items[] | "\(.cveId)|\(.package)|\(.severity)"' "$BODY" | sort > "$WORK/grype.txt"

COMMON=$(comm -12 "$WORK/trivy.txt" "$WORK/grype.txt" | wc -l | tr -d ' ')
[ "$COMMON" -gt 0 ] || {
  info "Trivy: $(head -3 "$WORK/trivy.txt" | tr '\n' ' ')"
  info "Grype: $(head -3 "$WORK/grype.txt" | tr '\n' ' ')"
  fail "no critical CVE described identically by both scanners"
}
pass "$COMMON critical CVE(s) described identically — CVE, package and severity"

# ─── 3. failOn NONE ───────────────────────────────────────────────────────────

step "6. Same scanners, NONE threshold — the deployment must go through"
D3=$(deploy '["trivy","grype"]' NONE)
fetch_deployment "$D3"

[ "$(jq -r .status "$BODY")" = "success" ] \
  || fail "expected \"success\", got \"$(jq -r .status "$BODY")\" ($(jq -r '.error // ""' "$BODY" | head -c 200))"
[ "$(step_status "$BODY" scan)" = "success" ] || fail "the \"scan\" step should have succeeded"
pass "deployment succeeded despite the vulnerabilities"

URL=$(jq -r '.url // empty' "$BODY")
PORT=$(jq -r '.publishedPort // empty' "$BODY")
PROBE="${PROBE_URL:-http://127.0.0.1:$PORT}"
http=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$PROBE" || echo 000)
[ "$http" = "200" ] || fail "$PROBE → HTTP $http"
pass "$PROBE → HTTP 200 ($URL)"

req GET "/api/deployments/$D3/scans" >/dev/null
jq -e '[.items[] | select(.verdict != "pass")] | length == 0' "$BODY" >/dev/null \
  || fail "with NONE, no verdict must be \"fail\": $(jq -c '[.items[]|{scanner,verdict}]' "$BODY")"
TOTAL3=$(jq '[.items[].total] | add' "$BODY")
[ "$TOTAL3" -gt 0 ] || fail "the findings should stay visible even without blocking"
pass "informative verdict, $TOTAL3 finding(s) recorded all the same"

# The cross-cutting view sees this deployment.
code=$(req GET "/api/findings?deploymentId=$D3&severity=CRITICAL&pageSize=5")
[ "$code" = "200" ] || fail "GET /api/findings → HTTP $code"
jq -e '.total > 0' "$BODY" >/dev/null || fail "GET /api/findings brings nothing up for this deployment"
pass "GET /api/findings: $(jq -r .total "$BODY") critical CVE(s), filter by deployment and severity"
info "$(jq -rc '.items[0] | {cveId, severity, package, fixedVersion}' "$BODY")"

# ─── 4. Syft alone ────────────────────────────────────────────────────────────

step "7. Syft alone, CRITICAL threshold — no blocking possible, downloadable SBOM"
D4=$(deploy '["syft"]' CRITICAL)
fetch_deployment "$D4"

[ "$(jq -r .status "$BODY")" = "success" ] \
  || fail "an SBOM must never block: got \"$(jq -r .status "$BODY")\" ($(jq -r '.error // ""' "$BODY" | head -c 200))"
pass "deployment succeeded — an inventory pronounces no blocking verdict"

req GET "/api/deployments/$D4/scans" >/dev/null
jq -e '[.items[].scanner] == ["syft"]' "$BODY" >/dev/null \
  || fail "only Syft was supposed to run: $(jq -c '[.items[].scanner]' "$BODY")"
jq -e '.items[0].kind == "sbom" and .items[0].verdict == "pass" and .items[0].total == 0' "$BODY" >/dev/null \
  || fail "an SBOM produces no finding: $(jq -c '.items[0]' "$BODY")"
SBOM_ID=$(jq -r '.items[0].id' "$BODY")
jq -e '.items[0].hasSbom == true' "$BODY" >/dev/null || fail "the SBOM is not flagged as downloadable"
pass "Syft: kind \"sbom\", no finding, verdict \"pass\""

code=$(curl -s -o "$WORK/sbom.json" -w '%{http_code}' -b "$JAR" "$BASE_URL/api/scans/$SBOM_ID/sbom")
[ "$code" = "200" ] || fail "GET /api/scans/$SBOM_ID/sbom → HTTP $code"
jq -e '.bomFormat == "CycloneDX" and (.components | length) > 0' "$WORK/sbom.json" >/dev/null \
  || fail "the downloaded document is not a usable CycloneDX"
pass "SBOM downloaded — $(jq -r '.components | length' "$WORK/sbom.json") components, $(wc -c < "$WORK/sbom.json" | tr -d ' ') bytes"

# A vulnerability scanner has no SBOM to offer: the route must say so.
code=$(req GET "/api/scans/$SCAN1/sbom")
[ "$code" = "409" ] || fail "a Trivy scan must not serve as an SBOM (HTTP $code)"
pass "GET /api/scans/<Trivy scan>/sbom → 409, as expected"

# ─── 5. Traceability ──────────────────────────────────────────────────────────

step "8. Traceability"
code=$(req GET "/api/audit-logs?resourceType=deployment&pageSize=100")
[ "$code" = "200" ] || fail "GET /api/audit-logs → HTTP $code"

jq -e --arg id "$D1" \
  '[.items[] | select(.action == "deployment.scan.blocked" and .resourceId == $id)] | length > 0' \
  "$BODY" >/dev/null || fail "\"deployment.scan.blocked\" missing from the log for $D1"
pass "audit: deployment.scan.blocked (Trivy, CRITICAL)"

jq -e --arg id "$D3" \
  '[.items[] | select(.action == "deployment.scan.passed" and .resourceId == $id)] | length > 0' \
  "$BODY" >/dev/null || fail "\"deployment.scan.passed\" missing from the log for $D3"
pass "audit: deployment.scan.passed (seuil NONE)"

jq -e --arg id "$D1" \
  '[.items[] | select(.action == "deployment.scan.blocked" and .resourceId == $id)][0].after.blocking | length > 0' \
  "$BODY" >/dev/null || fail "the log keeps no blocking finding"
pass "audit: the CVEs that blocked are named"
info "$(jq -rc --arg id "$D1" '[.items[] | select(.action == "deployment.scan.blocked" and .resourceId == $id)][0].after | {scanners, failOn, blockingTotal}' "$BODY")"

printf '\n\033[32m✓ Scanners and blocking policy verified.\033[0m\n'
printf '\033[2m  Blocked by Trivy: %s/deployments/%s\033[0m\n' "$BASE_URL" "$D1"
printf '\033[2m  Blocked by Grype: %s/deployments/%s\033[0m\n' "$BASE_URL" "$D2"
printf '\033[2m  Passed (NONE)   : %s/deployments/%s\033[0m\n' "$BASE_URL" "$D3"
printf '\033[2m  SBOM (Syft)      : %s/deployments/%s\033[0m\n' "$BASE_URL" "$D4"
printf '\n'
