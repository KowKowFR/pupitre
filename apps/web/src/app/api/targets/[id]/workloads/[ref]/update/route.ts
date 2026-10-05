import {
  WORKLOAD_UPDATE_JOB,
  decodeWorkloadRef,
  workloadActionJobDataSchema,
  workloadChannel,
} from '@pupitre/core';
import { getTarget, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { targets as messages } from '@/i18n/messages/targets';
import { ConflictError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';
import { fetchWorkloads, findWorkload } from '../../inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid(), ref: z.string().min(3).max(320) });
type Context = { params: Promise<{ id: string; ref: string }> };

/**
 * Updates a workload: the most recent image, the same configuration.
 *
 * Always through the queue, never in the route: a `docker pull` pulls dozens of
 * megabytes, a `rollout status` waits for pods to start. The progress goes out on
 * `workload:{targetId}` and is relayed over SSE.
 *
 * A panel workload is refused here too: updating it is redeploying it — the
 * panel has a pipeline for that, with its scans and its history.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'workload:manage');
  const { id, ref } = paramsSchema.parse(await context.params);

  const target = await getTarget(id);
  if (!target) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const decoded = decodeWorkloadRef(ref);
  if (!decoded) {
    throw new HttpError(422, 'invalid_workload_ref', msg(messages, 'error.badWorkloadRef', { ref }));
  }

  const list = await fetchWorkloads(id, auth.userId, auth.ip);
  const workload = findWorkload(list, ref);
  if (!workload) {
    throw new NotFoundError(
      msg(messages, 'error.workloadNotFound', { ref, name: target.name }),
    );
  }

  if (workload.managed) {
    await logAudit({
      actorId: auth.userId,
      action: 'workload.update.refused',
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
    // Two keys rather than an interpolated fragment: `msg()` only renders the
    // sentence at serialization time, when the language is known — a piece of French
    // pasted here would never have been translated.
    throw new ConflictError(
      workload.managedApp
        ? msg(messages, 'error.workloadManagedUpdateApp', {
            name: workload.name,
            app: workload.managedApp,
          })
        : msg(messages, 'error.workloadManagedUpdate', { name: workload.name }),
    );
  }

  const data = workloadActionJobDataSchema.parse({
    targetId: id,
    ref: decoded,
    action: 'update',
    name: workload.name,
    actorId: auth.userId,
    ip: auth.ip,
  });

  const job = await getOpsQueue().add(WORKLOAD_UPDATE_JOB, data, { attempts: 1 });
  if (!job.id) {
    throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.jobNoId'));
  }

  await logAudit({
    actorId: auth.userId,
    action: 'workload.update.requested',
    resourceType: 'target',
    resourceId: id,
    after: {
      workload: workload.name,
      ref,
      runtime: workload.runtime,
      image: workload.image,
      targetName: target.name,
      jobId: job.id,
    },
    ip: auth.ip,
  });

  return NextResponse.json(
    {
      jobId: job.id,
      targetId: id,
      ref,
      name: workload.name,
      action: 'update',
      state: 'queued',
      channel: workloadChannel(id),
    },
    { status: 202 },
  );
});
