# CI/CD

Déployer depuis votre pipeline : la CI construit et pousse une image, ou envoie le code, puis demande à Pupitre de déployer et attend l’issue. Ce chapitre couvre la préparation du jeton, la validation de `pupitre.json`, des pipelines GitHub Actions et GitLab CI complets, un script réutilisable, le téléversement du code et le retour en arrière.

## Trois façons de livrer

| Façon | La CI fait | Pupitre fait |
|---|---|---|
| **Une image** | construit, pousse vers un registre, appelle `POST /api/deployments` avec `images` | tire l’image sur la cible et la déploie |
| **Le code** | emballe le code, le téléverse, puis déploie | construit l’image sur la cible |
| **Rien** | — | suit tout seul le dépôt lié — voyez [Dépôts et code](/docs/repositories) |

Les deux premières conviennent à une application **sans** dépôt lié : une application liée prend son AppSpec et son code dans le dépôt, et refuse qu’une CI change son image.

## Préparer

1. **Un jeton** — [Mon compte](/account) → **Jetons d’API** → **Nouveau jeton** : préréglage **Déployer**, limité à l’application que la CI déploie, 90 jours. Un jeton qui fuit dans un journal ne peut rien faire ailleurs.
2. **Les identifiants** — celui de l’application et celui de la cible :

   ```bash
   curl -s {{origin}}/api/applications -H "Authorization: Bearer $PUPITRE_TOKEN" | jq -r '.items[] | "\(.id) \(.slug)"'
   curl -s {{origin}}/api/targets -H "Authorization: Bearer $PUPITRE_TOKEN" | jq -r '.items[] | "\(.id) \(.name)"'
   ```

3. **Les réglages de la CI** — `PUPITRE_URL` (`{{origin}}`), `PUPITRE_APP_ID`, `PUPITRE_TARGET_ID` en variables, `PUPITRE_TOKEN` en **secret**.
4. **La cible peut tirer l’image** — une image publique, ou, pour un registre privé, un `docker login` fait une fois sur la machine avec le compte de déploiement (Docker), ou `/etc/rancher/k3s/registries.yaml` (K3s).

> [!TIP]
> Un jeton limité à des applications ne peut pas lister les cibles. Lisez les identifiants une fois avec votre propre session ou un jeton de lecture, puis rangez-les dans la CI.

## Valider pupitre.json

Une étape qui fait échouer le pipeline quand l’AppSpec est fausse, avant toute construction — le corps est le fichier lui-même :

```bash
curl --fail-with-body -sS -X POST "$PUPITRE_URL/api/appspec/validate" \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  --data @pupitre.json | jq .valid
```

Un `422` affiche chaque problème avec son chemin, et `--fail-with-body` fait échouer l’étape.

## GitHub Actions

`.github/workflows/deploy.yml` — construire, pousser vers le registre de GitHub, déployer, attendre :

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

Le script est plus bas ; il fait échouer le job si le déploiement ne finit pas en `success`.

## GitLab CI

`.gitlab-ci.yml` — le même enchaînement avec le registre de GitLab :

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

`PUPITRE_URL`, `PUPITRE_TOKEN` (masquée), `APP_ID` et `TARGET_ID` se règlent dans **Settings → CI/CD → Variables** du projet.

## Un script de déploiement réutilisable

`scripts/pupitre-deploy.sh` — déploie une image pour un service, attend, affiche la fin du journal en cas d’échec :

```bash
#!/usr/bin/env bash
# Usage : pupitre-deploy.sh <service> <image>
# Demande PUPITRE_URL, PUPITRE_TOKEN, APP_ID, TARGET_ID ; facultatifs RUNTIME (docker), TIMEOUT (900 s).
set -euo pipefail
service="$1"; image="$2"
runtime="${RUNTIME:-docker}"; timeout="${TIMEOUT:-900}"
api() { curl -sS --fail-with-body -H "Authorization: Bearer $PUPITRE_TOKEN" "$@"; }

body=$(jq -n --arg app "$APP_ID" --arg target "$TARGET_ID" --arg runtime "$runtime" \
  --arg service "$service" --arg image "$image" \
  '{applicationId: $app, targetId: $target, runtime: $runtime, images: {($service): $image}}')
id=$(api -X POST "$PUPITRE_URL/api/deployments" -H "Content-Type: application/json" -d "$body" | jq -r .id)
echo "déploiement $id — $PUPITRE_URL/deployments?run=$id"

deadline=$(( $(date +%s) + timeout ))
while :; do
  status=$(api "$PUPITRE_URL/api/deployments/$id" | jq -r .status)
  case "$status" in
    success) echo "déployé"; exit 0 ;;
    pending|running)
      if [ "$(date +%s)" -ge "$deadline" ]; then echo "toujours $status après ${timeout}s"; exit 1; fi
      sleep 5 ;;
    *) echo "déploiement terminé : $status"
       api "$PUPITRE_URL/api/deployments/$id/logs/export?format=text" | tail -60
       exit 1 ;;
  esac
done
```

Un statut `rolled_back` fait aussi échouer le job : la nouvelle version n’a pas passé sa vérification de santé, et la précédente est de nouveau en service.

## Déployer du code téléversé

Pour une application dont un service se construit depuis un Dockerfile, sans registre : emballez le code, téléversez-le, attendez qu’il soit lu, déployez.

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

Le jeton a besoin de `application:update` pour téléverser et de `deployment:create` pour déployer — les deux sont dans le préréglage **Déployer**. Une archive **refusée** fait répondre le déploiement en `409` avant que rien ne démarre.

## Revenir en arrière depuis une CI

```bash
curl -sS --fail-with-body -X POST "$PUPITRE_URL/api/deployments/$DEPLOYMENT_ID/rollback" \
  -H "Authorization: Bearer $PUPITRE_TOKEN"
```

Il remet la release précédente sur la même cible, sans reconstruire, et répond `202` : suivez-le comme un déploiement.

## Bonnes pratiques

- **Un jeton par pipeline**, nommé d’après lui, limité à ses applications, avec une échéance — le journal d’activité dit alors « par le jeton *CI GitHub — boutique* ».
- **Taguez les images avec le commit** (`:$GITHUB_SHA`), jamais `:latest` : une version est alors une image fixe, et un retour en arrière la retrouve.
- **Gardez le retour automatique** : une CI qui déploie à chaque push a besoin d’un filet.
- **Révoquez** un jeton qui a fui, depuis [Mon compte](/account) : il est refusé aussitôt.
- **Laissez faire un agent** : les mêmes opérations sont à la portée d’un agent IA par [MCP](/docs/mcp).
