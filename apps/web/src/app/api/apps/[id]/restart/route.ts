import { APP_RESTART_JOB, deploymentJobDataSchema, isSupervisable } from '@pupitre/core';
import { getDeploymentSummary, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ConflictError, HttpError, NotFoundError } from '@/lib/errors';
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
  if (!deployment) throw new NotFoundError(`Déploiement « ${id} » introuvable`);
  if (!isSupervisable(deployment.status)) {
    throw new ConflictError(
      `Un déploiement « ${deployment.status} » ne se redémarre pas.`,
    );
  }

  const job = await getSupervisionQueue().add(
    APP_RESTART_JOB,
    deploymentJobDataSchema.parse({ deploymentId: id, actorId: auth.userId, ip: auth.ip }),
  );
  if (!job.id) throw new HttpError(500, 'enqueue_failed', "La tâche n'a pas reçu d'identifiant");

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
