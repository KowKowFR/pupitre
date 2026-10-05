import { TARGET_PREFLIGHT_JOB, targetPreflightJobDataSchema } from '@pupitre/core';
import { getTarget, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { targets as messages } from '@/i18n/messages/targets';
import { HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

type Context = { params: Promise<{ id: string }> };

/**
 * Queues a preflight. The route opens no SSH session: the connection is a
 * long-running operation, it belongs to the worker.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'target:update');
  const { id } = paramsSchema.parse(await context.params);

  const target = await getTarget(id);
  if (!target) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const data = targetPreflightJobDataSchema.parse({
    targetId: id,
    actorId: auth.userId,
    ip: auth.ip,
  });

  const job = await getOpsQueue().add(TARGET_PREFLIGHT_JOB, data, {
    // A preflight that fails fails for good: replaying it would mask the diagnosis
    // the operator is waiting for.
    attempts: 1,
  });

  if (!job.id) {
    throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.jobNoId'));
  }

  await logAudit({
    actorId: auth.userId,
    action: 'target.preflight.requested',
    resourceType: 'target',
    resourceId: id,
    after: { jobId: job.id, host: target.host },
    ip: auth.ip,
  });

  return NextResponse.json(
    { jobId: job.id, targetId: id, state: 'queued' },
    { status: 202 },
  );
});
