import { randomUUID } from 'node:crypto';
import {
  BACKUP_APPLICATION_JOB,
  backupFolder,
  hasBackupData,
  hotCopiedServices,
  parseAppSpec,
  planBackup,
} from '@pupitre/core';
import {
  createBackupRecord,
  getActiveBackupDestination,
  getApplication,
  getBackupPolicy,
  hasRunningBackup,
  lastRestoreOf,
  listBackups,
  listLiveDeployments,
  listTargets,
  logAudit,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { backups as messages } from '@/i18n/messages/backups';
import { ConflictError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import {
  backupScheduleView,
  backupView,
  destinationView,
  getBackupsQueue,
  lastRestoreView,
} from '@/lib/backups';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * Everything an application's "Backups" card shows: the policy, what a backup
 * would contain in each mode, where it would go, when it runs, and what has
 * already been done.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'backup:read');
  const { id } = paramsSchema.parse(await context.params);
  const application = await getApplication(id);
  if (!application) throw new NotFoundError(msg(messages, 'error.applicationNotFound'));

  const spec = parseAppSpec(application.appSpec);
  const [policy, destination, schedule, rows, live, targets, lastRestore] = await Promise.all([
    getBackupPolicy(id),
    getActiveBackupDestination(),
    backupScheduleView('backup'),
    listBackups({ applicationId: id, limit: 50 }),
    listLiveDeployments({ applicationId: id }),
    listTargets(),
    lastRestoreOf(id),
  ]);

  return NextResponse.json({
    policy,
    hasData: hasBackupData(spec),
    plan: { hot: planBackup(spec, 'hot'), stop: planBackup(spec, 'stop') },
    hotCopied: hotCopiedServices(spec),
    destination: destination ? destinationView(destination) : null,
    schedule,
    targets: live
      .filter((couple) => couple.inService)
      .map((couple) => ({
        id: couple.targetId,
        name: targets.find((target) => target.id === couple.targetId)?.name ?? couple.targetId,
        stopped: couple.inService?.stoppedAt !== null,
      })),
    // The names of the targets its backups come from, even if it no longer runs there.
    targetNames: Object.fromEntries(
      targets
        .filter((target) => rows.some((row) => row.targetId === target.id))
        .map((target) => [target.id, target.name]),
    ),
    items: rows.map(backupView),
    lastRestore: lastRestoreView(lastRestore),
  });
});

const postSchema = z.object({ targetId: z.string().uuid() });

/** "Back up now": the row is created here, the job fills it. */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'backup:manage');
  const { id } = paramsSchema.parse(await context.params);
  const { targetId } = await readJsonBody(request, postSchema);
  const application = await getApplication(id);
  if (!application) throw new NotFoundError(msg(messages, 'error.applicationNotFound'));

  const destination = await getActiveBackupDestination();
  if (!destination) throw new ConflictError(msg(messages, 'error.noDestination'));
  const spec = parseAppSpec(application.appSpec);
  if (!hasBackupData(spec)) {
    throw new ConflictError(msg(messages, 'error.nothingToBackup', { app: application.slug }));
  }
  const [live] = await listLiveDeployments({ applicationId: id, targetId });
  if (!live?.inService) {
    throw new ConflictError(msg(messages, 'error.notDeployed', { app: application.slug }));
  }
  if (await hasRunningBackup(id)) {
    throw new ConflictError(msg(messages, 'error.running', { app: application.slug }));
  }

  const policy = await getBackupPolicy(id);
  const backupId = randomUUID();
  await createBackupRecord({
    id: backupId,
    kind: 'application',
    applicationId: id,
    applicationSlug: application.slug,
    targetId,
    deploymentId: live.inService.id,
    destinationId: destination.id,
    trigger: 'manual',
    mode: policy.mode,
    location: backupFolder('application', application.slug, backupId, new Date()),
    requestedBy: auth.userId,
  });
  const job = await getBackupsQueue().add(BACKUP_APPLICATION_JOB, {
    applicationId: id,
    targetId,
    trigger: 'manual',
    backupId,
    actorId: auth.userId,
    ip: auth.ip,
  });
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.jobNoId'));
  await logAudit({
    actorId: auth.userId,
    action: 'backup.requested',
    resourceType: 'application',
    resourceId: id,
    after: { backupId, application: application.slug, targetId, mode: policy.mode },
    ip: auth.ip,
  });
  return NextResponse.json({ backupId, jobId: job.id }, { status: 202 });
});
