# Base de données

PostgreSQL 16, Drizzle, migrations SQL versionnées dans
`packages/db/migrations/`. **Une migration appliquée ne se modifie jamais** — on
en crée une nouvelle.

`packages/db` est la source unique du modèle : ni `apps/web` ni `apps/worker`
n'écrivent de SQL, et les drivers n'ont pas le droit de connaître une table.

## Les 48 tables

| Domaine | Tables |
|---|---|
| Authentification | `users` `sessions` `accounts` `verifications` `two_factors` `user_avatars` |
| RBAC | `roles` `permissions` `role_permissions` `user_roles` `api_tokens` |
| Infrastructure | `targets` `applications` `application_secrets` |
| Dépôts liés | `source_connections` `application_sources` `application_source_targets` `source_proposals` |
| Déploiement | `deployments` `deployment_steps` `port_allocations` `image_updates` |
| Sécurité | `scan_runs` `findings` |
| Supervision | `monitors` `monitor_checks` `monitor_incidents` `monitor_captures` `target_metric_samples` `target_metric_thresholds` `target_metric_breaches` |
| Automatisation | `scheduled_jobs` `scheduled_job_runs` |
| Notifications | `notification_channels` `notification_policy` `notification_digest_groups` `notification_digest_items` |
| Discussion | `chat_messages` `chat_reactions` `chat_reads` `chat_attachments` |
| Sauvegardes | `backup_destinations` `backup_policies` `backups` |
| Reverse proxies | `proxies` `routes` `proxy_links` |
| Divers | `audit_logs` `app_settings` |

Dix-sept d'entre elles ont été créées dès la première migration — y compris
celles qui ne serviraient que bien plus tard — pour n'avoir aucune migration
structurelle en cours de projet. Le schéma `users` / `sessions` / `accounts` /
`verifications` correspondait déjà champ pour champ à ce qu'attend Better Auth,
plugin `admin` compris : **l'arrivée de l'authentification n'a demandé aucune
migration**.

Tous les statuts sont des **enums Postgres**, jamais des `text` libres.

### Les octets en base

Trois tables portent des images, en `bytea` : `monitor_captures` (ce que la
sonde a vu), `user_avatars` (une photo de profil par personne) et
`chat_attachments` (les images de la discussion). Pas de volume de fichiers à
côté : la base est **la seule chose à sauvegarder**, et une suppression en
cascade emporte les octets avec la ligne.

Chacune est bornée à l'entrée : une capture est un JPEG plafonné et purgé à
90 jours, une photo de profil un carré de 256 px (512 Kio au plus), une image
de discussion 3 Mo au plus, quatre par message, réencodée par le navigateur.
Le format et les dimensions sont **relus dans les octets** par le serveur
(`sniffImage()`), jamais pris dans l'en-tête de la requête — et le SVG n'est
pas accepté. Aucun écran ne lit une colonne `bytea` dans une liste : seule la
route qui sert l'image charge les octets.

## Quatre invariants tenus par la base, pas par du TypeScript

**`port_allocations (target_id, port)` est unique.** C'est l'anti-collision de
ports. Deux workers qui visent le même port produisent une violation `23505`, et
celui qui perd rejoue. Il n'y a pas de `if` à trouver dans le code.

**`routes.hostname` est unique.** Deux applications ne peuvent pas réclamer le
même domaine : celui qui perd la course reçoit une `23505`, traduite en « déjà
routé vers… ». Et **`proxies_host_target_unique`**, index unique partiel, tient
un seul reverse proxy par machine. **`proxy_links.target_id`** est la clé
primaire : une machine passe par le proxy d'une autre au plus — et l'API
refuse qu'elle ait à la fois le sien et une liaison.

**`targets_port_range_check`** interdit une plage inversée, en plus de Zod.

**`monitor_incidents_open_idx`**, index unique partiel sur `(monitor_id) where
resolved_at is null`, interdit structurellement deux incidents ouverts sur la
même sonde. La logique d'ouverture peut se tromper ; la base, non.

Et **`app_settings` est un singleton**, tenu par `check (id = 1)`.

## Ce qui n'a délibérément pas de table

**Il n'y a pas de table « versions ».** Le déploiement *est* la version, et son
`app_spec` figée est ce qui rend un redéploiement possible des mois plus tard,
même si l'application a changé depuis.

