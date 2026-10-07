# CI/CD

Deploy from your pipeline: the CI builds and pushes an image, or sends the code, then asks Pupitre to deploy and waits for the outcome. This chapter covers preparing the token, validating `pupitre.json`, complete GitHub Actions and GitLab CI pipelines, a reusable script, code upload and rollback.

## Three ways to deliver

| Way | The CI does | Pupitre does |
|---|---|---|
| **An image** | builds, pushes to a registry, calls `POST /api/deployments` with `images` | pulls the image on the target and deploys it |
| **The code** | packs the code, uploads it, then deploys | builds the image on the target |
| **Nothing** | — | follows the linked repository by itself — see [Repositories and code](/docs/repositories) |

The first two suit an application **without** a linked repository: a linked application takes its AppSpec and its code from the repository, and refuses an image change from a CI.

## Prepare

1. **A token** — [My account](/account) → **API tokens** → **New token**: preset **Deploy**, limited to the application the CI deploys, 90 days. A token that leaks into a log can do nothing elsewhere.
2. **The identifiers** — the application's and the target's:

   ```bash
   curl -s {{origin}}/api/applications -H "Authorization: Bearer $PUPITRE_TOKEN" | jq -r '.items[] | "\(.id) \(.slug)"'
   curl -s {{origin}}/api/targets -H "Authorization: Bearer $PUPITRE_TOKEN" | jq -r '.items[] | "\(.id) \(.name)"'
   ```

3. **The CI's settings** — `PUPITRE_URL` (`{{origin}}`), `PUPITRE_APP_ID`, `PUPITRE_TARGET_ID` as variables, `PUPITRE_TOKEN` as a **secret**.
4. **The target can pull the image** — a public image, or, for a private registry, `docker login` done once on the machine as the deployment account (Docker), or `/etc/rancher/k3s/registries.yaml` (K3s).

> [!TIP]
> A token limited to applications cannot list targets. Read the identifiers once with your own session or a read token, then store them in the CI.

## Validate pupitre.json

A step that fails the pipeline when the AppSpec is wrong, before anything is built — the body is the file itself:

```bash
curl --fail-with-body -sS -X POST "$PUPITRE_URL/api/appspec/validate" \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  --data @pupitre.json | jq .valid
```

A `422` prints every problem with its path, and `--fail-with-body` makes the step fail.

## GitHub Actions

`.github/workflows/deploy.yml` — build, push to GitHub's registry, deploy, wait:

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    env:
      PUPITRE_URL: ${{ vars.PUPITRE_URL }}
      PUPITRE_TOKEN: ${{ secrets.PUPITRE_TOKEN }}
      APP_ID: ${{ vars.PUPITRE_APP_ID }}
      TARGET_ID: ${{ vars.PUPITRE_TARGET_ID }}
      IMAGE: ghcr.io/${{ github.repository }}:${{ github.sha }}
    steps:
      - uses: actions/checkout@v4

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: ${{ env.IMAGE }}

      - name: Deploy to Pupitre
        run: ./scripts/pupitre-deploy.sh web "$IMAGE"
```

The script is below; it fails the job if the deployment does not end in `success`.

## GitLab CI

`.gitlab-ci.yml` — the same flow with GitLab's registry:

```yaml
stages: [build, deploy]

build:
  stage: build
  image: docker:27
  services: [docker:27-dind]
  script:
    - docker login -u "$CI_REGISTRY_USER" -p "$CI_REGISTRY_PASSWORD" "$CI_REGISTRY"
    - docker build -t "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA" .
    - docker push "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA"

