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
 * Supprime une charge de la cible.
 *
 * Le garde-fou est ici, avant la file, et c'est ce qui lui donne son sens : une
 * charge déployée par le panel a déjà un cycle de vie — redémarrage,
 * destruction, rollback — et une ligne en base qui l'enregistre. L'effacer par
 * ce chemin laisserait la base persuadée que l'application tourne, son port
 * réservé pour rien, et le panel mentirait sur l'état du monde. Même
 * raisonnement que la purge d'un déploiement, qui refuse d'effacer la trace
 * d'une application encore en marche.
 *
 * Le refus est un 409 dont le message dit quoi faire à la place. Le driver le
 * refuse une seconde fois de son côté : cette route n'est pas le seul appelant
 * possible.
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

  // L'inventaire fait autorité, pas ce que le client affirme : c'est la machine
  // qui dit si cette charge est celle du panel, pas le formulaire qui l'appelle.
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
    // Le refus est écrit une fois, dans `@pupitre/core`, parce que le driver le
    // relève de son côté. On désigne sa clé plutôt que d'appeler la fonction :
    // `apiRoute()` rend la phrase dans la langue de l'instance, et
    // `error.message` reste en français pour les logs.
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

  // Sans identifiant personnalisé : une référence contient un `:`, que BullMQ
  // refuse dans un « Custom Id ». Et sans rejeu : rejouer une suppression n'a
  // aucun sens.
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
