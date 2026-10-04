import {
  getAppSettings,
  listOpenBreaches,
  listSupervisedApps,
  listTargets,
  resolveThresholds,
  targetHistories,
} from '@pupitre/db';
import { Server } from 'lucide-react';
import { z } from 'zod';
import { LiveRefresh } from '@/components/realtime/live-refresh';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { getT } from '@/i18n/server';
import { servers as messages } from '@/i18n/messages/servers';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import type { SupervisedRow } from './apps-table';
import type { HostHistoryData, HistoryMetric } from './host-history';
import { runningAppRecord } from './record/record';
import { ServersList, type ServerRow } from './servers-list';

export const dynamic = 'force-dynamic';

/**
 * The window rendered with the page. 24 h in 48 intervals of 30 minutes: fine
 * enough to see a weekend peak, coarse enough to fit in a hundred-pixel strip
 * without carrying 288 values per machine. The 7 days are asked of the route, on
 * demand — nobody opens this screen for them.
 */
const HISTORY_HOURS = 24;
const HISTORY_BUCKETS = 48;

/**
 * Monitoring, seen per server.
 *
 * Two sources, never mixed:
 *
 * - the **database** says which machines are declared and what runs on them. It
 *   always answers, even when all the machines are off;
 * - the **machine** says how it is doing *right now*. This reading is requested
 *   by the browser, target by target, and its failure takes nothing else with
 *   it.
 *
 * It is this separation that makes an unreachable server keep its applications
 * on screen.
 *
 * Since the readings are kept, the database has a third thing to say: **the
 * machine's past**. It is rendered with the page, on the server side, and for a
 * precise reason — it is SQL, not SSH. The curve of the last 24 h therefore
 * shows identically whether the machine answers or not, which is exactly the
 * moment one wants to read it.
 */
export default async function AppsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await requirePagePermission('/apps', 'deployment:read');
  const t = await getT(messages);
  const canReadTargets = auth.can('target:read');

  // Without `target:read`, the fleet is not listed: the only servers shown are
  // those the visible applications already mention.
  const [apps, targets] = await Promise.all([
    listSupervisedApps(),
    canReadTargets ? listTargets() : Promise.resolve([]),
  ]);

  // The history only concerns the targets really registered: a machine known only
  // through a deployment's memory was never read.
  const targetIds = targets.map((target) => target.id);
  const [histories, openBreaches, thresholdsByTarget] = await Promise.all([
    targetHistories(targetIds, HISTORY_HOURS, HISTORY_BUCKETS),
    listOpenBreaches(targetIds),
    // One resolution per machine: the thresholds are three layers, and it is the
    // database that stacks them (`resolveThresholds`). Copying the stacking here
    // would have made a second truth.
    Promise.all(targetIds.map((id) => resolveThresholds(id))),
  ]);

  const items: SupervisedRow[] = apps.map((app) => ({
    id: app.id,
    applicationSlug: app.applicationSlug,
    targetId: app.targetId,
    targetName: app.targetName,
    targetHost: app.targetHost,
    runtime: app.runtime,
    version: app.version,
    status: app.status,
    healthStatus: app.healthStatus,
    lastHealthAt: app.lastHealthAt?.toISOString() ?? null,
    url: app.url,
    publishedPort: app.publishedPort,
    services: app.services,
    startedAt: app.startedAt?.toISOString() ?? null,
    // Kept as is: an application whose last update failed stays visible, with the
    // mention of the failure. Making it disappear was the bug that was fixed, and
    // grouping by server does not reintroduce it.
    lastFailedUpdate: app.lastFailedUpdate
      ? {
          deploymentId: app.lastFailedUpdate.deploymentId,
          version: app.lastFailedUpdate.version,
          failedStep: app.lastFailedUpdate.failedStep,
          mayHaveReplacedServices: app.lastFailedUpdate.mayHaveReplacedServices,
        }
      : null,
  }));

  const servers = new Map<string, ServerRow>();

  for (const target of targets) {
    servers.set(target.id, {
      id: target.id,
      name: target.name,
      host: target.host,
      port: target.port,
      sshUser: target.sshUser,
      status: target.status,
      runtimes: target.runtimesAvailable,
      registered: true,
      apps: [],
    });
  }

  for (const app of items) {
    // A target absent from the list above: either the reader does not have
    // `target:read`, or the row disappeared from the table. In both cases the
    // application stays shown under the name its deployment kept — better a server
    // without a record than an orphan application.
    const existing = servers.get(app.targetId);
    if (existing) {
      existing.apps.push(app);
      continue;
    }
    servers.set(app.targetId, {
      id: app.targetId,
      name: app.targetName,
      host: app.targetHost,
      port: null,
      sshUser: null,
      status: 'unknown',
      runtimes: null,
      registered: false,
      apps: [app],
    });
  }

  const rows = [...servers.values()].sort((a, b) => a.name.localeCompare(b.name));

  const { settings } = await getAppSettings();

  // The open application (`?app=<deployment id>`): its console, in the drawer —
  // even if it no longer runs, the record says so.
  const wanted = (await searchParams).app;
  const record =
    typeof wanted === 'string' && z.string().uuid().safeParse(wanted).success
      ? await runningAppRecord(wanted, auth)
      : null;

  // The history data, shaped for the client: ISO strings rather than `Date`s, and
  // nothing other than what the screen shows.
  const history: Record<string, HostHistoryData> = {};
  targetIds.forEach((id, index) => {
    const window = histories.get(id);
    if (!window) return;
    const resolved = thresholdsByTarget[index];
    if (!resolved) return;
    history[id] = {
      hours: window.hours,
      samples: window.samples,
      reachable: window.reachable,
      points: window.points,
      summary: window.summary,
      thresholds: Object.fromEntries(
        (Object.keys(resolved) as HistoryMetric[]).map((metric) => [
          metric,
          {
            limitPercent: resolved[metric].limitPercent,
            enabled: resolved[metric].enabled,
            origin: resolved[metric].origin,
          },
        ]),
      ) as HostHistoryData['thresholds'],
      breaches: openBreaches
        .filter((breach) => breach.targetId === id)
        .map((breach) => ({
          id: breach.id,
          metric: breach.metric,
          startedAt: breach.startedAt.toISOString(),
          limitPercent: breach.limitPercent,
          peakValue: breach.peakValue,
          lastValue: breach.lastValue,
          samples: breach.samples,
        })),
    };
  });

  // The header lives in the list when there are servers: its "Read all" button
  // drives the readings, which are client state.
  if (rows.length === 0) {
    return (
      <>
        <PageHeader title={t('page.title')} description={t('page.description')} />
        <EmptyState
          icon={Server}
          title={t('page.empty')}
          hint={canReadTargets ? t('page.empty.hint') : t('page.empty.restricted')}
        />
      </>
    );
  }

  return (
    <>
      <LiveRefresh topics={['deployments', 'targets']} />
      <ServersList
        servers={rows}
        history={history}
        canRestart={auth.can('deployment:restart')}
        canReadTargets={canReadTargets}
        canTune={auth.can('target:update')}
        format={formatSettingsOf(settings)}
        record={record}
      />
    </>
  );
}
