import {
  WORKLOAD_LOGS_JOB,
  WORKLOAD_LOGS_MAX_TAIL,
  workloadChannel,
  workloadLogsJobDataSchema,
} from '@pupitre/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { targets as messages } from '@/i18n/messages/targets';
import { HttpError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { claimWorkloadRun } from '@/lib/workload-runs';
import { getSupervisionQueue } from '@/lib/supervision-queue';
import { resolveWorkload } from '../../resolve';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid(), ref: z.string().min(3).max(320) });
type Context = { params: Promise<{ id: string; ref: string }> };

const bodySchema = z.object({
  /** Drawn by the browser, which already opened this run's stream. */
  run: z.string().uuid(),
  tail: z.number().int().min(10).max(WORKLOAD_LOGS_MAX_TAIL).default(300),
});

/**
 * The last lines of a workload's log. They come back through the target's
 * real-time stream, marked with `run`: only the screen that asked for them reads
 * them. `workload:manage` and not `workload:read` — a container log can carry
 * secrets.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'workload:manage');
  const { id, ref } = paramsSchema.parse(await context.params);
  const { tail, run } = await readJsonBody(request, bodySchema);
  if (!(await claimWorkloadRun(run, auth.userId))) {
    throw new HttpError(403, 'run_not_owned', msg(messages, 'error.runNotOwned'));
  }
  const { ref: decoded, workload } = await resolveWorkload(id, ref, auth);

  const data = workloadLogsJobDataSchema.parse({
    targetId: id,
    ref: decoded,
    action: 'logs',
    name: workload.name,
    tail,
    run,
    actorId: auth.userId,
    ip: auth.ip,
  });
  const job = await getSupervisionQueue().add(WORKLOAD_LOGS_JOB, data, { attempts: 1 });
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.jobNoId'));

  return NextResponse.json(
    { jobId: job.id, run, ref, name: workload.name, channel: workloadChannel(id) },
    { status: 202 },
  );
});
