import { DEPLOYMENT_ROLLBACK_JOB, deploymentJobDataSchema } from '@pupitre/core';
import { getDeploymentSummary, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deployments as messages } from '@/i18n/messages/deployments';
import { ConflictError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { getOpsQueue } from '@/lib/queue';
import { requireApplicationScope, requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/** Redéploie la version précédente. Le travail réel appartient au worker. */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'deployment:rollback', {
    applicationScoped: true,
  });
  const { id } = paramsSchema.parse(await context.params);

  const deployment = await getDeploymentSummary(id);
  if (!deployment) throw new NotFoundError(msg(messages, 'error.notFound', { id }));
  await requireApplicationScope(request, auth, deployment.applicationId);

  if (!deployment.previousDeploymentId) {
    throw new ConflictError(msg(messages, 'error.noPrevious'));
  }
  if (deployment.status === 'running' || deployment.status === 'pending') {
    throw new ConflictError(msg(messages, 'error.inProgress'));
  }

  const job = await getOpsQueue().add(
    DEPLOYMENT_ROLLBACK_JOB,
    deploymentJobDataSchema.parse({ deploymentId: id, actorId: auth.userId, ip: auth.ip }),
    { attempts: 1 },
  );
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.enqueueFailed'));

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
