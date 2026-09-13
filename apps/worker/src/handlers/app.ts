import {
  STATUS_REFRESH_MS,
  STATUS_TTL_SECONDS,
  STREAM_MAX_MS,
  WATCH_POLL_MS,
  appLogChannel,
  appLogWatchKey,
  appStatusKey,
  deploymentJobDataSchema,
  isSupervisable,
  stripAnsi,
  type AppLogMessage,
  type AppStatus,
} from '@pupitre/core';
import { getDriver } from '@pupitre/core/drivers';
import { disconnect } from '@pupitre/core/ssh';
import { getDeploymentSummary, logAudit, recordHealthStatus } from '@pupitre/db';
import type { Job } from 'bullmq';
import { openDeploymentContext } from '../deploy/context.js';
import { logger } from '../logger.js';
import { getPublisher, getRedis } from '../redis.js';

/**
 * Supervision des applications en marche.
 *
 * Le suivi des logs est le seul travail du projet qui n'a **pas de fin
 * naturelle**. Il ne peut donc pas s'arrêter tout seul comme les autres : c'est
 * la présence d'un spectateur qui le maintient en vie. La route SSE rafraîchit
 * une clé Redis à courte durée de vie tant qu'un client écoute ; ce job la
 * relit régulièrement et coupe la session SSH dès qu'elle a disparu.
 *
 * Ce mécanisme couvre les quatre cas qui comptent :
 *   - onglet fermé proprement  → la route cesse de rafraîchir, la clé expire ;
 *   - onglet tué brutalement   → personne ne rafraîchit, la clé expire ;
 *   - plusieurs spectateurs    → tous rafraîchissent la même clé ;
 *   - worker redémarré         → le job meurt, le panel en redemande un.
 *
 * Un plafond de durée complète le dispositif : un slot de worker ne doit pas
 * rester pris parce qu'un onglet est resté ouvert tout un week-end.
 */

/**
 * Isole le nom du service d'une ligne préfixée.
 *
 * Le nom rendu doit être celui que `status()` rapporte, sinon le filtre par
 * service de l'interface ne trouverait jamais rien. Or les deux runtimes
 * décorent le préfixe différemment :
 *
 *   Compose  `api-1  | message`            — nom du conteneur : service + indice
 *   kubectl  `[pod/app-demo-api-7d9f/api] message` — dernier segment : conteneur,
 *                                             que nos manifestes nomment d'après
 *                                             le service
 */
function splitPrefix(raw: string): { service: string | null; line: string } {
  const kube = /^\[pod\/[^\]/]+\/([^\]/]+)]\s?([\s\S]*)$/.exec(raw);
  if (kube?.[1]) return { service: kube[1], line: kube[2] ?? '' };

  const separator = raw.indexOf('|');
  if (separator <= 0 || separator > 60) return { service: null, line: raw };

  const candidate = raw.slice(0, separator).trim();
  // Un préfixe de log est un identifiant, pas une phrase.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate)) return { service: null, line: raw };

  // Compose ajoute toujours exactement un indice de réplique : on en retire un
  // seul, ce qui reste juste même pour un service dont le nom finit par un
  // chiffre (`web-2` donne le conteneur `web-2-1`).
  return {
    service: candidate.replace(/-\d+$/, ''),
    line: raw.slice(separator + 1).replace(/^ /, ''),
  };
}

