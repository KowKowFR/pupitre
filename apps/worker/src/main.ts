import {
  APP_LOGS_JOB,
  APP_RESTART_JOB,
  DEPLOYMENT_DESTROY_JOB,
  DEPLOYMENT_ROLLBACK_JOB,
  DEPLOYMENT_RUN_JOB,
  OPS_QUEUE,
  PING_JOB,
  SUPERVISION_QUEUE,
  SCHEDULED_JOB_TYPES,
  SCHEDULED_JOB_TYPES_LIST,
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
import { handleWorkloadAction, handleWorkloadList } from './handlers/workload.js';
import { handleScheduledJob } from './handlers/scheduled.js';
import { logger } from './logger.js';
import { closeOpsQueue, getOpsQueue } from './queue.js';
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
};

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

  for (const [instance, queue, concurrency] of [
    [worker, OPS_QUEUE, env.WORKER_CONCURRENCY],
    [supervision, SUPERVISION_QUEUE, env.SUPERVISION_CONCURRENCY],
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
      await closeOpsQueue();
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
