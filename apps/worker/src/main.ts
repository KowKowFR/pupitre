import {
  APPLICATION_DELETE_JOB,
  APP_LOGS_JOB,
  APP_RESTART_JOB,
  DEPLOYMENT_DESTROY_JOB,
  DEPLOYMENT_ROLLBACK_JOB,
  DEPLOYMENT_RUN_JOB,
  MONITOR_SWEEP_EVERY_MS,
  MONITOR_SWEEP_JOB,
  NOTIFICATIONS_QUEUE,
  NOTIFICATION_DISPATCH_JOB,
  NOTIFICATION_TEST_JOB,
  OPS_QUEUE,
  PING_JOB,
  SUPERVISION_QUEUE,
  SCHEDULED_JOB_TYPES,
  SCHEDULED_JOB_TYPES_LIST,
  TARGET_METRICS_JOB,
  TARGET_PREFLIGHT_JOB,
  WORKLOAD_LIST_JOB,
  WORKLOAD_REMOVE_JOB,
  WORKLOAD_UPDATE_JOB,
  assertMasterKey,
} from '@tp/core';
import { closeDb, pingDb } from '@tp/db';
import { Worker, type Job } from 'bullmq';
import { env } from './env.js';
import { handlePing } from './handlers/ping.js';
import { handleTargetPreflight } from './handlers/target-preflight.js';
import {
  handleDeploymentDestroy,
  handleDeploymentRollback,
  handleDeploymentRun,
} from './handlers/deployment.js';
import { handleAppLogs, handleAppRestart } from './handlers/app.js';
import { handleApplicationDelete } from './handlers/application.js';
import { handleTargetMetrics } from './handlers/host-metrics.js';
import { handleMonitorSweep } from './handlers/monitor.js';
import {
  closeNotificationsQueue,
  handleNotificationDispatch,
  handleNotificationTest,
  installAuditNotifications,
} from './handlers/notification.js';
import { handleWorkloadAction, handleWorkloadList } from './handlers/workload.js';
import { handleScheduledJob } from './handlers/scheduled.js';
import { logger } from './logger.js';
import { closeOpsQueue, getOpsQueue, getSupervisionQueue } from './queue.js';
import { reconcileSchedulers } from './schedule/reconcile.js';
import { closePublisher, createRedisConnection } from './redis.js';

type JobHandler = (job: Job) => Promise<unknown>;

/**
 * Un seul point d'enregistrement des tâches de la queue `ops`.
 *
 * Les quatre tâches planifiées du jalon 8 sont enregistrées depuis la table de
 * données `SCHEDULED_JOB_TYPES` et partagent la même enveloppe : le nom BullMQ
 * varie, le traitement est dispatché par `type` à l'intérieur. Écrire les
 * quatre noms à la main ici aurait été un cinquième endroit à tenir à jour.
 */
const handlers: Record<string, JobHandler> = {
  [PING_JOB]: handlePing,
  [TARGET_PREFLIGHT_JOB]: handleTargetPreflight,
  [DEPLOYMENT_RUN_JOB]: handleDeploymentRun,
  [DEPLOYMENT_ROLLBACK_JOB]: handleDeploymentRollback,
  [DEPLOYMENT_DESTROY_JOB]: handleDeploymentDestroy,
  // Suppression en cascade : une session SSH par cible, puis la purge. Sur
  // `ops` parce que c'est la même ressource distante qu'un déploiement.
  [APPLICATION_DELETE_JOB]: handleApplicationDelete,
  // Écritures sur la machine : même file, même budget de concurrence qu'un
  // déploiement, parce qu'elles touchent la même ressource.
  [WORKLOAD_REMOVE_JOB]: handleWorkloadAction,
  [WORKLOAD_UPDATE_JOB]: handleWorkloadAction,
  ...Object.fromEntries(
    SCHEDULED_JOB_TYPES_LIST.map((type) => [
      SCHEDULED_JOB_TYPES[type].jobName,
      handleScheduledJob as JobHandler,
    ]),
  ),
};

/**
 * Tâches de supervision, sur leur propre file.
 * `app:logs` occupe son slot pendant toute la consultation : mêlé aux
 * déploiements, il les affamerait.
 */
const supervisionHandlers: Record<string, JobHandler> = {
  [APP_LOGS_JOB]: handleAppLogs,
  [APP_RESTART_JOB]: handleAppRestart,
  // L'inventaire est une lecture : sur la file de supervision, il ne retarde
  // aucun déploiement et aucun déploiement ne le retarde.
  [WORKLOAD_LIST_JOB]: handleWorkloadList,
  // Le relevé de métriques est de la même famille : une lecture courte, qu'un
  // déploiement en cours ne doit pas faire attendre.
  [TARGET_METRICS_JOB]: handleTargetMetrics,
  // Supervision de sites : la sonde part **du worker vers l'URL publique**, en
  // HTTP. C'est un autre point de vue que `health:periodic`, qui interroge la
  // machine cible par SSH — celle-ci voit le pare-feu, le proxy et le certificat.
  [MONITOR_SWEEP_JOB]: handleMonitorSweep,
};

