import { DEPLOYMENT_DESTROY_JOB, deploymentJobDataSchema } from '@tp/core';
import { getDeploymentSummary, listSteps, logAudit } from '@tp/db';
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

export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'deployment:read');
  const { id } = paramsSchema.parse(await context.params);

  const deployment = await getDeploymentSummary(id);
  if (!deployment) throw new NotFoundError(`Déploiement « ${id} » introuvable`);

  return NextResponse.json({ ...deployment, steps: await listSteps(id) });
});

export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'deployment:destroy');
  const { id } = paramsSchema.parse(await context.params);

  const deployment = await getDeploymentSummary(id);
  if (!deployment) throw new NotFoundError(`Déploiement « ${id} » introuvable`);

  if (deployment.status === 'running' || deployment.status === 'pending') {
    throw new ConflictError('Ce déploiement est en cours. Attendez qu’il se termine.');
  }
  if (deployment.status === 'destroyed') {
    throw new ConflictError('Ce déploiement est déjà détruit.');
  }

  const job = await getOpsQueue().add(
    DEPLOYMENT_DESTROY_JOB,
    deploymentJobDataSchema.parse({ deploymentId: id, actorId: auth.userId, ip: auth.ip }),
    { attempts: 1 },
  );
  if (!job.id) throw new HttpError(500, 'enqueue_failed', "La tâche n'a pas reçu d'identifiant");

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
