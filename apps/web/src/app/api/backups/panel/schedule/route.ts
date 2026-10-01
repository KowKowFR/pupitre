import { logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiRoute, readJsonBody } from '@/lib/http';
import { backupScheduleView, disableBackupSchedule, ensureBackupSchedule } from '@/lib/backups';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ enabled: z.boolean() });

/**
 * Activer la sauvegarde automatique de la base du panel : crée (ou réactive)
 * la tâche planifiée « Sauvegarde du panel ». Sa cadence se règle ensuite
 * dans « Tâches », comme toutes les autres.
 */
export const PUT = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'settings:manage');
  const { enabled } = await readJsonBody(request, bodySchema);
  if (enabled) await ensureBackupSchedule('panel_backup');
  else await disableBackupSchedule('panel_backup');
  await logAudit({
    actorId: auth.userId,
    action: enabled ? 'backup.panel.enabled' : 'backup.panel.disabled',
    resourceType: 'settings',
    resourceId: null,
    ip: auth.ip,
  });
  return NextResponse.json({ schedule: await backupScheduleView('panel_backup') });
});
