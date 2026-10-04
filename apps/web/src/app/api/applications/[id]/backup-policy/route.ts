import { backupPolicySchema } from '@pupitre/core';
import { getApplication, getBackupPolicy, logAudit, saveBackupPolicy } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { backups as messages } from '@/i18n/messages/backups';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { ensureBackupSchedule } from '@/lib/backups';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * Setting an application's backup. Enabling it creates, if needed, the
 * "Applications backups" scheduled task — without it, nothing would run.
 */
export const PUT = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'backup:manage');
  const { id } = paramsSchema.parse(await context.params);
  const policy = await readJsonBody(request, backupPolicySchema);
  const application = await getApplication(id);
  if (!application) throw new NotFoundError(msg(messages, 'error.applicationNotFound'));

  const before = await getBackupPolicy(id);
  await saveBackupPolicy(id, policy, auth.userId);
  if (policy.enabled) await ensureBackupSchedule('backup');
  await logAudit({
    actorId: auth.userId,
    action: 'backup.policy.updated',
    resourceType: 'application',
    resourceId: id,
    before: before.configured
      ? {
          enabled: before.enabled,
          mode: before.mode,
          beforeDeploy: before.beforeDeploy,
          retention: before.retention,
        }
      : null,
    after: { application: application.slug, ...policy },
    ip: auth.ip,
  });
  return NextResponse.json({ policy: { ...policy, configured: true } });
});
