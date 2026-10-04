import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Every status is a Postgres enum, never a free varchar.
 * Adding a value = a new migration, never an edit of the existing one.
 */

export const runtimeEnum = pgEnum('runtime', ['docker', 'k3s']);

export const proxyEnum = pgEnum('proxy', ['traefik', 'bunkerweb', 'npm']);

export const sshAuthMethodEnum = pgEnum('ssh_auth_method', ['key', 'password']);

/**
 * A target's status after preflight.
 *   ok          at least one usable runtime
 *   degraded    the machine answers, but nothing can be deployed on it
 *   unreachable SSH session impossible
 */
export const targetStatusEnum = pgEnum('target_status', [
  'unknown',
  'ok',
  'degraded',
  'unreachable',
]);

/** How the worker obtains root privileges on the target. */
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
 * A deployment's health, as the periodic healthcheck observes it. Takes the
 * three outcomes of `HealthOutcome` on the driver side, plus `unknown` until a
 * probe has passed. This status **informs**, it triggers nothing.
 */
export const healthStatusEnum = pgEnum('health_status', [
  'unknown',
  'healthy',
  'unhealthy',
  'unreachable',
]);

/**
 * Nature of a scheduled task.
 *
 * The enum dates from the original schema and was **not** migrated since: its
 * four values cover exactly the brief's four tasks. The BullMQ name
 * (`scan:periodic`, `health:periodic`, `cleanup:versions`, `target:preflight`)
 * lives in `scheduled_jobs.key`, which is precisely the repeatable job's key —
 * that is its reason for being. The type → task name mapping is data, in
 * `SCHEDULED_JOB_TYPES` (packages/core/src/schedule.ts), never an `if`.
 */
export const scheduledJobTypeEnum = pgEnum('scheduled_job_type', [
  'scan',
  'healthcheck',
  'preflight',
  'cleanup',
  'backup',
  'panel_backup',
]);

/**
 * Where an application secret's value comes from.
 *   generated  the panel drew it at random — nobody ever read it
 *   provided   an operator entered it: it comes from a third party (API key…)
 *
 * The distinction is not decorative: a `generated` secret has no reason to be
 * displayable, whereas a `provided` secret must be replaceable.
 */
export const secretOriginEnum = pgEnum('secret_origin', ['generated', 'provided']);

/**
 * A notification's sending means.
 *
 * A Postgres enum and not a free `text`, like everything else: the list of
 * channels is domain data, and a value made up in SQL by hand must not be able to
 * land in the database only to fail at send time. The four values follow
 * `@pupitre/core`'s `NOTIFICATION_CHANNEL_KINDS` — adding a channel therefore
 * costs a migration, which is the normal price of an enum value in this project.
 */
export const notificationChannelKindEnum = pgEnum('notification_channel_kind', [
  'smtp',
  'telegram',
  'discord',
  'webhook',
]);

/** Code provider of a linked repository. */
export const sourceProviderEnum = pgEnum('source_provider', ['github', 'gitea', 'gitlab']);

/**
 * Where an uploaded code archive stands: `receiving` its bytes are arriving;
 * `pending` received, waiting to be read by the worker; `ready` read and remade
 * clean, deployable; `rejected` refused — the reason is next to it.
 */
export const sourceArchiveStatusEnum = pgEnum('source_archive_status', [
  'receiving',
  'pending',
  'ready',
  'rejected',
]);

/**
 * What a new commit on a linked branch does: `auto` deploys it;
 * `auto_unless_infra` deploys it unless it touches the infrastructure (port,
 * domain, volumes, secrets…); `manual` always waits for approval.
 */
export const sourceModeEnum = pgEnum('source_mode', ['auto', 'auto_unless_infra', 'manual']);

/**
 * Where a new commit of a linked branch goes: `targets` on the link's targets;
 * `running` where the application runs at that moment; `none` nowhere — the
 * application takes the new version, and one deploys it wherever, whenever.
 */
export const sourceDeployToEnum = pgEnum('source_deploy_to', ['targets', 'running', 'none']);

/** A commit waiting for approval, and what became of it. */
export const sourceProposalStatusEnum = pgEnum('source_proposal_status', [
  'pending',
  'approved',
  'dismissed',
  'superseded',
]);

/**
 * The finding about a deployed service's image — the same vocabulary as
 * `imageUpdateStatusSchema` in `@pupitre/core`.
 */
export const imageUpdateStatusEnum = pgEnum('image_update_status', [
  'current',
  'outdated',
  'unknown',
  'pinned',
]);

/** Where backups go — the same vocabulary as `BACKUP_DESTINATION_KINDS`. */
export const backupDestinationKindEnum = pgEnum('backup_destination_kind', ['s3', 'sftp', 'local']);

export const backupKindEnum = pgEnum('backup_kind', ['application', 'panel']);

/** `hot`: hot, export of the recognized databases; `stop`: brief stop, volumes copied. */
export const backupModeEnum = pgEnum('backup_mode', ['hot', 'stop']);

export const backupTriggerEnum = pgEnum('backup_trigger', [
  'schedule',
  'manual',
  'pre_deploy',
  'pre_restore',
]);

export const backupStatusEnum = pgEnum('backup_status', ['running', 'success', 'failed']);

// ─── reverse proxies ─────────────────────────────────────────────────────────

/** Where a proxy runs: on the machine it serves, or elsewhere. */
export const proxyPlacementEnum = pgEnum('proxy_placement', ['target', 'remote']);

export const proxyStatusEnum = pgEnum('proxy_status', ['unknown', 'installing', 'ok', 'failed']);

export const routeStatusEnum = pgEnum('route_status', ['pending', 'active', 'failed']);

/**
 * A domain's protection by a proxy that is also a web application firewall
 * (`@pupitre/core`'s `WafMode`). Ignored by a proxy that is not one.
 */
export const wafModeEnum = pgEnum('waf_mode', ['block', 'detect', 'off']);

/**
 * A status page announcement's phase. The first four tell an outage, the last
 * three a maintenance; `@pupitre/core` (`statusUpdatePhasesFor`) decides which
 * suits which subject.
 */
export const statusUpdatePhaseEnum = pgEnum('status_update_phase', [
  'investigating',
  'identified',
  'monitoring',
  'resolved',
  'scheduled',
  'in_progress',
  'completed',
]);
