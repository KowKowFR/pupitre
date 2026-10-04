#!/usr/bin/env bash
#
# Prépare l'instance GitLab de test : un groupe et son sous-groupe, un projet
# avec son pupitre.json, un jeton de projet. Rejouable — ce qui existe déjà est
# repris.
#
#   docker compose --profile test up -d gitlab   # plusieurs minutes au premier démarrage
#   ./scripts/test-gitlab/setup.sh               # écrit le jeton du projet sur la sortie
#
# Le projet `atelier/web/bonjour` — dans un sous-groupe, comme souvent chez
# GitLab — porte une application `bonjour-gitlab` construite depuis son
# Dockerfile (busybox httpd, port 8080) : de quoi éprouver la liaison, le
# polling, la construction et les statuts de commit.
#
# Le jeton rendu est celui que Pupitre recevrait en vrai : un jeton de projet,
# rôle Maintainer, portée `api` — `main` est protégée, et GitLab n'y accepte un
# statut de commit que de qui peut y pousser. Pour fabriquer tout cela, le script se sert
# d'un jeton d'administration, créé une fois par `gitlab-rails runner` (lent :
# plusieurs minutes sur une petite machine) puis gardé dans le volume de
# configuration de l'instance (`/etc/gitlab/pupitre-admin-token`). Il ne sort
# jamais de la machine ; `verify-source-gitlab.sh` le relit au même endroit.
#
set -euo pipefail

GITLAB_URL="${GITLAB_URL:-http://localhost:3040}"
GROUP="${GITLAB_GROUP:-atelier}"
SUBGROUP="${GITLAB_SUBGROUP:-web}"
PROJECT="${GITLAB_PROJECT:-bonjour}"
APP_NAME="${GITLAB_APP_NAME:-bonjour-gitlab}"
TOKEN_FILE=/etc/gitlab/pupitre-admin-token

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

api() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$OUT" -w '%{http_code}' -X "$method" "$GITLAB_URL/api/v4$path"
              -H "private-token: $ADMIN_TOKEN" -H 'content-type: application/json')
  [ -n "$data" ] && args+=(--data-binary "$data")
  curl "${args[@]}"
}
die() { echo "$1 : HTTP $2 $(cat "$OUT")" >&2; exit 1; }

# ─── Le jeton d'administration ────────────────────────────────────────────────
ADMIN_TOKEN=$(docker compose exec -T gitlab cat "$TOKEN_FILE" 2>/dev/null || true)
if [ -z "$ADMIN_TOKEN" ] || [ "$(api GET /user)" != "200" ]; then
  ADMIN_TOKEN="pupitre-admin-$(openssl rand -hex 16)"
  echo "jeton d'administration : gitlab-rails runner, quelques minutes…" >&2
  docker compose exec -T -e PUPITRE_TOKEN="$ADMIN_TOKEN" gitlab gitlab-rails runner '
    user = User.find_by_username("root")
    user.personal_access_tokens.where(name: "pupitre-setup").each(&:revoke!)
    token = user.personal_access_tokens.build(name: "pupitre-setup", scopes: [:api], expires_at: 300.days.from_now)
    token.organization_id = user.organization_id if token.respond_to?(:organization_id=) && user.respond_to?(:organization_id)
    token.set_token(ENV.fetch("PUPITRE_TOKEN"))
    token.save!
  ' >&2
  printf '%s' "$ADMIN_TOKEN" | docker compose exec -T gitlab sh -c "umask 077 && cat > $TOKEN_FILE"
  [ "$(api GET /user)" = "200" ] || die "jeton d'administration refusé" "$(api GET /user)"
fi

# ─── Le groupe, le sous-groupe, le projet ─────────────────────────────────────
namespace_id() { # chemin complet → id, vide s'il n'existe pas
  local code
  code=$(api GET "/groups/$(jq -rn --arg p "$1" '$p | @uri')")
  [ "$code" = "200" ] && jq -r .id "$OUT" || true
}

