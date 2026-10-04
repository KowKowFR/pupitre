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
 * Restarts a running application. Same images, same volumes, same port: it is
 * neither a deployment nor a rollback. The route queues and gives control back.
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
   * Restarting a stopped application would be ambiguous: `docker compose restart`
   * would indeed start the containers again — the database would still believe it
   * stopped and the periodic probe would keep ignoring it —, while a `rollout
   * restart` on zero replicas would do nothing at all. The same button for two
   * opposite effects depending on the runtime is exactly what the architecture
   * refuses. The gesture exists, it is called "Start".
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
