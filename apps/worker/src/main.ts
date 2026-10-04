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
import { logger } from './logger.js';
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
 * Un seul point d'enregistrement des tâches de la queue `ops`.
 *
 * Les quatre tâches planifiées sont enregistrées depuis la table de
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
  [WORKLOAD_CONTROL_JOB]: handleWorkloadControl,
  [WORKLOAD_EXEC_JOB]: handleWorkloadExec,
  // Reverse proxies : regarder, installer, tester, retirer, poser des domaines.
  // Chacune ouvre une session et peut toucher la machine : la file d'un déploiement.
  [PROXY_DETECT_JOB]: handleProxyDetect,
  [PROXY_INSTALL_JOB]: handleProxyInstall,
  [PROXY_CHECK_JOB]: handleProxyCheck,
  [PROXY_REMOVE_JOB]: handleProxyRemove,
  [PROXY_APPLY_JOB]: handleProxyApply,
  [PROXY_LINK_CHECK_JOB]: handleProxyLinkCheck,
  // Le ménage des constructeurs d'images : une écriture sur la machine.
  [BUILDER_PRUNE_JOB]: handleBuilderPrune,
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
  // Arrêt et remise en marche : même famille que le redémarrage — une écriture
  // courte sur une application déjà en place, qui ne rejoue aucun pipeline.
  [APP_STOP_JOB]: handleAppStop,
  [APP_START_JOB]: handleAppStart,
  // L'inventaire est une lecture : sur la file de supervision, il ne retarde
  // aucun déploiement et aucun déploiement ne le retarde.
  [WORKLOAD_LIST_JOB]: handleWorkloadList,
  // Une lecture : comme l'inventaire, elle n'attend pas derrière un déploiement.
  [WORKLOAD_LOGS_JOB]: handleWorkloadLogs,
  // Le relevé de métriques est de la même famille : une lecture courte, qu'un
  // déploiement en cours ne doit pas faire attendre.
  [TARGET_METRICS_JOB]: handleTargetMetrics,
  // Supervision de sites : la sonde part **du worker vers l'URL publique**, en
  // HTTP. C'est un autre point de vue que `health:periodic`, qui interroge la
  // machine cible par SSH — celle-ci voit le pare-feu, le proxy et le certificat.
  [MONITOR_SWEEP_JOB]: handleMonitorSweep,
  // Capture d'écran d'une page supervisée. Même file, tâche séparée : le
  // balayage a déjà écrit l'incident et émis l'alerte quand celle-ci part. Une
  // capture ne doit jamais retarder ce qui compte.
  [MONITOR_CAPTURE_JOB]: handleMonitorCapture,
  // Supervision de serveurs : le balayage qui donne une mémoire aux relevés
  // d'hôte. Même file et même raison que `target:metrics`, dont il est
  // l'horloge — une lecture SSH courte, qu'un déploiement ne doit pas retarder.
  [HOST_SWEEP_JOB]: handleTargetMetricsSweep,
  // Dépôts liés : « quoi de neuf sur la branche ? », puis le déploiement
  // décidé par un humain. Des appels HTTP courts vers GitHub — le déploiement
  // lui-même part sur `ops`, comme tous les autres.
  [SOURCE_POLL_JOB]: handleSourcePoll,
  [SOURCE_DEPLOY_JOB]: handleSourceDeploy,
  // Une archive de code téléversée : la juger, la refaire propre. Quelques
  // secondes de disque, qui ne doivent pas attendre derrière un déploiement.
  [SOURCE_ARCHIVE_INSPECT_JOB]: handleSourceArchiveInspect,
  // Images déployées contre leurs registres : des HEAD HTTP et un
  // `docker inspect` par application, rien qui doive attendre un déploiement.
  [IMAGE_CHECK_JOB]: handleImageCheck,
  // Tester une destination de sauvegarde : quelques secondes de réseau, qui
  // ne doivent pas attendre derrière une sauvegarde d'une heure.
  [BACKUP_DESTINATION_CHECK_JOB]: handleBackupDestinationCheck,
  // Chaque domaine, à travers son proxy, depuis sa machine : une lecture.
  [ROUTES_CHECK_JOB]: handleRoutesCheck,
  // Le relevé d'un domaine pour son tiroir : DNS, RDAP, certificat, vus du
  // worker. Une lecture de quelques secondes, que le panel attend.
  [DOMAIN_INSPECT_JOB]: handleDomainInspect,
  // Les prévisions : des lectures SQL et un calcul, toutes les 30 minutes.
  [FORECAST_SWEEP_JOB]: handleForecastSweep,
  // Les fenêtres de maintenance : annoncer un début, fermer une fin.
  [MAINTENANCE_SWEEP_JOB]: handleMaintenanceSweep,
};

