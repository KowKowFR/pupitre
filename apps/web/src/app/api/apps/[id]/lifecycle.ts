import {
  APP_START_JOB,
  APP_STOP_JOB,
  deploymentJobDataSchema,
  isSupervisable,
} from '@pupitre/core';
import { getDeploymentSummary, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { appConsole } from '@/i18n/messages/console';
import { deployments } from '@/i18n/messages/deployments';
import { ConflictError, HttpError, NotFoundError, msg, type MessageRef } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { getSupervisionQueue } from '@/lib/supervision-queue';

/**
 * Arrêt et remise en marche, côté panel.
 *
 * Les deux routes sont le même geste au signe près : même permission, mêmes
 * refus, même file, même forme de réponse. Ce module porte ce qu'elles ont en
 * commun, et chaque route se réduit à la ligne qui la distingue — c'est aussi
 * ce qui garantit qu'un refus ajouté demain vaudra pour les deux.
 *
 * Rien d'autre n'est fait ici : la route enfile et rend l'identifiant de tâche.
 * Le travail — session SSH, driver, écriture en base — appartient au worker.
 *
 * ── La permission, et pourquoi ce n'est pas une nouvelle ────────────────────
 * `deployment:restart`. Un redémarrage *est* un arrêt suivi d'un démarrage :
 * même interruption de service, même absence de conséquence sur les données et
 * sur la version. Une permission `deployment:stop` distincte aurait produit un
 * rôle capable de couper le service par le bouton d'à côté mais pas par
 * celui-ci — une frontière que personne ne saurait expliquer, et un piège pour
 * qui compose un rôle.
 */

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

type Gesture = {
  /** `stop` arrête, `start` remet en marche. */
  key: 'stop' | 'start';
  jobName: typeof APP_STOP_JOB | typeof APP_START_JOB;
  auditAction: string;
  /**
   * Refus quand l'application est déjà dans l'état visé. Rendre 202 sur un
   * geste sans effet ferait croire à une action ; on préfère le dire.
   */
  refuseWhen: (stoppedAt: Date | null) => MessageRef | null;
};

export const STOP_GESTURE: Gesture = {
  key: 'stop',
  jobName: APP_STOP_JOB,
  auditAction: 'app.stop.requested',
  refuseWhen: (stoppedAt) =>
    stoppedAt === null
      ? null
      : // Horodatage neutre : la phrase est rendue dans la langue du demandeur,
        // pas la date — elle se lit en UTC, comme le journal d'activité.
        msg(appConsole, 'error.alreadyStopped', {
          date: `${stoppedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
        }),
};

export const START_GESTURE: Gesture = {
  key: 'start',
  jobName: APP_START_JOB,
  auditAction: 'app.start.requested',
  refuseWhen: (stoppedAt) => (stoppedAt === null ? msg(appConsole, 'error.notStopped') : null),
};

export function lifecycleRoute(gesture: Gesture) {
  return apiRoute<Context>(async (request, context) => {
    const auth = await requirePermission(request, 'deployment:restart');
    const { id } = paramsSchema.parse(await context.params);

    const deployment = await getDeploymentSummary(id);
    if (!deployment) throw new NotFoundError(msg(deployments, 'error.notFound', { id }));

    // Même garde que le redémarrage et que le flux de logs : hors de ces deux
    // statuts, il n'y a pas d'application en marche dont on puisse disposer.
    if (!isSupervisable(deployment.status)) {
      throw new ConflictError(
        msg(appConsole, `error.notSupervisable.${gesture.key}`, { status: deployment.status }),
      );
    }

    const refusal = gesture.refuseWhen(deployment.stoppedAt);
    if (refusal) throw new ConflictError(refusal);

    const job = await getSupervisionQueue().add(
      gesture.jobName,
      deploymentJobDataSchema.parse({ deploymentId: id, actorId: auth.userId, ip: auth.ip }),
    );
    if (!job.id) {
      throw new HttpError(500, 'enqueue_failed', msg(deployments, 'error.enqueueFailed'));
    }

    await logAudit({
      actorId: auth.userId,
      action: gesture.auditAction,
      resourceType: 'deployment',
      resourceId: id,
      after: {
        jobId: job.id,
        applicationSlug: deployment.applicationSlug,
        targetName: deployment.targetName,
      },
      ip: auth.ip,
    });

    return NextResponse.json({ id, jobId: job.id, state: 'queued' }, { status: 202 });
  });
}
