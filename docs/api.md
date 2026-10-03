# Pages et API

Toutes les routes passent par `apiRoute()`, qui traduit les erreurs typées en
réponses HTTP — sauf `/api/health` et `/api/auth/[...all]`. Aucune route ne
fabrique de 401/403 à la main, et **tout refus est audité**. Une écriture qu'un
navigateur envoie depuis une autre origine que `BETTER_AUTH_URL` est refusée
avant tout (`403 cross_site_request`) — voir
[`securite.md`](securite.md#une-écriture-vient-du-panel-ou-elle-est-refusée).

« session » veut dire : authentifié **par le navigateur**, sans permission
particulière.

**Une CI s'authentifie par un jeton d'API** — `Authorization: Bearer pup_…`,
créé depuis « Mon compte ». Il agit au nom de son auteur, avec les permissions
qu'on lui a données parmi les siennes, relues à chaque appel. Il est accepté
par toute route gardée par une permission, et refusé (`403 token_refused`) par
celles qui ne demandent qu'une session : compte, discussion, présence, gestion
des jetons. Il n'ouvre pas l'interface. Limité à des applications, il n'est
accepté que par les routes marquées ⓐ ci-dessous, qui vérifient l'application
visée ; toutes les autres le refusent (`403 token_scope`). Révoqué, échu ou
inconnu : `401 token_revoked`, `token_expired`, `token_invalid`. Voir
[`securite.md`](securite.md#jetons-dapi) et
[`exploitation.md`](exploitation.md#déployer-depuis-une-ci).

**Quand l'instance exige un second facteur** d'un compte qui ne l'a pas encore
(« Comptes et sessions »), toute route gardée par une permission — et la
discussion, la présence, les jetons — lui répond `403 two_factor_required`,
à lui comme à ses jetons d'API. Seules les routes du compte restent ouvertes,
le temps de l'activer. Voir [`securite.md`](securite.md#le-second-facteur-exigé).

## Pages

### Exploitation

| Route | Rôle | Accès |
|---|---|---|
| `/` | Tableau de bord — anomalies d'abord, inventaire en dernier | session ; chaque bloc filtré par sa permission |
| `/targets` | Parc de machines. `?target=<nom>` ouvre la **fiche dans un tiroir** : aperçu et relevés, charges, reverse proxy, ports, preflight, configuration (`&tab=…`) ; `&edit=1` la modifie sur place | `target:read` — modifier `target:update` |
| `/targets/new` | Déclarer une cible (le tiroir d'ajout) — credential jamais pré-rempli | `target:create` |
| `/targets/:id` · `/targets/:id/edit` | Redirigent (307) vers `/targets?target=:id` (`&edit=1`) | `target:read` |
| `/applications` | Catalogue des AppSpec déclarées. `?app=<slug>` ouvre la **fiche dans un tiroir** : aperçu et déploiement, versions, code, domaines, secrets, sauvegardes (`backup:read`), images (`&tab=…`) | `application:read` |
| `/applications/new` | Deux onglets : « Depuis une description » (IA) et « Depuis un JSON » | `application:create` |
| `/applications/:id` | Redirige (307) vers `/applications?app=:id` | `application:read` |
| `/apps` | **Supervision, vue par serveur** — une carte par machine, dépliable | `deployment:read` |
| `/apps/:id` | Redirige (307) vers `/apps?app=:id` : une application en marche — santé, logs live, gestes — **dans un tiroir** de la supervision | `deployment:read` |
| `/deployments` | Journal des runs, filtres, purge en masse | `deployment:read` |
| `/deployments/:id` | Redirige (307) vers `/deployments?run=:id` : le suivi d'un run — pipeline, logs SSE, scans, AppSpec figée, rollback, destruction — **dans un tiroir**, même hors de la page affichée | `deployment:read` |
| `/domains` | **Tous les domaines** : le proxy qui les sert, leur état, l'échéance de leur certificat ; filtre « À surveiller » (ne répond pas, ou certificat sous quatorze jours) | `application:read` |
| `/monitors` | Sondes HTTP et TLS. `?monitor=<id>` ouvre la **fiche dans un tiroir** : aperçu, mesures et incidents, capture de référence ; `&edit=1` la modifie sur place | `monitor:read` — modifier `monitor:manage` |
| `/monitors/:id` | Redirige (307) vers `/monitors?monitor=:id` | `monitor:read` |
| `/status-pages` | Pages de statut publiques : la liste, et l'éditeur **dans un tiroir** (`?page=<id>`, `?page=nouvelle`) — blocs, glisser-déposer, aperçu. Section « Annonces » : les pannes et maintenances des sondes des pages, chacune dans un tiroir (`?annonce=incident:<id>`, `?annonce=maintenance:<id>`) où publier, corriger, retirer | `status_page:manage` ou `status_page:announce` — chacun voit sa part |
| `/status`, `/status/<adresse>` | Une page de statut **publiée**, sans connexion ; 404 sinon | aucune |
| `/maintenance` | Fenêtres de maintenance en cours, à venir et terminées. `?fenetre=<id>` ouvre la fenêtre **dans un tiroir** (période, sujets, alertes retenues) ; `?nouvelle=1` le formulaire, `&cible=<id>` ou `&sonde=<id>` préremplis | `maintenance:read` — planifier `maintenance:manage` |
| `/jobs` | Tâches planifiées, cron traduit en français, historique déroulant | `job:read` |

### Administration

| Route | Rôle | Accès |
|---|---|---|
| `/admin/logs` | **Logs d'activité** — table paginée, criticité colorée, filtres et recherche libre | `audit:read` |
| `/admin/users` | Comptes : création, statut, rôle, réinitialisation du 2FA | `user:manage` |
| `/admin/roles` | Matrice des droits — un rôle par colonne, une famille de permissions par ligne ; `?role=…` ouvre son tiroir | `role:read` — modifier `role:manage` |
| `/admin/settings` | Redirige (307) vers `/admin/settings/identite` | `settings:read` |
| `/admin/settings/{identite,regionalisation,securite,connexion,comptes,notifications,ia,integrations,sauvegardes,demarrage}` | Les dix sections, en quatre groupes à onglets | `settings:read` — écriture `settings:manage` |

### Hors navigation

| Route | Rôle | Accès |
|---|---|---|
| `/account` | Mon compte — mot de passe, TOTP | session |
| `/onboarding` | Assistant de démarrage, coquille sans rail | session |
| `/login` · `/signup` · `/logout` | | publiques |
| `/forbidden` | Écran de refus, **nomme la permission manquante** | publique |

Le rail de navigation porte deux groupes — « Exploitation » (Tableau de bord,
Cibles, Applications, Catalogue, Supervision, Déploiements, Domaines, Sondes, Tâches) et
« Administration » (**Logs**, Utilisateurs, Rôles, Paramètres). Chaque entrée
n'apparaît qu'avec la permission qui va avec ; un groupe vide ne s'affiche pas.
« Mon compte » et « Déconnexion » vivent en pied de rail, volontairement hors de
la navigation métier.

## API

### Santé et authentification

| Route | Méthodes | Permission |
|---|---|---|
| `/api/health` | GET | **publique** — `{ status, db, redis, ai }`, 200 ou 503 |
| `/api/auth/[...all]` | GET POST | publique — Better Auth ; audite connexions et déconnexions. `/api/auth/admin/*` répond 404 : Pupitre a sa propre API d'administration ; `/api/auth/two-factor/*` aussi, hors `verify-totp` et `verify-backup-code` — le second facteur s'active et se retire par `/api/account/two-factor/*`. La connexion unique part de `POST /api/auth/sign-in/social` (`{ provider: "oidc", callbackURL }`, rend l'adresse du fournisseur) et revient par `GET /api/auth/callback/oidc` ; un retour en échec repart vers `/login?error=…` et s'écrit `auth.sso.login.failed` |

### Compte

| Route | Méthodes | Permission |
|---|---|---|
| `/api/account/password` | POST | session — `currentPassword` obligatoire |
| `/api/account/two-factor/setup` | POST | session |
| `/api/account/two-factor/activate` | POST | session |
| `/api/account/two-factor/disable` | POST | session — `409 two_factor_locked` quand la politique de l'instance l'exige de ce compte |
| `/api/account/avatar` | PUT / DELETE | session — le corps **est** l'image (`content-type: image/…`), 512 Kio au plus, recadrée par le navigateur ; format et dimensions relus dans les octets |
| `/api/users/:id/avatar` | GET | session — immuable avec `?v=`, l'URL que porte `users.image` |
| `/api/tokens` | GET / POST | membre de l'équipe¹, depuis le panel — ses jetons ; POST `{ name, permissions, applicationIds?, expiresInDays? }` (30, 90 ou 365, `null` sans échéance ; 90 par défaut) rend le jeton **une seule fois**. Une permission que l'auteur n'a pas : `403`. 25 jetons en service au plus |
| `/api/tokens/:id` | DELETE | le sien, ou `user:manage` — révoque ; le jeton reste en base, révoqué |

### Utilisateurs et rôles

| Route | Méthodes | Permission |
|---|---|---|
| `/api/admin/users` | GET / POST | `user:read` / `user:manage` |
| `/api/admin/users/:id` | GET / DELETE | `user:read` / `user:manage` |
| `/api/admin/users/:id/role` | PATCH | `user:manage` |
| `/api/admin/users/:id/status` | PATCH | `user:manage` |
| `/api/admin/users/:id/two-factor` | DELETE | **`user:reset-2fa`** |
| `/api/admin/users/:id/avatar` | DELETE | `user:manage` — modération d'une photo, tracée à l'audit |
| `/api/admin/roles` | GET / POST | `role:read` / `role:manage` |
| `/api/admin/roles/:key` | GET / PATCH / DELETE | `role:read` / `role:manage` / `role:manage` |
| `/api/admin/tokens` | GET | `user:read`, depuis le panel — tous les jetons de l'instance, avec leur auteur |

### Cibles

| Route | Méthodes | Permission |
|---|---|---|
| `/api/targets` | GET / POST | `target:read` / `target:create` — credential chiffré avant insertion |
| `/api/targets/:id` | GET / PATCH / DELETE | `target:read` / `target:update` / `target:delete` |
| `/api/targets/:id/preflight` | POST | `target:update` — enfile, rend `202 { jobId }` |
| `/api/targets/:id/host-key` | POST | `target:update` — `{ decision: accept \| dismiss }` : trancher une clé d'hôte inattendue — l'accepter (machine réinstallée) ou garder l'ancienne ; 409 si rien n'est en attente. Tracé avec les deux empreintes |
| `/api/targets/:id/metrics` | GET | `target:read` — relevé d'hôte, par la file |
| `/api/targets/:id/ports` | GET | `target:read` — plage, alloués, libres, et par qui |
| `/api/targets/:id/workloads` | GET | `workload:read` |
| `/api/targets/:id/workloads/events` | GET | `workload:read` — SSE ; `?run=` : le flux d'une seule exécution, réservé à qui l'a ouverte |
| `/api/targets/:id/workloads/:ref` | DELETE | `workload:manage` |
| `/api/targets/:id/workloads/:ref/update` | POST | `workload:manage` |
| `/api/targets/:id/workloads/:ref/control` | POST | `workload:manage` — `{ action: start \| stop \| restart }`, `202` |
| `/api/targets/:id/workloads/:ref/logs` | POST | `workload:manage` — `{ run, tail }`, les lignes reviennent par le flux `?run=` |
| `/api/targets/:id/workloads/:ref/exec` | POST | `workload:exec` — `{ run, command }`, 30 par minute ; la sortie revient par le flux `?run=` |
| `/api/targets/:id/proxy` | GET / PUT / DELETE | `target:read` / `target:update` / `target:update` — GET : le proxy de la machine et les machines qu'il sert, ou la liaison au proxy d'une autre, plus les proxies auxquels la relier ; PUT relie un proxy **trouvé** (`{ kind, config }`), un test part aussitôt, 409 si la machine est reliée à un autre ; DELETE `?uninstall=1` défait ce que Pupitre a installé, 409 tant que des domaines passent par lui — ceux des machines qu'il sert compris |
| `/api/targets/:id/proxy/detect` | POST | `target:update` — ce que la machine porte et ce qu'on peut y installer, tous proxies confondus : chaque détection et chaque option dit son genre (`kind`), une option dit aussi son titre et les autorités qu'elle accepte (`acmeServers`) ; la route attend la tâche (60 s au plus) |
| `/api/targets/:id/proxy/install` | POST | `target:update` — `{ kind: traefik \| bunkerweb, option, acme }` (`kind` vaut `traefik` s'il manque), `202` ; la connexion passe `installing` puis `ok` ou `failed` ; une autorité que l'option n'accepte pas fait échouer l'installation, en le disant |
| `/api/targets/:id/proxy/check` | POST | `target:update` — « Tester », par la file |
| `/api/targets/:id/proxy/link` | PUT / DELETE | `target:update` — le proxy central : PUT `{ proxyId, address }` relie la machine au proxy d'une autre, joint à `address` (une IPv4 pour le Traefik d'un cluster, sinon 422), et lance le test de la liaison ; 409 si la machine a son propre proxy. DELETE délie, 409 tant que des domaines de la machine passent par lui |
| `/api/targets/:id/proxy/link/check` | POST | `target:update` — « Tester la liaison », par la file : adresse d'arrivée du proxy, adresse bien à la machine |
| `/api/proxies` | GET / POST | `target:read` / `target:update` — les proxies **distants**, hors des cibles (Nginx Proxy Manager), avec le nombre de machines qu'ils servent ; POST `{ kind, name?, config, secrets }` connecte une instance : le mot de passe est chiffré aussitôt, le test part et la route attend son issue — une connexion qui n'entre pas n'est pas gardée (422, avec ce qui ne va pas) |
| `/api/proxies/:id` | PATCH / DELETE | `target:update` — PATCH change l'adresse ou le compte (`secrets` absents : ceux d'avant restent) et rend le nouveau test ; DELETE retire la connexion, 409 tant que des domaines passent par elle — les machines qu'elle sert sans domaine en sont déliées |
| `/api/proxies/:id/check` | POST | `target:update` — « Tester » un proxy distant, par la file |
| `/api/targets/:id/dns` | GET | `target:read` — `?hostname=` : le domaine pointe-t-il vers cette machine ? Un avertissement, jamais un refus |

### Applications

| Route | Méthodes | Permission |
|---|---|---|
| `/api/applications` | GET / POST | `application:read` / `application:create` |
| `/api/applications/generate` | POST | `application:create` — 501 sans clé, 422 spec invalide, 502 fournisseur muet, 429 au-delà du quota |
| `/api/applications/from-source` | POST | `application:create` — créer une application **depuis son dépôt** : `{ provider: github \| gitea, repository, installationId (GitHub), branch, specPath, deployTo: none \| running, mode }` lit le `pupitre.json` au commit en tête, crée l'application et sa liaison sans cible ; `preview: true` lit et valide sans rien créer ; 422 fichier absent ou refusé, 409 nom déjà pris |
| `/api/applications/:id/sources` | GET / POST | `application:read` / `application:update` — les branches suivies ; POST relie une branche : `provider` (`github` par défaut, ou `gitea`), `installationId` pour GitHub seulement, `deployTo` (`targets` · `running` · `none`), cibles exigées pour `targets` ; 409 fournisseur non connecté ou dépôt qui ne lui est pas accessible |
| `/api/applications/:id/sources/:sourceId` | PATCH / DELETE | `application:update` — 422 si `deployTo: targets` sans cible |
| `/api/integrations/repositories` | GET | `application:update` — les dépôts lisibles, **tous fournisseurs confondus**, chacun avec son `provider` ; un fournisseur qui ne répond pas est nommé dans `errors` sans masquer les autres ; 409 si aucun n'est connecté |
| `/api/integrations/specs` | GET | `application:create` — les `pupitre.json` d'une branche (`provider`, `repository`, `installationId` pour GitHub, `branch` facultative), avec le commit lu |
| `/api/integrations/github` | GET / POST / DELETE | `settings:read` / `settings:manage` — la GitHub App : état et installations ; POST la connecte à la main (`appId`, clé privée) ; DELETE la déconnecte, ses liaisons avec. La clé n'est jamais rendue |
| `/api/integrations/github/manifest`, `/callback` | POST / GET | `settings:manage` — la création de l'App par manifeste, aller et retour par le navigateur |
| `/api/integrations/gitea` | GET / PUT / DELETE | `settings:read` / `settings:manage` — la forge Gitea / Forgejo : `{ url, token }` est essayé auprès de la forge avant d'être enregistré (502 si elle refuse), le jeton chiffré, jamais rendu ; PUT remplace aussi le jeton (409 si l'adresse change alors que des liaisons y passent) ; DELETE la déconnecte, ses liaisons avec |
| `/api/integrations/gitea/check` | POST | `settings:manage` — « Tester » : `{ url, token }` → `{ ok, login, version, baseUrl }` ou `{ ok: false, error }`, sans rien enregistrer |
| `/api/domains` | GET | `application:read` — tous les domaines de l'instance : proxy, état, certificat, `certificateDaysLeft`, et `attention` pour ceux qui ne répondent pas ou dont le certificat approche de l'échéance |
| `/api/domains/:id/inspect` | GET | `application:read` — le relevé d'un domaine, fait par le worker à l'instant : DNS (A, AAAA, CNAME, TTL), adresses et noms inverses, s'il mène à la machine du proxy, enregistrement RDAP (registrar, dates, serveurs de noms, statuts), zone (NS, MX, CAA), certificat présenté. Rien n'est écrit ; 30 relevés par 5 minutes et par personne |
| `/api/applications/:id` | GET / PATCH / DELETE | `application:read` ⓐ / `application:update` / `application:delete` |
| `/api/applications/:id/cascade` | GET / POST | GET : `application:delete` · POST : **union** `deployment:destroy` + `deployment:purge` + `application:delete` |
| `/api/applications/:id/redeploy` | POST | `deployment:create` ⓐ — une version construite depuis une archive qui n'est plus gardée : 409 `archive_gone` |
| `/api/applications/:id/archives` | GET / POST | `application:read` ⓐ / `application:update` ⓐ — le code téléversé. POST : le corps **est** l'archive (`.tar.gz`, `.tar`, `.zip`, reconnue à ses octets, 100 Mio au plus), son nom dans `x-archive-name` (encodé comme un composant d'URL) ; `202` avec `{ archive, jobId }`, le worker la lit ensuite (`status` : `pending` → `ready` ou `rejected`, avec `rejection` et `rejectionDetail`). 413 trop gros, 415 pas une archive, 409 application liée à un dépôt, 429 au-delà de 20 envois en dix minutes |
| `/api/applications/:id/archives/:archiveId` | GET / DELETE | `application:read` ⓐ / `application:update` ⓐ — son état et le rapport de lecture (`report` : fichiers, taille décompressée, dossier de tête retiré, Dockerfiles trouvés) ; jamais ses octets. DELETE : 409 tant qu'un déploiement en cours la construit |
| `/api/applications/:id/images` | GET | `application:read` — dernier constat des images, cible par cible |
| `/api/applications/:id/images/check` | POST | `application:read` — « Vérifier maintenant », par la file, 6 par minute |
| `/api/applications/:id/versions` | GET | `application:read` |
| `/api/applications/:id/secrets` | GET | `application:read` — **jamais de valeur** |
| `/api/applications/:id/secrets/:name` | PUT / DELETE | `application:update` |
| `/api/applications/:id/routes` | GET / PUT | `application:read` / `deployment:create` — les domaines, cible par cible ; PUT `{ targetId, routes }` remplace la liste et la pose sur le proxy si l'application tourne — chaque route `{ hostname, tls, redirectHttps, waf }`, `waf` (`block` \| `detect` \| `off`, `block` par défaut) n'ayant d'effet que derrière un proxy qui est un WAF ; 409 si un domaine est déjà pris, ou si le proxy est en cours d'installation |
| `/api/applications/:id/backups` | GET / POST | `backup:read` / `backup:manage` — POST : « Sauvegarder maintenant » `{ targetId }`, `202` ; 409 sans destination, sans volume, sans déploiement en service ou pendant une autre sauvegarde |
| `/api/applications/:id/backup-policy` | PUT | `backup:manage` — automatique, avant déploiement, mode, rétention ; crée ou réactive la tâche « Sauvegardes des applications » |

### Déploiements

| Route | Méthodes | Permission |
|---|---|---|
| `/api/deployments` | GET / POST | `deployment:read` / `deployment:create` ⓐ (+ `scan:configure` si un `scanConfig` est fourni ; un `backup` n'est retenu qu'avec `backup:manage`, et seulement si l'application n'a pas encore de politique ; `domains` remplace les domaines de l'application sur la cible avant le déploiement ; `images` — `{ "web": "ghcr.io/acme/web:4f2c1e9" }` — remplace l'image de ces services et enregistre l'AppSpec, avec **`application:update`** en plus, refusé pour une application liée à un dépôt). Sans dépôt lié, un service qui se construit prend la dernière archive téléversée ; sinon 409 `source_code_missing`, `archive_pending`, `archive_rejected` ou `archive_dockerfile_missing`, avant que rien ne parte. Le détail d'un déploiement nomme son archive (`sourceArchiveName`, `sourceArchiveSha256`) comme son commit |
| `/api/deployments/:id` | GET / DELETE | `deployment:read` ⓐ / **`deployment:destroy`** |
| `/api/deployments/:id/purge` | DELETE | **`deployment:purge`** |
| `/api/deployments/purge` | POST | `deployment:purge` — en masse, `dryRun` compris |
| `/api/deployments/:id/rollback` | POST | `deployment:rollback` ⓐ |
| `/api/deployments/:id/logs` | GET | `deployment:read` ⓐ — **SSE**, historique puis direct |
| `/api/deployments/:id/logs/export` | GET | `deployment:read` — texte ou JSONL |
| `/api/deployments/:id/scans` | GET | `scan:read` |

### Supervision des applications en marche

| Route | Méthodes | Permission |
|---|---|---|
| `/api/apps` | GET | `deployment:read` |
| `/api/apps/:id/logs` | GET | `deployment:read` — SSE |
| `/api/apps/:id/restart` | POST | `deployment:restart` |

### Sécurité

| Route | Méthodes | Permission |
|---|---|---|
| `/api/scans/:id` | GET | `scan:read` — findings paginés, filtre `severity` |
| `/api/scans/:id/sbom` | GET | `scan:read` — 409 si le scanner n'en produit pas |
| `/api/findings` | GET | `scan:read` — vue transverse, filtres `cveId` `severity` `applicationId` `deploymentId` `scanner` |

### Sondes

| Route | Méthodes | Permission |
|---|---|---|
| `/api/monitors` | GET / POST | `monitor:read` / `monitor:manage` |
| `/api/monitors/:id` | GET / PATCH / DELETE | `monitor:read` / `monitor:manage` / `monitor:manage` |
| `/api/monitors/:id/check` | POST | `monitor:manage` — « sonder maintenant » |

### Prévisions

| Route | Méthodes | Permission |
|---|---|---|
| `/api/forecasts` | GET | session — les prévisions en cours, chacune rendue seulement à qui peut lire son sujet (`target:read`, `monitor:read`, `application:read`). « Bientôt » d'abord, puis par échéance ; voir [supervision](supervision.md#prévisions) |

### Fenêtres de maintenance

| Route | Méthodes | Permission |
|---|---|---|
| `/api/maintenance-windows` | GET / POST | `maintenance:read` / `maintenance:manage` — en cours et à venir, puis les vingt dernières terminées ; chaque sujet n'est rendu qu'à qui peut le lire. Choisir des sujets demande de pouvoir les lire |
| `/api/maintenance-windows/:id` | GET / PATCH / DELETE | `maintenance:read` / `maintenance:manage` / `maintenance:manage` — GET ajoute les alertes retenues. PATCH `{ "endsAt": maintenant }` termine la fenêtre ; une fenêtre terminée répond `409`. DELETE refuse une fenêtre en cours (`409`) : on la termine |

### Pages de statut

| Route | Méthodes | Permission |
|---|---|---|
| `/api/status-pages` | GET / POST | `status_page:manage` — une adresse déjà prise répond `409` ; chaque sonde nommée doit exister |
| `/api/status-pages/:id` | GET / PATCH / DELETE | `status_page:manage` |
| `/api/status-pages/preview` | POST | `status_page:manage` — la page telle qu'un visiteur la lirait, calculée sur des blocs non enregistrés ; rien n'est écrit |
| `/api/status-updates` | GET / POST | `status_page:announce` — GET `?subject=incident:<id>` (ou `maintenance:<id>`) : les annonces du sujet ; POST `{ "subject": { "type": "incident", "id": … }, "phase": "identified", "message": … }`, phase propre au sujet (`422` sinon), sujet inexistant `404` |
| `/api/status-updates/:id` | PATCH / DELETE | `status_page:announce` — PATCH `{ "phase"?, "message"? }` corrige sans changer l'heure de publication |

### Tâches et file

| Route | Méthodes | Permission |
|---|---|---|
| `/api/jobs` | GET / POST | `job:read` / `job:manage` — tâches **planifiées** |
| `/api/jobs/:id` | GET / PATCH / DELETE | `job:read` / `job:manage` / `job:manage` |
| `/api/jobs/:id/run` | POST | `job:manage` — une occurrence hors calendrier, `202` |
| `/api/queue/jobs/:id` | GET | `job:read` — état d'un job **BullMQ** |
| `/api/ping` · `/api/ping/:id` | POST / GET | `job:manage` / `job:read` |

`/api/jobs` désigne les tâches planifiées, `/api/queue/jobs/:id` l'état d'un job
dans la file. Une même route ne pouvait pas répondre à la fois à « où en est le
job n° 42 » et à « modifie la tâche planifiée `<uuid>` » : deux ressources, deux
chemins.

### Sauvegardes

| Route | Méthodes | Permission |
|---|---|---|
| `/api/backups/destination` | GET / PUT / DELETE | `settings:read` / `settings:manage` — **secrets jamais rendus**, seulement leurs noms ; PUT enfile un test, `202` |
| `/api/backups/destination/check` | POST | `settings:manage` — « Tester », par la file |
| `/api/backups/panel` | GET / POST | `settings:read` / `settings:manage` — POST : sauvegarde de la base du panel, `202` |
| `/api/backups/panel/schedule` | PUT | `settings:manage` — `{ enabled }`, la tâche « Sauvegarde du panel » |
| `/api/backups/:id` | DELETE | `backup:manage` (+ `settings:manage` pour une sauvegarde du panel) — efface sur la destination puis dans l'index, `202` |
| `/api/backups/:id/restore` | POST | **`backup:restore`** — `{ targetId, safetyBackup }`, `202` ; 409 si l'application est arrêtée, absente de la cible ou occupée |

La base du panel ne se restaure pas par l'API : on ne remplace pas la base d'un
processus qui s'en sert. C'est la ligne de commande, panel et worker arrêtés —
voir [`exploitation.md`](exploitation.md#restaurer-la-base-du-panel).

### Discussion

| Route | Méthodes | Permission |
|---|---|---|
| `/api/chat/messages` | GET / POST | membre de l'équipe¹ — POST en JSON, ou en `multipart/form-data` avec des images (champ `image`, quatre au plus, 3 Mo chacune) ; une image seule suffit |
| `/api/chat/messages/:id` | DELETE | l'auteur, ou `user:manage` — efface aussi les images |
| `/api/chat/messages/:id/reactions` | POST | membre de l'équipe¹ |
| `/api/chat/attachments/:id` | GET | membre de l'équipe¹ — immuable ; 404 si le message a été effacé |
| `/api/chat/read` | POST | membre de l'équipe¹ |
| `/api/chat/directory` | GET | membre de l'équipe¹ — ce que la session peut mentionner |
| `/api/presence` | POST | membre de l'équipe¹ |
| `/api/search` | GET | une session — la palette ⌘K. `q`, et `kinds` (`target,application,running,deployment,monitor,domain,role,template`) pour restreindre ; chaque famille n'est lue qu'avec sa permission de lecture (le catalogue : `application:create`). Correspondance tolérante : accents, débuts de mots, lettres dans l'ordre, fautes de frappe |

¹ Une session dont le rôle porte au moins une permission (`requireTeamMember()`). Un compte
**Sans accès** — une inscription publique qui attend son rôle — reçoit `403 no_access`, et le flux
temps réel ne lui porte ni la discussion ni la présence.

### Paramètres, notifications, journal

| Route | Méthodes | Permission |
|---|---|---|
| `/api/settings` | GET / PATCH | `settings:read` / `settings:manage` — **une seule route pour toutes les sections**. `ssoClientSecret` suit la convention d'`aiApiKey` (absent : inchangé, `null` : effacé) ; la lecture rend `ssoClientSecretConfigured` et `ssoStatus` (`active`, `error`, `callbackUrl`) — jamais le secret. Un rôle inconnu dans `sso.roleMappings` ou `sso.defaultRole` : 422. `accounts` : `twoFactorPolicy` (`off`, `sensitive`, `all`), `sessionIdleHours` (1, 8, 24, 168, 720), `sessionMaxHours` (24, 168, 720 ou `null`) ; une politique qui exigerait de son auteur un second facteur qu'il n'a pas : `409 two_factor_self` |
| `/api/settings/sso/check` | POST | `settings:manage`, depuis le panel — « Tester » : `{ issuer }` → `{ ok, issuer, endpoints }` ou `{ ok: false, error }`, sans rien enregistrer |
| `/api/notifications/channels` | GET / POST | `settings:read` / `settings:manage` |
| `/api/notifications/channels/:id` | GET / PATCH / DELETE | `settings:read` / `settings:manage` / `settings:manage` |
| `/api/notifications/channels/:id/test` | POST | `settings:manage` |
| `/api/audit-logs` | GET | `audit:read` — paginé, filtres `q` (recherche libre : action, ressource, acteur, IP, charge utile) `severity` (`high,critical`) `actorId` `action` `resourceType` `from` `to` ; chaque entrée porte sa `severity` |
| `/api/onboarding` | GET / PATCH | session — `restart` exige `settings:manage` |
