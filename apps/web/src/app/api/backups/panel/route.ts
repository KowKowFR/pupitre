import { randomUUID } from 'node:crypto';
import { BACKUP_PANEL_JOB, backupFolder } from '@pupitre/core';
import {
  createBackupRecord,
  getActiveBackupDestination,
  hasRunningBackup,
  listBackups,
  logAudit,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { backups as messages } from '@/i18n/messages/backups';
import { ConflictError, HttpError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { backupScheduleView, backupView, getBackupsQueue } from '@/lib/backups';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Les sauvegardes de la base du panel, et la tâche qui les planifie. */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'settings:read');
  const [rows, schedule] = await Promise.all([
    listBackups({ kind: 'panel', limit: 30 }),
    backupScheduleView('panel_backup'),
  ]);
  return NextResponse.json({ items: rows.map(backupView), schedule });
});

/** « Sauvegarder maintenant ». */
export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'settings:manage');
  const destination = await getActiveBackupDestination();
  if (!destination) throw new ConflictError(msg(messages, 'error.noDestination'));
  if (await hasRunningBackup(null)) throw new ConflictError(msg(messages, 'error.panelRunning'));

  const id = randomUUID();
  await createBackupRecord({
    id,
    kind: 'panel',
    applicationId: null,
    applicationSlug: null,
    targetId: null,
    deploymentId: null,
    destinationId: destination.id,
    trigger: 'manual',
    mode: null,
    location: backupFolder('panel', null, id, new Date()),
    requestedBy: auth.userId,
  });
  const job = await getBackupsQueue().add(BACKUP_PANEL_JOB, {
    trigger: 'manual',
    backupId: id,
    actorId: auth.userId,
    ip: auth.ip,
  });
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.jobNoId'));
  await logAudit({
    actorId: auth.userId,
    action: 'backup.requested',
    resourceType: 'settings',
    resourceId: null,
    after: { kind: 'panel', backupId: id },
    ip: auth.ip,
  });
  return NextResponse.json({ backupId: id, jobId: job.id }, { status: 202 });
});
