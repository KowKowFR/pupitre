import { BACKUP_DESTINATION_CHECK_JOB } from '@pupitre/core';
import { getActiveBackupDestination } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { backups as messages } from '@/i18n/messages/backups';
import { HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { getSupervisionQueue } from '@/lib/supervision-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * "Test": write, read back and erase a witness file, through the worker — it is
 * the worker that will reach the destination, not the panel. The verdict comes
 * back on the destination itself (`lastCheckedAt`, `lastCheckError`).
 */
export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'settings:manage');
  const destination = await getActiveBackupDestination();
  if (!destination) throw new NotFoundError(msg(messages, 'error.noDestination'));
  const job = await getSupervisionQueue().add(BACKUP_DESTINATION_CHECK_JOB, {
    destinationId: destination.id,
    actorId: auth.userId,
    ip: auth.ip,
  });
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.jobNoId'));
  return NextResponse.json({ jobId: job.id }, { status: 202 });
});
