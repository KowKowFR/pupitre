import {
  ACCOUNT_MAIL_JOB,
  APPLICATION_DELETE_JOB,
  APP_LOGS_JOB,
  APP_RESTART_JOB,
  APP_START_JOB,
  APP_STOP_JOB,
  BACKUPS_QUEUE,
  BACKUP_APPLICATION_JOB,
  BACKUP_DELETE_JOB,
  BACKUP_DESTINATION_CHECK_JOB,
  BACKUP_PANEL_JOB,
  BACKUP_RESTORE_JOB,
  BUILDER_PRUNE_EVERY_MS,
  BUILDER_PRUNE_JOB,
  DEPLOYMENT_DESTROY_JOB,
  DEPLOYMENT_ROLLBACK_JOB,
  DEPLOYMENT_RUN_JOB,
  IMAGE_CHECK_EVERY_MS,
  PROXY_APPLY_JOB,
  PROXY_CHECK_JOB,
  PROXY_DETECT_JOB,
  PROXY_INSTALL_JOB,
  PROXY_LINK_CHECK_JOB,
  PROXY_REMOVE_JOB,
  ROUTES_CHECK_EVERY_MS,
  ROUTES_CHECK_JOB,
  IMAGE_CHECK_JOB,
  MONITOR_CAPTURE_JOB,
  MONITOR_SWEEP_EVERY_MS,
  MONITOR_SWEEP_JOB,
  SOURCE_ARCHIVE_INSPECT_JOB,
  SOURCE_DEPLOY_JOB,
  SOURCE_POLL_EVERY_MS,
  SOURCE_POLL_JOB,
  NOTIFICATIONS_QUEUE,
  NOTIFICATION_DELIVER_JOB,
  NOTIFICATION_DIGEST_SWEEP_JOB,
  NOTIFICATION_DISPATCH_JOB,
  NOTIFICATION_TEST_JOB,
  OPS_QUEUE,
  PING_JOB,
  SUPERVISION_QUEUE,
  SCHEDULED_JOB_TYPES,
  SCHEDULED_JOB_TYPES_LIST,
  TARGET_METRICS_JOB,
  DOMAIN_INSPECT_JOB,
  TARGET_PREFLIGHT_JOB,
  WORKLOAD_CONTROL_JOB,
  WORKLOAD_EXEC_JOB,
  WORKLOAD_LIST_JOB,
  WORKLOAD_LOGS_JOB,
  WORKLOAD_REMOVE_JOB,
  WORKLOAD_UPDATE_JOB,
  assertMasterKey,
} from '@pupitre/core';
import { HOST_SWEEP_EVERY_MS, closeDb, failInterruptedBackups, pingDb } from '@pupitre/db';
import { Worker, type Job } from 'bullmq';
import { env } from './env.js';
import { handlePing } from './handlers/ping.js';
import { handleTargetPreflight } from './handlers/target-preflight.js';
import {
  handleDeploymentDestroy,
  handleDeploymentRollback,
  handleDeploymentRun,
} from './handlers/deployment.js';
import {
  handleAppLogs,
  handleAppRestart,
  handleAppStart,
  handleAppStop,
} from './handlers/app.js';
import { handleApplicationDelete } from './handlers/application.js';
import { handleTargetMetrics, handleTargetMetricsSweep } from './handlers/host-metrics.js';
import { handleDomainInspect } from './handlers/domain-inspect.js';
import {
  FORECAST_SWEEP_EVERY_MS,
  FORECAST_SWEEP_JOB,
  FORECAST_SWEEP_SCHEDULER_KEY,
  handleForecastSweep,
} from './forecast/sweep.js';
import {
  MAINTENANCE_SWEEP_EVERY_MS,
  MAINTENANCE_SWEEP_JOB,
  MAINTENANCE_SWEEP_SCHEDULER_KEY,
  handleMaintenanceSweep,
} from './maintenance/sweep.js';
import { handleMonitorCapture, handleMonitorSweep } from './handlers/monitor.js';
import { startCaptureEgress, stopCaptureEgress } from './monitors/egress.js';
import {
  closeNotificationsQueue,
  handleNotificationDeliver,
  handleNotificationDigestSweep,
  handleNotificationDispatch,
  handleNotificationTest,
  installAuditNotifications,
  installNotificationDigestSweep,
} from './handlers/notification.js';
import { handleAccountMail } from './handlers/account-mail.js';
import {
  handleWorkloadAction,
  handleWorkloadControl,
  handleWorkloadExec,
  handleWorkloadList,
  handleWorkloadLogs,
} from './handlers/workload.js';
import { handleScheduledJob } from './handlers/scheduled.js';
import { handleBuilderPrune } from './handlers/builder.js';
import { handleImageCheck } from './handlers/images.js';
import {
  handleProxyApply,
  handleProxyCheck,
  handleProxyDetect,
  handleProxyInstall,
  handleProxyLinkCheck,
  handleProxyRemove,
  handleRoutesCheck,
} from './handlers/proxy.js';
import {
  handleBackupApplication,
  handleBackupDelete,
  handleBackupDestinationCheck,
  handleBackupPanel,
  handleBackupRestore,
} from './handlers/backup.js';
import { handleSourceDeploy, handleSourcePoll } from './handlers/source.js';
import { handleSourceArchiveInspect } from './handlers/source-archive.js';
import { reconcileFailedDeploymentJob } from './deploy/abandoned.js';
import { instanceLanguage } from './language.js';
import { logger } from './logger.js';
import { workerSay } from './messages.js';
import { closeOpsQueue, getOpsQueue, getSupervisionQueue } from './queue.js';
import { reconcileSchedulers } from './schedule/reconcile.js';
import { installRealtimeAudit, installRealtimeJobEvents } from './realtime.js';
import {
  HOST_SWEEP_JOB,
  HOST_SWEEP_SCHEDULER_KEY,
} from './supervision/sweep.js';
import { closePublisher, createRedisConnection } from './redis.js';

