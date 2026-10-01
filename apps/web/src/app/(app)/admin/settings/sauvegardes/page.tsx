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
 * Paramètres → Sauvegardes : où elles partent, la base du panel, et les
 * applications sauvegardées avec leur historique. Chaque application règle sa
 * politique sur sa fiche ; ici, on voit tout d'un coup d'œil, et l'on restaure
 * une ancienne sauvegarde sans aller la chercher fiche par fiche.
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
      // L'historique des applications relève de `backup:read`, pas des paramètres.
      auth.can('backup:read') ? applicationBackupsOverview() : null,
    ]);

  return (
    <>
      {/* Une sauvegarde ou une restauration qui s'achève : l'écran se relit. */}
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