**Les métriques d'hôte ne sont pas stockées.** Le relevé voyage par la valeur de
retour du job et meurt avec elle — pas de table, pas de rétention. Voir
[`supervision.md`](supervision.md#les-métriques-dhôte).

**Les paramètres tiennent dans un seul JSONB**, pour qu'ajouter un réglage ne
coûte pas une migration. Les canaux de notification, eux, ont mérité leur table :
ils sont multiples, nommés, et portent chacun un état d'exécution.

**Le SBOM n'a pas de colonne dédiée** : il *est* la sortie brute de l'outil qui
le produit, donc il vit dans `scan_runs.raw`. Une colonne le dupliquerait octet
pour octet, et il faudrait décider laquelle fait foi.

**`scheduled_job_runs` est une table et non des lignes d'`audit_logs`**, parce que
ce ne sont pas les mêmes questions. Le journal répond à « qui a fait quoi » :
append-only, lu par un humain qui enquête. L'historique des exécutions répond à
« le scan de 4 h a-t-il tourné, combien de temps, et qu'a-t-il trouvé » : cadré
par une clé étrangère, purgé avec sa tâche.

**`audit_logs.resource_id` est un `text` sans clé étrangère** — le journal
survit à ce qu'il décrit, et c'est voulu. Purger un déploiement ne purge pas sa
trace.

**Les sauvegardes ne sont pas en base, seulement leur index.** `backups` dit où
chacune a été déposée (`destination_id`, `location`) et ce qu'elle contient
(`manifest`) ; les octets sont sur la destination, avec un manifeste chiffré qui
suffit à les relire sans le panel. Une sauvegarde **survit à son application**
(`application_id` passe à `null`, `application_slug` garde le nom) : supprimer
une application n'efface pas ses données de la destination. Et une destination
changée de lieu n'est pas modifiée mais remplacée, pour que `destination_id`
désigne toujours l'endroit où sont vraiment les fichiers.

## Les 13 migrations

| Migration | Contenu |
|---|---|
| `0000_rainy_prodigy` | les 17 tables initiales |
| `0001_ambitious_mordo` | `targets.sudo_method`, `targets.labels`, `target_status` passe à `unknown \| ok \| degraded \| unreachable`, `runtimes_available` devient un objet structuré |
| `0002_awesome_next_avengers` | `deployment_steps.log`, `deployments.app_spec` (AppSpec figée), `published_port`, `failed_step` |
| `0003_omniscient_redwing` | `deployments.scan_config` — scanners retenus et seuil, figés au déploiement |
| `0004_sparkling_skin` | `targets.port_range_start` / `port_range_end` (défaut 30000-32767) avec `targets_port_range_check`, et `deployments.auto_rollback` |
| `0005_sad_gorgon` | provenance IA sur `applications`, santé constatée sur `deployments` (`health_status` + son enum), et la table `scheduled_job_runs` |
| `0006_legal_slayback` | `roles.locked` et `roles.updated_at` — les rôles deviennent des données modifiables, avec `admin` verrouillé |
| `0007_odd_earthquake` | la table `app_settings` : singleton, JSONB, et `ai_api_key_encrypted` dans sa propre colonne |
| `0008_real_wendell_rand` | la table `two_factors` et `users.two_factor_enabled` |
| `0009_public_deathbird` | `scheduled_jobs.timezone` — voir ci-dessous |
| `0010_cheerful_red_skull` | l'enum `secret_origin` et la table `application_secrets`, avec l'index unique `(application_id, name)` |
| `0011_mushy_firelord` | les trois tables de supervision de sites, dont l'index unique partiel sur l'incident ouvert |
| `0012_bent_may_parker` | l'enum `notification_channel_kind` et la table `notification_channels` |

La liste s'arrête aux treize premières ; les suivantes — jusqu'à
`0027_reverse_proxy`, les connexions et les routes, avec la reprise de ce qui
était routé avant, `0028_central_proxy`, les liaisons d'une machine au proxy
d'une autre, `0029_route_waf`, l'enum `waf_mode` et la protection de chaque
domaine (`routes.waf`, `block` par défaut), `0030_source_deploy_to`, où part
le commit d'une branche liée et le commit dont l'application porte la version,
`0031_proxy_npm`, le genre `npm` des proxies distants, et
`0032_target_host_key`, la clé d'hôte retenue d'une cible et celle qui attend une
décision, `0033_drop_deployment_proxy`, qui retire `deployments.proxy` — un
reste du premier modèle, où le proxy se choisissait par déploiement —, et
`0034_roles_auditor_no_access`, qui ajoute les rôles `auditor` et `no-access` à
une base existante et resserre `viewer` s'il n'a jamais été modifié, et
`0035_api_tokens`, les jetons d'API (`api_tokens`, l'empreinte seule) et le jeton
qui a porté chaque entrée du journal (`audit_logs.api_token_id`), se lisent dans
`packages/db/migrations/`.

### Deux arbitrages qui se lisent dans le SQL

**`0009` pose `UTC` sur les tâches existantes, pas le fuseau de l'instance.** Ces
tâches ont été créées quand `upsertJobScheduler` était appelé sans option `tz` ;
cron-parser retombait sur le fuseau du process, et les conteneurs n'ont pas de
`TZ` : elles tournent donc en UTC. Poser rétroactivement `Europe/Paris` ferait
passer un `0 3 * * *` de 03:00 à 01:00 UTC — on aurait **déplacé l'exécution
d'une tâche que personne n'a demandé à changer**, sans trace et sans
avertissement. Le fuseau d'instance ne vaut donc que pour les tâches créées
ensuite, et il est appliqué côté application, pas dans la migration.

**L'enum `scheduled_job_type` n'a jamais été migrée.** Elle vaut
`scan | healthcheck | preflight | cleanup` depuis le début, là où les tâches
BullMQ s'appellent `scan:periodic`, `health:periodic`, `cleanup:versions`,
`target:preflight`. Les quatre valeurs recouvrent exactement les quatre tâches :
migrer une enum Postgres pour un renommage cosmétique, sur une table déjà
appliquée, aurait coûté une migration délicate sans rien apporter. Le nom BullMQ
vit dans `scheduled_jobs.key`, qui *est* l'identifiant du scheduler côté BullMQ —
c'est sa raison d'être. La correspondance type → tâche est une table de données,
`SCHEDULED_JOB_TYPES` ; il n'existe nulle part de `if (type === 'scan')`.

Deux noms diffèrent aussi entre `findings` et le rapport normalisé
(`findings.version` = `installedVersion`, `findings.reference` = `primaryUrl`) ;
la traduction vit dans `packages/db/src/scans.ts`, pas dans une migration.
