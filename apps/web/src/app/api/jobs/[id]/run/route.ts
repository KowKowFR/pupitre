import { getScheduledJob, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { jobs as messages } from '@/i18n/messages/jobs';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { triggerNow } from '@/lib/schedules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

type Context = { params: Promise<{ id: string }> };

/**
 * Manual trigger.
 *
 * The route queues an occurrence and gives control back: the work itself is long
 * — SSH sessions, scanners — and has no business in an HTTP request. The
 * occurrence is marked `manual`, hence distinguishable in the history, and it
 * runs even if the task is disabled: that is precisely what a "run now" is for on
 * a task one is tuning.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'job:manage');
  const { id } = paramsSchema.parse(await context.params);

  const row = await getScheduledJob(id);
  if (!row) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const jobId = await triggerNow(row, { userId: auth.userId, ip: auth.ip });

  await logAudit({
    actorId: auth.userId,
    action: 'schedule.triggered',
    resourceType: 'scheduled_job',
    resourceId: row.id,
    after: { key: row.key, type: row.type, jobId },
    ip: auth.ip,
  });

  return NextResponse.json({ scheduledJobId: row.id, jobId, key: row.key }, { status: 202 });
});
