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

/**
 * État d'une tâche de la queue `ops`, quel que soit son type.
 *
 * Déplacée de `/api/jobs/:id` vers `/api/queue/jobs/:id` au jalon 8. La raison
 * est un conflit de ressources : `/api/jobs` désigne désormais les **tâches
 * planifiées**, qui sont des objets de la base avec un cycle de vie CRUD, et
 * `:id` y est l'identifiant d'une ligne `scheduled_jobs`. Une même route ne
 * pouvait pas répondre à la fois « où en est le job BullMQ n° 42 » et « modifie
 * la tâche planifiée <uuid> ». Ce sont deux ressources, elles ont deux chemins.
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
