import {
  DEPLOYMENT_DESTROY_JOB,
  DEPLOYMENT_ROLLBACK_JOB,
  DEPLOYMENT_RUN_JOB,
  deployChannel,
} from '@tp/core';
import { abandonDeployment, logAudit } from '@tp/db';
import { logger } from '../logger.js';
import { getPublisher } from '../redis.js';

/**
 * Réconciliation d'un déploiement dont la tâche vient de mourir **sans que
 * notre handler ait tourné**.
 *
 * ── Le cas réel, constaté ────────────────────────────────────────────────────
 * BullMQ récupère tout seul une tâche dont le worker a disparu : au bout de deux
 * passages du contrôleur de tâches bloquées, elle repart en `wait` et un worker
 * la reprend. Mais à la deuxième récupération — deux redémarrages en vol sur un
 * déploiement assez long — le compteur dépasse `maxStalledCount` et BullMQ pose
 * un « échec différé » sur la tâche : le worker suivant la met en échec
 * (« job stalled more than allowable limit ») **sans jamais appeler le
 * handler**. Le `catch` de `handleDeploymentRun`, qui écrit d'ordinaire le
 * verdict en base, ne tourne donc pas. Le déploiement reste `running` pour
 * toujours ; la destruction le refuse, la purge le refuse, et l'application qui
 * le porte devient indélébile.
 *
 * ── Pourquoi ici, et pourquoi seulement ici ──────────────────────────────────
 * L'événement `failed` du worker est le seul instant où l'on sait, sans rien
 * deviner et sans interroger la file, qu'une tâche vient de passer dans un état
 * terminal. Pas de balayage périodique, pas de fenêtre à choisir, pas de course
 * avec un worker qui travaillerait encore : la tâche est morte, on le tient de
 * BullMQ lui-même.
 *
 * Et l'on **ne reprend rien**. Réenfiler un pipeline dont on ignore où il s'est
 * arrêté redéploierait par-dessus un état inconnu — conteneurs à moitié
 * remplacés, port déjà pris, fichiers déposés. Le déploiement est arrêté sur un
 * échec qui nomme ce qui reste à vérifier sur la machine ; lever cette
 * incertitude est un geste humain, avec sa propre permission.
 *
 * Tout le reste — une tâche disparue de Redis, un déploiement figé avant ce
 * correctif — passe par le geste manuel : `POST /api/deployments/:id/unblock`.
 */

const DEPLOYMENT_JOBS: ReadonlySet<string> = new Set([
  DEPLOYMENT_RUN_JOB,
  DEPLOYMENT_ROLLBACK_JOB,
  DEPLOYMENT_DESTROY_JOB,
]);

function deploymentIdOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const value = (data as Record<string, unknown>).deploymentId;
  return typeof value === 'string' ? value : null;
}

function actorOf(data: unknown): { actorId: string | null; ip: string | null } {
  if (typeof data !== 'object' || data === null) return { actorId: null, ip: null };
  const record = data as Record<string, unknown>;
  return {
    actorId: typeof record.actorId === 'string' ? record.actorId : null,
    ip: typeof record.ip === 'string' ? record.ip : null,
  };
}

/**
 * À brancher sur `worker.on('failed')`. Ne fait rien — et c'est le cas normal —
 * quand le handler a déjà écrit le verdict : `abandonDeployment()` ne touche
 * qu'un déploiement encore `pending` ou `running`, et rend `null` sinon.
 */
export async function reconcileFailedDeploymentJob(
  job: { name: string; data: unknown } | undefined,
  reason: string,
): Promise<void> {
  if (!job || !DEPLOYMENT_JOBS.has(job.name)) return;

  const deploymentId = deploymentIdOf(job.data);
  if (!deploymentId) return;

  const cause =
    `BullMQ a terminé la tâche « ${job.name} » en échec sans l'exécuter : « ${reason} »`;

  const report = await abandonDeployment(deploymentId, { cause }).catch(
    (error: unknown) => {
      logger.error({ err: error, deploymentId }, 'réconciliation impossible');
      return null;
    },
  );
  if (!report) return;

  logger.warn(
    { deploymentId, jobName: job.name, reason, failedStep: report.failedStep },
    'déploiement laissé « en cours » par une tâche morte : arrêté en échec',
  );

  const { actorId, ip } = actorOf(job.data);

  // Un spectateur qui regarde encore le flux SSE doit voir le verdict tomber,
  // plutôt qu'un pipeline qui reste figé sous ses yeux.
  getPublisher()
    .publish(
      deployChannel(deploymentId),
      JSON.stringify({
        kind: 'event',
        payload: {
          ts: new Date().toISOString(),
          type: 'deployment',
          key: deploymentId,
          status: 'failed',
          detail: report.error,
        },
      }),
    )
    .catch(() => {});

  await logAudit({
    actorId,
    action: 'deployment.unblocked',
    resourceType: 'deployment',
    resourceId: deploymentId,
    after: {
      status: 'failed',
      failedStep: report.failedStep,
      mayHaveStartedServices: report.mayHaveStartedServices,
      applicationSlug: report.applicationSlug,
      targetName: report.targetName,
      error: report.error,
      detectedBy: `tâche « ${job.name} » terminée en échec sans avoir été exécutée`,
    },
    ip,
  }).catch((error: unknown) => {
    logger.error({ err: error, deploymentId }, "écriture d'audit impossible");
  });
}