/**
 * Tâches de notification, sur leur propre file.
 *
 * Ni `ops` ni `supervision` : une alerte « déploiement en échec » qui attend
 * derrière les déploiements — ou derrière huit suivis de logs qui tiennent leur
 * slot une demi-heure — arrive trop tard pour servir à quelque chose. Le
 * raisonnement est celui qui a justifié `supervision` en son temps.
 */
const notificationHandlers: Record<string, JobHandler> = {
  [NOTIFICATION_DISPATCH_JOB]: handleNotificationDispatch,
  [NOTIFICATION_TEST_JOB]: handleNotificationTest,
};

/**
 * Installe l'horloge du balayage des sondes.
 *
 * Pas de ligne en base, donc pas de réconciliation : ce scheduler est un détail
 * d'exécution, réinstallé à l'identique à chaque démarrage. La cadence des
 * sondes, elle, vit en base (`monitors.interval_seconds`) — c'est le balayage
 * qui la respecte, pas BullMQ.
 *
 * `MONITOR_SWEEP_JOB` contient un deux-points : c'est le *nom* de la tâche,
 * jamais un `jobId`. La clé du scheduler, elle, n'en porte pas.
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
  logger.info({ everyMs: MONITOR_SWEEP_EVERY_MS }, 'balayage de supervision installé');
}

async function waitForDatabase(attempts = 30, delayMs = 2000): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pingDb();
      logger.info('base de données joignable');
      return;
    } catch (error) {
      logger.warn(
        { attempt, attempts, error: error instanceof Error ? error.message : error },
        'base de données injoignable, nouvelle tentative',
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`base de données injoignable après ${attempts} tentatives`);
}

async function main(): Promise<void> {
  // Refuse de démarrer sans une MASTER_KEY exploitable.
  assertMasterKey();
  await waitForDatabase();

  const connection = createRedisConnection();

  // Redis n'est que le miroir de la base : on remet les deux d'accord avant
  // d'accepter la moindre occurrence. Un worker redémarré ne doit ni perdre une
  // tâche active, ni exécuter une tâche désactivée pendant son absence.
  try {
    await reconcileSchedulers(getOpsQueue());
  } catch (error) {
    // Une réconciliation impossible ne doit pas empêcher le worker de consommer
    // les déploiements : c'est une dégradation, pas une panne.
    logger.error({ err: error }, 'réconciliation des tâches planifiées impossible');
  }

  try {
    await installMonitorSweep();
  } catch (error) {
    // Même principe : sans balayage, le panel reste utilisable, il ne sonde
    // simplement plus. C'est une dégradation, pas une panne.
    logger.error({ err: error }, 'installation du balayage de supervision impossible');
  }

  const worker = new Worker(
    OPS_QUEUE,
    async (job: Job) => {
      const handler = handlers[job.name];
      if (!handler) {
        throw new Error(`aucun handler enregistré pour la tâche « ${job.name} »`);
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
   * Branche le journal d'audit sur la file des notifications.
   *
   * Avant d'ouvrir les workers : un déploiement en échec consommé dans la
   * seconde qui suit le démarrage doit déjà déclencher son alerte.
   */
  installAuditNotifications();

  const supervision = new Worker(
    SUPERVISION_QUEUE,
    async (job: Job) => {
      const handler = supervisionHandlers[job.name];
      if (!handler) {
        throw new Error(`aucun handler de supervision pour « ${job.name} »`);
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
   * Concurrence volontairement modeste : quatre envois en vol suffisent
   * largement pour des événements qui se comptent en unités par jour, et un
   * serveur SMTP n'apprécie pas qu'on lui ouvre vingt sessions d'un coup.
   */
  const notifications = new Worker(
    NOTIFICATIONS_QUEUE,
    async (job: Job) => {
      const handler = notificationHandlers[job.name];
      if (!handler) {
        throw new Error(`aucun handler de notification pour « ${job.name} »`);
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

  for (const [instance, queue, concurrency] of [
    [worker, OPS_QUEUE, env.WORKER_CONCURRENCY],
    [supervision, SUPERVISION_QUEUE, env.SUPERVISION_CONCURRENCY],
    [notifications, NOTIFICATIONS_QUEUE, 4],
  ] as const) {
    instance.on('ready', () => {
      logger.info({ queue, concurrency }, 'worker prêt');
    });
    instance.on('error', (error) => {
      logger.error({ queue, error: error.message }, 'erreur worker');
    });
  }

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, jobName: job.name }, 'tâche terminée');
  });

  worker.on('failed', (job, error) => {
    logger.error(
      { jobId: job?.id, jobName: job?.name, error: error.message },
      'tâche en échec',
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'arrêt demandé, drainage des tâches en cours');
    try {
      await worker.close();
      await supervision.close();
      await notifications.close();
      await closeOpsQueue();
      await closeNotificationsQueue();
      await closePublisher();
      await connection.quit();
      await closeDb();
      logger.info('arrêt propre');
      process.exit(0);
    } catch (error) {
      logger.error({ error }, 'arrêt en erreur');
      process.exit(1);
    }
  };

  process.on('SIGTERM', (signal) => void shutdown(signal));
  process.on('SIGINT', (signal) => void shutdown(signal));
}

main().catch((error: unknown) => {
  logger.fatal({ error }, 'démarrage du worker impossible');
  process.exit(1);
});
