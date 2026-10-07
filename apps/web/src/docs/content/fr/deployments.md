# Déploiements

Un déploiement est une exécution du pipeline : une application, une cible, un runtime, une version. Ce chapitre couvre son lancement, chaque étape du pipeline, son suivi, la vérification de santé, le retour en arrière, les versions, et les trois façons de se défaire d’un déploiement.

## Lancer un déploiement

Depuis la fiche de l’application, **Déployer** (`deployment:create`) :

1. choisissez la **cible** et le **runtime** qu’elle propose ;
2. le champ **Domaines** apparaît si la cible a un proxy — le domaine de l’AppSpec est proposé ;
3. le **retour automatique** est coché par défaut — gardez-le ;
4. au premier déploiement, avec `backup:manage` et des volumes, deux cases proposent d’activer les sauvegardes automatiques ;
5. **Déployer** : le tiroir passe au run.

Par l’API — la réponse arrive aussitôt, `202`, avec l’identifiant du déploiement :

```bash
curl --fail-with-body -X POST {{origin}}/api/deployments \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"applicationId":"'"$APP_ID"'","targetId":"'"$TARGET_ID"'","runtime":"docker"}'
```

| Champ du corps | Sens |
|---|---|
| `applicationId`, `targetId`, `runtime` | quoi, où, avec quel runtime — requis |
| `autoRollback` | revenir à la version précédente si la vérification de santé échoue — `true` par défaut |
| `images` | `{ "web": "ghcr.io/acme/web:4f2c1e9" }` — remplace l’image de ces services et l’enregistre dans l’AppSpec ; demande aussi `application:update` |
| `domains` | la liste complète des domaines de l’application sur cette cible, qui remplace l’actuelle |
| `backup` | `{ "enabled": true, "beforeDeploy": true }` à un premier déploiement, avec `backup:manage` |
| `scanConfig` | une politique d’analyse explicite — demande `scan:configure` ; l’instance ne peut que la durcir |

## Le pipeline, étape par étape

Les onze étapes existent dès le départ, `pending` ; chacune passe `running`, puis `success`, `failed` ou `skipped`. Un échec arrête le pipeline et marque la suite `skipped`.

| Étape | Ce qu’elle fait | Ignorée quand |
|---|---|---|
| `preflight` | revérifie la cible — runtime, disque, le chemin depuis le proxy central s’il la sert | jamais |
| `allocate_port` | réserve un port dans la plage de la cible, vérifié libre sur la machine | sur K3s |
| `render` | écrit `compose.yml` et son `.env`, ou les manifestes Kubernetes | jamais |
| `upload` | dépose la release sur la machine, avec le code à construire | jamais |
| `build` | construit les services qui ont un Dockerfile, sur la machine | aucun service à construire |
| `scan` | lance les analyseurs sur les images ; peut bloquer | aucun analyseur choisi |
| `backup` | sauvegarde les volumes avant de toucher à ce qui tourne | pas de politique « avant chaque déploiement », ou premier déploiement |
| `deploy` | démarre la nouvelle version | jamais |
| `healthcheck` | sonde chaque service jusqu’à ce qu’il soit sain, ou abandonne | jamais |
| `proxy` | pose les domaines sur le reverse proxy, puis les sonde | pas de domaine, ou pas de proxy |
| `rollback` | remet la version précédente | le déploiement a réussi |

Un domaine qui ne répond pas à l’étape `proxy` n’annule pas un déploiement sain : la nouvelle version tourne, la route est marquée en échec, et le journal dit pourquoi.

## Suivre un déploiement

Le tiroir du run a trois onglets : **Pipeline** — les étapes et le journal en direct —, **Sécurité** — les résultats d’analyse —, et **AppSpec figée** — exactement ce qui a été déployé. **Déploiements** liste tous les runs, avec des filtres par application, cible, statut et runtime.

| Statut | Sens |
|---|---|
| `pending` | enregistré, en attente du worker |
| `running` | le pipeline se déroule |
| `success` | la nouvelle version est en service |
| `failed` | une étape a échoué ; la version précédente, s’il y en a une, tourne toujours |
| `rolled_back` | la nouvelle version a raté sa vérification de santé et la précédente a été remise |
| `destroyed` | retiré de la machine ; l’enregistrement reste dans l’historique |

Depuis un script, interrogez le statut, puis lisez le journal :

```bash
curl -s {{origin}}/api/deployments/$DEPLOYMENT_ID \
  -H "Authorization: Bearer $PUPITRE_TOKEN" | jq '{status, steps: [.steps[] | {key, status}]}'

curl -s "{{origin}}/api/deployments/$DEPLOYMENT_ID/logs/export?format=text" \
  -H "Authorization: Bearer $PUPITRE_TOKEN" | tail -50
```

