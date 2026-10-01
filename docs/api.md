# Pages et API

Toutes les routes passent par `apiRoute()`, qui traduit les erreurs typées en
réponses HTTP — sauf `/api/health` et `/api/auth/[...all]`. Aucune route ne
fabrique de 401/403 à la main, et **tout refus est audité**.

« session » veut dire : authentifié, sans permission particulière.

## Pages

### Exploitation

| Route | Rôle | Accès |
|---|---|---|
| `/` | Tableau de bord — anomalies d'abord, inventaire en dernier | session ; chaque bloc filtré par sa permission |
| `/targets` | Parc de machines, preflight, suppression | `target:read` |
| `/targets/new` · `/targets/:id/edit` | Déclarer / modifier — credential jamais pré-rempli | `target:create` / `target:update` |
| `/targets/:id` | Preflight, métriques, jauge des ports, charges qui y tournent | `target:read` |
| `/applications` | Catalogue des AppSpec déclarées | `application:read` |
| `/applications/new` | Deux onglets : « Depuis une description » (IA) et « Depuis un JSON » | `application:create` |
| `/applications/:id` | AppSpec, secrets, historique des versions, redéploiement ; sauvegardes avec `backup:read` | `application:read` |
| `/apps` | **Supervision, vue par serveur** — une carte par machine, dépliable | `deployment:read` |
| `/apps/:id` | Une application en marche : santé, logs live, redémarrage | `deployment:read` |
| `/deployments` | Journal des runs, filtres, purge en masse | `deployment:read` |
| `/deployments/:id` | Pipeline, logs SSE, scans, rollback, destruction | `deployment:read` |
| `/monitors` | Sondes HTTP et TLS | `monitor:read` |
| `/monitors/:id` | Historique de mesures et incidents d'une sonde | `monitor:read` |
| `/jobs` | Tâches planifiées, cron traduit en français, historique déroulant | `job:read` |

### Administration

| Route | Rôle | Accès |
|---|---|---|
| `/admin/logs` | **Logs d'activité** — table paginée, filtres | `audit:read` |
| `/admin/users` | Comptes : création, statut, rôle, réinitialisation du 2FA | `user:manage` |
| `/admin/roles` | Rôles et leurs permissions | `role:read` |
| `/admin/settings` | Sommaire, en lecture seule | `settings:read` |
| `/admin/settings/{identite,regionalisation,securite,notifications,ia,integrations,sauvegardes,demarrage}` | Les huit sections | `settings:read` — écriture `settings:manage` |

### Hors navigation

| Route | Rôle | Accès |
|---|---|---|
| `/account` | Mon compte — mot de passe, TOTP | session |
| `/onboarding` | Assistant de démarrage, coquille sans rail | session |
| `/login` · `/signup` · `/logout` | | publiques |
| `/forbidden` | Écran de refus, **nomme la permission manquante** | publique |

Le rail de navigation porte deux groupes — « Exploitation » (Tableau de bord,
Cibles, Applications, Supervision, Sondes, Déploiements, Tâches) et
« Administration » (**Logs**, Utilisateurs, Rôles, Paramètres). Chaque entrée
n'apparaît qu'avec la permission qui va avec ; un groupe vide ne s'affiche pas.
« Mon compte » et « Déconnexion » vivent en pied de rail, volontairement hors de
la navigation métier.

## API

### Santé et authentification

| Route | Méthodes | Permission |
|---|---|---|
| `/api/health` | GET | **publique** — `{ status, db, redis, ai }`, 200 ou 503 |
| `/api/auth/[...all]` | GET POST | publique — Better Auth ; audite connexions et déconnexions |

### Compte

| Route | Méthodes | Permission |
|---|---|---|
| `/api/account/password` | POST | session — `currentPassword` obligatoire |
| `/api/account/two-factor/setup` | POST | session |
| `/api/account/two-factor/activate` | POST | session |
| `/api/account/two-factor/disable` | POST | session |
| `/api/account/avatar` | PUT / DELETE | session — le corps **est** l'image (`content-type: image/…`), 512 Kio au plus, recadrée par le navigateur ; format et dimensions relus dans les octets |
| `/api/users/:id/avatar` | GET | session — immuable avec `?v=`, l'URL que porte `users.image` |

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

### Cibles

