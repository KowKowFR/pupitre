import {
  countEnabledBackupPolicies,
  getActiveBackupDestination,
  getAppSettingsValue,
  listBackups,
} from '@pupitre/db';
import { backupScheduleView, backupView, destinationView } from '@/lib/backups';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { BackupSettings } from './backup-settings';

export const dynamic = 'force-dynamic';

/**
 * Paramètres → Sauvegardes : où elles partent, la base du panel, et combien
 * d'applications sont couvertes. Chaque application règle la sienne sur sa
 * fiche ; ici, ce qui vaut pour toute l'instance.
 */
export default async function BackupSettingsPage() {
  const auth = await requirePagePermission('/admin/settings/sauvegardes', 'settings:read');
  const [destination, panelBackups, panelSchedule, appsSchedule, enabledApps, settings] =
    await Promise.all([
      getActiveBackupDestination(),
      listBackups({ kind: 'panel', limit: 20 }),
      backupScheduleView('panel_backup'),
      backupScheduleView('backup'),
      countEnabledBackupPolicies(),
      getAppSettingsValue(),
    ]);

  return (
    <BackupSettings
      initialDestination={destination ? destinationView(destination) : null}
      panelBackups={panelBackups.map(backupView)}
      panelSchedule={panelSchedule}
      appsSchedule={appsSchedule}
      enabledApps={enabledApps}
      canManage={auth.can('settings:manage')}
      format={formatSettingsOf(settings)}
    />
  );
}
