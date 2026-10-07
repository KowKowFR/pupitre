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
| HTTPS | exigé — le HTTP simple reçoit `403 https_required`, sauf depuis la machine elle-même (`localhost`, un tunnel SSH) |
| Révisions du protocole | `2025-11-25`, `2025-06-18`, `2025-03-26` |
| Capacités | outils, ressources |

La machine de l’agent doit joindre l’adresse du panel — par le réseau privé, un VPN ou un tunnel si le panel n’est pas public.

Vérifiez-le depuis un terminal — macOS, Linux, ou Windows avec WSL ou Git Bash :

```bash
curl -s {{origin}}/api/mcp \
  -H "Authorization: Bearer $PUPITRE_TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq -r '.result.tools[].name'
```

Sous Windows, dans PowerShell — sans `curl` ni `jq` :

```powershell
$headers = @{ Authorization = "Bearer $env:PUPITRE_TOKEN"; Accept = "application/json, text/event-stream" }
$body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
(Invoke-RestMethod -Method Post -Uri "{{origin}}/api/mcp" -Headers $headers `
  -ContentType "application/json" -Body $body).result.tools.name
```

Les deux listent les 41 outils.

## Servir le panel en HTTPS

Le serveur MCP ne répond qu’en **HTTPS** : le jeton d’un agent porte souvent toutes les permissions de son auteur, et en HTTP simple quiconque est sur le chemin le lit à chaque appel. Une requête en clair reçoit `403 https_required`, et le refus est écrit au journal d’activité sous le compte du jeton — ce jeton a circulé en clair : révoquez-le. Seule la machine elle-même est exemptée : `localhost`, donc un tunnel SSH.

### Avec le Traefik de la machine

Quand le panel tourne sur une machine où Pupitre a installé Traefik — le reverse proxy d’une cible —, ce Traefik peut servir le panel aussi, avec un certificat Let’s Encrypt.

1. Faites pointer un domaine vers la machine : un enregistrement `A`, `pupitre.example.com` → son adresse publique.
2. Trouvez le dossier que surveille Traefik, sur la machine :

   ```bash
   docker inspect pupitre-traefik | grep -B1 '"Destination": "/etc/traefik/dynamic"'
   ```

3. Dans ce dossier, écrivez `_panel.yml` — un nom qu’aucune application ne peut prendre, pour que Pupitre n’y touche jamais :

   ```yaml
   http:
     routers:
       pupitre-panel:
         rule: Host(`pupitre.example.com`)
         entryPoints: [websecure]
         service: pupitre-panel
         tls:
           certResolver: pupitre
       pupitre-panel-http:
         rule: Host(`pupitre.example.com`)
         entryPoints: [web]
         middlewares: [pupitre-panel-https]
         service: pupitre-panel
     middlewares:
       pupitre-panel-https:
         redirectScheme:
           scheme: https
           permanent: true
     services:
       pupitre-panel:
         loadBalancer:
           servers:
             - url: http://127.0.0.1:3000
   ```

4. Dans le `.env` du panel : la nouvelle adresse du panel, et son port sur la boucle locale seulement — Traefik l’y joint, Internet ne le joint plus :

   ```bash
   BETTER_AUTH_URL=https://pupitre.example.com
   WEB_PORT=127.0.0.1:3000
   ```

5. Redémarrez, puis vérifiez :

   ```bash
   docker compose up -d
   curl -s https://pupitre.example.com/api/health
   ```

Le certificat est demandé à la première visite en HTTPS ; le port 80 doit être joignable depuis Internet pour le défi. Ouvrez désormais le panel à sa nouvelle adresse : la connexion et les écritures sont liées à `BETTER_AUTH_URL`. Tout autre reverse proxy fait l’affaire — le Traefik d’un cluster, Caddy, nginx — pourvu qu’il termine TLS et transmette `X-Forwarded-Proto: https` au port 3000.

### Sans domaine : un tunnel SSH

Le tunnel chiffre tout entre votre poste et la machine, et le panel voit une requête `localhost` :

```bash
ssh -N -L 3000:localhost:3000 compte@machine
```

La commande est la même dans PowerShell. Laissez-la tourner, et utilisez `http://localhost:3000` comme adresse du panel dans le client.

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

Dans chaque exemple, le jeton est dans la variable d’environnement `PUPITRE_TOKEN`. Sous macOS et Linux : `export PUPITRE_TOKEN=pup_…`. Sous Windows, dans PowerShell :