deploy:
  stage: deploy
  image: alpine:3.22
  needs: [build]
  before_script:
    - apk add --no-cache bash curl jq
  script:
    - ./scripts/pupitre-deploy.sh web "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA"
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
```

`PUPITRE_URL`, `PUPITRE_TOKEN` (masked), `APP_ID` and `TARGET_ID` are set in **Settings → CI/CD → Variables** of the project.

## A reusable deploy script

`scripts/pupitre-deploy.sh` — deploys an image for one service, waits, prints the end of the log on failure:

```bash
#!/usr/bin/env bash
# Usage: pupitre-deploy.sh <service> <image>
# Needs PUPITRE_URL, PUPITRE_TOKEN, APP_ID, TARGET_ID; optional RUNTIME (docker), TIMEOUT (900 s).
set -euo pipefail
service="$1"; image="$2"
runtime="${RUNTIME:-docker}"; timeout="${TIMEOUT:-900}"
api() { curl -sS --fail-with-body -H "Authorization: Bearer $PUPITRE_TOKEN" "$@"; }

body=$(jq -n --arg app "$APP_ID" --arg target "$TARGET_ID" --arg runtime "$runtime" \
  --arg service "$service" --arg image "$image" \
  '{applicationId: $app, targetId: $target, runtime: $runtime, images: {($service): $image}}')
id=$(api -X POST "$PUPITRE_URL/api/deployments" -H "Content-Type: application/json" -d "$body" | jq -r .id)
echo "deployment $id — $PUPITRE_URL/deployments?run=$id"

deadline=$(( $(date +%s) + timeout ))
while :; do
  status=$(api "$PUPITRE_URL/api/deployments/$id" | jq -r .status)
  case "$status" in
    success) echo "deployed"; exit 0 ;;
    pending|running)
      if [ "$(date +%s)" -ge "$deadline" ]; then echo "still $status after ${timeout}s"; exit 1; fi
      sleep 5 ;;
    *) echo "deployment ended: $status"
       api "$PUPITRE_URL/api/deployments/$id/logs/export?format=text" | tail -60
       exit 1 ;;
  esac
done
```

A `rolled_back` status also fails the job: the new version did not pass its healthcheck, and the previous one is back in service.

## Deploy uploaded code

For an application whose service is built from a Dockerfile, without a registry: pack the code, upload it, wait for it to be read, deploy.

```bash
tar czf build.tar.gz --exclude=.git --exclude=node_modules .
archive=$(curl -sS --fail-with-body -X POST "$PUPITRE_URL/api/applications/$APP_ID/archives" \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "x-archive-name: build-$GIT_SHA.tar.gz" \
  --data-binary @build.tar.gz | jq -r .archive.id)

until [ "$(curl -sS "$PUPITRE_URL/api/applications/$APP_ID/archives/$archive" \
  -H "Authorization: Bearer $PUPITRE_TOKEN" | jq -r .status)" != "pending" ]; do sleep 2; done

curl -sS --fail-with-body -X POST "$PUPITRE_URL/api/deployments" \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"applicationId":"'"$APP_ID"'","targetId":"'"$TARGET_ID"'","runtime":"docker"}'
```

The token needs `application:update` to upload and `deployment:create` to deploy — both in the **Deploy** preset. An archive **refused** makes the deployment answer `409` before anything starts.

## Roll back from a CI

```bash
curl -sS --fail-with-body -X POST "$PUPITRE_URL/api/deployments/$DEPLOYMENT_ID/rollback" \
  -H "Authorization: Bearer $PUPITRE_TOKEN"
```

It puts the previous release back on the same target, without rebuilding, and answers `202`: follow it like a deployment.

## Good practices

- **One token per pipeline**, named after it, limited to its applications, with an expiry — the activity log then says "through the token *GitHub CI — shop*".
- **Tag images with the commit** (`:$GITHUB_SHA`), never `:latest`: a version is then a fixed image, and a rollback finds it again.
- **Keep automatic rollback on**: a CI that deploys on every push needs a safety net.
- **Revoke** a token that leaked, from [My account](/account): it is refused at once.
- **Let an agent do it**: the same operations are available to an AI agent through [MCP](/docs/mcp).
