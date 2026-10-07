# Serveur MCP

Pupitre est un serveur MCP : un agent IA — Claude Code, Claude Desktop, Cursor, VS Code, ou tout client du Model Context Protocol — s’y connecte avec un jeton d’API et pilote le panel en langage courant : « déploie shop sur prod-1 et dis-moi si ça a marché ». Il agit avec les permissions du jeton, et chaque action arrive dans le journal d’activité.

## Ce qu’apporte MCP

- **Tout ce que fait l’API, un agent le fait** : des outils typés pour le travail courant — cibles, applications, déploiements, journaux, retour en arrière, domaines, secrets — et un outil générique pour toutes les autres routes.
- **Les mêmes droits que vous, ou moins** : l’agent utilise un jeton d’API lié à votre compte, ramené à ce que vous pouvez encore faire, éventuellement limité à certaines applications.
- **Les mêmes garde-fous** : chaque outil passe par la route REST qui fait la même chose — permissions, validation, refus, journal d’activité. La couche MCP ne décide rien.
- **La documentation intégrée** : l’agent peut lire cette documentation — chapitres et recherche — pour savoir comment Pupitre fonctionne avant d’agir.

## Le point d’accès

| | |
|---|---|
| Adresse | `{{origin}}/api/mcp` |
| Transport | Streamable HTTP, sans état — un `POST` par message, une réponse JSON |
| Authentification | `Authorization: Bearer pup_…` — un jeton d’API, jamais une session de navigateur |
| Révisions du protocole | `2025-11-25`, `2025-06-18`, `2025-03-26` |
| Capacités | outils, ressources |

La machine de l’agent doit joindre l’adresse du panel — par le réseau privé, un VPN ou un tunnel si le panel n’est pas public.

Vérifiez-le depuis un terminal :

```bash
curl -s {{origin}}/api/mcp \
  -H "Authorization: Bearer $PUPITRE_TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq -r '.result.tools[].name'
```

## Créer un jeton pour un agent

[Mon compte](/account) → **Jetons d’API** → **Nouveau jeton** :

1. un nom — « Claude Code — portable » : le journal d’activité dira « par le jeton *Claude Code — portable* » ;
2. ce qu’il peut faire — **Tout ce que je peux faire** pour un agent qui exploite tout le panel, **Lire** pour un agent qui ne fait que regarder, **Sur mesure** pour tout l’entre-deux ;
3. éventuellement **seulement celles-ci** : l’agent peut alors déployer ces applications, les suivre et les ramener en arrière, et rien d’autre ;
4. une échéance — 30 ou 90 jours pour un agent ;
5. **Créer le jeton** : le tiroir le montre une fois, avec les commandes ci-dessous prêtes à coller.

> [!WARNING]
> L’agent peut tout ce que le jeton permet, y compris détruire des déploiements si le jeton porte `deployment:destroy`. Donnez-lui ce dont il a besoin, gardez la confirmation des actions de votre client MCP, et révoquez le jeton quand l’agent n’en a plus besoin.

## Connecter un client

Dans chaque exemple, exportez d’abord le jeton : `export PUPITRE_TOKEN=pup_…`.

### Claude Code

```bash
claude mcp add --transport http pupitre {{origin}}/api/mcp \
  --header "Authorization: Bearer $PUPITRE_TOKEN"
```

Ou, partagé dans le `.mcp.json` d’un projet — le jeton reste dans l’environnement de chacun :

```json
{
  "mcpServers": {
    "pupitre": {
      "type": "http",
      "url": "{{origin}}/api/mcp",
      "headers": { "Authorization": "Bearer ${PUPITRE_TOKEN}" }
    }
  }
}
```

`/mcp` dans Claude Code montre le serveur connecté et ses outils.

### Claude Desktop

Claude Desktop démarre des serveurs locaux : le pont `mcp-remote` relaie vers le panel. Dans `claude_desktop_config.json` :

```json
{
  "mcpServers": {
    "pupitre": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "{{origin}}/api/mcp", "--header", "Authorization:${PUPITRE_AUTH}"],
      "env": { "PUPITRE_AUTH": "Bearer pup_…" }
    }
  }
}
```

