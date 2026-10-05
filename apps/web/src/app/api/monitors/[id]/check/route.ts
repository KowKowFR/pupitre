import { MONITOR_SWEEP_JOB, monitorSweepJobDataSchema } from '@pupitre/core';
import { getMonitor, logAudit, markMonitorDue, monitorTarget } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { monitors as messages } from '@/i18n/messages/monitors';
import { HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { getSupervisionQueue } from '@/lib/supervision-queue';
import { currentLanguage } from '@/i18n/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * "Probe now".
 *
 * The route **queues and gives control back**: probing is network with a delay
 * that can go up to thirty seconds, and an HTTP route is not the place for that.
 * The result arrives through the probe itself, and the screen reads it again.
 *
 * `monitor:manage` and not `monitor:read`: triggering an outgoing request is a
 * gesture, not a read.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'monitor:manage');
  const { id } = paramsSchema.parse(await context.params);

  const monitor = await getMonitor(id);
  if (!monitor) throw new NotFoundError(msg(messages, 'error.monitorNotFound', { id }));

  // Bringing the due time forward serves the case where the worker would queue the
  // job after the next sweep: the probe would be due anyway.
  await markMonitorDue(id);

  const job = await getSupervisionQueue().add(
    MONITOR_SWEEP_JOB,
    monitorSweepJobDataSchema.parse({
      monitorId: id,
      // A paused probe is probed on demand all the same: it is precisely how one
      // checks that it can be resumed.
      force: true,
      actorId: auth.userId,
      ip: auth.ip,
    }),
  );
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.noJobId'));

  await logAudit({
    actorId: auth.userId,
    action: 'monitor.check.requested',
    resourceType: 'monitor',
    resourceId: id,
    after: {
      jobId: job.id,
      name: monitor.name,
      target: monitorTarget(monitor, await currentLanguage()),
    },
    ip: auth.ip,
  });

  return NextResponse.json({ id, jobId: job.id, state: 'queued' }, { status: 202 });
});
