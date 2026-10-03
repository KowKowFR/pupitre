import 'server-only';
import {
  STATUS_PAGE_HISTORY_DAYS,
  dayBars,
  overallStateOf,
  publicStateOf,
  statusPageMonitorIds,
  statusPagePath,
  uptimeOf,
  type DayBar,
  type OverallState,
  type PublicState,
  type StatusBlock,
} from '@pupitre/core';
import {
  getAppSettingsValue,
  listMonitors,
  maintenanceCoverage,
  maintenanceForMonitors,
  monitorDayTallies,
  recentMonitorIncidents,
  type StatusPageRow,
} from '@pupitre/db';
import { statusPages as messages } from '@/i18n/messages/status-pages';
import { NotFoundError, msg } from '@/lib/errors';

/**
 * Ce qu'une page de statut montre, calculé au serveur : un JSON qui ne porte
 * **que** des libellés publics, des états et des dates. C'est la frontière —
 * le composant qui l'affiche, sur la page publique comme dans l'aperçu de
 * l'éditeur, ne voit jamais une sonde, une URL ni une machine.
 */
export type StatusService = {
  label: string;
  state: PublicState;
  bars: DayBar[] | null;
  uptime: number | null;
};

export type StatusBlockModel =
  | { id: string; type: 'summary'; state: OverallState }
  | { id: string; type: 'heading'; text: string }
  | { id: string; type: 'text'; text: string }
  | {
      id: string;
      type: 'services';
      title: string | null;
      services: StatusService[];
      uptimeShown: boolean;
    }
  | {
      id: string;
      type: 'maintenance';
      windows: Array<{ startsAt: string; endsAt: string; active: boolean; services: string[] }>;
    }
  | {
      id: string;
      type: 'incidents';
      days: number;
      incidents: Array<{ service: string; startedAt: string; resolvedAt: string | null }>;
    };

export type StatusPageModel = {
  title: string;
  description: string | null;
  overall: OverallState;
  generatedAt: string;
  historyDays: number;
  blocks: StatusBlockModel[];
};