type JobHandler = (job: Job) => Promise<unknown>;

/**
 * A single place where the `ops` queue's jobs are registered.
 *
 * The four scheduled tasks are registered from the `SCHEDULED_JOB_TYPES` data
 * table and share the same envelope: the BullMQ name varies, the handling is
 * dispatched by `type` inside. Writing the four names by hand here would have
 * been a fifth place to keep up to date.
 */
const handlers: Record<string, JobHandler> = {
  [PING_JOB]: handlePing,
  [TARGET_PREFLIGHT_JOB]: handleTargetPreflight,
  [DEPLOYMENT_RUN_JOB]: handleDeploymentRun,
  [DEPLOYMENT_ROLLBACK_JOB]: handleDeploymentRollback,
  [DEPLOYMENT_DESTROY_JOB]: handleDeploymentDestroy,
  // Cascading deletion: one SSH session per target, then the purge. On `ops`
  // because it is the same remote resource as a deployment.
  [APPLICATION_DELETE_JOB]: handleApplicationDelete,
  // Writes on the machine: same queue, same concurrency budget as a deployment,
  // because they touch the same resource.
  [WORKLOAD_REMOVE_JOB]: handleWorkloadAction,
  [WORKLOAD_UPDATE_JOB]: handleWorkloadAction,
  [WORKLOAD_CONTROL_JOB]: handleWorkloadControl,
  [WORKLOAD_EXEC_JOB]: handleWorkloadExec,
  // Reverse proxies: look, install, test, remove, set domains. Each opens a
  // session and can touch the machine: a deployment's queue.
  [PROXY_DETECT_JOB]: handleProxyDetect,
  [PROXY_INSTALL_JOB]: handleProxyInstall,
  [PROXY_CHECK_JOB]: handleProxyCheck,
  [PROXY_REMOVE_JOB]: handleProxyRemove,
  [PROXY_APPLY_JOB]: handleProxyApply,
  [PROXY_LINK_CHECK_JOB]: handleProxyLinkCheck,
  // Cleaning up image builders: a write on the machine.
  [BUILDER_PRUNE_JOB]: handleBuilderPrune,
  ...Object.fromEntries(
    SCHEDULED_JOB_TYPES_LIST.map((type) => [
      SCHEDULED_JOB_TYPES[type].jobName,
      handleScheduledJob as JobHandler,
    ]),
  ),
};

