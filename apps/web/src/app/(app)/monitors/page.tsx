import { MONITOR_CHECK_RETENTION_DAYS, MONITOR_TYPES_LIST } from '@pupitre/core';
import { getAppSettingsValue, listAdoptableApps, listMonitors } from '@pupitre/db';
import { monitorRecord } from './record/record';
import { LiveRefresh } from '@/components/realtime/live-refresh';
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
export default async function MonitorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await requirePagePermission('/monitors', 'monitor:read');

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
  const format = formatSettingsOf(settings);

  // La fiche ouverte (`?monitor=<id>`) : sa courbe, ses incidents, sa capture.
  const wanted = (await searchParams).monitor;
  const selected = typeof wanted === 'string' ? rows.find((row) => row.id === wanted) : undefined;
  const record = selected ? await monitorRecord(selected, auth, format) : null;

  return (
    <>
      <LiveRefresh topics={['monitors']} />
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
        format={format}
        record={record}
      />
    </>
  );
}