GROUP_ID=$(namespace_id "$GROUP")
if [ -z "$GROUP_ID" ]; then
  code=$(api POST /groups "$(jq -n --arg p "$GROUP" '{name:$p, path:$p, visibility:"private"}')")
  [ "$code" = "201" ] || die "groupe $GROUP" "$code"
  GROUP_ID=$(jq -r .id "$OUT")
fi
SUBGROUP_ID=$(namespace_id "$GROUP/$SUBGROUP")
if [ -z "$SUBGROUP_ID" ]; then
  code=$(api POST /groups "$(jq -n --arg p "$SUBGROUP" --argjson parent "$GROUP_ID" \
    '{name:$p, path:$p, parent_id:$parent, visibility:"private"}')")
  [ "$code" = "201" ] || die "sous-groupe $SUBGROUP" "$code"
  SUBGROUP_ID=$(jq -r .id "$OUT")
fi

FULL="$GROUP/$SUBGROUP/$PROJECT"
ENCODED=$(jq -rn --arg p "$FULL" '$p | @uri')
code=$(api GET "/projects/$ENCODED")
if [ "$code" = "404" ]; then
  code=$(api POST /projects "$(jq -n --arg p "$PROJECT" --argjson ns "$SUBGROUP_ID" \
    '{name:$p, path:$p, namespace_id:$ns, visibility:"private", initialize_with_readme:true, default_branch:"main"}')")
  [ "$code" = "201" ] || die "projet $FULL" "$code"
fi

# ─── Ses fichiers, en un commit ───────────────────────────────────────────────
action_for() { # create ou update, selon que le fichier existe sur main
  local code
  code=$(api GET "/projects/$ENCODED/repository/files/$(jq -rn --arg p "$1" '$p | @uri')?ref=main")
  [ "$code" = "200" ] && echo update || echo create
}
SPEC=$(jq -n --arg n "$APP_NAME" '{name:$n, version:"1.0.0", services:[{
  name:"web", source:{type:"dockerfile", context:"app", dockerfile:"Dockerfile"},
  port:8080, exposed:true, healthcheck:{path:"/", intervalSec:3, timeoutSec:3, retries:30}}]}')
DOCKERFILE=$'FROM busybox:1.37\nCOPY index.html /www/index.html\nEXPOSE 8080\nCMD ["httpd", "-f", "-p", "8080", "-h", "/www"]\n'
PAGE=$'<h1>bonjour depuis gitlab</h1>\n'
body=$(jq -n \
  --arg a1 "$(action_for pupitre.json)" --arg spec "$SPEC" \
  --arg a2 "$(action_for app/Dockerfile)" --arg dockerfile "$DOCKERFILE" \
  --arg a3 "$(action_for app/index.html)" --arg page "$PAGE" \
  '{branch:"main", commit_message:"pupitre.json, Dockerfile, page", actions:[
     {action:$a1, file_path:"pupitre.json", content:$spec},
     {action:$a2, file_path:"app/Dockerfile", content:$dockerfile},
     {action:$a3, file_path:"app/index.html", content:$page}]}')
code=$(api POST "/projects/$ENCODED/repository/commits" "$body")
[ "$code" = "201" ] || die "commit des fichiers" "$code"

# ─── Le jeton du projet, neuf à chaque passage ────────────────────────────────
# GitLab ne rend sa valeur qu'à la création : les anciens sont révoqués.
code=$(api GET "/projects/$ENCODED/access_tokens")
[ "$code" = "200" ] || die "jetons du projet" "$code"
for id in $(jq -r '.[] | select(.name == "pupitre-test" and .revoked == false) | .id' "$OUT"); do
  api DELETE "/projects/$ENCODED/access_tokens/$id" >/dev/null
done
code=$(api POST "/projects/$ENCODED/access_tokens" "$(jq -n --arg e "$(date -u -v+30d +%F 2>/dev/null || date -u -d '+30 days' +%F)" \
  '{name:"pupitre-test", scopes:["api"], access_level:40, expires_at:$e}')")
[ "$code" = "201" ] || die "jeton du projet" "$code"
jq -r .token "$OUT"
