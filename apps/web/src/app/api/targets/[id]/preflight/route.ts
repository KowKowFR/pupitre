import { TARGET_PREFLIGHT_JOB, targetPreflightJobDataSchema } from '@tp/core';
import { getTarget, logAudit } from '@tp/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { HttpError, NotFoundError } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

type Context = { params: Promise<{ id: string }> };

/**
 * Enfile un preflight. La route n'ouvre aucune session SSH : la connexion est
 * une opération longue, elle appartient au worker.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'target:update');
  const { id } = paramsSchema.parse(await context.params);

  const target = await getTarget(id);
  if (!target) throw new NotFoundError(`Cible « ${id} » introuvable`);

  const data = targetPreflightJobDataSchema.parse({
    targetId: id,
    actorId: auth.userId,
    ip: auth.ip,
  });

  const job = await getOpsQueue().add(TARGET_PREFLIGHT_JOB, data, {
    // Un preflight qui échoue échoue pour de bon : le rejouer masquerait
    // le diagnostic que l'opérateur attend.
    attempts: 1,
  });

  if (!job.id) {
    throw new HttpError(500, 'enqueue_failed', "La tâche n'a pas reçu d'identifiant");
  }

  await logAudit({
    actorId: auth.userId,
    action: 'target.preflight.requested',
    resourceType: 'target',
    resourceId: id,
    after: { jobId: job.id, host: target.host },
    ip: auth.ip,
  });

  return NextResponse.json(
    { jobId: job.id, targetId: id, state: 'queued' },
    { status: 202 },
  );
});
