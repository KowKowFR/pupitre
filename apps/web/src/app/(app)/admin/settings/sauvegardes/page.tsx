import {
  countEnabledBackupPolicies,
  getActiveBackupDestination,
  getAppSettingsValue,
  listBackups,
} from '@pupitre/db';
import { LiveRefresh } from '@/components/realtime/live-refresh';
import {
  applicationBackupsOverview,
  backupScheduleView,
  backupView,
  destinationView,
} from '@/lib/backups';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { BackupSettings } from './backup-settings';

export const dynamic = 'force-dynamic';

/**
 * Settings → Backups: where they go, the panel's database, and the backed-up
 * applications with their history. Each application sets its policy on its
 * record; here, everything is seen at a glance, and an old backup is restored
 * without going to look for it record by record.
 */
export default async function BackupSettingsPage() {
  const auth = await requirePagePermission('/admin/settings/sauvegardes', 'settings:read');
  const [destination, panelBackups, panelSchedule, appsSchedule, enabledApps, settings, apps] =
    await Promise.all([
      getActiveBackupDestination(),
      listBackups({ kind: 'panel', limit: 20 }),
      backupScheduleView('panel_backup'),
      backupScheduleView('backup'),
      countEnabledBackupPolicies(),
      getAppSettingsValue(),
      // The applications' history falls under `backup:read`, not the settings.
      auth.can('backup:read') ? applicationBackupsOverview() : null,
    ]);

  return (
    <>
      {/* A backup or a restore that finishes: the screen reads itself again. */}
      <LiveRefresh topics={['applications', 'settings']} />
      <BackupSettings
        initialDestination={destination ? destinationView(destination) : null}
        panelBackups={panelBackups.map(backupView)}
        panelSchedule={panelSchedule}
        appsSchedule={appsSchedule}
        enabledApps={enabledApps}
        appsOverview={apps}
        canManage={auth.can('settings:manage')}
        canManageBackups={auth.can('backup:manage')}
        canRestore={auth.can('backup:restore')}
        format={formatSettingsOf(settings)}
      />
    </>
  );
}
