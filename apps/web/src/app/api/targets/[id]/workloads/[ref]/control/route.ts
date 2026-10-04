import {
  WORKLOAD_CONTROL_JOB,
  workloadChannel,
  workloadControlActionSchema,
  workloadControlJobDataSchema,
} from '@pupitre/core';
import { logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { targets as messages } from '@/i18n/messages/targets';
import { ConflictError, HttpError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';
import { resolveWorkload } from '../../resolve';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid(), ref: z.string().min(3).max(320) });
type Context = { params: Promise<{ id: string; ref: string }> };

const bodySchema = z.object({ action: workloadControlActionSchema });

/**
 * Starting, stopping, restarting a workload. Through the queue: a stop gives the
 * process twenty seconds, a `rollout status` waits for pods.
 *
 * A panel workload is restarted here, but neither stopped nor started: it is the
 * application's stop that keeps its state in the database. The refusal is
 * returned here, before the queue; the driver does it again on its side.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'workload:manage');
  const { id, ref } = paramsSchema.parse(await context.params);
  const { action } = await readJsonBody(request, bodySchema);
  const { target, ref: decoded, workload } = await resolveWorkload(id, ref, auth);

  if (workload.managed && action !== 'restart') {
    await logAudit({
      actorId: auth.userId,
      action: `workload.${action}.refused`,
      resourceType: 'target',
      resourceId: id,
      after: {
        workload: workload.name,
        ref,
        runtime: workload.runtime,
        targetName: target.name,
        reason: 'managed_by_panel',
        managedApp: workload.managedApp,
      },
      ip: auth.ip,
    });
    throw new ConflictError(msg(messages, 'error.workloadManagedControl', { name: workload.name }));
  }

  const data = workloadControlJobDataSchema.parse({
    targetId: id,
    ref: decoded,
    action,
    name: workload.name,
    actorId: auth.userId,
    ip: auth.ip,
  });
  const job = await getOpsQueue().add(WORKLOAD_CONTROL_JOB, data, { attempts: 1 });
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.jobNoId'));

  return NextResponse.json(
    { jobId: job.id, ref, name: workload.name, action, channel: workloadChannel(id) },
    { status: 202 },
  );
});
