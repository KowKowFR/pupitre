# API REST

Tout ce que font les écrans passe par une API REST, et un script, une CI ou un agent IA peut s’en servir aussi, avec un jeton d’API lié à votre compte. Ce chapitre couvre l’authentification, les conventions, les erreurs, des exemples complets, et la référence de chaque route.

## Vue d’ensemble

- **Adresse de base** : `{{origin}}/api` — l’adresse du panel lui-même, `BETTER_AUTH_URL`.
- **JSON** en entrée et en sortie ; les identifiants sont des UUID.
- **Authentification** : `Authorization: Bearer pup_…`, un jeton d’API créé depuis [Mon compte](/account).
- **Les opérations longues répondent `202 Accepted`** aussitôt, et se déroulent en arrière-plan — suivez-les ensuite.
- **Les erreurs** portent un `code` stable et un `message` dans la langue de l’instance.
- **Les permissions** sont celles du jeton, ramenées à chaque appel à ce que son auteur peut encore faire.

## S’authentifier avec un jeton

### Créer un jeton

[Mon compte](/account) → **Jetons d’API** → **Nouveau jeton** :

1. un **nom** qui dit à quoi il sert — le journal d’activité l’affichera (« CI GitHub — boutique », « Agent Claude ») ;
2. une **échéance** : 30 jours, 90 jours (par défaut), un an, ou aucune ;
3. **ce qu’il peut faire**, parmi vos propres permissions ;
4. **sur quelles applications** : toutes, ou seulement certaines ;
5. **Créer le jeton**, puis copiez-le : il n’est montré **qu’une fois**. La base n’en garde qu’une empreinte.

Rangez-le comme un secret — `PUPITRE_TOKEN` dans une CI, une variable d’environnement sur un poste —, jamais dans un dépôt.

### Choisir ce qu’il peut faire

| Choix | Permissions | Pour |
|---|---|---|
| Déployer | `deployment:create`, `deployment:read`, `deployment:rollback`, `application:read`, `application:update` | une CI qui déploie une image et la suit |
| Lire | toutes les permissions `:read` que vous avez | un tableau de bord, un export, un agent en lecture seule |
| Tout ce que je peux faire | toutes vos permissions | un agent IA par MCP, un script d’automatisation |
| Sur mesure | cochées une à une | tout le reste |

Une permission que vous n’avez pas ne peut pas être donnée : la création est refusée, pas réduite en silence. Ensuite, le jeton ne fait jamais plus que vous **aujourd’hui** : un rôle que vous perdez lui retire ce qu’il vous retire, et un compte désactivé le désactive.

### Le limiter à des applications

Un jeton limité à certaines applications n’est accepté que par les routes qui vérifient l’application visée — lire l’application, la déployer, suivre ses déploiements et leurs journaux, revenir en arrière, redéployer une version, téléverser son code. Toute autre route le refuse (`403 token_scope`), même au sujet de sa propre application. Un jeton qui fuite dans le journal d’une CI ne peut alors rien faire ailleurs.

### Ce qu’un jeton ne peut pas faire

- ouvrir l’interface : il n’ouvre que l’API ;
- gérer les jetons, votre compte, votre mot de passe, la messagerie : ces routes répondent `403 token_refused` ;
- passer un second facteur que l’instance exige et que votre compte n’a pas : `403 two_factor_required`.

Révoquez un jeton à tout instant depuis **Mon compte** ; un administrateur voit tous les jetons de l’instance sur **Utilisateurs**.

## Vérifier qui vous êtes

```bash
export PUPITRE_URL={{origin}}
export PUPITRE_TOKEN=pup_…

curl -s "$PUPITRE_URL/api/me" -H "Authorization: Bearer $PUPITRE_TOKEN"
```

```json
{
  "user": { "id": "4b0c…", "email": "ops@example.com", "name": "Ops", "image": null },
  "roles": ["operator"],
  "permissions": ["application:read", "deployment:create", "deployment:read"],
  "twoFactor": { "enabled": true, "required": false, "mustEnroll": false },
  "token": { "id": "9e1f…", "name": "CI GitHub — boutique", "applicationIds": ["2d7a…"] }
}
```