/**
 * Monitoring jobs, on their own queue. `app:logs` holds its slot for the whole
 * viewing: mixed with deployments, it would starve them.
 */
const supervisionHandlers: Record<string, JobHandler> = {
  [APP_LOGS_JOB]: handleAppLogs,
  [APP_RESTART_JOB]: handleAppRestart,
  // Stop and start: the same family as restart — a short write on an application
  // already in place, which replays no pipeline.
  [APP_STOP_JOB]: handleAppStop,
  [APP_START_JOB]: handleAppStart,
  // The inventory is a read: on the monitoring queue, it delays no deployment and
  // no deployment delays it.
  [WORKLOAD_LIST_JOB]: handleWorkloadList,
  // A read: like the inventory, it does not wait behind a deployment.
  [WORKLOAD_LOGS_JOB]: handleWorkloadLogs,
  // The metrics reading is of the same family: a short read, which a deployment
  // in progress must not make wait.
  [TARGET_METRICS_JOB]: handleTargetMetrics,
  // Site monitoring: the probe goes **from the worker to the public URL**, over
  // HTTP. It is another point of view than `health:periodic`, which queries the
  // target machine over SSH — this one sees the firewall, the proxy and the
  // certificate.
  [MONITOR_SWEEP_JOB]: handleMonitorSweep,
  // Screenshot of a monitored page. Same queue, separate job: the sweep has already
  // written the incident and sent the alert when this one goes out. A capture must
  // never delay what matters.
  [MONITOR_CAPTURE_JOB]: handleMonitorCapture,
  // Server monitoring: the sweep that gives host readings a memory. Same queue
  // and same reason as `target:metrics`, whose clock it is — a short SSH read,
  // which a deployment must not delay.
  [HOST_SWEEP_JOB]: handleTargetMetricsSweep,
  // Linked repositories: "anything new on the branch?", then the deployment
  // decided by a human. Short HTTP calls to GitHub — the deployment itself goes on
  // `ops`, like all the others.
  [SOURCE_POLL_JOB]: handleSourcePoll,
  [SOURCE_DEPLOY_JOB]: handleSourceDeploy,
  // An uploaded code archive: judge it, remake it clean. A few seconds of disk,
  // which must not wait behind a deployment.
  [SOURCE_ARCHIVE_INSPECT_JOB]: handleSourceArchiveInspect,
  // Deployed images against their registries: HTTP HEADs and one
  // `docker inspect` per application, nothing that should wait for a deployment.
  [IMAGE_CHECK_JOB]: handleImageCheck,
  // Testing a backup destination: a few seconds of network, which must not wait
  // behind an hour-long backup.
  [BACKUP_DESTINATION_CHECK_JOB]: handleBackupDestinationCheck,
  // Each domain, through its proxy, from its machine: a read.
  [ROUTES_CHECK_JOB]: handleRoutesCheck,
  // A domain's reading for its drawer: DNS, RDAP, certificate, seen from the
  // worker. A read of a few seconds, which the panel waits for.
  [DOMAIN_INSPECT_JOB]: handleDomainInspect,
  // Forecasts: SQL reads and a computation, every 30 minutes.
  [FORECAST_SWEEP_JOB]: handleForecastSweep,
  // Maintenance windows: announce a start, close an end.
  [MAINTENANCE_SWEEP_JOB]: handleMaintenanceSweep,
};

/** The backups queue: long, slow, one at a time by default. */
const backupHandlers: Record<string, JobHandler> = {
  [BACKUP_APPLICATION_JOB]: handleBackupApplication,
  [BACKUP_PANEL_JOB]: handleBackupPanel,
  [BACKUP_RESTORE_JOB]: handleBackupRestore,
  [BACKUP_DELETE_JOB]: handleBackupDelete,
};

/**
 * Notification jobs, on their own queue.
 *
 * Neither `ops` nor `supervision`: a "deployment failed" alert waiting behind
 * the deployments — or behind eight log follows holding their slot for half an
 * hour — arrives too late to be of any use. The reasoning is the one that
 * justified `supervision` in its time.
 */
