import {
  WORKLOAD_UPDATE_JOB,
  decodeWorkloadRef,
  workloadActionJobDataSchema,
  workloadChannel,
} from '@pupitre/core';
import { getTarget, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ConflictError, HttpError, NotFoundError } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';
import { fetchWorkloads, findWorkload } from '../../inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid(), ref: z.string().min(3).max(320) });
type Context = { params: Promise<{ id: string; ref: string }> };

/**
 * Met à jour une charge : image la plus récente, même configuration.
 *
 * Toujours par la file, jamais dans la route : un `docker pull` tire des
 * dizaines de mégaoctets, un `rollout status` attend que des pods démarrent.
 * La progression part sur `workload:{targetId}` et se relaie en SSE.
 *
 * Une charge du panel est refusée ici aussi : la mettre à jour, c'est la
 * redéployer — le panel a un pipeline pour ça, avec ses scans et son historique.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'workload:manage');
  const { id, ref } = paramsSchema.parse(await context.params);

  const target = await getTarget(id);
  if (!target) throw new NotFoundError(`Cible « ${id} » introuvable`);

  const decoded = decodeWorkloadRef(ref);
  if (!decoded) {
    throw new HttpError(422, 'invalid_workload_ref', `Référence de charge illisible : « ${ref} »`);
  }

  const list = await fetchWorkloads(id, auth.userId, auth.ip);
  const workload = findWorkload(list, ref);
  if (!workload) {
    throw new NotFoundError(`Aucune charge « ${ref} » sur « ${target.name} »`);
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
    throw new ConflictError(
      `« ${workload.name} » est déployée par le panel` +
        `${workload.managedApp ? ` (application « ${workload.managedApp} »)` : ''} : ` +
        'sa mise à jour est un redéploiement. Lancez-en un depuis la fiche de ' +
        "l'application, qui rejouera aussi les scans et l'historique.",
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
    throw new HttpError(500, 'enqueue_failed', "La tâche n'a pas reçu d'identifiant");
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