`permissions` est ce que le jeton a vraiment maintenant ; `applicationIds` vaut `null` pour un jeton valable sur toutes les applications.

## Conventions

- **Accepté, puis suivi.** Un déploiement, un préflight, une sauvegarde, une restauration répond `202` avec un identifiant ; interrogez la ressource (`GET /api/deployments/{id}`) ou lisez son journal.
- **Flux en direct.** Quelques routes diffusent des Server-Sent Events — le journal d’un déploiement, les journaux d’une application. Un script lit plutôt la forme exportée (`/logs/export`).
- **Pagination.** Les listes qui peuvent grandir prennent `page` et `pageSize` et répondent `{ items, total, page, pageSize }`.
- **Modifications partielles.** Un `PATCH` ne change que les champs qu’il nomme ; un champ absent est gardé.
- **Les secrets ne reviennent jamais.** Aucune réponse ne porte la valeur d’un secret, une clé SSH ou un jeton — seulement s’il est défini.
- **Langue.** `error.message` suit la langue de l’instance ; `error.code` ne change jamais — testez le code.
- **Origine.** Une écriture qu’un navigateur envoie depuis un autre site est refusée (`403 cross_site_request`) ; `curl`, les scripts et les agents n’envoient pas d’`Origin` et ne sont pas concernés.

## Les erreurs

Toutes les erreurs ont la même forme :

```json
{ "error": { "code": "forbidden", "message": "Permission « deployment:create » requise", "details": { "permission": "deployment:create" } } }
```