const notificationHandlers: Record<string, JobHandler> = {
  // Decides: does this alert go out now, or is it held to be summarized? The "now"
  // path is the default path.
  [NOTIFICATION_DISPATCH_JOB]: handleNotificationDispatch,
  // Delivers to **one** channel, and retries by itself. It is this split that
  // makes retrying possible: the attempt that fails only concerns one recipient.
  [NOTIFICATION_DELIVER_JOB]: handleNotificationDeliver,
  // Closes the due grouping windows and composes the digests.
  [NOTIFICATION_DIGEST_SWEEP_JOB]: handleNotificationDigestSweep,
  [NOTIFICATION_TEST_JOB]: handleNotificationTest,
  // Invitation and password reset. On this queue because it is an email send: it
  // shares the email sends' concurrency budget, and it must not wait behind a
  // deployment. It is, however, **not** a notification — the recipient comes from
  // the action, not from the channel's configuration. See
  // `handlers/account-mail.ts`.
  [ACCOUNT_MAIL_JOB]: handleAccountMail,
};

/**
 * Installs the probes sweep's clock.
 *
 * No database row, hence no reconciliation: this scheduler is a run detail,
 * reinstalled identically at each startup. The probes' interval lives in the
 * database (`monitors.interval_seconds`) — it is the sweep that respects it, not
 * BullMQ.
 *
 * `MONITOR_SWEEP_JOB` contains a colon: it is the job's *name*, never a `jobId`.
 * The scheduler's key carries none.
 */
async function installMonitorSweep(): Promise<void> {
  const queue = getSupervisionQueue();
  await queue.upsertJobScheduler(
    'monitor-sweep',
    { every: MONITOR_SWEEP_EVERY_MS },
    {
      name: MONITOR_SWEEP_JOB,
      data: { monitorId: null, force: false, actorId: null, ip: null },
      opts: {
        attempts: 1,
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 24 * 3600, count: 100 },
      },
    },
  );
  logger.info({ everyMs: MONITOR_SWEEP_EVERY_MS }, 'monitoring sweep installed');
}

/**
 * Installs the servers sweep's clock.
 *
 * The same pattern as `installMonitorSweep()`, and for the same reasons: no
 * database row, hence no reconciliation — this scheduler is a run detail,
 * reinstalled identically at each startup. The *reading* interval (5 min per
 * machine) is not here: it is the sweep that enforces it, by only claiming the
 * machines whose last reading is old enough. BullMQ is only the clock.
 *
 * The job's name contains a colon; the scheduler's key does not.
 */
async function installHostSweep(): Promise<void> {
  const queue = getSupervisionQueue();
  await queue.upsertJobScheduler(
    HOST_SWEEP_SCHEDULER_KEY,
    { every: HOST_SWEEP_EVERY_MS },
    {
      name: HOST_SWEEP_JOB,
      data: { targetId: null, force: false },
      opts: {
        // A sweep that fails is not retried: the next one comes in a minute and the
        // machines are still due.
        attempts: 1,
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 24 * 3600, count: 100 },
      },
    },
  );
  logger.info({ everyMs: HOST_SWEEP_EVERY_MS }, 'servers sweep installed');
}

/**
 * Installs the linked repositories' clock: one check per minute.
 *
 * The same pattern as the two sweeps above. The panel is private, no webhook
 * reaches it: it is the worker that asks, and the ETag makes the question almost
 * free when nothing moved.
 */
async function installSourcePoll(): Promise<void> {
  const queue = getSupervisionQueue();
  await queue.upsertJobScheduler(
    'source-poll',
    { every: SOURCE_POLL_EVERY_MS },
    {
      name: SOURCE_POLL_JOB,
      data: { sourceId: null, force: false, actorId: null, ip: null },
      opts: {
        attempts: 1,
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 24 * 3600, count: 100 },
      },
    },
  );
  logger.info({ everyMs: SOURCE_POLL_EVERY_MS }, 'linked repositories check installed');
}

/**
 * Installs the images check's clock: every six hours.
 *
 * The same pattern as the sweeps above. Six hours and not a minute: a public
 * registry does not like being queried in a loop, and a base image is not
 * republished several times a day. "Check now" is there for whoever does not
 * want to wait.
 */
