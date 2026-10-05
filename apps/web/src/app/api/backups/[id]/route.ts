import { BACKUP_DELETE_JOB } from '@pupitre/core';
import { getBackup } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { backups as messages } from '@/i18n/messages/backups';
import { ConflictError, ForbiddenError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { getBackupsQueue } from '@/lib/backups';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * Erasing a backup: from the destination, then from the index. Through the queue
 * — it is the worker that talks to the destination. A panel backup falls under
 * the instance settings.
 */
export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'backup:manage');
  const { id } = paramsSchema.parse(await context.params);
  const backup = await getBackup(id);
  if (!backup) throw new NotFoundError(msg(messages, 'error.notFound'));
  if (backup.kind === 'panel' && !auth.can('settings:manage'))
    throw new ForbiddenError('settings:manage');
  if (backup.status === 'running') {
    throw new ConflictError(
      msg(messages, 'error.running', { app: backup.applicationSlug ?? 'pupitre' }),
    );
  }
  const job = await getBackupsQueue().add(BACKUP_DELETE_JOB, {
    backupId: id,
    actorId: auth.userId,
    ip: auth.ip,
  });
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.jobNoId'));
  return NextResponse.json({ jobId: job.id }, { status: 202 });
});
