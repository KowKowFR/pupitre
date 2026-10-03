import 'server-only';
import {
  ENDED_MAINTENANCE_SHOWN_HOURS,
  RESOLVED_INCIDENT_ANNOUNCE_DAYS,
  parseStatusUpdateSubjectKey,
  statusPageMonitorIds,
  statusUpdateSubjectKey,
  type StatusUpdatePhase,
  type StatusUpdateSubject,
  type StatusUpdateSubjectType,
} from '@pupitre/core';
import {
  announceableIncidents,
  getAnnounceableIncident,
  getMaintenanceWindow,
  listMonitors,
  listStatusUpdates,
  maintenanceTouching,
  statusUpdateSubjectOf,
  type StatusPageRow,
  type StatusUpdateRow,
} from '@pupitre/db';
import { statusPages as messages } from '@/i18n/messages/status-pages';
import { NotFoundError, msg } from '@/lib/errors';

/** Une annonce telle que l'écran et l'API la rendent. L'auteur y est : ce n'est pas une page publique. */
export type StatusUpdateJson = {
  id: string;
  subject: StatusUpdateSubject;
  phase: StatusUpdatePhase;
  message: string;
  authorName: string | null;
  createdAt: string;
  edited: boolean;
};

export function statusUpdateJson(
  row: StatusUpdateRow,
  authorName: string | null = null,
): StatusUpdateJson {
  return {
    id: row.id,
    subject: statusUpdateSubjectOf(row),
    phase: row.phase,
    message: row.message,
    authorName,
    createdAt: row.createdAt.toISOString(),
    edited: row.updatedAt.getTime() > row.createdAt.getTime(),
  };
}

/** Le sujet d'une annonce doit exister : un incident de sonde, une fenêtre de maintenance. */
export async function assertStatusUpdateSubject(subject: StatusUpdateSubject): Promise<void> {
  const found =
    subject.type === 'incident'
      ? await getAnnounceableIncident(subject.id)
      : await getMaintenanceWindow(subject.id);
  if (!found) throw new NotFoundError(msg(messages, 'error.announce.subject'));
}

/** Pour le journal : ce qui a été dit, et à propos de quoi. Le texte est public, il peut y figurer. */
export function statusUpdateAuditSummary(row: StatusUpdateRow) {
  return { subject: statusUpdateSubjectOf(row), phase: row.phase, message: row.message };
}

/** Ce qu'on peut annoncer, tel que l'écran des annonces le reçoit. */
export type AnnounceSubjectJson = {
  key: string;
  type: StatusUpdateSubjectType;
  id: string;
  /** Le nom de la sonde, ou le titre de la fenêtre : pour l'équipe, pas pour les visiteurs. */
  title: string;
  startsAt: string;
  /** La fin de la panne (`null` : en cours), ou celle de la fenêtre. */
  endsAt: string | null;
  state: 'ongoing' | 'upcoming' | 'ended';
  /** Une page de statut montre-t-elle ce sujet ? Sinon, l'annonce ne paraîtra nulle part. */
  onPage: boolean;
  /** Les noms sous lesquels les visiteurs voient les sondes touchées. */
  seenAs: string[];
  /** Des plus anciennes aux plus récentes. */
  updates: StatusUpdateJson[];
};

/**
 * Les sujets à annoncer : les pannes des sondes de vos pages, en cours ou
 * refermées depuis peu, et les maintenances qui les touchent, à venir, en
 * cours ou tout juste finies. `extraKey` — un sujet demandé par son adresse,
 * depuis la fiche d'une sonde ou d'une fenêtre — s'y ajoute même hors de ces
 * bornes, marqué hors page.
 */