Ajoutez `"--allow-http"` à `args` si le panel est servi en HTTP simple sur un réseau privé.

### Cursor

`~/.cursor/mcp.json`, ou `.cursor/mcp.json` dans un projet :

```json
{
  "mcpServers": {
    "pupitre": {
      "url": "{{origin}}/api/mcp",
      "headers": { "Authorization": "Bearer ${env:PUPITRE_TOKEN}" }
    }
  }
}
```

### VS Code

`.vscode/mcp.json` — VS Code demande le jeton une fois et le garde dans son stockage de secrets :

```json
{
  "inputs": [
    { "type": "promptString", "id": "pupitre-token", "description": "Jeton d’API Pupitre", "password": true }
  ],
  "servers": {
    "pupitre": {
      "type": "http",
      "url": "{{origin}}/api/mcp",
      "headers": { "Authorization": "Bearer ${input:pupitre-token}" }
    }
  }
}
```

### Tout autre client

Un client qui parle Streamable HTTP a besoin de l’adresse et d’un en-tête, `Authorization: Bearer pup_…`. Un client qui ne sait lancer que des processus locaux passe par `mcp-remote`, comme pour Claude Desktop.

> [!NOTE]
> Les clients qui exigent OAuth pour ajouter un serveur distant ne peuvent pas utiliser un en-tête de jeton : passez par `mcp-remote`, ou utilisez un client qui accepte les en-têtes.

## Les outils

L’agent ne voit que les outils que son jeton peut utiliser ; un jeton limité à des applications ne voit que ceux qui l’acceptent.

| Outil | Ce qu’il fait | Permission |
|---|---|---|
| `whoami` | le compte, les rôles et les permissions réelles du jeton | — |
| `docs` | cette documentation : sommaire, recherche, un chapitre entier | — |
| `api_request` | n’importe quelle route REST — méthode, chemin, paramètres, corps | celle de la route |
| `appspec_schema` | le JSON Schema de l’AppSpec | — |
| `appspec_validate` | valide une AppSpec sans rien créer | — |
| `targets_list` | les machines et leurs runtimes | `target:read` |
| `target_get` | une machine : préflight, ports, proxy | `target:read` |
| `target_preflight` | revérifie une machine | `target:update` |
| `target_metrics` | charge, mémoire, disque, maintenant | `target:read` |
| `target_ports` | les ports alloués et libres | `target:read` |
| `target_workloads` | tout ce qui tourne sur une machine | `workload:read` |
| `workload_control` | démarre, arrête, redémarre une charge | `workload:manage` |
| `applications_list` | les applications | `application:read` |
| `application_get` | une application, son AppSpec, où elle tourne | `application:read` |
| `application_create` | crée une application depuis une AppSpec | `application:create` |
| `application_update` | remplace une AppSpec ou une description | `application:update` |
| `application_generate` | rédige une AppSpec avec l’IA de l’instance | `application:create` |
| `application_versions` | les versions, chacune rejouable | `application:read` |
| `application_secrets` | noms et état des secrets, jamais une valeur | `application:read` |
| `application_secret_set` | définit ou régénère un secret | `application:update` |
| `application_secret_delete` | supprime la valeur d’un secret | `application:update` |
| `application_domains` | les domaines par cible | `application:read` |
| `application_domains_set` | remplace les domaines sur une cible | `deployment:create` |
| `deployments_list` | les runs, avec filtres | `deployment:read` |
| `deploy` | déploie une application, en arrière-plan | `deployment:create` |
| `deployment_get` | le statut et les étapes d’un run | `deployment:read` |
| `deployment_wait` | attend la fin d’un run, jusqu’à deux minutes par appel | `deployment:read` |
| `deployment_logs` | le journal d’un run, ses dernières lignes | `deployment:read` |
| `deployment_rollback` | remet la version précédente | `deployment:rollback` |
| `deployment_redeploy` | rejoue une version, sur n’importe quelle cible | `deployment:create` |
| `deployment_destroy` | retire un déploiement de sa machine | `deployment:destroy` |
| `deployment_scans` | les analyses d’un run | `scan:read` |
| `running_apps` | ce qui est en service, machine par machine | `deployment:read` |
| `running_app_state` | les services et la santé d’une application en service | `deployment:read` |
| `running_app_restart` | redémarre une application en service | `deployment:restart` |
| `running_app_stop` | l’arrête, en gardant volumes, port et domaine | `deployment:restart` |
| `running_app_start` | la redémarre après un arrêt | `deployment:restart` |
| `domains_list` | chaque domaine, son état et son certificat | `application:read` |
| `monitors_list` | les sondes et leur état | `monitor:read` |
| `findings_list` | les vulnérabilités à travers les déploiements | `scan:read` |
| `audit_search` | le journal d’activité | `audit:read` |

