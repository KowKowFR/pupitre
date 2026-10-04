import 'server-only';
import {
  ENDED_MAINTENANCE_SHOWN_HOURS,
  STATUS_PAGE_HISTORY_DAYS,
  dayBars,
  overallStateOf,
  publicStateOf,
  latestFirst,
  statusNotices,
  statusPageMonitorIds,
  statusPagePath,
  uptimeOf,
  type DayBar,
  type OverallState,
  type PublicState,
  type PublicStatusUpdate,
  type StatusBlock,
  type StatusNotice,
} from '@pupitre/core';
import {
  getAppSettingsValue,
  listMonitors,
  listStatusUpdates,
  maintenanceCoverage,
  maintenanceTouching,
  monitorDayTallies,
  recentMonitorIncidents,
  type StatusPageRow,
  type StatusUpdateView,
} from '@pupitre/db';
import { statusPages as messages } from '@/i18n/messages/status-pages';
import { NotFoundError, msg } from '@/lib/errors';

/**
 * What a status page shows, computed on the server: a JSON that **only** carries
 * public labels, states and dates. It is the boundary — the component that shows
 * it, on the public page as in the editor's preview, never sees a probe, a URL or
 * a machine.
 */
export type StatusService = {
  label: string;
  state: PublicState;
  bars: DayBar[] | null;
  uptime: number | null;
};

export type StatusBlockModel =
  | { id: string; type: 'summary'; state: OverallState; notices: StatusNotice[] }
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
      windows: Array<{
        startsAt: string;
        endsAt: string;
        active: boolean;
        /** Finished less than a day ago, and announced: shown long enough to read "ended". */
        ended: boolean;
        services: string[];
        updates: PublicStatusUpdate[];
      }>;
    }
  | {
      id: string;
      type: 'incidents';
      days: number;
      incidents: Array<{
        service: string;
        startedAt: string;
        resolvedAt: string | null;
        updates: PublicStatusUpdate[];
      }>;
    };

export type StatusPageModel = {
  title: string;
  description: string | null;
  overall: OverallState;
  generatedAt: string;
  historyDays: number;
  blocks: StatusBlockModel[];
};

/** Today's "YYYY-MM-DD", in the instance's time zone. */
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
  // The general state carries the announcements of the ongoing subjects: without an
  // incidents block, it still needs the open outages (`days` at 0).
  const hasSummary = page.blocks.some((block) => block.type === 'summary');
  const settings = await getAppSettingsValue();
  const timeZone = settings.timezone;
  const [monitors, coverage, dayTallies, incidents, windows] = await Promise.all([
    monitorIds.length > 0 ? listMonitors() : Promise.resolve([]),
    monitorIds.length > 0 ? maintenanceCoverage(now) : Promise.resolve(null),
    monitorDayTallies(monitorIds, STATUS_PAGE_HISTORY_DAYS, timeZone),
    maxIncidentDays > 0 || hasSummary
      ? recentMonitorIncidents(monitorIds, maxIncidentDays)
      : Promise.resolve([]),
    page.blocks.some((block) => block.type === 'maintenance') || hasSummary
      ? maintenanceTouching(monitorIds, {
          endsAfter: new Date(now.getTime() - ENDED_MAINTENANCE_SHOWN_HOURS * 3_600_000),
          startsBefore: new Date(now.getTime() + 7 * 86_400_000),
        })
      : Promise.resolve([]),
  ]);
  const updates = await listStatusUpdates({
    incidentIds: incidents.map((incident) => incident.id),
    windowIds: windows.map((window) => window.id),
  });
  const updatesOfIncident = groupUpdates(updates, (update) => update.monitorIncidentId);
  const updatesOfWindow = groupUpdates(updates, (update) => update.maintenanceWindowId);
  const today = todayIn(timeZone, now);

  // A probe's public label: the first one the page gives it, otherwise its name.
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
  const servicesOf = (ids: readonly string[]) =>
    ids.map((id) => labels.get(id)).filter((label): label is string => label !== undefined);
  const notices = statusNotices([
    ...incidents.map((incident) => ({
      kind: 'incident' as const,
      services: servicesOf([incident.monitorId]),
      ongoing: incident.resolvedAt === null,
      updates: updatesOfIncident.get(incident.id) ?? [],
    })),
    ...windows.map((window) => ({
      kind: 'maintenance' as const,
      services: servicesOf(window.monitorIds),
      ongoing: window.startsAt <= now && window.endsAt > now,
      updates: updatesOfWindow.get(window.id) ?? [],
    })),
  ]);

  const blocks = page.blocks.map((block): StatusBlockModel => {
    switch (block.type) {
      case 'summary':
        return { id: block.id, type: 'summary', state: overall, notices };
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
          windows: windows
            .filter((window) => window.endsAt > now || updatesOfWindow.has(window.id))
            .map((window) => ({
              startsAt: window.startsAt.toISOString(),
              endsAt: window.endsAt.toISOString(),
              active: window.startsAt <= now && window.endsAt > now,
              ended: window.endsAt <= now,
              services: servicesOf(window.monitorIds),
              updates: latestFirst(updatesOfWindow.get(window.id) ?? []),
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
              updates: latestFirst(updatesOfIncident.get(incident.id) ?? []),
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

/**
 * The announcements, sorted by subject and reduced to what a visitor reads: the
 * phase, the text, the time. Neither author nor identifier.
 */
function groupUpdates(
  updates: readonly StatusUpdateView[],
  keyOf: (update: StatusUpdateView) => string | null,
): Map<string, PublicStatusUpdate[]> {
  const grouped = new Map<string, PublicStatusUpdate[]>();
  for (const update of updates) {
    const key = keyOf(update);
    if (key === null) continue;
    const list = grouped.get(key) ?? [];
    list.push({ phase: update.phase, message: update.message, at: update.createdAt.toISOString() });
    grouped.set(key, list);
  }
  return grouped;
}

// ─── For the screen that composes them ────────────────────────────────────────

/** A page as the editor receives it. */
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

/** All the probes the blocks name must exist. */
export async function assertStatusMonitors(blocks: readonly StatusBlock[]): Promise<void> {
  const ids = statusPageMonitorIds(blocks);
  if (ids.length === 0) return;
  const known = new Set((await listMonitors()).map((monitor) => monitor.id));
  const missing = ids.find((id) => !known.has(id));
  if (missing) throw new NotFoundError(msg(messages, 'error.monitorNotFound', { id: missing }));
}

/** A summary for the log: enough to know what was made public, without copying everything. */
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
