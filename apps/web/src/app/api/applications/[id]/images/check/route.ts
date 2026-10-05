import { IMAGE_CHECK_JOB, imageCheckJobDataSchema } from '@pupitre/core';
import { getApplication } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { applications as messages } from '@/i18n/messages/applications';
import { HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { enforceRateLimit, type RateLimitRule } from '@/lib/rate-limit';
import { requirePermission } from '@/lib/rbac';
import { getSupervisionQueue } from '@/lib/supervision-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/** Public registries count requests: no burst from a button. */
const CHECK_RULE: RateLimitRule = { name: 'images:check', limit: 6, windowSec: 60 };

/**
 * "Check now": the same job as the scheduled check, restricted to this
 * application. Through the queue — a check opens an SSH session per target and
 * queries registries. The result comes back through the `applications` real-time
 * signal, which refreshes the record.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'application:read');
  await enforceRateLimit(CHECK_RULE, auth.userId);
  const { id } = paramsSchema.parse(await context.params);

  const application = await getApplication(id);
  if (!application) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const data = imageCheckJobDataSchema.parse({
    applicationId: id,
    actorId: auth.userId,
    ip: auth.ip,
  });
  // One identifier per application: two clicks close together make only one job.
  const job = await getSupervisionQueue().add(IMAGE_CHECK_JOB, data, {
    jobId: `images-check-${id}-${Math.floor(Date.now() / 10_000)}`,
    attempts: 1,
    removeOnComplete: { age: 3600, count: 100 },
    removeOnFail: { age: 24 * 3600, count: 100 },
  });
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.jobNoId'));

  return NextResponse.json({ jobId: job.id, state: 'queued' }, { status: 202 });
});