Les outils portent des indications pour le client — lecture seule, destructif, idempotent — pour qu’il puisse vous demander avant une action qui change quelque chose.

## Les ressources

Chaque chapitre de cette documentation est une ressource, `pupitre://docs/{langue}/{chapitre}` — `pupitre://docs/fr/deployments`, par exemple —, en Markdown, qu’un client peut joindre à une conversation.

## Que demander à un agent

- « Qu’est-ce qui tourne sur prod-1, et y a-t-il quelque chose de malade ? »
- « Déploie la dernière version de shop sur staging, attends, et si ça échoue montre-moi pourquoi. »
- « Ramène shop à la version précédente sur prod-1. »
- « Crée une application depuis ce docker-compose.yml, valide-la, et déploie-la sur staging avec le domaine shop-staging.example.com. »
- « Quels certificats expirent dans les deux prochaines semaines ? »
- « Quels déploiements ont échoué cette semaine, et que disent leurs journaux ? »
- « Mets prod-1 en maintenance ce soir de 22 h à 23 h. » — par `api_request`.

L’agent enchaîne les outils de lui-même : `whoami`, puis `targets_list` et `applications_list` pour trouver les identifiants, `deploy`, `deployment_wait`, `deployment_logs` si cela a échoué.

## La sécurité

- **Le jeton est la limite.** Un agent ne fait jamais plus que son jeton : des permissions choisies parmi les vôtres, ramenées à ce que vous détenez aujourd’hui, éventuellement limitées à certaines applications.
- **Pas d’escalade de privilèges.** Un jeton ne peut pas créer de jetons, changer votre mot de passe ni ouvrir l’interface ; les routes qui le permettraient refusent les jetons.
- **Tout est tracé.** Chaque action est dans le journal d’activité sous votre compte, « par le jeton » qui l’a portée, avec le nom du client comme navigateur.
- **Les écritures venues de navigateurs sont contrôlées.** Une requête envoyée par une page web depuis un autre site est refusée, comme le protocole l’exige contre le DNS rebinding.
- **Révoquer aussitôt.** Depuis [Mon compte](/account) : l’appel suivant est refusé.

## Quand ça ne marche pas

| Symptôme | Cause | Que faire |
|---|---|---|
| `401` à la connexion | pas de jeton, ou jeton inconnu, révoqué ou échu | vérifiez l’en-tête, créez un nouveau jeton |
| `403 cross_site_request` | un client qui tourne dans un navigateur envoie son propre `Origin` | utilisez un client de bureau, ou `mcp-remote` |
| un outil manque | il manque sa permission au jeton, ou le jeton est limité à des applications | `whoami` dit ce qu’il détient ; ajustez le jeton |
| un outil répond `HTTP 403 forbidden` | la route demande une permission que le jeton a perdue | le message la nomme |
| un outil répond `HTTP 409` | l’état l’interdit : un déploiement en cours, un domaine pris | lisez le message, puis agissez |
| `deployment_wait` renvoie « still running » | le déploiement dure plus qu’un appel | rappelez-le, ou lisez `deployment_logs` |
| `400 Unsupported MCP-Protocol-Version` | le client parle une révision absente de la liste ci-dessus | mettez le client à jour |
