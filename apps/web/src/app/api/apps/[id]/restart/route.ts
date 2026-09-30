import { APP_RESTART_JOB, deploymentJobDataSchema, isSupervisable } from '@pupitre/core';
import { getDeploymentSummary, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { appConsole } from '@/i18n/messages/console';
import { deployments } from '@/i18n/messages/deployments';
import { ConflictError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { getSupervisionQueue } from '@/lib/supervision-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * Redémarre une application en marche. Mêmes images, mêmes volumes, même port :
 * ce n'est ni un déploiement, ni un rollback. La route enfile et rend la main.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'deployment:restart');
  const { id } = paramsSchema.parse(await context.params);

  const deployment = await getDeploymentSummary(id);
  if (!deployment) throw new NotFoundError(msg(deployments, 'error.notFound', { id }));
  if (!isSupervisable(deployment.status)) {
    throw new ConflictError(msg(appConsole, 'error.notRestartable', { status: deployment.status }));
  }
  /**
   * Redémarrer une application arrêtée serait ambigu : `docker compose restart`
   * relancerait bel et bien les conteneurs — la base la croirait toujours
   * arrêtée et la sonde périodique continuerait de l'ignorer —, tandis qu'un
   * `rollout restart` sur zéro réplique ne ferait rien du tout. Un même bouton
   * pour deux effets opposés selon le runtime est exactement ce que
   * l'architecture refuse. Le geste existe, il s'appelle « Démarrer ».
   */
  if (deployment.stoppedAt !== null) {
    throw new ConflictError(msg(appConsole, 'error.stoppedRestart'));
  }

  const job = await getSupervisionQueue().add(
    APP_RESTART_JOB,
    deploymentJobDataSchema.parse({ deploymentId: id, actorId: auth.userId, ip: auth.ip }),
  );
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(deployments, 'error.enqueueFailed'));

  await logAudit({
    actorId: auth.userId,
    action: 'app.restart.requested',
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
