import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Tous les statuts sont des enums Postgres, jamais des varchar libres.
 * Ajouter une valeur = une nouvelle migration, jamais une édition de l'existante.
 */

export const runtimeEnum = pgEnum('runtime', ['docker', 'k3s']);

export const proxyEnum = pgEnum('proxy', ['traefik', 'bunkerweb']);

export const sshAuthMethodEnum = pgEnum('ssh_auth_method', ['key', 'password']);

/**
 * Statut d'une cible après preflight.
 *   ok          au moins un runtime exploitable
 *   degraded    la machine répond, mais rien n'y est déployable
 *   unreachable session SSH impossible
 */
export const targetStatusEnum = pgEnum('target_status', [
  'unknown',
  'ok',
  'degraded',
  'unreachable',
]);

/** Comment le worker obtient les privilèges root sur la cible. */
export const sudoMethodEnum = pgEnum('sudo_method', ['nopasswd', 'password']);

export const deploymentStatusEnum = pgEnum('deployment_status', [
  'pending',
  'running',
  'success',
  'failed',
  'rolled_back',
  'destroyed',
]);

export const stepStatusEnum = pgEnum('step_status', [
  'pending',
  'running',
  'success',
  'failed',
  'skipped',
]);

export const scannerEnum = pgEnum('scanner', ['trivy', 'grype', 'syft']);

export const scanStatusEnum = pgEnum('scan_status', [
  'pending',
  'running',
  'success',
  'failed',
  'skipped',
]);

export const scanVerdictEnum = pgEnum('scan_verdict', ['pass', 'fail', 'unknown']);

export const failOnEnum = pgEnum('fail_on', ['none', 'high', 'critical']);

export const severityEnum = pgEnum('severity', [
  'unknown',
  'negligible',
  'low',
  'medium',
  'high',
  'critical',
]);

/**
 * Santé d'un déploiement, telle que le healthcheck périodique la constate.
 * Reprend les trois issues de `HealthOutcome` côté driver, plus `unknown` tant
 * qu'aucune sonde n'est passée. Ce statut **informe**, il ne déclenche rien.
 */
export const healthStatusEnum = pgEnum('health_status', [
  'unknown',
  'healthy',
  'unhealthy',
  'unreachable',
]);

/**
 * Nature d'une tâche planifiée.
 *
 * L'enum date du jalon 1 et n'a **pas** été migrée au jalon 8 : ses quatre
 * valeurs couvrent exactement les quatre tâches du brief. Le nom BullMQ
 * (`scan:periodic`, `health:periodic`, `cleanup:versions`, `target:preflight`)
 * vit dans `scheduled_jobs.key`, qui est justement la clé du repeatable job —
 * c'est sa raison d'être. La correspondance type → nom de tâche est une donnée,
 * dans `SCHEDULED_JOB_TYPES` (packages/core/src/schedule.ts), jamais un `if`.
 */
export const scheduledJobTypeEnum = pgEnum('scheduled_job_type', [
  'scan',
  'healthcheck',
  'preflight',
  'cleanup',
]);

/**
 * D'où vient la valeur d'un secret d'application.
 *   generated  le panel l'a tirée au sort — personne ne l'a jamais lue
 *   provided   un opérateur l'a saisie : elle vient d'un tiers (clé d'API…)
 *
 * La distinction n'est pas décorative : un secret `generated` n'a aucune raison
 * d'être affichable, alors qu'un secret `provided` doit pouvoir être remplacé.
 */
export const secretOriginEnum = pgEnum('secret_origin', ['generated', 'provided']);

/**
 * Moyen d'envoi d'une notification.
 *
 * Un enum Postgres et non un `text` libre, comme tout le reste : la liste des
 * canaux est une donnée du domaine, et une valeur inventée en SQL à la main ne
 * doit pas pouvoir atterrir en base pour n'échouer qu'au moment d'envoyer. Les
 * quatre valeurs suivent `NOTIFICATION_CHANNEL_KINDS` de `@pupitre/core` — ajouter
 * un canal coûte donc une migration, ce qui est le prix normal d'une valeur
 * d'enum dans ce projet.
 */
export const notificationChannelKindEnum = pgEnum('notification_channel_kind', [
  'smtp',
  'telegram',
  'discord',
  'webhook',
]);