export async function loadAnnounceSubjects(
  pages: readonly StatusPageRow[],
  extraKey: string | null,
  now: Date = new Date(),
): Promise<AnnounceSubjectJson[]> {
  const monitorIds = [...new Set(pages.flatMap((page) => statusPageMonitorIds(page.blocks)))];
  const [incidents, windows, monitors] = await Promise.all([
    announceableIncidents(
      monitorIds,
      new Date(now.getTime() - RESOLVED_INCIDENT_ANNOUNCE_DAYS * 86_400_000),
    ),
    maintenanceTouching(monitorIds, {
      endsAfter: new Date(now.getTime() - ENDED_MAINTENANCE_SHOWN_HOURS * 3_600_000),
      startsBefore: new Date(now.getTime() + 30 * 86_400_000),
    }),
    monitorIds.length > 0 ? listMonitors() : Promise.resolve([]),
  ]);

  // Le nom public d'une sonde, page par page : son libellé, sinon son nom.
  const names = new Map(monitors.map((monitor) => [monitor.id, monitor.name]));
  const labels = new Map<string, Set<string>>();
  for (const page of pages) {
    for (const block of page.blocks) {
      if (block.type !== 'services') continue;
      for (const item of block.items) {
        const label = item.label ?? names.get(item.monitorId);
        if (!label) continue;
        const set = labels.get(item.monitorId) ?? new Set<string>();
        set.add(label);
        labels.set(item.monitorId, set);
      }
    }
  }
  const seenAs = (ids: readonly string[]) => [
    ...new Set(ids.flatMap((id) => [...(labels.get(id) ?? [])])),
  ];

  const subjects: Array<Omit<AnnounceSubjectJson, 'updates'>> = [
    ...incidents.map((incident) => ({
      key: statusUpdateSubjectKey({ type: 'incident', id: incident.id }),
      type: 'incident' as const,
      id: incident.id,
      title: incident.monitorName,
      startsAt: incident.startedAt.toISOString(),
      endsAt: incident.resolvedAt?.toISOString() ?? null,
      state: incident.resolvedAt ? ('ended' as const) : ('ongoing' as const),
      onPage: true,
      seenAs: seenAs([incident.monitorId]),
    })),
    ...windows.map((window) => ({
      key: statusUpdateSubjectKey({ type: 'maintenance', id: window.id }),
      type: 'maintenance' as const,
      id: window.id,
      title: window.title,
      startsAt: window.startsAt.toISOString(),
      endsAt: window.endsAt.toISOString(),
      state: windowState(window.startsAt, window.endsAt, now),
      onPage: true,
      seenAs: seenAs(window.monitorIds),
    })),
  ];

  const extra = parseStatusUpdateSubjectKey(extraKey);
  if (extra && !subjects.some((subject) => subject.key === statusUpdateSubjectKey(extra))) {
    if (extra.type === 'incident') {
      const incident = await getAnnounceableIncident(extra.id);
      if (incident) {
        subjects.push({
          key: statusUpdateSubjectKey(extra),
          type: 'incident',
          id: incident.id,
          title: incident.monitorName,
          startsAt: incident.startedAt.toISOString(),
          endsAt: incident.resolvedAt?.toISOString() ?? null,
          state: incident.resolvedAt ? 'ended' : 'ongoing',
          onPage: monitorIds.includes(incident.monitorId),
          seenAs: seenAs([incident.monitorId]),
        });
      }
    } else {
      const window = await getMaintenanceWindow(extra.id);
      if (window) {
        subjects.push({
          key: statusUpdateSubjectKey(extra),
          type: 'maintenance',
          id: window.id,
          title: window.title,
          startsAt: window.startsAt.toISOString(),
          endsAt: window.endsAt.toISOString(),
          state: windowState(window.startsAt, window.endsAt, now),
          onPage: false,
          seenAs: [],
        });
      }
    }
  }

  const updates = await listStatusUpdates({
    incidentIds: subjects.filter((subject) => subject.type === 'incident').map((s) => s.id),
    windowIds: subjects.filter((subject) => subject.type === 'maintenance').map((s) => s.id),
  });
  const bySubject = new Map<string, StatusUpdateJson[]>();
  for (const row of updates) {
    const key = statusUpdateSubjectKey(statusUpdateSubjectOf(row));
    const list = bySubject.get(key) ?? [];
    list.push(statusUpdateJson(row, row.authorName));
    bySubject.set(key, list);
  }

  // En cours d'abord, puis à venir, puis finis ; les plus récents d'abord.
  const rank = { ongoing: 0, upcoming: 1, ended: 2 } as const;
  return subjects
    .map((subject) => ({ ...subject, updates: bySubject.get(subject.key) ?? [] }))
    .sort(
      (a, b) => rank[a.state] - rank[b.state] || Date.parse(b.startsAt) - Date.parse(a.startsAt),
    );
}

function windowState(startsAt: Date, endsAt: Date, now: Date): AnnounceSubjectJson['state'] {
  if (endsAt <= now) return 'ended';
  return startsAt <= now ? 'ongoing' : 'upcoming';
}