/** « AAAA-MM-JJ » d'aujourd'hui, dans le fuseau de l'instance. */
function todayIn(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export async function buildStatusPageModel(
  page: { title: string; description: string | null; blocks: StatusBlock[] },
  now: Date = new Date(),
): Promise<StatusPageModel> {
  const monitorIds = statusPageMonitorIds(page.blocks);
  const maxIncidentDays = Math.max(
    0,
    ...page.blocks.map((block) => (block.type === 'incidents' ? block.days : 0)),
  );
  const settings = await getAppSettingsValue();
  const timeZone = settings.timezone;
  const [monitors, coverage, dayTallies, incidents, windows] = await Promise.all([
    monitorIds.length > 0 ? listMonitors() : Promise.resolve([]),
    monitorIds.length > 0 ? maintenanceCoverage(now) : Promise.resolve(null),
    monitorDayTallies(monitorIds, STATUS_PAGE_HISTORY_DAYS, timeZone),
    maxIncidentDays > 0 ? recentMonitorIncidents(monitorIds, maxIncidentDays) : Promise.resolve([]),
    page.blocks.some((block) => block.type === 'maintenance')
      ? maintenanceForMonitors(monitorIds, new Date(now.getTime() + 7 * 86_400_000), now)
      : Promise.resolve([]),
  ]);
  const today = todayIn(timeZone, now);

  // Le libellé public d'une sonde : le premier que la page lui donne, sinon son nom.
  const byId = new Map(monitors.map((monitor) => [monitor.id, monitor]));
  const labels = new Map<string, string>();
  for (const block of page.blocks) {
    if (block.type !== 'services') continue;
    for (const item of block.items) {
      const monitor = byId.get(item.monitorId);
      if (!monitor || labels.has(item.monitorId)) continue;
      labels.set(item.monitorId, item.label ?? monitor.name);
    }
  }
  const stateOf = (id: string): PublicState => {
    const monitor = byId.get(id);
    if (!monitor) return 'unknown';
    return publicStateOf({
      status: monitor.status,
      enabled: monitor.enabled,
      inMaintenance: coverage?.monitors.has(id) ?? false,
    });
  };

  const shown = monitorIds.filter((id) => byId.has(id));
  const overall = overallStateOf(shown.map(stateOf));

  const blocks = page.blocks.map((block): StatusBlockModel => {
    switch (block.type) {
      case 'summary':
        return { id: block.id, type: 'summary', state: overall };
      case 'heading':
      case 'text':
        return { id: block.id, type: block.type, text: block.text };
      case 'services':
        return {
          id: block.id,
          type: 'services',
          title: block.title,
          uptimeShown: block.uptime,
          services: block.items
            .filter((item) => byId.has(item.monitorId))
            .map((item) => {
              const tally = dayTallies.get(item.monitorId) ?? [];
              return {
                label: item.label ?? byId.get(item.monitorId)!.name,
                state: stateOf(item.monitorId),
                bars: block.history ? dayBars(tally, today, STATUS_PAGE_HISTORY_DAYS) : null,
                uptime: block.uptime ? uptimeOf(tally) : null,
              };
            }),
        };
      case 'maintenance':
        return {
          id: block.id,
          type: 'maintenance',
          windows: windows.map((window) => ({
            startsAt: window.startsAt.toISOString(),
            endsAt: window.endsAt.toISOString(),
            active: window.startsAt <= now,
            services: window.monitorIds
              .map((id) => labels.get(id))
              .filter((label): label is string => label !== undefined),
          })),
        };
      case 'incidents': {
        const since = now.getTime() - block.days * 86_400_000;
        return {
          id: block.id,
          type: 'incidents',
          days: block.days,
          incidents: incidents
            .filter(
              (incident) =>
                labels.has(incident.monitorId) &&
                (incident.resolvedAt === null || incident.resolvedAt.getTime() > since),
            )
            .map((incident) => ({
              service: labels.get(incident.monitorId)!,
              startedAt: incident.startedAt.toISOString(),
              resolvedAt: incident.resolvedAt?.toISOString() ?? null,
            })),
        };
      }
    }
  });

  return {
    title: page.title,
    description: page.description,
    overall,
    generatedAt: now.toISOString(),
    historyDays: STATUS_PAGE_HISTORY_DAYS,
    blocks,
  };
}

// ─── Pour l'écran qui les compose ─────────────────────────────────────────────

/** Une page telle que l'éditeur la reçoit. */
export type StatusPageJson = {
  id: string;
  slug: string;
  path: string;
  title: string;
  description: string | null;
  published: boolean;
  blocks: StatusBlock[];
  updatedAt: string;
};

export function statusPageJson(row: StatusPageRow): StatusPageJson {
  return {
    id: row.id,
    slug: row.slug,
    path: statusPagePath(row.slug),
    title: row.title,
    description: row.description,
    published: row.published,
    blocks: row.blocks,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Toutes les sondes que les blocs nomment doivent exister. */
export async function assertStatusMonitors(blocks: readonly StatusBlock[]): Promise<void> {
  const ids = statusPageMonitorIds(blocks);
  if (ids.length === 0) return;
  const known = new Set((await listMonitors()).map((monitor) => monitor.id));
  const missing = ids.find((id) => !known.has(id));
  if (missing) throw new NotFoundError(msg(messages, 'error.monitorNotFound', { id: missing }));
}

/** Un résumé pour le journal : de quoi savoir ce qui a été rendu public, sans tout recopier. */
export function statusPageAuditSummary(page: {
  slug: string;
  title: string;
  published: boolean;
  blocks: readonly StatusBlock[];
}) {
  return {
    path: statusPagePath(page.slug),
    title: page.title,
    published: page.published,
    blocks: page.blocks.map((block) => block.type),
    monitors: statusPageMonitorIds(page.blocks).length,
  };
}