| Route | Méthodes | Permission |
|---|---|---|
| `/api/targets` | GET / POST | `target:read` / `target:create` — credential chiffré avant insertion |
| `/api/targets/:id` | GET / PATCH / DELETE | `target:read` / `target:update` / `target:delete` |
| `/api/targets/:id/preflight` | POST | `target:update` — enfile, rend `202 { jobId }` |
| `/api/targets/:id/metrics` | GET | `target:read` — relevé d'hôte, par la file |
| `/api/targets/:id/ports` | GET | `target:read` — plage, alloués, libres, et par qui |
| `/api/targets/:id/workloads` | GET | `workload:read` |
| `/api/targets/:id/workloads/events` | GET | `workload:read` — SSE ; `?run=` : le flux d'une seule exécution, réservé à qui l'a ouverte |
| `/api/targets/:id/workloads/:ref` | DELETE | `workload:manage` |
| `/api/targets/:id/workloads/:ref/update` | POST | `workload:manage` |
| `/api/targets/:id/workloads/:ref/control` | POST | `workload:manage` — `{ action: start \| stop \| restart }`, `202` |
| `/api/targets/:id/workloads/:ref/logs` | POST | `workload:manage` — `{ run, tail }`, les lignes reviennent par le flux `?run=` |
| `/api/targets/:id/workloads/:ref/exec` | POST | `workload:exec` — `{ run, command }`, 30 par minute ; la sortie revient par le flux `?run=` |

### Applications

| Route | Méthodes | Permission |
|---|---|---|
| `/api/applications` | GET / POST | `application:read` / `application:create` |
| `/api/applications/generate` | POST | `application:create` — 501 sans clé, 422 spec invalide, 502 fournisseur muet, 429 au-delà du quota |
| `/api/applications/:id` | GET / PATCH / DELETE | `application:read` / `application:update` / `application:delete` |
| `/api/applications/:id/cascade` | GET / POST | GET : `application:delete` · POST : **union** `deployment:destroy` + `deployment:purge` + `application:delete` |
| `/api/applications/:id/redeploy` | POST | `deployment:create` |
| `/api/applications/:id/images` | GET | `application:read` — dernier constat des images, cible par cible |
| `/api/applications/:id/images/check` | POST | `application:read` — « Vérifier maintenant », par la file, 6 par minute |
| `/api/applications/:id/versions` | GET | `application:read` |
| `/api/applications/:id/secrets` | GET | `application:read` — **jamais de valeur** |
| `/api/applications/:id/secrets/:name` | PUT / DELETE | `application:update` |
| `/api/applications/:id/backups` | GET / POST | `backup:read` / `backup:manage` — POST : « Sauvegarder maintenant » `{ targetId }`, `202` ; 409 sans destination, sans volume, sans déploiement en service ou pendant une autre sauvegarde |
| `/api/applications/:id/backup-policy` | PUT | `backup:manage` — automatique, avant déploiement, mode, rétention ; crée ou réactive la tâche « Sauvegardes des applications » |

### Déploiements

| Route | Méthodes | Permission |
|---|---|---|
| `/api/deployments` | GET / POST | `deployment:read` / `deployment:create` (+ `scan:configure` si un `scanConfig` est fourni ; un `backup` n'est retenu qu'avec `backup:manage`, et seulement si l'application n'a pas encore de politique) |
| `/api/deployments/:id` | GET / DELETE | `deployment:read` / **`deployment:destroy`** |
| `/api/deployments/:id/purge` | DELETE | **`deployment:purge`** |
| `/api/deployments/purge` | POST | `deployment:purge` — en masse, `dryRun` compris |
| `/api/deployments/:id/rollback` | POST | `deployment:rollback` |
| `/api/deployments/:id/logs` | GET | `deployment:read` — **SSE**, historique puis direct |
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
| `/api/chat/messages` | GET / POST | session — POST en JSON, ou en `multipart/form-data` avec des images (champ `image`, quatre au plus, 3 Mo chacune) ; une image seule suffit |
| `/api/chat/messages/:id` | DELETE | l'auteur, ou `user:manage` — efface aussi les images |
| `/api/chat/messages/:id/reactions` | POST | session |
| `/api/chat/attachments/:id` | GET | session — immuable ; 404 si le message a été effacé |
| `/api/chat/read` | POST | session |
| `/api/chat/directory` | GET | session — ce que la session peut mentionner |

### Paramètres, notifications, journal

| Route | Méthodes | Permission |
|---|---|---|
| `/api/settings` | GET / PATCH | `settings:read` / `settings:manage` — **une seule route pour les six sections** |
| `/api/notifications/channels` | GET / POST | `settings:read` / `settings:manage` |
| `/api/notifications/channels/:id` | GET / PATCH / DELETE | `settings:read` / `settings:manage` / `settings:manage` |
| `/api/notifications/channels/:id/test` | POST | `settings:manage` |
| `/api/audit-logs` | GET | `audit:read` — paginé, filtres `actorId` `action` `resourceType` `from` `to` |
| `/api/onboarding` | GET / PATCH | session — `restart` exige `settings:manage` |