/** La file des sauvegardes : longues, lentes, une à la fois par défaut. */
const backupHandlers: Record<string, JobHandler> = {
  [BACKUP_APPLICATION_JOB]: handleBackupApplication,
  [BACKUP_PANEL_JOB]: handleBackupPanel,
  [BACKUP_RESTORE_JOB]: handleBackupRestore,
  [BACKUP_DELETE_JOB]: handleBackupDelete,
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
  // Décide : cette alerte part-elle maintenant, ou est-elle retenue pour être
  // résumée ? Le chemin « maintenant » est le chemin par défaut.
  [NOTIFICATION_DISPATCH_JOB]: handleNotificationDispatch,
  // Délivre à **un** canal, et se rejoue seule. C'est ce découpage qui rend le
  // rejeu possible : la tentative qui rate ne concerne qu'un destinataire.
  [NOTIFICATION_DELIVER_JOB]: handleNotificationDeliver,
  // Ferme les fenêtres de regroupement échues et compose les résumés.
  [NOTIFICATION_DIGEST_SWEEP_JOB]: handleNotificationDigestSweep,
  [NOTIFICATION_TEST_JOB]: handleNotificationTest,
  // Invitation et réinitialisation de mot de passe. Sur cette file parce que
  // c'est un envoi d'e-mail : il partage le budget de concurrence des envois
  // d'e-mails, et il ne doit pas attendre derrière un déploiement. Ce n'est en
  // revanche **pas** une notification — le destinataire vient de l'action, pas
  // de la configuration du canal. Voir `handlers/account-mail.ts`.
  [ACCOUNT_MAIL_JOB]: handleAccountMail,
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

/**
 * Installe l'horloge du balayage des serveurs.
 *
 * Même motif que `installMonitorSweep()`, et pour les mêmes raisons : pas de
 * ligne en base, donc pas de réconciliation — ce scheduler est un détail
 * d'exécution, réinstallé à l'identique à chaque démarrage. La cadence de
 * *relevé* (5 min par machine), elle, n'est pas ici : c'est le balayage qui la
 * fait respecter, en ne réclamant que les machines dont le dernier relevé est
 * assez vieux. BullMQ n'est que l'horloge.
 *
 * Le nom de la tâche contient un deux-points ; la clé du scheduler, non.
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
        // Un balayage qui rate n'est pas rejoué : le suivant arrive dans une
        // minute et les machines sont toujours dues.
        attempts: 1,
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 24 * 3600, count: 100 },
      },
    },
  );
  logger.info({ everyMs: HOST_SWEEP_EVERY_MS }, 'balayage des serveurs installé');
}

/**
 * Installe l'horloge des dépôts liés : une vérification par minute.
 *
 * Même motif que les deux balayages ci-dessus. Le panel est privé, aucun
 * webhook ne l'atteint : c'est le worker qui demande, et l'ETag rend la
 * question presque gratuite quand rien n'a bougé.
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
  logger.info({ everyMs: SOURCE_POLL_EVERY_MS }, 'vérification des dépôts liés installée');
}

/**
 * Installe l'horloge de la vérification des images : toutes les six heures.
 *
 * Même motif que les balayages ci-dessus. Six heures et pas une minute : un
 * registre public n'apprécie pas d'être interrogé en boucle, et une image de
 * base n'est pas republiée plusieurs fois par jour. « Vérifier maintenant »
 * reste là pour qui ne veut pas attendre.
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
  logger.info({ everyMs: IMAGE_CHECK_EVERY_MS }, 'vérification des images installée');
}

/**
 * L'horloge du ménage des constructeurs d'images : toutes les heures, sur
 * `ops`. Même motif que les balayages — réinstallée à l'identique à chaque
 * démarrage. La durée au-delà de laquelle un constructeur est retiré n'est pas
 * ici : chaque driver tient la sienne.
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
  logger.info({ everyMs: BUILDER_PRUNE_EVERY_MS }, 'ménage des constructeurs installé');
}

/** L'horloge de la sonde des domaines : toutes les dix minutes, sur `supervision`. */
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
  logger.info({ everyMs: ROUTES_CHECK_EVERY_MS }, 'sonde des domaines installée');
}

