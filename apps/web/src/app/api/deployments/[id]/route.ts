import { DEPLOYMENT_DESTROY_JOB, deploymentJobDataSchema } from '@pupitre/core';
import { getDeploymentSummary, listSteps, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deployments as messages } from '@/i18n/messages/deployments';
import { ConflictError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'deployment:read');
  const { id } = paramsSchema.parse(await context.params);

  const deployment = await getDeploymentSummary(id);
  if (!deployment) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  return NextResponse.json({ ...deployment, steps: await listSteps(id) });
});

export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'deployment:destroy');
  const { id } = paramsSchema.parse(await context.params);

  const deployment = await getDeploymentSummary(id);
  if (!deployment) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  if (deployment.status === 'running' || deployment.status === 'pending') {
    throw new ConflictError(msg(messages, 'error.running'));
  }
  if (deployment.status === 'destroyed') {
    throw new ConflictError(msg(messages, 'error.alreadyDestroyed'));
  }

  const job = await getOpsQueue().add(
    DEPLOYMENT_DESTROY_JOB,
    deploymentJobDataSchema.parse({ deploymentId: id, actorId: auth.userId, ip: auth.ip }),
    { attempts: 1 },
  );
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.enqueueFailed'));

  await logAudit({
    actorId: auth.userId,
    action: 'deployment.destroy.requested',
    resourceType: 'deployment',
    resourceId: id,
    after: { jobId: job.id, applicationSlug: deployment.applicationSlug },
    ip: auth.ip,
  });

  return NextResponse.json({ id, jobId: job.id, state: 'queued' }, { status: 202 });
});