async function installImageCheck(): Promise<void> {
  const queue = getSupervisionQueue();
  await queue.upsertJobScheduler(
    'image-check',
    { every: IMAGE_CHECK_EVERY_MS },
    {
      name: IMAGE_CHECK_JOB,
      data: { applicationId: null, actorId: null, ip: null },
      opts: {
        attempts: 1,
        removeOnComplete: { age: 24 * 3600, count: 50 },
        removeOnFail: { age: 7 * 24 * 3600, count: 50 },
      },
    },
  );
  logger.info({ everyMs: IMAGE_CHECK_EVERY_MS }, 'images check installed');
}

/**
 * The clock for cleaning up image builders: every hour, on `ops`. The same
 * pattern as the sweeps — reinstalled identically at each startup. The duration
 * beyond which a builder is removed is not here: each driver holds its own.
 */
async function installBuilderPrune(): Promise<void> {
  const queue = getOpsQueue();
  await queue.upsertJobScheduler(
    'builder-prune',
    { every: BUILDER_PRUNE_EVERY_MS },
    {
      name: BUILDER_PRUNE_JOB,
      data: {},
      opts: {
        attempts: 1,
        removeOnComplete: { age: 24 * 3600, count: 50 },
        removeOnFail: { age: 7 * 24 * 3600, count: 50 },
      },
    },
  );
  logger.info({ everyMs: BUILDER_PRUNE_EVERY_MS }, 'builders cleanup installed');
}

/** The domains probe's clock: every ten minutes, on `supervision`. */
async function installRoutesCheck(): Promise<void> {
  const queue = getSupervisionQueue();
  await queue.upsertJobScheduler(
    'routes-check',
    { every: ROUTES_CHECK_EVERY_MS },
    {
      name: ROUTES_CHECK_JOB,
      data: {},
      opts: {
        attempts: 1,
        removeOnComplete: { age: 24 * 3600, count: 50 },
        removeOnFail: { age: 7 * 24 * 3600, count: 50 },
      },
    },
  );
  logger.info({ everyMs: ROUTES_CHECK_EVERY_MS }, 'domains probe installed');
}

/**
 * Installs the forecasts' clock: every 30 minutes. The same pattern as the
 * sweeps above — no database row, reinstalled identically at each startup. The
 * series it reads move every 5 minutes at the fastest: half an hour is enough to
 * see coming a wall that is days away.
 */
async function installForecastSweep(): Promise<void> {
  const queue = getSupervisionQueue();
  await queue.upsertJobScheduler(
    FORECAST_SWEEP_SCHEDULER_KEY,
    { every: FORECAST_SWEEP_EVERY_MS },
    {
      name: FORECAST_SWEEP_JOB,
      data: {},
      opts: {
        attempts: 1,
        removeOnComplete: { age: 24 * 3600, count: 50 },
        removeOnFail: { age: 7 * 24 * 3600, count: 50 },
      },
    },
  );
  logger.info({ everyMs: FORECAST_SWEEP_EVERY_MS }, 'forecasts sweep installed');
}

/**
 * Installs the maintenance windows' clock: every minute. Muting does not depend
 * on it — it is decided at each alert —, only announcing the start and closing
 * the end wait for this sweep.
 */
async function installMaintenanceSweep(): Promise<void> {
  const queue = getSupervisionQueue();
  await queue.upsertJobScheduler(
    MAINTENANCE_SWEEP_SCHEDULER_KEY,
    { every: MAINTENANCE_SWEEP_EVERY_MS },
    {
      name: MAINTENANCE_SWEEP_JOB,
      data: {},
      opts: {
        attempts: 1,
        removeOnComplete: { age: 3600, count: 50 },
        removeOnFail: { age: 7 * 24 * 3600, count: 50 },
      },
    },
  );
  logger.info({ everyMs: MAINTENANCE_SWEEP_EVERY_MS }, 'maintenance sweep installed');
}

async function waitForDatabase(attempts = 30, delayMs = 2000): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pingDb();
      logger.info('database reachable');
      return;
    } catch (error) {
      logger.warn(
        { attempt, attempts, error: error instanceof Error ? error.message : error },
        'database unreachable, retrying',
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`database unreachable after ${attempts} attempts`);
}

