# Base de données

PostgreSQL 16, Drizzle, migrations SQL versionnées dans
`packages/db/migrations/`. **Une migration appliquée ne se modifie jamais** — on
en crée une nouvelle.

`packages/db` est la source unique du modèle : ni `apps/web` ni `apps/worker`
n'écrivent de SQL, et les drivers n'ont pas le droit de connaître une table.

## Les 25 tables

| Domaine | Tables |
|---|---|
| Authentification | `users` `sessions` `accounts` `verifications` `two_factors` |
| RBAC | `roles` `permissions` `role_permissions` `user_roles` |
| Infrastructure | `targets` `applications` `application_secrets` |
| Déploiement | `deployments` `deployment_steps` `port_allocations` |
| Sécurité | `scan_runs` `findings` |
| Supervision | `monitors` `monitor_checks` `monitor_incidents` |
| Automatisation | `scheduled_jobs` `scheduled_job_runs` |
| Divers | `audit_logs` `app_settings` `notification_channels` |

Dix-sept d'entre elles ont été créées dès la première migration — y compris
celles qui ne serviraient que bien plus tard — pour n'avoir aucune migration
structurelle en cours de projet. Le schéma `users` / `sessions` / `accounts` /
`verifications` correspondait déjà champ pour champ à ce qu'attend Better Auth,
plugin `admin` compris : **l'arrivée de l'authentification n'a demandé aucune
migration**.

Tous les statuts sont des **enums Postgres**, jamais des `text` libres.

## Trois invariants tenus par la base, pas par du TypeScript

**`port_allocations (target_id, port)` est unique.** C'est l'anti-collision de
ports. Deux workers qui visent le même port produisent une violation `23505`, et
celui qui perd rejoue. Il n'y a pas de `if` à trouver dans le code.

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

Au 12/09/2026, une quatorzième migration (`0013`, regroupement des
notifications) est en cours d'écriture dans un chantier parallèle : elle est
dans l'arbre de travail, pas encore appliquée. Les 25 tables ci-dessus sont
celles d'une base à jour des treize premières.

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