`GET /api/deployments/{id}/logs` diffuse le même journal en direct (Server-Sent Events) : l’historique d’abord, puis chaque nouvelle ligne.

## Les issues de la vérification de santé

| Issue | Ce qu’elle signifie |
|---|---|
| `healthy` | le service répond, et répond bien (2xx ou 3xx en HTTP, un port ouvert en TCP) |
| `unhealthy` | il répond, mais mal : il tourne et il est cassé |
| `unreachable` | rien ne répond : conteneur absent, port fermé, pod pas prêt |

Avant d’abandonner, l’étape capture la scène — l’état des conteneurs ou des pods et leurs dernières lignes de journal — et l’écrit dans le journal : le retour en arrière qui suit l’effacerait.

## Le retour automatique

Trois conditions, toutes des données : l’échec est à `healthcheck` (ou à `deploy` avec une version qui n’est jamais devenue saine), `autoRollback` est actif, et une version précédente existe. La release précédente est redémarrée, puis **sa** santé est vérifiée avec **sa propre** AppSpec. Le déploiement finit `rolled_back`, peint en ambre : quelque chose s’est mal passé, et le filet a fonctionné.

Un échec ailleurs — une analyse bloquante, une construction qui échoue — ne fait rien revenir : la version précédente ne s’est jamais arrêtée. Si le retour échoue à son tour, le déploiement finit `failed` et nomme les deux échecs ; il n’y a jamais de seconde tentative.

## Revenir en arrière à la main, ou redéployer une version

| | Revenir en arrière | Redéployer une version |
|---|---|---|
| Geste | **Revenir à la version précédente** sur un run | **Redéployer cette version** dans l’onglet **Versions** |
| Permission | `deployment:rollback` | `deployment:create` |
| Ce qu’il fait | redémarre la release précédente encore présente sur la machine | relance tout le pipeline depuis l’AppSpec figée de cette version |
| Reconstruit, réanalyse | non | oui |
| Où | la même cible | n’importe quelle cible |

```bash
# Revenir en arrière
curl --fail-with-body -X POST {{origin}}/api/deployments/$DEPLOYMENT_ID/rollback \
  -H "Authorization: Bearer $PUPITRE_TOKEN"

# Redéployer la version <versionId> sur une autre cible
curl --fail-with-body -X POST {{origin}}/api/applications/$APP_ID/redeploy \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"versionId":"<deployment id>","targetId":"<target id>"}'
```

## Versions et releases

Chaque déploiement est une **version** : son AppSpec y est figée. Sur la machine, il dépose une **release** dans `apps/{name}/{version}-r{numéro}`, et les images qu’il construit portent le même tag. Les cinq dernières releases sont gardées, plus celle en service ; les images d’une release retirée partent avec elle. Une version construite depuis une archive téléversée ne se redéploie que tant que son archive fait partie des cinq dernières gardées.

## Les analyses dans le pipeline

L’étape `scan` lance en parallèle les analyseurs choisis sur les images sur le point de démarrer. Avec un seuil bloquant, une vulnérabilité à ce niveau ou au-dessus — corrigeable si la politique le demande, et non acceptée — fait échouer l’étape : le déploiement n’a pas lieu, et la version précédente continue de tourner. Voyez [Analyses de sécurité](/docs/security-scans).

## Détruire, purger, débloquer

| Geste | Agit sur | Permission | Effet |
|---|---|---|---|
| **Détruire** | la machine | `deployment:destroy` | conteneurs ou namespace, volumes, fichiers de release, port et domaines retirés ; le run reste, `destroyed` |
| **Purger** | la base | `deployment:purge` | le run, ses étapes et ses analyses effacés ; la machine n’est pas touchée ; le journal d’activité garde la trace |
| **Débloquer** | la base | `deployment:purge` | un run bloqué `pending` ou `running` sans tâche derrière lui passe `failed`, en nommant ce qu’il faut vérifier sur la machine |

Détruire est refusé pour un run en cours ou déjà détruit ; purger, pour un run en service. Une purge en masse prend des critères et un `dryRun` :

```bash
curl --fail-with-body -X POST {{origin}}/api/deployments/purge \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"statuses":["failed","rolled_back"],"olderThanDays":30,"dryRun":true}'
```

`GET /api/deployments/stuck` liste les runs que la base croit en cours alors que la file n’en sait rien — après un plantage du worker, par exemple.