```powershell
$env:PUPITRE_TOKEN = "pup_…"                                                  # cette fenêtre seulement
[Environment]::SetEnvironmentVariable("PUPITRE_TOKEN", "pup_…", "User")        # pour de bon, pour les clients
```

Un client lancé depuis le menu Démarrer — Cursor, VS Code, Claude Desktop — ne voit qu’une variable posée « pour de bon », et seulement une fois rouvert.

> [!TIP]
> Le tiroir **Nouveau jeton** montre une commande `claude mcp add` où le jeton est déjà écrit, sur une seule ligne : elle se colle telle quelle dans bash, zsh, PowerShell et cmd.

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

Sous Windows, dans PowerShell :

```powershell
claude mcp add --transport http pupitre {{origin}}/api/mcp --header "Authorization: Bearer $env:PUPITRE_TOKEN"
```

`/mcp` dans Claude Code montre le serveur connecté et ses outils ; `claude mcp list` dit s’il répond.

### Claude Desktop

Claude Desktop démarre des serveurs locaux : le pont `mcp-remote` relaie vers le panel. Il lui faut Node.js sur la machine. Dans `claude_desktop_config.json` — `~/Library/Application Support/Claude/` sous macOS, `%APPDATA%\Claude\` sous Windows (**Settings → Developer → Edit Config**) :

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

Par un tunnel SSH, l’adresse est `http://localhost:3000/api/mcp` : ajoutez `"--allow-http"` à `args`. `Authorization:${PUPITRE_AUTH}` n’a pas d’espace exprès : sous Windows, certains clients transmettent mal un argument qui en contient un. Si Windows répond que `npx` n’est pas reconnu, donnez son chemin complet : `"command": "C:\\Program Files\\nodejs\\npx.cmd"`. Redémarrez Claude Desktop après chaque changement.

### Cursor

`~/.cursor/mcp.json` — `%USERPROFILE%\.cursor\mcp.json` sous Windows —, ou `.cursor/mcp.json` dans un projet :

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
- **HTTPS seulement.** Une requête en clair est refusée avant tout le reste, et tracée sous le compte du jeton — voyez [Servir le panel en HTTPS](#servir-le-panel-en-https).
- **Les écritures venues de navigateurs sont contrôlées.** Une requête envoyée par une page web depuis un autre site est refusée, comme le protocole l’exige contre le DNS rebinding.
- **Révoquer aussitôt.** Depuis [Mon compte](/account) : l’appel suivant est refusé.

## Quand ça ne marche pas

| Symptôme | Cause | Que faire |
|---|---|---|
| `401` à la connexion | pas de jeton, ou jeton inconnu, révoqué ou échu | vérifiez l’en-tête, créez un nouveau jeton |
| `403 https_required` | le panel est joint en HTTP simple | servez-le en HTTPS, ou passez par un tunnel SSH — et révoquez le jeton |
| `403 cross_site_request` | un client qui tourne dans un navigateur envoie son propre `Origin` | utilisez un client de bureau, ou `mcp-remote` |
| un outil manque | il manque sa permission au jeton, ou le jeton est limité à des applications | `whoami` dit ce qu’il détient ; ajustez le jeton |
| un outil répond `HTTP 403 forbidden` | la route demande une permission que le jeton a perdue | le message la nomme |
| un outil répond `HTTP 409` | l’état l’interdit : un déploiement en cours, un domaine pris | lisez le message, puis agissez |
| `deployment_wait` renvoie « still running » | le déploiement dure plus qu’un appel | rappelez-le, ou lisez `deployment_logs` |
| `400 Unsupported MCP-Protocol-Version` | le client parle une révision absente de la liste ci-dessus | mettez le client à jour |
| Windows : `npx` n’est pas reconnu | Node.js manque, ou n’est pas dans le chemin du client | installez Node.js, ou donnez le chemin complet de `npx.cmd` |
| Windows : `curl -H` refusé par PowerShell | dans Windows PowerShell 5.1, `curl` est `Invoke-WebRequest` | utilisez l’exemple PowerShell ci-dessus, ou `curl.exe` |
| Windows : le client ne voit pas le jeton | la variable a été posée dans une fenêtre, pas pour de bon | `SetEnvironmentVariable(…, "User")`, puis rouvrez le client |
