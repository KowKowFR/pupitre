import { MONITOR_CHECK_RETENTION_DAYS, MONITOR_TYPES_LIST } from '@pupitre/core';
import { getAppSettingsValue, listAdoptableApps, listMonitors } from '@pupitre/db';
import { PageHeader } from '@/components/page-header';
import { getT } from '@/i18n/server';
import { monitors as messages } from '@/i18n/messages/monitors';
import { formatSettingsOf } from '@/lib/format';
import { buildMonitorViews, monitorTypeOptions } from '@/lib/monitors';
import { requirePagePermission } from '@/lib/page-auth';
import { MonitorsPanel, type MonitorRow, type TypeOption } from './monitors-panel';

export const dynamic = 'force-dynamic';

/**
 * Supervision de sites.
 *
 * La distinction avec l'écran `/apps` est le cœur du sujet et mérite d'être dite
 * dans l'en-tête : `/apps` montre ce que la machine cible rapporte d'elle-même,
 * par SSH ; ici, la sonde part du worker vers l'adresse publique. Un pare-feu
 * refermé, un proxy cassé ou un certificat expiré n'apparaissent que là.
 */
export default async function MonitorsPage() {
  const auth = await requirePagePermission('/monitors', 'monitor:read');
  const t = await getT(messages);

  const [rows, adoptable, settings] = await Promise.all([
    listMonitors(),
    listAdoptableApps(),
    getAppSettingsValue(),
  ]);
  const views = await buildMonitorViews(rows);

  const monitors: MonitorRow[] = views.map((view) => ({
    id: view.id,
    name: view.name,
    type: view.type,
    typeLabel: view.typeLabel,
    target: view.target,
    targetLink: view.targetLink,
    intervalSeconds: view.intervalSeconds,
    failureThreshold: view.failureThreshold,
    recoveryThreshold: view.recoveryThreshold,
    enabled: view.enabled,
    pausedReason: view.pausedReason,
    applicationId: view.applicationId,
    hasWebhook: view.hasWebhook,
    status: view.status,
    lastOutcome: view.lastOutcome,
    consecutiveFailures: view.consecutiveFailures,
    lastCheckedAt: view.lastCheckedAt,
    lastLatencyMs: view.lastLatencyMs,
    lastDetail: view.lastDetail,
    neverRan: view.neverRan,
    uptime24h: view.uptime24h,
    uptime7d: view.uptime7d,
    recent: view.recent,
    openIncidentSince: view.openIncidentSince,
  }));

  const types = (await monitorTypeOptions(MONITOR_TYPES_LIST)) as TypeOption[];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={t('page.eyebrow')}
        title={t('page.title')}
        description={t('page.description')}
      />

      <MonitorsPanel
        monitors={monitors}
        types={types}
        adoptable={adoptable.map((app) => ({
          applicationId: app.applicationId,
          slug: app.slug,
          name: app.name,
          url: app.url,
        }))}
        canManage={auth.can('monitor:manage')}
        retentionDays={MONITOR_CHECK_RETENTION_DAYS}
        format={formatSettingsOf(settings)}
      />
    </div>
  );
}
