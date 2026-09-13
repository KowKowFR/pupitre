import { getScheduledJob, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { jobs as messages } from '@/i18n/messages/jobs';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { triggerNow } from '@/lib/schedules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

type Context = { params: Promise<{ id: string }> };

/**
 * Déclenchement manuel.
 *
 * La route enfile une occurrence et rend la main : le travail lui-même est
 * long — sessions SSH, scanners — et n'a rien à faire dans une requête HTTP.
 * L'occurrence est marquée `manual`, donc distinguable dans l'historique, et
 * elle s'exécute même si la tâche est désactivée : c'est précisément à quoi
 * sert un « lancer maintenant » sur une tâche que l'on est en train de régler.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'job:manage');
  const { id } = paramsSchema.parse(await context.params);

  const row = await getScheduledJob(id);
  if (!row) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const jobId = await triggerNow(row, { userId: auth.userId, ip: auth.ip });

  await logAudit({
    actorId: auth.userId,
    action: 'schedule.triggered',
    resourceType: 'scheduled_job',
    resourceId: row.id,
    after: { key: row.key, type: row.type, jobId },
    ip: auth.ip,
  });

  return NextResponse.json({ scheduledJobId: row.id, jobId, key: row.key }, { status: 202 });
});
