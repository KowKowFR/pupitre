import { BACKUP_RESTORE_JOB } from '@pupitre/core';
import {
  getApplication,
  getBackup,
  hasRunningBackup,
  listDeployments,
  listLiveDeployments,
  logAudit,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { backups as messages } from '@/i18n/messages/backups';
import { ConflictError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { getBackupsQueue } from '@/lib/backups';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  /** By default: the target the backup comes from. */
  targetId: z.string().uuid().optional(),
  safetyBackup: z.boolean().default(true),
});

/**
 * Restoring — replacing the application's data with a backup's. Its own
 * permission, `backup:restore`. The refusals known in advance are returned here;
 * the rest is said in the job's log.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'backup:restore');
  const { id } = paramsSchema.parse(await context.params);
  const input = await readJsonBody(request, bodySchema);
  const backup = await getBackup(id);
  if (!backup) throw new NotFoundError(msg(messages, 'error.notFound'));
  if (backup.kind !== 'application' || backup.status !== 'success') {
    throw new ConflictError(msg(messages, 'error.notRestorable'));
  }
  const application = backup.applicationId ? await getApplication(backup.applicationId) : null;
  if (!application) throw new ConflictError(msg(messages, 'error.applicationGone'));

  const targetId = input.targetId ?? backup.targetId;
  if (!targetId) throw new NotFoundError(msg(messages, 'error.targetNotFound'));
  const [live] = await listLiveDeployments({ applicationId: application.id, targetId });
  if (!live?.inService) {
    throw new ConflictError(msg(messages, 'error.notDeployed', { app: application.slug }));
  }
  if (live.inService.stoppedAt) {
    throw new ConflictError(msg(messages, 'error.appStopped', { app: application.slug }));
  }
  if (await hasRunningBackup(application.id)) {
    throw new ConflictError(msg(messages, 'error.running', { app: application.slug }));
  }
  const running = await listDeployments({
    applicationId: application.id,
    status: 'running',
    page: 1,
    pageSize: 1,
  }).catch(() => null);
  if (running && running.items.length > 0) {
    throw new ConflictError(msg(messages, 'error.deploying', { app: application.slug }));
  }

  const job = await getBackupsQueue().add(BACKUP_RESTORE_JOB, {
    backupId: id,
    targetId,
    safetyBackup: input.safetyBackup,
    actorId: auth.userId,
    ip: auth.ip,
  });
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.jobNoId'));
  await logAudit({
    actorId: auth.userId,
    action: 'backup.restore.requested',
    resourceType: 'application',
    resourceId: application.id,
    after: {
      backupId: id,
      backupDate: backup.startedAt.toISOString(),
      targetId,
      safetyBackup: input.safetyBackup,
    },
    ip: auth.ip,
  });
  return NextResponse.json({ jobId: job.id }, { status: 202 });
});