export async function handleAppLogs(job: Job<unknown>): Promise<{ lines: number }> {
  const data = deploymentJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, deploymentId: data.deploymentId });

  const summary = await getDeploymentSummary(data.deploymentId);
  if (!summary) throw new Error(`Déploiement « ${data.deploymentId} » introuvable`);
  if (!isSupervisable(summary.status)) {
    log.info({ status: summary.status }, 'déploiement non supervisable, flux non ouvert');
    return { lines: 0 };
  }

  const channel = appLogChannel(data.deploymentId);
  const watchKey = appLogWatchKey(data.deploymentId);
  const publisher = getPublisher();
  const redis = getRedis();

  // Personne n'écoute déjà : inutile d'ouvrir une session SSH.
  if ((await redis.exists(watchKey)) === 0) {
    log.info('aucun spectateur, flux non ouvert');
    return { lines: 0 };
  }

  const emit = (message: AppLogMessage) => {
    publisher.publish(channel, JSON.stringify(message)).catch((error: unknown) => {
      log.warn({ err: error }, 'publication du flux applicatif impossible');
    });
  };

  const { session, ctx, deployment } = await openDeploymentContext(data.deploymentId);
  const driver = getDriver(deployment.runtime);

  let lines = 0;
  let stop = false;
  let watcher: NodeJS.Timeout | null = null;
  let ceiling: NodeJS.Timeout | null = null;
  let refresher: NodeJS.Timeout | null = null;

  /**
   * Publie un relevé **et le retient**.
   *
   * Publier ne suffit pas : Redis ne rejoue pas un `publish`, et le flux est
   * partagé entre tous les spectateurs d'un déploiement. Le deuxième onglet
   * arrive donc après la diffusion et n'aurait jamais d'état — c'est ce qui
   * faisait afficher « aucun conteneur rapporté » à côté de logs bien vivants.
   * La clé retenue est ce que la route SSE sert au nouveau venu.
   */
  const publishStatus = async (status: AppStatus): Promise<void> => {
    emit({ kind: 'status', payload: status });
    try {
      await redis.set(
        appStatusKey(data.deploymentId),
        JSON.stringify(status),
        'EX',
        STATUS_TTL_SECONDS,
      );
    } catch (error) {
      // Le flux ne s'arrête pas parce que le cache d'état a raté.
      log.warn({ err: error }, "mémorisation du dernier état impossible");
    }
  };

  try {
    emit({
      kind: 'lifecycle',
      payload: { ts: new Date().toISOString(), action: 'stream.started', detail: null },
    });

    // Un instantané d'état avant les logs : le spectateur voit tout de suite ce
    // qui tourne, sans attendre qu'une ligne soit produite.
    const status: AppStatus = await driver.status(ctx);
    await publishStatus(status);

    /**
     * Couper la session SSH est ce qui met fin à `logs -f` : la commande
     * distante reçoit un EOF et rend la main. C'est plus sûr que de compter
     * sur un signal, qui ne traverse pas toujours le canal.
     */
    const halt = (reason: string) => {
      if (stop) return;
      stop = true;
      log.info({ reason, lines }, 'flux applicatif interrompu');
      void disconnect(session);
    };

    watcher = setInterval(() => {
      redis
        .exists(watchKey)
        .then((present) => {
          if (present === 0) halt('plus de spectateur');
        })
        .catch((error: unknown) => {
          log.warn({ err: error }, 'lecture de la clé de présence impossible');
        });
    }, WATCH_POLL_MS);

    ceiling = setTimeout(() => halt('durée maximale atteinte'), STREAM_MAX_MS);

    /**
     * Re-relevé périodique, sur la session SSH déjà ouverte.
     *
     * Sans lui, la carte d'état est figée sur l'instantané d'ouverture pendant
     * toute la vie du flux — jusqu'à trente minutes. Un conteneur qui sort ou
     * qui redémarre en boucle se lirait dans les logs sans jamais apparaître
     * dans l'inventaire, ce qui est précisément la contradiction qu'on corrige.
     *
     * Un relevé à la fois : `pending` évite d'empiler des `compose ps` si la
     * machine met plus de vingt secondes à répondre.
     */
    let pending = false;
    refresher = setInterval(() => {
      if (stop || pending) return;
      pending = true;
      driver
        .status(ctx)
        .then((fresh) => publishStatus(fresh))
        .catch((error: unknown) => {
          // La session est peut-être en train d'être coupée : ce n'est pas une
          // raison d'interrompre le flux de logs, qui lui vit encore.
          if (!stop) log.warn({ err: error }, "relevé d'état impossible");
        })
        .finally(() => {
          pending = false;
        });
    }, STATUS_REFRESH_MS);

    await driver.logs(ctx, (raw) => {
      if (stop) return;
      const cleaned = stripAnsi(raw).replace(/\r$/, '');
      if (cleaned.trim().length === 0) return;

      lines += 1;
      const { service, line } = splitPrefix(cleaned);
      emit({
        kind: 'log',
        payload: { ts: new Date().toISOString(), service, line },
      });
    });

    return { lines };
  } finally {
    if (watcher) clearInterval(watcher);
    if (ceiling) clearTimeout(ceiling);
    if (refresher) clearInterval(refresher);

    emit({
      kind: 'lifecycle',
      payload: {
        ts: new Date().toISOString(),
        action: 'stream.stopped',
        detail: `${lines} ligne(s)`,
      },
    });

    await disconnect(session);
  }
}

/**
 * Redémarrage d'une application en marche.
 *
 * Ce n'est ni un déploiement ni un rollback : mêmes images, mêmes volumes, même
 * port. Le statut du déploiement n'en est pas modifié — seule sa santé l'est,
 * et elle est resondée juste après.
 */
export async function handleAppRestart(job: Job<unknown>): Promise<{ healthy: boolean }> {
  const data = deploymentJobDataSchema.parse(job.data);
  const log = logger.child({ jobId: job.id, deploymentId: data.deploymentId });

  const summary = await getDeploymentSummary(data.deploymentId);
  if (!summary) throw new Error(`Déploiement « ${data.deploymentId} » introuvable`);
  if (!isSupervisable(summary.status)) {
    throw new Error(`Un déploiement « ${summary.status} » ne se redémarre pas`);
  }

  const channel = appLogChannel(data.deploymentId);
  const publisher = getPublisher();
  const emit = (message: AppLogMessage) => {
    publisher.publish(channel, JSON.stringify(message)).catch(() => {
      // Le redémarrage ne doit pas échouer parce que personne ne regarde.
    });
  };

  const { session, ctx, deployment } = await openDeploymentContext(data.deploymentId);
  const driver = getDriver(deployment.runtime);

  try {
    emit({
      kind: 'lifecycle',
      payload: { ts: new Date().toISOString(), action: 'restart', detail: 'démarré' },
    });

    await driver.restart(ctx, (line) => {
      emit({ kind: 'log', payload: { ts: new Date().toISOString(), service: null, line } });
    });

    const health = await driver.healthcheck(ctx);
    emit({ kind: 'status', payload: await driver.status(ctx) });
    emit({
      kind: 'lifecycle',
      payload: {
        ts: new Date().toISOString(),
        action: 'restart',
        detail: health.healthy ? 'terminé, service sain' : `terminé, ${health.outcome}`,
      },
    });

    // Le statut du déploiement ne bouge pas : un redémarrage n'est pas un
    // nouveau déploiement. Seule la santé constatée est mise à jour.
    await recordHealthStatus(
      data.deploymentId,
      health.healthy ? 'healthy' : health.outcome === 'unreachable' ? 'unreachable' : 'unhealthy',
    );

    await logAudit({
      actorId: data.actorId,
      action: 'app.restarted',
      resourceType: 'deployment',
      resourceId: data.deploymentId,
      after: {
        applicationSlug: summary.applicationSlug,
        targetName: summary.targetName,
        healthy: health.healthy,
      },
      ip: data.ip,
    });

    log.info({ healthy: health.healthy }, 'application redémarrée');
    return { healthy: health.healthy };
  } finally {
    await disconnect(session);
  }
}
