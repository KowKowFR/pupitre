import {
  WORKLOAD_REMOVE_JOB,
  decodeWorkloadRef,
  workloadActionJobDataSchema,
  workloadChannel,
  workloadCopy,
} from '@pupitre/core';
import { getTarget, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { targets as messages } from '@/i18n/messages/targets';
import { ConflictError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';
import { fetchWorkloads, findWorkload } from '../inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid(), ref: z.string().min(3).max(320) });
type Context = { params: Promise<{ id: string; ref: string }> };

/**
 * Deletes a workload from the target.
 *
 * The guardrail is here, before the queue, and that is what gives it its meaning:
 * a workload deployed by the panel already has a life cycle — restart,
 * destruction, rollback — and a database row that records it. Erasing it through
 * this path would leave the database convinced that the application runs, its
 * port reserved for nothing, and the panel would lie about the state of the
 * world. The same reasoning as a deployment's purge, which refuses to erase the
 * trace of an application still running.
 *
 * The refusal is a 409 whose message says what to do instead. The driver refuses
 * it a second time on its side: this route is not the only possible caller.
 */
export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'workload:manage');
  const { id, ref } = paramsSchema.parse(await context.params);

  const target = await getTarget(id);
  if (!target) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const decoded = decodeWorkloadRef(ref);
  if (!decoded) {
    throw new HttpError(422, 'invalid_workload_ref', msg(messages, 'error.badWorkloadRef', { ref }));
  }

  // The inventory is authoritative, not what the client claims: it is the machine
  // that says whether this workload is the panel's, not the form that calls it.
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
      action: 'workload.remove.refused',
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
    // The refusal is written once, in `@pupitre/core`, because the driver raises it
    // on its side. We designate its key rather than call the function: `apiRoute()`
    // renders the sentence in the instance's language, and `error.message` stays in
    // the source language for the logs.
    throw new ConflictError(
      workload.managedApp
        ? msg(workloadCopy, 'managed.refusal.app', {
            name: workload.name,
            app: workload.managedApp,
          })
        : msg(workloadCopy, 'managed.refusal', { name: workload.name }),
    );
  }

  const data = workloadActionJobDataSchema.parse({
    targetId: id,
    ref: decoded,
    action: 'remove',
    name: workload.name,
    actorId: auth.userId,
    ip: auth.ip,
  });

  // Without a custom identifier: a reference contains a `:`, which BullMQ refuses
  // in a "Custom Id". And without replay: replaying a deletion makes no sense.
  const job = await getOpsQueue().add(WORKLOAD_REMOVE_JOB, data, { attempts: 1 });
  if (!job.id) {
    throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.jobNoId'));
  }

  await logAudit({
    actorId: auth.userId,
    action: 'workload.remove.requested',
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
      action: 'remove',
      state: 'queued',
      channel: workloadChannel(id),
    },
    { status: 202 },
  );
});
