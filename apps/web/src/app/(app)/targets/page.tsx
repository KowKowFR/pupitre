import {
  countDeploymentsOnTarget,
  getAppSettings,
  getTargetPortReport,
  HOST_METRIC_CATALOG,
  listSupervisedApps,
  listTargets,
  targetHistories,
} from '@pupitre/db';
import { LiveRefresh } from '@/components/realtime/live-refresh';
import { getT } from '@/i18n/server';
import { common } from '@/i18n/messages/common';
import { formatDateTimeWith, formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { relativeTime } from '@/lib/relative-time';
import { targetRecord } from './record/record';
import { TargetsView, type TargetRow } from './targets-view';

export const dynamic = 'force-dynamic';

function readFilters(params: Record<string, string | string[] | undefined>) {
  const raw = params.label;
  const status = typeof params.status === 'string' ? params.status : '';
  return {
    query: typeof params.q === 'string' ? params.q : '',
    labels: (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((pair) => pair.includes('=')),
    status: ['ok', 'degraded', 'unreachable', 'unknown'].includes(status) ? status : '',
  };
}

/**
 * Les cibles : la liste, et la fiche de chacune dans un tiroir
 * (`?target=prod-1`) — son aperçu, puis ses charges, son reverse proxy, ses
 * ports, son preflight et sa configuration, rendus ici quand il est ouvert.
 *
 * Tout ce que le drawer affiche est lu ici, en une fois : un parc compte des
 * dizaines de machines, pas des milliers, et un aperçu qui s'ouvre sans
 * attendre vaut les quelques lectures de plus. Chaque lecture est celle d'un
 * écran existant — l'historique machine, les applications supervisées, le
 * rapport de ports, le décompte qui conditionne la suppression.
 */
export default async function TargetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await requirePagePermission('/targets', 'target:read');
  const canDelete = auth.can('target:delete');
  const [targets, { settings }, params, tc] = await Promise.all([
    listTargets(),
    getAppSettings(),
    searchParams,
    getT(common),
  ]);
  const format = formatSettingsOf(settings);
  const filters = readFilters(params);
  const ids = targets.map((target) => target.id);

  const [histories, running, ports, counts] = await Promise.all([
    targetHistories(ids, 24, 24),
    auth.can('deployment:read') ? listSupervisedApps() : Promise.resolve(null),
    Promise.all(ids.map((id) => getTargetPortReport(id))),
    canDelete ? Promise.all(ids.map((id) => countDeploymentsOnTarget(id))) : Promise.resolve(null),
  ]);

  const shortDate = (value: Date | null) =>
    value === null
      ? null
      : formatDateTimeWith(value.toISOString(), format, {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
  const clock = (value: Date | null) =>
    value === null
      ? null
      : formatDateTimeWith(value.toISOString(), format, { hour: '2-digit', minute: '2-digit' });

  const rows: TargetRow[] = targets.map((target, index) => {
    const history = histories.get(target.id);
    const report = target.preflightReport;
    return {
      id: target.id,
      name: target.name,
      description: target.description,
      host: target.host,
      port: target.port,
      sshUser: target.sshUser,
      authMethod: target.authMethod,
      sudoMethod: target.sudoMethod,
      labels: target.labels,
      runtimesAvailable: target.runtimesAvailable,
      status: target.status,
      lastCheck: shortDate(target.lastPreflightAt),
      lastCheckClock: clock(target.lastPreflightAt),
      testedAgo: relativeTime(target.lastPreflightAt, tc),
      measured: (history?.samples ?? 0) > 0,
      load: (history?.points ?? []).map((point) => point.loadPercent),
      loadLast: history?.summary.load.last ?? null,
      loadWorst: history?.summary.load.worst ?? null,
      memory: history?.summary.memory.last ?? null,
      disk: history?.summary.disk.last ?? null,
      failedChecks: (report?.checks ?? [])
        .filter((check) => check.status === 'failed')
        .map((check) => (check.detail ? `${check.label} (${check.detail})` : check.label)),
      error: report?.error ?? null,
      portRange: { start: target.portRangeStart, end: target.portRangeEnd },
      portsUsed: ports[index]?.used ?? null,
      apps:
        running === null
          ? null
          : running
              .filter((app) => app.targetId === target.id)
              .map((app) => ({ id: app.id, slug: app.applicationSlug, health: app.healthStatus })),
      deployments: counts?.[index] ?? null,
    };
  });

  // La fiche ouverte : par son nom, ou par son identifiant (un lien d'avant
  // les tiroirs, `/targets/<uuid>`, arrive ici ainsi).
  const wanted = params.target;
  const selected =
    typeof wanted === 'string'
      ? (targets.find((target) => target.name === wanted || target.id === wanted) ?? null)
      : null;
  const record = selected ? await targetRecord(selected, auth, format) : null;

  return (
    <>
      <LiveRefresh topics={['targets', 'deployments']} />
      <TargetsView
        targets={rows}
        canCreate={auth.can('target:create')}
        canRunPreflight={auth.can('target:update')}
        canEdit={auth.can('target:update')}
        canDelete={canDelete}
        timezone={format.timezone}
        limits={{
          load: HOST_METRIC_CATALOG.load.defaultLimitPercent,
          memory: HOST_METRIC_CATALOG.memory.defaultLimitPercent,
          disk: HOST_METRIC_CATALOG.disk.defaultLimitPercent,
        }}
        initialQuery={filters.query}
        initialLabels={filters.labels}
        initialStatus={filters.status}
        canReadWorkloads={auth.can('workload:read')}
        record={record}
      />
    </>
  );
}
