import type { Metadata } from 'next';
import {
  getAppSettingsValue,
  listMaintenanceWindows,
  listMonitors,
  listTargets,
} from '@pupitre/db';
import { PageHeader } from '@/components/page-header';
import { LiveRefresh } from '@/components/realtime/live-refresh';
import { maintenance as messages } from '@/i18n/messages/maintenance';
import { getT } from '@/i18n/server';
import { formatSettingsOf } from '@/lib/format';
import { maintenanceJson } from '@/lib/maintenance';
import { requirePagePermission } from '@/lib/page-auth';
import { MaintenanceView, NewMaintenanceButton } from './maintenance-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT(messages))('meta.title') };
}

export const dynamic = 'force-dynamic';

/**
 * « Maintenances » : les fenêtres en cours, à venir et terminées. Planifier,
 * modifier, terminer et supprimer se font dans des tiroirs, sans sous-page.
 *
 * Le formulaire ne propose que ce que la session peut lire : une fenêtre ne
 * met pas en sourdine une sonde qu'on ne voit pas.
 */
export default async function MaintenancePage() {
  const auth = await requirePagePermission('/maintenance', 'maintenance:read');
  const canManage = auth.can('maintenance:manage');
  const [t, settings, windows, targets, monitors] = await Promise.all([
    getT(messages),
    getAppSettingsValue(),
    listMaintenanceWindows(),
    canManage && auth.can('target:read') ? listTargets() : Promise.resolve([]),
    canManage && auth.can('monitor:read') ? listMonitors() : Promise.resolve([]),
  ]);

  return (
    <>
      <LiveRefresh topics={['targets']} />
      <PageHeader
        title={t('page.title')}
        description={t('page.description')}
        actions={canManage ? <NewMaintenanceButton /> : null}
      />
      <MaintenanceView
        windows={windows.map((window) => maintenanceJson(window, auth))}
        format={formatSettingsOf(settings)}
        canManage={canManage}
        canAnnounce={auth.can('status_page:announce')}
        targets={targets.map((target) => ({
          id: target.id,
          name: target.name,
          detail: target.host,
        }))}
        monitors={monitors.map((monitor) => ({ id: monitor.id, name: monitor.name, detail: null }))}
      />
    </>
  );
}
