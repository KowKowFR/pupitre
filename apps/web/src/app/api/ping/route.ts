import { PING_JOB, pingJobDataSchema } from '@pupitre/core';
import { logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { jobs as messages } from '@/i18n/messages/jobs';
import { HttpError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { logger } from '@/lib/logger';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  message: z.string().min(1).max(280).default('pong'),
});

/**
 * Queues a smoke job on the `ops` queue. The route only queues: the real work
 * belongs to the worker.
 */
export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'job:manage');
  const body = await readJsonBody(request, bodySchema);

  const data = pingJobDataSchema.parse({
    message: body.message,
    requestedAt: new Date().toISOString(),
    actorId: auth.userId,
    ip: auth.ip,
  });

  const job = await getOpsQueue().add(PING_JOB, data);
  if (!job.id) {
    throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.noJobId'));
  }

  await logAudit({
    actorId: auth.userId,
    action: 'ping.enqueued',
    resourceType: 'job',
    resourceId: job.id,
    after: { queue: job.queueName, message: data.message },
    ip: auth.ip,
  });

  logger.info({ jobId: job.id, actorId: auth.userId }, 'ping queued');

  return NextResponse.json(
    { jobId: job.id, queue: job.queueName, message: data.message, state: 'queued' },
    { status: 202 },
  );
});