/**
 * Installe l'horloge des prévisions : toutes les 30 minutes. Même motif que
 * les balayages ci-dessus — pas de ligne en base, réinstallée à l'identique à
 * chaque démarrage. Les séries qu'elle lit bougent toutes les 5 minutes au
 * plus vite : une demi-heure suffit à voir venir un mur qui est à des jours.
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
  logger.info({ everyMs: FORECAST_SWEEP_EVERY_MS }, 'balayage des prévisions installé');
}

/**
 * Installe l'horloge des maintenances : chaque minute. La mise en sourdine n'en
 * dépend pas — elle se décide à chaque alerte —, seules l'annonce du début et
 * la fermeture de la fin attendent ce balayage.
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
  logger.info({ everyMs: MAINTENANCE_SWEEP_EVERY_MS }, 'balayage des maintenances installé');
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
  // Refuse de démarrer sans une MASTER_KEY exploitable — et le dit tout haut
  // si elle est exploitable mais devinable. Les identifiants SSH des cibles
  // sont chiffrés sous cette clé : la valeur d'exemple les rend lisibles par
  // quiconque met la main sur une sauvegarde de la base.
  const weakKey = assertMasterKey();
  if (weakKey) {
    logger.warn(
      { reason: weakKey },
      'MASTER_KEY est la valeur d\'exemple ou une valeur devinable — ' +
        'les identifiants chiffrés en base ne sont pas protégés. ' +
        'Générer : openssl rand -hex 32, puis rechiffrer les cibles.',
    );
  }
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

  try {
    await installHostSweep();
  } catch (error) {
    // Sans balayage, l'historique des serveurs cesse de se remplir et les
    // seuils ne sont plus évalués. Le panel reste utilisable et le relevé à la
    // demande continue d'écrire : c'est une dégradation, pas une panne.
    logger.error({ err: error }, 'installation du balayage des serveurs impossible');
  }

  try {
    await installSourcePoll();
  } catch (error) {
    // Sans horloge, les dépôts liés ne sont plus suivis d'eux-mêmes ;
    // « Vérifier maintenant » et « Déployer ce commit » marchent toujours.
    logger.error({ err: error }, 'installation de la vérification des dépôts impossible');
  }

  try {
    await installImageCheck();
    await installRoutesCheck();
  } catch (error) {
    // Sans horloge, plus d'annonce de mise à jour d'image ; « Vérifier
    // maintenant » marche toujours.
    logger.error({ err: error }, 'installation de la vérification des images impossible');
  }

  try {
    await installBuilderPrune();
  } catch (error) {
    // Sans horloge, les constructeurs restent en place, comme avant : leur
    // cache survit, ils occupent le cluster. Une dégradation, pas une panne.
    logger.error({ err: error }, 'installation du ménage des constructeurs impossible');
  }

  try {
    // Le mandataire par lequel le navigateur de capture atteint l'Internet.
    // N'ouvre rien quand la capture est éteinte, et un échec d'ouverture ne
    // fait pas tomber le worker : sans mandataire, il n'y a pas de capture, et
    // c'est tout ce qu'on perd.
    await startCaptureEgress();
  } catch (error) {
    logger.error({ err: error }, 'mandataire de sortie des captures indisponible');
  }

  try {
    await installForecastSweep();
  } catch (error) {
    // Sans horloge, plus de prévision nouvelle ; les épisodes ouverts restent
    // affichés tels quels. Une dégradation, pas une panne.
    logger.error({ err: error }, 'installation du balayage des prévisions impossible');
  }

  try {
    await installMaintenanceSweep();
  } catch (error) {
    // Sans horloge, les alertes restent retenues pendant les fenêtres, mais
    // ce qui est resté en panne ne part plus à leur fin. On le crie : c'est
    // une alerte qui attend sans le savoir. Le prochain démarrage réinstalle.
    logger.error({ err: error }, 'installation du balayage des maintenances impossible');
  }

  try {
    await installNotificationDigestSweep();
  } catch (error) {
    // Sans ce balayage, les fenêtres ouvertes ne se referment plus : les
    // alertes retenues restent en base au lieu de partir en résumé. C'est grave
    // — mais moins que de refuser de consommer les déploiements. On le crie
    // dans les logs et on continue ; le prochain démarrage réinstalle.
    logger.error({ err: error }, 'installation du balayage de regroupement impossible');
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
  installRealtimeAudit();

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

  // Ce qui « tournait » quand le worker s'est arrêté ne tourne plus : le dire.
  try {
    const interrupted = await failInterruptedBackups(new Date());
    if (interrupted > 0)
      logger.warn({ interrupted }, 'sauvegardes interrompues par le redémarrage');
  } catch (error) {
    logger.error({ err: error }, 'relecture des sauvegardes interrompues impossible');
  }

  const backupWorker = new Worker(
    BACKUPS_QUEUE,
    async (job: Job) => {
      const handler = backupHandlers[job.name];
      if (!handler) {
        throw new Error(`aucun handler de sauvegarde pour « ${job.name} »`);
      }
      return handler(job);
    },
    {
      connection: createRedisConnection(),
      concurrency: env.BACKUP_CONCURRENCY,
      // Une sauvegarde de plusieurs gigaoctets tient son verrou longtemps :
      // BullMQ le renouvelle, mais un délai court ferait croire à une tâche bloquée.
      lockDuration: 5 * 60_000,
      removeOnComplete: { age: 7 * 24 * 3600, count: 500 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  );

  // Les écrans ouverts apprennent qu'un déploiement part ou finit, qu'une
  // sonde a tourné : ils se relisent d'eux-mêmes.
  installRealtimeJobEvents([worker, supervision, backupWorker]);

  for (const [instance, queue, concurrency] of [
    [worker, OPS_QUEUE, env.WORKER_CONCURRENCY],
    [supervision, SUPERVISION_QUEUE, env.SUPERVISION_CONCURRENCY],
    [notifications, NOTIFICATIONS_QUEUE, 4],
    [backupWorker, BACKUPS_QUEUE, env.BACKUP_CONCURRENCY],
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
    // Une tâche de déploiement peut mourir SANS que le handler ait tourné —
    // c'est ce que fait BullMQ d'une tâche qui a trop bloqué. Personne n'aurait
    // alors écrit le verdict en base, et le déploiement resterait « en cours »
    // pour toujours. On l'arrête en échec, sans jamais le rejouer.
    void reconcileFailedDeploymentJob(job, error.message);
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
      await backupWorker.close();
      await stopCaptureEgress();
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
