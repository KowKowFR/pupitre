import { DEPLOYMENT_ROLLBACK_JOB, deploymentJobDataSchema } from '@tp/core';
import { getDeploymentSummary, logAudit } from '@tp/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ConflictError, HttpError, NotFoundError } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/** Redéploie la version précédente. Le travail réel appartient au worker. */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'deployment:rollback');
  const { id } = paramsSchema.parse(await context.params);

  const deployment = await getDeploymentSummary(id);
  if (!deployment) throw new NotFoundError(`Déploiement « ${id} » introuvable`);

  if (!deployment.previousDeploymentId) {
    throw new ConflictError(
      "Aucun déploiement précédent réussi sur cette cible : il n'y a nulle part où revenir.",
    );
  }
  if (deployment.status === 'running' || deployment.status === 'pending') {
    throw new ConflictError('Ce déploiement est en cours.');
  }

  const job = await getOpsQueue().add(
    DEPLOYMENT_ROLLBACK_JOB,
    deploymentJobDataSchema.parse({ deploymentId: id, actorId: auth.userId, ip: auth.ip }),
    { attempts: 1 },
  );
  if (!job.id) throw new HttpError(500, 'enqueue_failed', "La tâche n'a pas reçu d'identifiant");

  await logAudit({
    actorId: auth.userId,
    action: 'deployment.rollback.requested',
    resourceType: 'deployment',
    resourceId: id,
    after: { jobId: job.id, to: deployment.previousDeploymentId },
    ip: auth.ip,
  });

  return NextResponse.json({ id, jobId: job.id, state: 'queued' }, { status: 202 });
});
