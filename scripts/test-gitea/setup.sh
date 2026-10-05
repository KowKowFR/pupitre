#!/usr/bin/env bash
#
# Prepares the test Gitea forge: an account, a token, a repository with its
# pupitre.json. Replayable — what already exists is reused.
#
#   docker compose --profile test up -d gitea
#   ./scripts/test-gitea/setup.sh            # writes the token to the output
#
# The `pupitre/bonjour` repository carries a `bonjour-gitea` application built
# from its Dockerfile (busybox httpd, port 8080): enough to try out the link, the
# polling, the build and the commit statuses.
#
set -euo pipefail

GITEA_URL="${GITEA_URL:-http://localhost:3030}"
GITEA_USER="${GITEA_USER:-pupitre}"
GITEA_PASSWORD="${GITEA_PASSWORD:-motdepasse-forge-test}"
REPO="${GITEA_REPO:-bonjour}"
APP_NAME="${GITEA_APP_NAME:-bonjour-gitea}"

api() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o /tmp/gitea-setup.json -w '%{http_code}' -X "$method" "$GITEA_URL/api/v1$path"
              -u "$GITEA_USER:$GITEA_PASSWORD" -H 'content-type: application/json')
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}

# The account, through Gitea's command line: sign-up is closed.
docker compose exec -T -u git gitea gitea admin user create \
  --username "$GITEA_USER" --password "$GITEA_PASSWORD" --email "$GITEA_USER@forge.test" \
  --admin --must-change-password=false >/dev/null 2>&1 || true

# A new token at each pass: Gitea only returns its value at creation.
api DELETE "/users/$GITEA_USER/tokens/pupitre-test" >/dev/null || true
code=$(api POST "/users/$GITEA_USER/tokens" \
  '{"name":"pupitre-test","scopes":["write:repository","read:user"]}')
[ "$code" = "201" ] || { echo "token: HTTP $code $(cat /tmp/gitea-setup.json)" >&2; exit 1; }
TOKEN=$(jq -r .sha1 /tmp/gitea-setup.json)

# The repository and its files.
code=$(api GET "/repos/$GITEA_USER/$REPO")
if [ "$code" = "404" ]; then
  code=$(api POST /user/repos "{\"name\":\"$REPO\",\"private\":true,\"auto_init\":true,\"default_branch\":\"main\"}")
  [ "$code" = "201" ] || { echo "repository: HTTP $code $(cat /tmp/gitea-setup.json)" >&2; exit 1; }
fi

put_file() {
  local path="$1" content="$2" message="$3" sha body code
  code=$(api GET "/repos/$GITEA_USER/$REPO/contents/$path?ref=main")
  sha=""
  [ "$code" = "200" ] && sha=$(jq -r .sha /tmp/gitea-setup.json)
  body=$(jq -n --arg c "$(printf '%s' "$content" | base64 | tr -d '\n')" --arg m "$message" --arg s "$sha" \
    '{content:$c, message:$m, branch:"main"} + (if $s == "" then {} else {sha:$s} end)')
  if [ -n "$sha" ]; then code=$(api PUT "/repos/$GITEA_USER/$REPO/contents/$path" "$body")
  else code=$(api POST "/repos/$GITEA_USER/$REPO/contents/$path" "$body"); fi
  case "$code" in 200|201) ;; *) echo "$path: HTTP $code $(cat /tmp/gitea-setup.json)" >&2; exit 1 ;; esac
}

put_file "pupitre.json" "$(jq -n --arg n "$APP_NAME" '{name:$n, version:"1.0.0", services:[{
  name:"web", source:{type:"dockerfile", context:"app", dockerfile:"Dockerfile"},
  port:8080, exposed:true, healthcheck:{path:"/", intervalSec:3, timeoutSec:3, retries:30}}]}')" \
  "pupitre.json"
put_file "app/Dockerfile" $'FROM busybox:1.37\nCOPY index.html /www/index.html\nEXPOSE 8080\nCMD ["httpd", "-f", "-p", "8080", "-h", "/www"]\n' "Dockerfile"
put_file "app/index.html" $'<h1>bonjour depuis gitea</h1>\n' "page"

printf '%s\n' "$TOKEN"
