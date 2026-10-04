import {
  WORKLOAD_EXEC_JOB,
  WORKLOAD_EXEC_MAX_COMMAND,
  workloadChannel,
  workloadExecJobDataSchema,
} from '@pupitre/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { targets as messages } from '@/i18n/messages/targets';
import { HttpError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { getOpsQueue } from '@/lib/queue';
import { enforceRateLimit, type RateLimitRule } from '@/lib/rate-limit';
import { requirePermission } from '@/lib/rbac';
import { claimWorkloadRun } from '@/lib/workload-runs';
import { resolveWorkload } from '../../resolve';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid(), ref: z.string().min(3).max(320) });
type Context = { params: Promise<{ id: string; ref: string }> };

const bodySchema = z.object({
  /** Drawn by the browser, which already opened this run's stream. */
  run: z.string().uuid(),
  command: z.string().trim().min(1).max(WORKLOAD_EXEC_MAX_COMMAND),
});

/** A console, not a burst launcher. */
const EXEC_RULE: RateLimitRule = { name: 'workload:exec', limit: 30, windowSec: 60 };

/**
 * Running a command in a workload — non-interactive, under `sh -c`, two minutes
 * at most, two thousand output lines at most.
 *
 * Its own permission, `workload:exec`: it is the hand in the container, data
 * included. Each command is traced in the audit log with its exit code (by the
 * worker, once executed); its output only goes to the screen that started it,
 * never to the database.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'workload:exec');
  await enforceRateLimit(EXEC_RULE, auth.userId);
  const { id, ref } = paramsSchema.parse(await context.params);
  const { command, run } = await readJsonBody(request, bodySchema);
  if (!(await claimWorkloadRun(run, auth.userId))) {
    throw new HttpError(403, 'run_not_owned', msg(messages, 'error.runNotOwned'));
  }
  const { ref: decoded, workload } = await resolveWorkload(id, ref, auth);

  const data = workloadExecJobDataSchema.parse({
    targetId: id,
    ref: decoded,
    action: 'exec',
    name: workload.name,
    command,
    run,
    actorId: auth.userId,
    ip: auth.ip,
  });
  const job = await getOpsQueue().add(WORKLOAD_EXEC_JOB, data, { attempts: 1 });
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.jobNoId'));

  return NextResponse.json(
    { jobId: job.id, run, ref, name: workload.name, channel: workloadChannel(id) },
    { status: 202 },
  );
});
