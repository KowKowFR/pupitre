import { NextResponse } from 'next/server';
import { z } from 'zod';
import { jobs as messages } from '@/i18n/messages/jobs';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({
  // i18n-ignore — a Zod message: it travels in `error.details`, which the panel
  // does not show. It is a diagnosis for whoever calls the API by hand.
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9:_-]+$/, 'identifiant de tâche invalide'),
});

type Context = { params: Promise<{ id: string }> };

/**
 * The state of an `ops` queue job, whatever its type.
 *
 * Moved from `/api/jobs/:id` to `/api/queue/jobs/:id`. The reason is a resource
 * conflict: `/api/jobs` now designates the **scheduled tasks**, which are
 * database objects with a CRUD life cycle, and `:id` there is the identifier of a
 * `scheduled_jobs` row. The same route could not answer both "where is BullMQ
 * job no. 42" and "change scheduled task <uuid>". They are two resources, they
 * have two paths.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'job:read');
  const { id } = paramsSchema.parse(await context.params);

  const job = await getOpsQueue().getJob(id);
  if (!job) throw new NotFoundError(msg(messages, 'error.queueJobNotFound', { id }));

  const state = await job.getState();

  return NextResponse.json({
    jobId: job.id,
    name: job.name,
    queue: job.queueName,
    state,
    attemptsMade: job.attemptsMade,
    createdAt: new Date(job.timestamp).toISOString(),
    processedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
    finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    result: job.returnvalue ?? null,
    failedReason: job.failedReason ?? null,
  });
});
