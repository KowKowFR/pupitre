import { MONITOR_SWEEP_JOB, monitorSweepJobDataSchema } from '@tp/core';
import { getMonitor, logAudit, markMonitorDue, monitorTarget } from '@tp/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { HttpError, NotFoundError } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { getSupervisionQueue } from '@/lib/supervision-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * « Sonder maintenant ».
 *
 * La route **enfile et rend la main** : sonder, c'est du réseau avec un délai
 * qui peut aller à trente secondes, et une route HTTP n'est pas l'endroit pour
 * ça. Le résultat arrive par la sonde elle-même, et l'écran le relit.
 *
 * `monitor:manage` et non `monitor:read` : déclencher une requête sortante est
 * un geste, pas une lecture.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'monitor:manage');
  const { id } = paramsSchema.parse(await context.params);

  const monitor = await getMonitor(id);
  if (!monitor) throw new NotFoundError(`Sonde « ${id} » introuvable`);

  // Avancer l'échéance sert au cas où le worker enfilerait la tâche après le
  // prochain balayage : la sonde serait due de toute façon.
  await markMonitorDue(id);

  const job = await getSupervisionQueue().add(
    MONITOR_SWEEP_JOB,
    monitorSweepJobDataSchema.parse({
      monitorId: id,
      // Une sonde suspendue se sonde quand même à la demande : c'est justement
      // comme ça qu'on vérifie qu'elle peut être reprise.
      force: true,
      actorId: auth.userId,
      ip: auth.ip,
    }),
  );
  if (!job.id) throw new HttpError(500, 'enqueue_failed', "La tâche n'a pas reçu d'identifiant");

  await logAudit({
    actorId: auth.userId,
    action: 'monitor.check.requested',
    resourceType: 'monitor',
    resourceId: id,
    after: { jobId: job.id, name: monitor.name, target: monitorTarget(monitor) },
    ip: auth.ip,
  });

  return NextResponse.json({ id, jobId: job.id, state: 'queued' }, { status: 202 });
});