| Statut | Code | Sens |
|---|---|---|
| 400 | `invalid_json` | le corps n’est pas du JSON |
| 401 | `unauthenticated` | ni session ni jeton |
| 401 | `token_invalid`, `token_revoked`, `token_expired` | le jeton est inconnu, révoqué ou échu : faites-en un autre |
| 403 | `forbidden` | la permission nommée dans `details` manque |
| 403 | `token_scope` | un jeton limité à des applications, sur une route qui ne l’accepte pas |
| 403 | `token_refused` | une route qui se fait depuis le panel seulement |
| 403 | `two_factor_required` | l’instance exige un second facteur que le compte n’a pas |
| 403 | `cross_site_request` | une écriture d’un navigateur depuis un autre site |
| 403 | `https_required` | le serveur MCP joint en HTTP simple — voyez [MCP](/docs/mcp#servir-le-panel-en-https) |
| 404 | `not_found` | la ressource n’existe pas, ou la route est inconnue |
| 409 | `conflict` et d’autres | l’état l’interdit — un déploiement en cours, un domaine déjà pris, un nom utilisé |
| 422 | `validation_failed` | le corps ne respecte pas le schéma — `details` dit quels champs |
| 422 | `invalid_appspec` | une AppSpec refusée — `details.issues` liste chaque problème avec son chemin |
| 429 | `rate_limited` | trop de requêtes : attendez les secondes indiquées |
| 501 | `not_implemented` | une fonction non configurée, comme l’IA sans fournisseur |

## Exemples

### Trouver les identifiants

```bash
curl -s "$PUPITRE_URL/api/targets" -H "Authorization: Bearer $PUPITRE_TOKEN" \
  | jq -r '.items[] | "\(.id)  \(.name)  \(.status)"'

curl -s "$PUPITRE_URL/api/applications" -H "Authorization: Bearer $PUPITRE_TOKEN" \
  | jq -r '.items[] | "\(.id)  \(.slug)"'
```

### Créer une application, puis la déployer

```bash
APP_ID=$(jq -n --slurpfile spec pupitre.json '{appSpec: $spec[0]}' \
  | curl -s --fail-with-body -X POST "$PUPITRE_URL/api/applications" \
      -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" --data @- \
  | jq -r .id)

DEPLOYMENT_ID=$(curl -s --fail-with-body -X POST "$PUPITRE_URL/api/deployments" \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"applicationId":"'"$APP_ID"'","targetId":"'"$TARGET_ID"'","runtime":"docker"}' \
  | jq -r .id)
```

### Suivre un déploiement jusqu’au bout

```bash
while :; do
  STATUS=$(curl -s "$PUPITRE_URL/api/deployments/$DEPLOYMENT_ID" \
    -H "Authorization: Bearer $PUPITRE_TOKEN" | jq -r .status)
  case "$STATUS" in
    pending|running) sleep 5 ;;
    success) echo "déployé"; break ;;
    *) echo "déploiement terminé : $STATUS"
       curl -s "$PUPITRE_URL/api/deployments/$DEPLOYMENT_ID/logs/export?format=text" \
         -H "Authorization: Bearer $PUPITRE_TOKEN" | tail -40
       exit 1 ;;
  esac
done
```

### Changer une image et déployer

```bash
curl -s --fail-with-body -X POST "$PUPITRE_URL/api/deployments" \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"applicationId":"'"$APP_ID"'","targetId":"'"$TARGET_ID"'","runtime":"docker",
       "images":{"web":"ghcr.io/acme/shop:'"$GIT_SHA"'"}}'
```

### Mettre une cible en maintenance

```bash
curl -s --fail-with-body -X POST "$PUPITRE_URL/api/maintenance-windows" \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Mise à jour du noyau","startsAt":"2026-10-08T22:00:00Z","endsAt":"2026-10-08T23:00:00Z",
       "targetIds":["'"$TARGET_ID"'"],"monitorIds":[]}'
```

### Lire le journal d’activité

```bash
curl -s "$PUPITRE_URL/api/audit-logs?action=deployment.failed&pageSize=20" \
  -H "Authorization: Bearer $PUPITRE_TOKEN" | jq '.items[] | {createdAt, resourceId, after}'
```

## Référence des routes

ⓐ signale les routes qui acceptent aussi un jeton limité à des applications. « Tout appelant » veut dire une session ou un jeton, sans permission particulière.

### Identité, AppSpec et agents

| Méthode | Chemin | Permission | Ce qu’elle fait |
|---|---|---|---|
| GET | `/api/me` | tout appelant | qui appelle, ses rôles et permissions, le jeton |
| GET | `/api/appspec/schema` | tout appelant | le JSON Schema de l’AppSpec |
| POST | `/api/appspec/validate` | tout appelant | valide une AppSpec — le corps — sans rien créer |
| POST | `/api/mcp` | un jeton d’API | le serveur MCP — voyez [MCP](/docs/mcp) |
| GET | `/api/health` | public | `{ status, db, redis, ai }`, 200 ou 503 |

### Cibles

| Méthode | Chemin | Permission | Ce qu’elle fait |
|---|---|---|---|
| GET, POST | `/api/targets` | `target:read`, `target:create` | lister ; déclarer — l’accès est chiffré aussitôt |
| GET, PATCH, DELETE | `/api/targets/{id}` | `target:read`, `target:update`, `target:delete` | lire, modifier, supprimer — 409 tant qu’il reste des déploiements |
| POST | `/api/targets/{id}/preflight` | `target:update` | revérifie la machine, `202` |
| POST | `/api/targets/{id}/host-key` | `target:update` | `{ "decision": "accept" }` ou `"dismiss"` une clé d’hôte inattendue |
| GET | `/api/targets/{id}/metrics` | `target:read` | un relevé maintenant ; `/metrics/history` les derniers jours |
| GET | `/api/targets/{id}/ports` | `target:read` | la plage, les ports alloués et à qui |
| GET | `/api/targets/{id}/dns` | `target:read` | `?hostname=` — le nom pointe-t-il vers cette machine ? |
| GET | `/api/targets/{id}/workloads` | `workload:read` | tout ce qui tourne sur la machine |
| POST | `/api/targets/{id}/workloads/{ref}/control` | `workload:manage` | `{ "action": "start" }`, `"stop"` ou `"restart"` |
| POST | `/api/targets/{id}/workloads/{ref}/update` | `workload:manage` | tire à nouveau l’image et recrée |
| DELETE | `/api/targets/{id}/workloads/{ref}` | `workload:manage` | supprime une charge que Pupitre n’a pas déployée |
| POST | `/api/targets/{id}/workloads/{ref}/exec` | `workload:exec` | une commande de console ; la sortie arrive sur le flux |
| GET, PUT, DELETE | `/api/supervision/thresholds` | `target:read`, `target:update` | les seuils d’alerte, par machine ou pour toutes |

### Reverse proxys

| Méthode | Chemin | Permission | Ce qu’elle fait |
|---|---|---|---|
| GET, PUT, DELETE | `/api/targets/{id}/proxy` | `target:read`, `target:update` | le proxy de la machine ; relier un proxy trouvé ; retirer (`?uninstall=1`) |
| POST | `/api/targets/{id}/proxy/detect` | `target:update` | ce que porte la machine, ce qu’elle peut installer |
| POST | `/api/targets/{id}/proxy/install` | `target:update` | `{ kind, option, acme }`, `202` |
| POST | `/api/targets/{id}/proxy/check` | `target:update` | **Tester** |
| PUT, DELETE | `/api/targets/{id}/proxy/link` | `target:update` | passer par le proxy d’une autre machine : `{ proxyId, address }` |
| POST | `/api/targets/{id}/proxy/link/check` | `target:update` | **Tester le lien** |
| GET, POST | `/api/proxies` | `target:read`, `target:update` | les proxys distants (Nginx Proxy Manager) ; en connecter un |
| PATCH, DELETE | `/api/proxies/{id}` | `target:update` | modifier, retirer |
| POST | `/api/proxies/{id}/check` | `target:update` | **Tester** un proxy distant |

### Applications

| Méthode | Chemin | Permission | Ce qu’elle fait |
|---|---|---|---|
| GET, POST | `/api/applications` | `application:read`, `application:create` | lister ; créer depuis `{ appSpec, description?, secrets? }` |
| GET, PATCH, DELETE | `/api/applications/{id}` | `application:read` ⓐ, `application:update`, `application:delete` | lire, modifier, supprimer — 409 tant qu’elle tourne |
| GET, POST | `/api/applications/{id}/cascade` | `application:delete` ; la réunion de détruire, purger et supprimer | aperçu ; tout détruire puis supprimer |
| POST | `/api/applications/generate` | `application:create` | une AppSpec rédigée par l’IA depuis `{ prompt }` — rien n’est enregistré |
| POST | `/api/applications/import-compose` | `application:create` | une AppSpec proposée depuis un `docker-compose.yml` |
| POST | `/api/catalog/{id}` | `application:create` | installer un modèle du catalogue |
| GET | `/api/applications/{id}/versions` | `application:read` | les versions, chacune rejouable |
| GET | `/api/applications/{id}/secrets` | `application:read` | les noms et leur état — jamais une valeur |
| PUT, DELETE | `/api/applications/{id}/secrets/{name}` | `application:update` | `{ "value" }` ou `{ "generate": true }` ; supprimer |
| GET, PUT | `/api/applications/{id}/routes` | `application:read`, `deployment:create` | les domaines par cible ; les remplacer |
| GET | `/api/applications/{id}/images` | `application:read` | les mises à jour d’images trouvées ; `POST …/images/check` vérifie maintenant |
| POST | `/api/applications/{id}/redeploy` | `deployment:create` ⓐ | rejouer `{ versionId, targetId }` |

### Code et dépôts

| Méthode | Chemin | Permission | Ce qu’elle fait |
|---|---|---|---|
| GET, POST | `/api/applications/{id}/archives` | `application:read` ⓐ, `application:update` ⓐ | les archives ; en téléverser une — le corps est l’archive |
| GET, DELETE | `/api/applications/{id}/archives/{archiveId}` | `application:read` ⓐ, `application:update` ⓐ | son état et son rapport ; supprimer |
| POST | `/api/applications/from-source` | `application:create` | créer depuis le `pupitre.json` d’un dépôt |
| GET, POST | `/api/applications/{id}/sources` | `application:read`, `application:update` | les branches liées ; en lier une |
| PATCH, DELETE | `/api/applications/{id}/sources/{sourceId}` | `application:update` | modifier, délier |
| POST | `/api/applications/{id}/sources/{sourceId}/deploy` | `deployment:create` | déployer un commit maintenant |
| POST | `/api/source-proposals/{id}/approve` | `deployment:create` | déployer un commit en attente d’approbation ; `/dismiss` le laisse |
| GET | `/api/integrations/repositories` | `application:update` | les dépôts que chaque forge propose |
| GET, PUT, DELETE | `/api/integrations/gitlab`, `/api/integrations/gitea` | `settings:read`, `settings:manage` | la connexion de la forge |
| GET, POST, DELETE | `/api/integrations/github` | `settings:read`, `settings:manage` | la GitHub App |

### Déploiements

| Méthode | Chemin | Permission | Ce qu’elle fait |
|---|---|---|---|
| GET, POST | `/api/deployments` | `deployment:read`, `deployment:create` ⓐ | lister avec filtres ; déployer, `202` |
| GET, DELETE | `/api/deployments/{id}` | `deployment:read` ⓐ, `deployment:destroy` | statut et étapes ; détruire sur la machine |
| POST | `/api/deployments/{id}/rollback` | `deployment:rollback` ⓐ | remettre la version précédente |
| GET | `/api/deployments/{id}/logs` | `deployment:read` ⓐ | le journal, en direct (SSE) |
| GET | `/api/deployments/{id}/logs/export` | `deployment:read` | le journal, `?format=text` ou `jsonl` |
| GET | `/api/deployments/{id}/scans` | `scan:read` | les analyses du run |
| DELETE | `/api/deployments/{id}/purge` | `deployment:purge` | effacer le run de la base |
| POST | `/api/deployments/purge` | `deployment:purge` | purger en masse, `dryRun` compris |
| GET | `/api/deployments/stuck` | `deployment:read` | les runs crus en cours sans rien derrière |
| POST | `/api/deployments/{id}/unblock` | `deployment:purge` | passer un tel run en échec |

### Applications en service et domaines

| Méthode | Chemin | Permission | Ce qu’elle fait |
|---|---|---|---|
| GET | `/api/apps` | `deployment:read` | ce qui est en service, machine par machine |
| GET | `/api/apps/{id}/state` | `deployment:read` | les services et la santé d’une application en service |
| POST | `/api/apps/{id}/restart`, `/stop`, `/start` | `deployment:restart` | redémarrer, arrêter, redémarrer après arrêt |
| GET | `/api/apps/{id}/logs` | `deployment:read` | journaux en direct (SSE) |
| GET | `/api/domains` | `application:read` | chaque domaine, son proxy, son état, son certificat |
| GET | `/api/domains/{id}/inspect` | `application:read` | DNS, enregistrement, zone et certificat, lus maintenant |

### Sécurité

| Méthode | Chemin | Permission | Ce qu’elle fait |
|---|---|---|---|
| GET | `/api/scans/{id}` | `scan:read` | les trouvailles d’une analyse, avec filtres |
| GET | `/api/scans/{id}/sbom` | `scan:read` | le SBOM |
| GET | `/api/findings` | `scan:read` | les vulnérabilités à travers les déploiements |
| GET, PUT | `/api/applications/{id}/scan-policy` | `scan:read`, `scan:configure` | le seuil et la règle des corrigeables de l’application |
| GET, POST | `/api/applications/{id}/vulnerability-acceptances` | `scan:read`, `scan:configure` | les vulnérabilités acceptées ; en accepter une |
| DELETE | `/api/applications/{id}/vulnerability-acceptances/{acceptanceId}` | `scan:configure` | retirer une acceptation |

### Sondes, maintenances et pages de statut

| Méthode | Chemin | Permission | Ce qu’elle fait |
|---|---|---|---|
| GET, POST | `/api/monitors` | `monitor:read`, `monitor:manage` | les sondes ; en créer une |
| GET, PATCH, DELETE | `/api/monitors/{id}` | `monitor:read`, `monitor:manage` | lire, modifier, supprimer |
| POST | `/api/monitors/{id}/check` | `monitor:manage` | sonder maintenant |
| GET, POST | `/api/maintenance-windows` | `maintenance:read`, `maintenance:manage` | les fenêtres ; en planifier une |
| GET, PATCH, DELETE | `/api/maintenance-windows/{id}` | `maintenance:read`, `maintenance:manage` | lire, modifier ou terminer (`endsAt`), supprimer |
| GET, POST | `/api/status-pages` | `status_page:manage` | les pages de statut ; en créer une |
| GET, PATCH, DELETE | `/api/status-pages/{id}` | `status_page:manage` | lire, modifier, supprimer |
| GET, POST | `/api/status-updates` | `status_page:announce` | les annonces ; en publier une |
| PATCH, DELETE | `/api/status-updates/{id}` | `status_page:announce` | corriger, retirer |

### Tâches et sauvegardes

| Méthode | Chemin | Permission | Ce qu’elle fait |
|---|---|---|---|
| GET, POST | `/api/jobs` | `job:read`, `job:manage` | les tâches planifiées ; en créer une |
| GET, PATCH, DELETE | `/api/jobs/{id}` | `job:read`, `job:manage` | lire, modifier, supprimer |
| POST | `/api/jobs/{id}/run` | `job:manage` | une occurrence maintenant, `202` |
| GET | `/api/queue/jobs/{id}` | `job:read` | l’état d’une tâche dans la file |
| GET, POST | `/api/applications/{id}/backups` | `backup:read`, `backup:manage` | les sauvegardes d’une application ; sauvegarder maintenant `{ targetId }` |
| PUT | `/api/applications/{id}/backup-policy` | `backup:manage` | automatique, avant déploiement, mode, rétention |
| POST | `/api/backups/{id}/restore` | `backup:restore` | `{ targetId, safetyBackup }`, `202` |
| DELETE | `/api/backups/{id}` | `backup:manage` | supprimer une sauvegarde |
| GET, PUT, DELETE | `/api/backups/destination` | `settings:read`, `settings:manage` | la destination — les secrets ne reviennent jamais |
| GET, POST | `/api/backups/panel` | `settings:read`, `settings:manage` | les sauvegardes du panel ; sauvegarder maintenant |

### Utilisateurs, rôles, paramètres et journal d’activité

| Méthode | Chemin | Permission | Ce qu’elle fait |
|---|---|---|---|
| GET, POST | `/api/admin/users` | `user:read`, `user:manage` | les comptes ; en créer un |
| GET, DELETE | `/api/admin/users/{id}` | `user:read`, `user:manage` | lire, supprimer |
| PATCH | `/api/admin/users/{id}/role`, `/status` | `user:manage` | changer le rôle ; désactiver ou réactiver |
| POST, DELETE | `/api/admin/users/{id}/invitation` | `user:manage` | envoyer ou annuler une invitation |
| DELETE | `/api/admin/users/{id}/two-factor` | `user:reset-2fa` | réinitialiser le second facteur de quelqu’un |
| GET, POST | `/api/admin/roles` | `role:read`, `role:manage` | les rôles ; en créer un |
| GET, PATCH, DELETE | `/api/admin/roles/{key}` | `role:read`, `role:manage` | lire, modifier, supprimer |
| GET, PATCH | `/api/settings` | `settings:read`, `settings:manage` | toutes les sections des paramètres, en une route |
| GET, POST | `/api/notifications/channels` | `settings:read`, `settings:manage` | les canaux ; en créer un |
| GET, PATCH, DELETE | `/api/notifications/channels/{id}` | `settings:read`, `settings:manage` | lire, modifier, supprimer ; `POST …/test` envoie un test |
| GET | `/api/audit-logs` | `audit:read` | le journal d’activité, avec filtres |
| GET | `/api/audit-logs/export` | `audit:read` | le journal d’activité en JSONL |

### Depuis le panel seulement

Ces routes demandent une session de navigateur et refusent un jeton (`403 token_refused`) : `/api/account/*` (mot de passe, second facteur, sessions, photo), `/api/tokens` et `/api/admin/tokens`, `/api/chat/*`, `/api/presence`, `/api/realtime`, `/api/search`, `/api/forecasts`, `/api/onboarding`, et le test de la connexion unique.
