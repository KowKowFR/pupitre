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
  // i18n-ignore — message Zod : il voyage dans `error.details`, que le panel
  // n'affiche pas. C'est un diagnostic pour qui appelle l'API à la main.
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9:_-]+$/, 'identifiant de tâche invalide'),
});

type Context = { params: Promise<{ id: string }> };

export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'job:read');
  const { id } = paramsSchema.parse(await context.params);

  const job = await getOpsQueue().getJob(id);
  if (!job) {
    throw new NotFoundError(msg(messages, 'error.queueJobNotFound', { id }));
  }

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