async function main(): Promise<void> {
  // Refuses to start without a usable MASTER_KEY — and says it out loud if it is
  // usable but guessable. The targets' SSH credentials are encrypted under this
  // key: the example value makes them readable by anyone who gets hold of a
  // database backup.
  const weakKey = assertMasterKey();
  if (weakKey) {
    logger.warn(
      { reason: weakKey },
      'MASTER_KEY is the example value or a guessable one — ' +
        'the credentials encrypted in the database are not protected. ' +
        'Generate one: openssl rand -hex 32, then encrypt the targets again.',
    );
  }
  await waitForDatabase();

  const connection = createRedisConnection();

  // Redis is only the database's mirror: we bring both into agreement before
  // accepting the slightest occurrence. A restarted worker must neither lose an
  // active task nor run a task disabled during its absence.
  try {
    await reconcileSchedulers(getOpsQueue());
  } catch (error) {
    // An impossible reconciliation must not prevent the worker from consuming
    // deployments: it is a degradation, not an outage.
    logger.error({ err: error }, 'scheduled tasks reconciliation failed');
  }

  try {
    await installMonitorSweep();
  } catch (error) {
    // Same principle: without a sweep, the panel stays usable, it simply no longer
    // probes. It is a degradation, not an outage.
    logger.error({ err: error }, 'monitoring sweep installation failed');
  }

  try {
    await installHostSweep();
  } catch (error) {
    // Without a sweep, the servers' history stops filling up and thresholds are no
    // longer evaluated. The panel stays usable and on-demand reading keeps writing:
    // it is a degradation, not an outage.
    logger.error({ err: error }, 'servers sweep installation failed');
  }

  try {
    await installSourcePoll();
  } catch (error) {
    // Without a clock, linked repositories are no longer followed by themselves;
    // "Check now" and "Deploy this commit" still work.
    logger.error({ err: error }, 'repositories check installation failed');
  }

  try {
    await installImageCheck();
    await installRoutesCheck();
  } catch (error) {
    // Without a clock, no more image update announcements; "Check now" still works.
    logger.error({ err: error }, 'images check installation failed');
  }

  try {
    await installBuilderPrune();
  } catch (error) {
    // Without a clock, builders stay in place, as before: their cache survives, they
    // occupy the cluster. A degradation, not an outage.
    logger.error({ err: error }, 'builders cleanup installation failed');
  }

  try {
    // The proxy through which the capture browser reaches the Internet. Opens
    // nothing when capture is off, and an opening failure does not bring the worker
    // down: without a proxy, there is no capture, and that is all we lose.
    await startCaptureEgress();
  } catch (error) {
    logger.error({ err: error }, 'capture egress proxy unavailable');
  }

  try {
    await installForecastSweep();
  } catch (error) {
    // Without a clock, no new forecast; the open episodes stay shown as they are. A
    // degradation, not an outage.
    logger.error({ err: error }, 'forecasts sweep installation failed');
  }

  try {
    await installMaintenanceSweep();
  } catch (error) {
    // Without a clock, alerts stay held during the windows, but what stayed down no
    // longer goes out at their end. We shout it: it is an alert waiting without
    // knowing it. The next startup reinstalls.
    logger.error({ err: error }, 'maintenance sweep installation failed');
  }

  try {
    await installNotificationDigestSweep();
  } catch (error) {
    // Without this sweep, open windows no longer close: held alerts stay in the
    // database instead of going out as a digest. It is serious — but less so than
    // refusing to consume deployments. We shout it in the logs and go on; the next
    // startup reinstalls.
    logger.error({ err: error }, 'digest windows sweep installation failed');
  }

  const worker = new Worker(
    OPS_QUEUE,
    async (job: Job) => {
      const handler = handlers[job.name];
      if (!handler) {
        throw new Error(`no handler registered for job "${job.name}"`);
      }
      return handler(job);
    },
    {
      connection,
      concurrency: env.WORKER_CONCURRENCY,
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  );

  /**
   * Plugs the audit log into the notifications queue.
   *
   * Before opening the workers: a failed deployment consumed in the second after
   * startup must already trigger its alert.
   */
  installAuditNotifications();
  installRealtimeAudit();

  const supervision = new Worker(
    SUPERVISION_QUEUE,
    async (job: Job) => {
      const handler = supervisionHandlers[job.name];
      if (!handler) {
        throw new Error(`no monitoring handler for "${job.name}"`);
      }
      return handler(job);
    },
    {
      connection: createRedisConnection(),
      concurrency: env.SUPERVISION_CONCURRENCY,
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 24 * 3600 },
    },
  );

  /**
   * Deliberately modest concurrency: four sends in flight are plenty for events
   * that count in units per day, and an SMTP server does not like having twenty
   * sessions opened at once.
   */
  const notifications = new Worker(
    NOTIFICATIONS_QUEUE,
    async (job: Job) => {
      const handler = notificationHandlers[job.name];
      if (!handler) {
        throw new Error(`no notification handler for "${job.name}"`);
      }
      return handler(job);
    },
    {
      connection: createRedisConnection(),
      concurrency: 4,
      removeOnComplete: { age: 24 * 3600, count: 500 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  );

  // What "was running" when the worker stopped no longer runs: say so.
  try {
    const interrupted = await failInterruptedBackups(
      new Date(),
      workerSay(await instanceLanguage())('backup.interrupted'),
    );
    if (interrupted > 0) logger.warn({ interrupted }, 'backups interrupted by the restart');
  } catch (error) {
    logger.error({ err: error }, 'interrupted backups could not be reviewed');
  }

  const backupWorker = new Worker(
    BACKUPS_QUEUE,
    async (job: Job) => {
      const handler = backupHandlers[job.name];
      if (!handler) {
        throw new Error(`no backup handler for "${job.name}"`);
      }
      return handler(job);
    },
    {
      connection: createRedisConnection(),
      concurrency: env.BACKUP_CONCURRENCY,
      // A multi-gigabyte backup holds its lock for a long time: BullMQ renews it, but
      // a short delay would make it look like a stuck job.
      lockDuration: 5 * 60_000,
      removeOnComplete: { age: 7 * 24 * 3600, count: 500 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  );

  // Open screens learn that a deployment starts or finishes, that a probe ran:
  // they read themselves again.
  installRealtimeJobEvents([worker, supervision, backupWorker]);

  for (const [instance, queue, concurrency] of [
    [worker, OPS_QUEUE, env.WORKER_CONCURRENCY],
    [supervision, SUPERVISION_QUEUE, env.SUPERVISION_CONCURRENCY],
    [notifications, NOTIFICATIONS_QUEUE, 4],
    [backupWorker, BACKUPS_QUEUE, env.BACKUP_CONCURRENCY],
  ] as const) {
    instance.on('ready', () => {
      logger.info({ queue, concurrency }, 'worker ready');
    });
    instance.on('error', (error) => {
      logger.error({ queue, error: error.message }, 'worker error');
    });
  }

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, jobName: job.name }, 'job completed');
  });

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, jobName: job?.name, error: error.message }, 'job failed');
    // A deployment job can die WITHOUT the handler having run — it is what BullMQ
    // does with a job that stalled too much. Nobody would then have written the
    // verdict in the database, and the deployment would stay "in progress" forever.
    // We stop it as failed, without ever replaying it.
    void reconcileFailedDeploymentJob(job, error.message);
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown requested, draining the jobs in progress');
    try {
      await worker.close();
      await supervision.close();
      await notifications.close();
      await backupWorker.close();
      await stopCaptureEgress();
      await closeOpsQueue();
      await closeNotificationsQueue();
      await closePublisher();
      await connection.quit();
      await closeDb();
      logger.info('clean shutdown');
      process.exit(0);
    } catch (error) {
      logger.error({ error }, 'shutdown with an error');
      process.exit(1);
    }
  };

  process.on('SIGTERM', (signal) => void shutdown(signal));
  process.on('SIGINT', (signal) => void shutdown(signal));
}

main().catch((error: unknown) => {
  logger.fatal({ error }, 'worker startup failed');
  process.exit(1);
});
