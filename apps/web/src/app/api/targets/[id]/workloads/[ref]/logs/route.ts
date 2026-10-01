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
  /** Tiré par le navigateur, qui a déjà ouvert le flux de cette exécution. */
  run: z.string().uuid(),
  tail: z.number().int().min(10).max(WORKLOAD_LOGS_MAX_TAIL).default(300),
});

/**
 * Les dernières lignes du journal d'une charge. Elles reviennent par le flux
 * temps réel de la cible, marquées de `run` : seul l'écran qui les a
 * demandées les lit. `workload:manage` et non `workload:read` — un journal de
 * conteneur peut porter des secrets.
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
